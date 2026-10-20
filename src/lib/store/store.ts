import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import { EscrowError } from '../errors.ts';

export const CUSTODY_OVERLAYS = [
  'expired_recovery_available',
  'expired_pending_unattributed',
  'expired_spent_unattributed',
  'settlement_unfulfillable',
] as const;
export type CustodyOverlay = (typeof CUSTODY_OVERLAYS)[number];

const PreparedP2pkSpend = z.object({ payload: z.string().min(1) }).strict();
const Bolt11MeltQuote = z
  .object({
    id: z.string().min(1),
    amount: z.number().int().positive(),
    feeReserve: z.number().int().nonnegative(),
    expiry: z.number().int().nonnegative(),
  })
  .strict();
const PreparedMelt = z
  .object({
    payload: z.string().min(1),
    quote: Bolt11MeltQuote,
    inputFee: z.number().int().nonnegative(),
    maxChangeInputFee: z.number().int().nonnegative(),
  })
  .strict();

const PendingSpend = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['settlement_p2pk', 'refund_p2pk']),
      prepared: PreparedP2pkSpend,
      operatorFeeSats: z.number().int().nonnegative(),
      payoutSats: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('settlement_bolt11_recipient'),
      prepared: PreparedMelt,
      operatorFeeQuote: Bolt11MeltQuote.optional(),
      operatorFeeInvoice: z.string().min(1).optional(),
      operatorFeeSats: z.number().int().nonnegative(),
      payoutSats: z.number().int().positive(),
      networkBudgetSats: z.number().int().nonnegative(),
      returnOverage: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('settlement_bolt11_operator'),
      prepared: PreparedMelt,
      sourceToken: z.string().min(1),
      operatorFeeInvoice: z.string().min(1),
      operatorFeeSats: z.number().int().positive(),
      payoutSats: z.number().int().positive(),
      networkBudgetSats: z.number().int().nonnegative(),
      networkSpentSats: z.number().int().nonnegative(),
      returnOverage: z.boolean(),
    })
    .strict(),
]);

export type PendingCustodySpend = z.infer<typeof PendingSpend>;

const StoredRecord = z
  .object({
    coordinationId: z.string().min(1),
    revision: z.number().int().positive(),
    status: z.enum([
      'held',
      'spending',
      'settled',
      'refunded',
      'reconciliation_required',
    ]),
    spend: PendingSpend.optional(),
    reconciliationReason: z.string().min(1).optional(),
    reconciliationTokens: z.array(z.string().min(1)).min(1).optional(),
    overlay: z.enum(CUSTODY_OVERLAYS).optional(),
    token: z.string().min(1),
    mintUrl: z.string().url(),
    providerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    grossSats: z.number().int().positive(),
    inputFeeSats: z.number().int().nonnegative(),
    proofCount: z.number().int().positive(),
    tokenFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    networkCostSats: z.number().int().nonnegative(),
    locktime: z.number().int().positive(),
    operatorFeeSats: z.number().int().nonnegative().optional(),
    payoutSats: z.number().int().positive().optional(),
    payoutToken: z.string().min(1).optional(),
    operatorToken: z.string().min(1).optional(),
    overageToken: z.string().min(1).optional(),
    observedAt: z.number().int().nonnegative(),
  })
  .strict();

export type CustodyRecord = z.infer<typeof StoredRecord>;

