import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { NostrEvent } from 'nostr-tools/pure';
import { z } from 'zod';

import {
  SignedQuote,
  quoteCommitment,
  type SignedQuote as SignedQuoteValue,
} from '../cashu/quotes.ts';
import { EscrowError } from '../errors.ts';
import { HexEventId, HexPubkey } from '../primitives.ts';

export const PayoutTarget = z.discriminatedUnion('type', [
  z.object({ type: z.literal('cashu_p2pk'), pubkey: HexPubkey }).strict(),
  z
    .object({
      type: z.literal('bolt11'),
      invoice: z.string().min(1).max(8_192),
    })
    .strict(),
]);
export type PayoutTarget = z.infer<typeof PayoutTarget>;

const StoredEvent = z
  .object({
    id: HexEventId,
    pubkey: HexPubkey,
    created_at: z.number().int().nonnegative(),
    kind: z.number().int().nonnegative(),
    tags: z.array(z.array(z.string())),
    content: z.string(),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();

const QuoteEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('quote'),
    key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    quote: SignedQuote,
  })
  .strict();

const PayoutEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('payout'),
    coordinationId: HexEventId,
    payout: PayoutTarget,
  })
  .strict();

const FundingInstructionEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('funding_instruction'),
    coordinationId: HexEventId,
    locktime: z.number().int().positive(),
  })
  .strict();

const OutboxEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('outbox'),
    key: z.string().regex(/^[a-z0-9:_-]{1,256}$/),
    event: StoredEvent,
    published: z.boolean(),
  })
  .strict();

const StoreEntry = z.discriminatedUnion('type', [
  QuoteEntry,
  PayoutEntry,
  FundingInstructionEntry,
  OutboxEntry,
]);

