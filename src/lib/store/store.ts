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

const StoredRecord = z
  .object({
    coordinationId: z.string().min(1),
    revision: z.number().int().positive(),
    status: z.enum(['held', 'settled', 'refunded']),
    overlay: z.enum(CUSTODY_OVERLAYS).optional(),
    token: z.string().min(1),
    mintUrl: z.string().url(),
    providerPubkey: z.string().regex(/^[0-9a-f]{64}$/),
    grossSats: z.number().int().positive(),
    inputFeeSats: z.number().int().nonnegative(),
    proofCount: z.number().int().positive(),
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

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) {
      throw new EscrowError('config_invalid', 'custody store key is invalid');
    }
    this.#path = path;
    this.#key = new Uint8Array(key);
  }

  async get(coordinationId: string): Promise<CustodyRecord | undefined> {
    const records = await this.all();
    return records.find((record) => record.coordinationId === coordinationId);
  }

  async all(): Promise<readonly CustodyRecord[]> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw storageError('custody store could not be read');
    }

    const current = new Map<string, CustodyRecord>();
    try {
      for (const rawLine of contents.split('\n')) {
        if (rawLine.length === 0) continue;
        const line = JournalLine.parse(JSON.parse(rawLine));
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
    } catch {
      throw storageError('custody store is corrupt or uses the wrong key');
    }
    return [...current.values()];
  }

  async append(input: CustodyRecord): Promise<void> {
    const record = StoredRecord.safeParse(input);
    if (!record.success) throw storageError('custody record is invalid');
    const current = await this.get(record.data.coordinationId);
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
      throw storageError('custody record could not be persisted');
    }
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
