import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
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
    caller: HexPubkey.optional(),
    storedAt: z.number().int().nonnegative().optional(),
  })
  .strict();

const QuoteBindingEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('quote_binding'),
    key: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    coordinationId: HexEventId,
    observationPolicy: z.literal('first_seen_v1').optional(),
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

const ForkEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('fork'),
    coordinationId: HexEventId,
    predecessor: HexEventId,
    branches: z.array(HexEventId).min(2),
    actions: z.array(StoredEvent).min(2),
  })
  .strict();

const EventObservationEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('event_observation'),
    eventId: HexEventId,
    observedAt: z.number().int().nonnegative(),
  })
  .strict();

const EventObservationMigrationEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('event_observation_migration'),
    coordinationId: HexEventId,
  })
  .strict();

const Nip98ReplayEntry = z
  .object({
    revision: z.number().int().positive(),
    type: z.literal('nip98_replay'),
    eventId: HexEventId,
    expiresAt: z.number().int().nonnegative(),
  })
  .strict();

const StoreEntry = z.discriminatedUnion('type', [
  QuoteEntry,
  QuoteBindingEntry,
  PayoutEntry,
  FundingInstructionEntry,
  OutboxEntry,
  ForkEntry,
  EventObservationEntry,
  EventObservationMigrationEntry,
  Nip98ReplayEntry,
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

export type PersistedFork = {
  coordinationId: string;
  predecessor: string;
  branches: readonly string[];
  actions: readonly NostrEvent[];
};

export type QuoteBindingMode = 'none' | 'legacy' | 'first_seen_v1';

export interface OperatorStore {
  initialize(): Promise<void>;
  putQuote(
    quote: SignedQuoteValue,
    caller: string,
    storedAt: number
  ): Promise<string>;
  getQuote(
    commitmentDigest: string,
    caller: string
  ): Promise<SignedQuoteValue | undefined>;
  bindQuote(commitmentDigest: string, coordinationId: string): Promise<boolean>;
  getQuoteBindingMode(
    commitmentDigest: string,
    coordinationId: string
  ): Promise<QuoteBindingMode>;
  putPayout(coordinationId: string, payout: PayoutTarget): Promise<void>;
  getPayout(coordinationId: string): Promise<PayoutTarget | undefined>;
  getOrCreateFundingLocktime(
    coordinationId: string,
    proposedLocktime?: number
  ): Promise<number | undefined>;
  stageOutbox(key: string, event: NostrEvent): Promise<OutboxItem>;
  markOutboxPublished(key: string): Promise<void>;
  putFork(fork: PersistedFork): Promise<void>;
  getFork(coordinationId: string): Promise<PersistedFork | undefined>;
  observeEvent(eventId: string, observedAt: number): Promise<number>;
  isEventObservationMigrationComplete(coordinationId: string): Promise<boolean>;
  completeEventObservationMigration(coordinationId: string): Promise<void>;
  useNip98Event(
    eventId: string,
    expiresAt: number,
    now: number
  ): Promise<boolean>;
}

type StoreState = {
  revision: number;
  quotes: Map<string, StoredQuote>;
  payouts: Map<string, PayoutTarget>;
  fundingLocktimes: Map<string, number>;
  outbox: Map<string, OutboxItem>;
  forks: Map<string, PersistedFork>;
  eventObservations: Map<string, number>;
  eventObservationMigrations: Set<string>;
  nip98Replay: Map<string, number>;
};

type StoredQuote = {
  quote: SignedQuoteValue;
  caller?: string;
  storedAt?: number;
  coordinationIds: Map<string, Exclude<QuoteBindingMode, 'none'>>;
};

const QUOTE_RATE_WINDOW_SECONDS = 60;
const MAX_QUOTES_PER_CALLER_PER_WINDOW = 10;
const MAX_QUOTES_GLOBAL_PER_WINDOW = 100;
const UNBOUND_QUOTE_RETENTION_SECONDS = 24 * 60 * 60;

/** Encrypted journal for quotes, private payout targets, and NIP-59 outbox events. */
export class EncryptedOperatorStore implements OperatorStore {
  readonly #path: string;
  readonly #key: Uint8Array;
  #cachedState: StoreState | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(path: string, key: Uint8Array) {
    if (key.length !== 32) {
      throw new EscrowError('config_invalid', 'operator store key is invalid');
    }
    this.#path = path;
    this.#key = new Uint8Array(key);
  }

  async initialize(): Promise<void> {
    return this.#exclusive(async () => {
      await this.#read();
    });
  }

  async putQuote(
    quote: SignedQuoteValue,
    caller: string,
    storedAt: number
  ): Promise<string> {
    const parsed = SignedQuote.safeParse(quote);
    const parsedCaller = HexPubkey.safeParse(caller);
    if (
      !parsed.success ||
      !parsedCaller.success ||
      !Number.isSafeInteger(storedAt) ||
      storedAt < 0
    ) {
      invalid('signed quote metadata is invalid');
    }
    const key = quoteCommitment(parsed.data).digest;
    await this.#exclusive(async () => {
      let state = await this.#read();
      const existing = state.quotes.get(key);
      if (existing !== undefined) {
        if (
          existing.caller !== parsedCaller.data ||
          JSON.stringify(existing.quote) !== JSON.stringify(parsed.data)
        ) {
          conflict('quote commitment already has different bytes');
        }
        return;
      }
      state = await this.#pruneExpiredQuotes(state, storedAt);
      const recent = [...state.quotes.values()].filter(
        (stored) =>
          stored.storedAt !== undefined &&
          stored.storedAt > storedAt - QUOTE_RATE_WINDOW_SECONDS
      );
      if (
        recent.length >= MAX_QUOTES_GLOBAL_PER_WINDOW ||
        recent.filter((stored) => stored.caller === parsedCaller.data).length >=
          MAX_QUOTES_PER_CALLER_PER_WINDOW
      ) {
        throw new EscrowError('rate_limited', 'quote request limit exceeded');
      }
      await this.#append({
        revision: state.revision + 1,
        type: 'quote',
        key,
        quote: parsed.data,
        caller: parsedCaller.data,
        storedAt,
      });
    });
    return key;
  }

  async getQuote(
    key: string,
    caller: string
  ): Promise<SignedQuoteValue | undefined> {
    const parsedCaller = HexPubkey.safeParse(caller);
    if (!parsedCaller.success) invalid('quote caller is invalid');
    return this.#exclusive(async () => {
      const stored = (await this.#read()).quotes.get(key);
      return stored?.caller === parsedCaller.data
        ? structuredClone(stored.quote)
        : undefined;
    });
  }

  async bindQuote(key: string, coordinationId: string): Promise<boolean> {
    const parsedKey = QuoteBindingEntry.shape.key.safeParse(key);
    const parsedId = HexEventId.safeParse(coordinationId);
    if (!parsedKey.success || !parsedId.success)
      invalid('quote binding is invalid');
    return this.#exclusive(async () => {
      const state = await this.#read();
      const quote = state.quotes.get(parsedKey.data);
      if (quote === undefined) conflict('quote is unavailable', parsedId.data);
      if (quote.coordinationIds.has(parsedId.data)) return true;
      if (quote.coordinationIds.size > 0) {
        return false;
      }
      await this.#append({
        revision: state.revision + 1,
        type: 'quote_binding',
        key: parsedKey.data,
        coordinationId: parsedId.data,
        observationPolicy: 'first_seen_v1',
      });
      return true;
    });
  }

  async getQuoteBindingMode(
    key: string,
    coordinationId: string
  ): Promise<QuoteBindingMode> {
    const parsedKey = QuoteBindingEntry.shape.key.safeParse(key);
    const parsedId = HexEventId.safeParse(coordinationId);
    if (!parsedKey.success || !parsedId.success) {
      invalid('quote binding lookup is invalid');
    }
    return this.#exclusive(async () => {
      return (
        (await this.#read()).quotes
          .get(parsedKey.data)
          ?.coordinationIds.get(parsedId.data) ?? 'none'
      );
    });
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
    return this.#exclusive(async () => {
      const payout = (await this.#read()).payouts.get(coordinationId);
      return payout === undefined ? undefined : structuredClone(payout);
    });
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
      if (existing !== undefined) return structuredClone(existing);
      const item = { key: parsed.data, event: signed.data, published: false };
      await this.#append({
        revision: state.revision + 1,
        type: 'outbox',
        ...item,
      });
      return structuredClone(item);
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

  async putFork(input: PersistedFork): Promise<void> {
    const parsed = ForkEntry.omit({ revision: true, type: true }).safeParse(
      input
    );
    if (!parsed.success) invalid('fork evidence is invalid');
    const branches = [...new Set(parsed.data.branches)].sort();
    const actions = [...parsed.data.actions].sort((left, right) =>
      left.id.localeCompare(right.id)
    );
    if (
      branches.length < 2 ||
      branches.some((branch) => !actions.some((action) => action.id === branch))
    ) {
      invalid('fork evidence is incomplete');
    }
    const fork: PersistedFork = {
      coordinationId: parsed.data.coordinationId,
      predecessor: parsed.data.predecessor,
      branches,
      actions,
    };
    await this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.forks.get(fork.coordinationId);
      // The first complete record is sufficient evidence. Later relay catch-up
      // must not replace it or block expiry recovery.
      if (existing !== undefined) return;
      await this.#append({
        revision: state.revision + 1,
        type: 'fork',
        ...fork,
        branches: [...fork.branches],
        actions: [...fork.actions],
      });
    });
  }

  async getFork(coordinationId: string): Promise<PersistedFork | undefined> {
    return this.#exclusive(async () => {
      const fork = (await this.#read()).forks.get(coordinationId);
      return fork === undefined ? undefined : structuredClone(fork);
    });
  }

  async observeEvent(eventId: string, observedAt: number): Promise<number> {
    const id = HexEventId.safeParse(eventId);
    if (!id.success || !Number.isSafeInteger(observedAt) || observedAt < 0) {
      invalid('event observation is invalid');
    }
    return this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.eventObservations.get(id.data);
      if (existing !== undefined) return existing;
      await this.#append({
        revision: state.revision + 1,
        type: 'event_observation',
        eventId: id.data,
        observedAt,
      });
      return observedAt;
    });
  }

  async isEventObservationMigrationComplete(
    coordinationId: string
  ): Promise<boolean> {
    const id = HexEventId.safeParse(coordinationId);
    if (!id.success) invalid('event observation migration lookup is invalid');
    return this.#exclusive(async () =>
      (await this.#read()).eventObservationMigrations.has(id.data)
    );
  }

  async completeEventObservationMigration(
    coordinationId: string
  ): Promise<void> {
    const id = HexEventId.safeParse(coordinationId);
    if (!id.success) invalid('event observation migration is invalid');
    await this.#exclusive(async () => {
      const state = await this.#read();
      if (state.eventObservationMigrations.has(id.data)) return;
      await this.#append({
        revision: state.revision + 1,
        type: 'event_observation_migration',
        coordinationId: id.data,
      });
    });
  }

  async useNip98Event(
    eventId: string,
    expiresAt: number,
    now: number
  ): Promise<boolean> {
    const id = HexEventId.safeParse(eventId);
    if (
      !id.success ||
      !Number.isSafeInteger(expiresAt) ||
      expiresAt < 0 ||
      !Number.isSafeInteger(now) ||
      now < 0
    ) {
      invalid('NIP-98 replay metadata is invalid');
    }
    return this.#exclusive(async () => {
      const state = await this.#read();
      const existing = state.nip98Replay.get(id.data);
      if (existing !== undefined && existing >= now) return false;
      await this.#append({
        revision: state.revision + 1,
        type: 'nip98_replay',
        eventId: id.data,
        expiresAt,
      });
      return true;
    });
  }

  async #read(): Promise<StoreState> {
    if (this.#cachedState !== undefined) return this.#cachedState;
    let contents: string;
    try {
      contents = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) {
        this.#cachedState = emptyState();
        return this.#cachedState;
      }
      throw unavailable('operator store could not be read');
    }

    const state = emptyState();
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
        applyEntry(state, StoreEntry.parse(JSON.parse(plaintext)));
      }
      if (finalLineIsUnframed && !discardedTail && lines.at(-1)?.length !== 0) {
        await frameValidTail(this.#path);
      }
    } catch {
      throw unavailable('operator store is corrupt or uses the wrong key');
    }
    this.#cachedState = state;
    return state;
  }

  async #pruneExpiredQuotes(
    state: StoreState,
    now: number
  ): Promise<StoreState> {
    const next = cloneState(state);
    let changed = false;
    for (const [key, stored] of next.quotes) {
      if (
        stored.coordinationIds.size === 0 &&
        stored.quote.quote.expires_at + UNBOUND_QUOTE_RETENTION_SECONDS < now
      ) {
        next.quotes.delete(key);
        changed = true;
      }
    }
    if (changed) {
      for (const [eventId, expiry] of next.nip98Replay) {
        if (expiry < now) next.nip98Replay.delete(eventId);
      }
      await this.#rewrite(next);
      return next;
    }
    return state;
  }

  async #rewrite(state: StoreState): Promise<void> {
    const entries: Array<z.infer<typeof StoreEntry>> = [];
    const add = (entry: unknown): void => {
      entries.push(
        StoreEntry.parse({
          ...(entry as Record<string, unknown>),
          revision: entries.length + 1,
        })
      );
    };
    for (const [key, stored] of state.quotes) {
      add({
        type: 'quote',
        key,
        quote: stored.quote,
        ...(stored.caller === undefined ? {} : { caller: stored.caller }),
        ...(stored.storedAt === undefined ? {} : { storedAt: stored.storedAt }),
      });
      for (const [
        coordinationId,
        observationPolicy,
      ] of stored.coordinationIds) {
        add({
          type: 'quote_binding',
          key,
          coordinationId,
          ...(observationPolicy === 'first_seen_v1'
            ? { observationPolicy }
            : {}),
        });
      }
    }
    for (const [coordinationId, payout] of state.payouts) {
      add({ type: 'payout', coordinationId, payout });
    }
    for (const [coordinationId, locktime] of state.fundingLocktimes) {
      add({ type: 'funding_instruction', coordinationId, locktime });
    }
    for (const item of state.outbox.values()) {
      add({ type: 'outbox', ...item });
    }
    for (const fork of state.forks.values()) {
      add({
        type: 'fork',
        ...fork,
        branches: [...fork.branches],
        actions: [...fork.actions],
      });
    }
    for (const [eventId, observedAt] of state.eventObservations) {
      add({ type: 'event_observation', eventId, observedAt });
    }
    for (const coordinationId of state.eventObservationMigrations) {
      add({ type: 'event_observation_migration', coordinationId });
    }
    for (const [eventId, expiresAt] of state.nip98Replay) {
      add({ type: 'nip98_replay', eventId, expiresAt });
    }

    const temporaryPath = `${this.#path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      const handle = await open(temporaryPath, 'wx', 0o600);
      try {
        for (const entry of entries) {
          await handle.appendFile(`${this.#encode(entry)}\n`, 'utf8');
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporaryPath, this.#path);
      state.revision = entries.length;
      this.#cachedState = state;
    } catch {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw unavailable('operator store could not be compacted');
    }
  }

  async #append(entry: z.infer<typeof StoreEntry>): Promise<void> {
    const line = this.#encode(entry);
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
      this.#cachedState = undefined;
      throw unavailable('operator store could not be persisted');
    }
    if (this.#cachedState === undefined) {
      throw unavailable('operator store was not initialized');
    }
    applyEntry(this.#cachedState, entry);
  }

  #encode(entry: z.infer<typeof StoreEntry>): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entry), 'utf8'),
      cipher.final(),
    ]);
    return JSON.stringify({
      v: 1,
      nonce: nonce.toString('hex'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('hex'),
    });
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

function applyEntry(
  state: StoreState,
  entry: z.infer<typeof StoreEntry>
): void {
  if (entry.revision !== state.revision + 1) throw new Error();
  state.revision = entry.revision;
  if (entry.type === 'quote') {
    state.quotes.set(entry.key, {
      quote: entry.quote,
      ...(entry.caller === undefined ? {} : { caller: entry.caller }),
      ...(entry.storedAt === undefined ? {} : { storedAt: entry.storedAt }),
      coordinationIds: new Map(),
    });
  }
  if (entry.type === 'quote_binding') {
    const quote = state.quotes.get(entry.key);
    if (quote === undefined) throw new Error();
    quote.coordinationIds.set(
      entry.coordinationId,
      entry.observationPolicy ?? 'legacy'
    );
  }
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
  if (entry.type === 'fork') {
    state.forks.set(entry.coordinationId, {
      coordinationId: entry.coordinationId,
      predecessor: entry.predecessor,
      branches: entry.branches,
      actions: entry.actions,
    });
  }
  if (
    entry.type === 'event_observation' &&
    !state.eventObservations.has(entry.eventId)
  ) {
    state.eventObservations.set(entry.eventId, entry.observedAt);
  }
  if (entry.type === 'event_observation_migration') {
    state.eventObservationMigrations.add(entry.coordinationId);
  }
  if (entry.type === 'nip98_replay') {
    state.nip98Replay.set(entry.eventId, entry.expiresAt);
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

function emptyState(): StoreState {
  return {
    revision: 0,
    quotes: new Map(),
    payouts: new Map(),
    fundingLocktimes: new Map(),
    outbox: new Map(),
    forks: new Map(),
    eventObservations: new Map(),
    eventObservationMigrations: new Set(),
    nip98Replay: new Map(),
  };
}

function cloneState(state: StoreState): StoreState {
  return {
    revision: state.revision,
    quotes: new Map(
      [...state.quotes].map(([key, stored]) => [
        key,
        { ...stored, coordinationIds: new Map(stored.coordinationIds) },
      ])
    ),
    payouts: new Map(state.payouts),
    fundingLocktimes: new Map(state.fundingLocktimes),
    outbox: new Map(state.outbox),
    forks: new Map(state.forks),
    eventObservations: new Map(state.eventObservations),
    eventObservationMigrations: new Set(state.eventObservationMigrations),
    nip98Replay: new Map(state.nip98Replay),
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