const JournalLine = z
  .object({
    v: z.literal(1),
    nonce: z.string().regex(/^[0-9a-f]{24}$/),
    ciphertext: z.string().min(1),
    tag: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict();

type OutboxItem = {
  key: string;
  event: NostrEvent;
  published: boolean;
};

export interface OperatorStore {
  initialize(): Promise<void>;
  putQuote(quote: SignedQuoteValue): Promise<string>;
  getQuote(commitmentDigest: string): Promise<SignedQuoteValue | undefined>;
  putPayout(coordinationId: string, payout: PayoutTarget): Promise<void>;
  getPayout(coordinationId: string): Promise<PayoutTarget | undefined>;
  getOrCreateFundingLocktime(
    coordinationId: string,
    proposedLocktime?: number
  ): Promise<number | undefined>;
  stageOutbox(key: string, event: NostrEvent): Promise<OutboxItem>;
  markOutboxPublished(key: string): Promise<void>;
}

type StoreState = {
  revision: number;
  quotes: Map<string, SignedQuoteValue>;
  payouts: Map<string, PayoutTarget>;
  fundingLocktimes: Map<string, number>;
  outbox: Map<string, OutboxItem>;
};

/** Encrypted journal for quotes, private payout targets, and NIP-59 outbox events. */
export class EncryptedOperatorStore implements OperatorStore {
  readonly #path: string;
  readonly #key: Uint8Array;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) {
      throw new EscrowError('config_invalid', 'operator store key is invalid');
    }
    this.#path = path;
    this.#key = new Uint8Array(key);
  }

  async initialize(): Promise<void> {
    await this.#exclusive(async () => {
      await this.#read();
    });
  }

  async putQuote(quote: SignedQuoteValue): Promise<string> {
    const parsed = SignedQuote.safeParse(quote);
    if (!parsed.success) invalid('signed quote is invalid');
    const key = quoteCommitment(parsed.data).digest;
    await this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.quotes.get(key);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
          conflict('quote commitment already has different bytes');
        }
        return;
      }
      await this.#append({
        revision: state.revision + 1,
        type: 'quote',
        key,
        quote: parsed.data,
      });
    });
    return key;
  }

  async getQuote(key: string): Promise<SignedQuoteValue | undefined> {
    return this.#exclusive(async () => (await this.#read()).quotes.get(key));
  }

  async putPayout(coordinationId: string, payout: PayoutTarget): Promise<void> {
    const id = HexEventId.safeParse(coordinationId);
    const parsed = PayoutTarget.safeParse(payout);
    if (!id.success || !parsed.success) invalid('payout target is invalid');
    await this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.payouts.get(id.data);
      if (existing !== undefined) {
        if (JSON.stringify(existing) !== JSON.stringify(parsed.data)) {
          conflict(
            'coordination already has a different payout target',
            id.data
          );
        }
        return;
      }
      await this.#append({
        revision: state.revision + 1,
        type: 'payout',
        coordinationId: id.data,
        payout: parsed.data,
      });
    });
  }

  async getPayout(coordinationId: string): Promise<PayoutTarget | undefined> {
    return this.#exclusive(async () =>
      (await this.#read()).payouts.get(coordinationId)
    );
  }

  async getOrCreateFundingLocktime(
    coordinationId: string,
    proposedLocktime?: number
  ): Promise<number | undefined> {
    const id = HexEventId.safeParse(coordinationId);
    if (!id.success) invalid('coordination id is invalid');
    if (
      proposedLocktime !== undefined &&
      (!Number.isSafeInteger(proposedLocktime) || proposedLocktime <= 0)
    ) {
      invalid('funding locktime is invalid');
    }
    return this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.fundingLocktimes.get(id.data);
      if (existing !== undefined || proposedLocktime === undefined) {
        return existing;
      }
      await this.#append({
        revision: state.revision + 1,
        type: 'funding_instruction',
        coordinationId: id.data,
        locktime: proposedLocktime,
      });
      return proposedLocktime;
    });
  }

  async stageOutbox(key: string, event: NostrEvent): Promise<OutboxItem> {
    const parsed = OutboxEntry.shape.key.safeParse(key);
    const signed = StoredEvent.safeParse(event);
    if (!parsed.success || !signed.success) invalid('outbox event is invalid');
    return this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.outbox.get(parsed.data);
      if (existing !== undefined) return existing;
      const item = { key: parsed.data, event: signed.data, published: false };
      await this.#append({
        revision: state.revision + 1,
        type: 'outbox',
        ...item,
      });
      return item;
    });
  }

  async markOutboxPublished(key: string): Promise<void> {
    await this.#exclusive(async () => {
      const state = await this.#read();
      const item = state.outbox.get(key);
      if (item === undefined) conflict('outbox event was not staged');
      if (item.published) return;
      await this.#append({
        revision: state.revision + 1,
        type: 'outbox',
        key,
        event: item.event,
        published: true,
      });
    });
  }

  async #read(): Promise<StoreState> {
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return emptyState();
      throw unavailable('operator store could not be read');
    }

    const state = emptyState();
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
        const entry = StoreEntry.parse(JSON.parse(plaintext));
        if (entry.revision !== state.revision + 1) throw new Error();
        state.revision = entry.revision;
        if (entry.type === 'quote') state.quotes.set(entry.key, entry.quote);
        if (entry.type === 'payout') {
          state.payouts.set(entry.coordinationId, entry.payout);
        }
        if (entry.type === 'funding_instruction') {
          state.fundingLocktimes.set(entry.coordinationId, entry.locktime);
        }
        if (entry.type === 'outbox') {
          state.outbox.set(entry.key, {
            key: entry.key,
            event: entry.event,
            published: entry.published,
          });
        }
      }
    } catch {
      throw unavailable('operator store is corrupt or uses the wrong key');
    }
    return state;
  }

  async #append(entry: z.infer<typeof StoreEntry>): Promise<void> {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entry), 'utf8'),
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
      throw unavailable('operator store could not be persisted');
    }
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

function emptyState(): StoreState {
  return {
    revision: 0,
    quotes: new Map(),
    payouts: new Map(),
    fundingLocktimes: new Map(),
    outbox: new Map(),
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}

function invalid(message: string): never {
  throw new EscrowError('content_invalid', message);
}

function conflict(message: string, coordinationId?: string): never {
  throw new EscrowError('custody_conflict', message, {
    ...(coordinationId === undefined ? {} : { swapId: coordinationId }),
  });
}

function unavailable(message: string): EscrowError {
  return new EscrowError('storage_unavailable', message);
}