const JournalLine = z
  .object({
    v: z.literal(1),
    nonce: z.string().regex(/^[0-9a-f]{24}$/),
    ciphertext: z.string().min(1),
    tag: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

export interface CustodyStore {
  get(coordinationId: string): Promise<CustodyRecord | undefined>;
  append(record: CustodyRecord): Promise<void>;
  all(): Promise<readonly CustodyRecord[]>;
}

/** AES-256-GCM encrypted, append-only JSON-lines custody journal. */
export class EncryptedCustodyStore implements CustodyStore {
  readonly #path: string;
  readonly #key: Uint8Array;
  #records: Map<string, CustodyRecord> | undefined;
  #writeUncertain = false;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) {
      throw new EscrowError('config_invalid', 'custody store key is invalid');
    }
    this.#path = path;
    this.#key = new Uint8Array(key);
  }

  async get(coordinationId: string): Promise<CustodyRecord | undefined> {
    return this.#exclusive(async () => {
      const record = (await this.#state()).get(coordinationId);
      return record === undefined ? undefined : structuredClone(record);
    });
  }

  async all(): Promise<readonly CustodyRecord[]> {
    return this.#exclusive(async () =>
      [...(await this.#state()).values()].map((record) =>
        structuredClone(record)
      )
    );
  }

  async #state(): Promise<Map<string, CustodyRecord>> {
    if (this.#writeUncertain) {
      throw storageError(
        'custody store write outcome is uncertain; restart is required'
      );
    }
    if (this.#records !== undefined) return this.#records;
    this.#records = await this.#load();
    return this.#records;
  }

  async #load(): Promise<Map<string, CustodyRecord>> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return new Map();
      throw storageError('custody store could not be read');
    }

    const current = new Map<string, CustodyRecord>();
    const lines = contents.split('\n');
    const finalLineIsUnframed = !contents.endsWith('\n');
    let discardedTail = false;
    try {
      for (const [index, rawLine] of lines.entries()) {
        if (rawLine.length === 0) continue;
        let parsedLine: unknown;
        try {
          parsedLine = JSON.parse(rawLine);
        } catch (error) {
          if (finalLineIsUnframed && index === lines.length - 1) {
            await repairUnframedTail(this.#path, contents, rawLine);
            discardedTail = true;
            break;
          }
          throw error;
        }
        const line = JournalLine.parse(parsedLine);
        const decipher = createDecipheriv(
          'aes-256-gcm',
          this.#key,
          Buffer.from(line.nonce, 'hex')
        );
        decipher.setAuthTag(Buffer.from(line.tag, 'hex'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(line.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8');
        const record = StoredRecord.parse(JSON.parse(plaintext));
        const previous = current.get(record.coordinationId);
        if (
          previous !== undefined &&
          record.revision !== previous.revision + 1
        ) {
          throw new Error();
        }
        if (previous === undefined && record.revision !== 1) throw new Error();
        current.set(record.coordinationId, record);
      }
      if (finalLineIsUnframed && !discardedTail && lines.at(-1)?.length !== 0) {
        await frameValidTail(this.#path);
      }
    } catch {
      throw storageError('custody store is corrupt or uses the wrong key');
    }
    return current;
  }

  async append(input: CustodyRecord): Promise<void> {
    await this.#exclusive(() => this.#append(input));
  }

  async #append(input: CustodyRecord): Promise<void> {
    const record = StoredRecord.safeParse(input);
    if (!record.success) throw storageError('custody record is invalid');
    const records = await this.#state();
    const current = records.get(record.data.coordinationId);
    const expectedRevision = (current?.revision ?? 0) + 1;
    if (record.data.revision !== expectedRevision) {
      throw new EscrowError(
        'custody_conflict',
        'custody record revision is stale',
        { swapId: record.data.coordinationId }
      );
    }

    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(record.data), 'utf8'),
      cipher.final(),
    ]);
    const line = JSON.stringify({
      v: 1,
      nonce: nonce.toString('hex'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('hex'),
    });

    try {
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(this.#path, 'a', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.appendFile(`${line}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch {
      this.#records = undefined;
      this.#writeUncertain = true;
      throw storageError('custody record could not be persisted');
    }
    records.set(record.data.coordinationId, record.data);
  }

  async #exclusive<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }
}

async function repairUnframedTail(
  path: string,
  contents: string,
  tail: string
): Promise<void> {
  const length = Buffer.byteLength(contents.slice(0, -tail.length), 'utf8');
  const handle = await open(path, 'r+');
  try {
    await handle.truncate(length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function frameValidTail(path: string): Promise<void> {
  const handle = await open(path, 'a');
  try {
    await handle.appendFile('\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function storageError(message: string): EscrowError {
  return new EscrowError('storage_unavailable', message);
}
