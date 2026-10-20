import type { NostrEvent } from 'nostr-tools/pure';

import {
  quoteCommitment,
  type SignedQuote,
} from '../../../src/lib/cashu/quotes.ts';
import type {
  OperatorStore,
  PayoutTarget,
  PersistedFork,
  QuoteBindingMode,
} from '../../../src/lib/store/operator-store.ts';
import { OPERATOR } from './keys.ts';

export class MemoryOperatorStore implements OperatorStore {
  beforeStageOutbox: ((key: string) => Promise<void> | void) | undefined;
  readonly quotes = new Map<string, SignedQuote>();
  readonly quoteCallers = new Map<string, string>();
  readonly quoteBindings = new Map<string, string>();
  readonly quoteBindingModes = new Map<string, QuoteBindingMode>();
  readonly payouts = new Map<string, PayoutTarget>();
  readonly fundingLocktimes = new Map<string, number>();
  readonly outbox = new Map<
    string,
    { key: string; event: NostrEvent; published: boolean }
  >();
  readonly forks = new Map<string, PersistedFork>();
  readonly eventObservations = new Map<string, number>();
  readonly eventObservationMigrations = new Set<string>();
  readonly nip98Replay = new Map<string, number>();

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  putQuote(
    quote: SignedQuote,
    caller = OPERATOR.pubkey,
    _storedAt = quote.quote.expires_at - 1
  ): Promise<string> {
    const key = quoteCommitment(quote).digest;
    this.quotes.set(key, quote);
    this.quoteCallers.set(key, caller);
    return Promise.resolve(key);
  }

  bindQuote(key: string, coordinationId: string): Promise<boolean> {
    if (!this.quotes.has(key))
      return Promise.reject(new Error('missing quote'));
    const existing = this.quoteBindings.get(key);
    if (existing !== undefined && existing !== coordinationId) {
      return Promise.resolve(false);
    }
    this.quoteBindings.set(key, coordinationId);
    this.quoteBindingModes.set(key, 'first_seen_v1');
    return Promise.resolve(true);
  }

  getQuoteBindingMode(
    key: string,
    coordinationId: string
  ): Promise<QuoteBindingMode> {
    return Promise.resolve(
      this.quoteBindings.get(key) === coordinationId
        ? (this.quoteBindingModes.get(key) ?? 'legacy')
        : 'none'
    );
  }

  getQuote(key: string, caller: string): Promise<SignedQuote | undefined> {
    return Promise.resolve(
      this.quoteCallers.get(key) === caller ? this.quotes.get(key) : undefined
    );
  }

  putPayout(coordinationId: string, payout: PayoutTarget): Promise<void> {
    const existing = this.payouts.get(coordinationId);
    if (
      existing !== undefined &&
      JSON.stringify(existing) !== JSON.stringify(payout)
    ) {
      return Promise.reject(new Error('payout conflict'));
    }
    this.payouts.set(coordinationId, payout);
    return Promise.resolve();
  }

  getPayout(coordinationId: string): Promise<PayoutTarget | undefined> {
    return Promise.resolve(this.payouts.get(coordinationId));
  }

  getOrCreateFundingLocktime(
    coordinationId: string,
    proposedLocktime?: number
  ): Promise<number | undefined> {
    const existing = this.fundingLocktimes.get(coordinationId);
    if (existing !== undefined || proposedLocktime === undefined) {
      return Promise.resolve(existing);
    }
    this.fundingLocktimes.set(coordinationId, proposedLocktime);
    return Promise.resolve(proposedLocktime);
  }

  async stageOutbox(key: string, event: NostrEvent) {
    await this.beforeStageOutbox?.(key);
    const existing = this.outbox.get(key);
    if (existing !== undefined) return existing;
    const item = { key, event, published: false };
    this.outbox.set(key, item);
    return item;
  }

  markOutboxPublished(key: string): Promise<void> {
    const item = this.outbox.get(key);
    if (item === undefined) return Promise.reject(new Error('missing outbox'));
    this.outbox.set(key, { ...item, published: true });
    return Promise.resolve();
  }

  putFork(fork: PersistedFork): Promise<void> {
    const existing = this.forks.get(fork.coordinationId);
    if (existing !== undefined) return Promise.resolve();
    this.forks.set(fork.coordinationId, structuredClone(fork));
    return Promise.resolve();
  }

  getFork(coordinationId: string): Promise<PersistedFork | undefined> {
    return Promise.resolve(this.forks.get(coordinationId));
  }

  observeEvent(eventId: string, observedAt: number): Promise<number> {
    const existing = this.eventObservations.get(eventId);
    if (existing !== undefined) return Promise.resolve(existing);
    this.eventObservations.set(eventId, observedAt);
    return Promise.resolve(observedAt);
  }

  isEventObservationMigrationComplete(
    coordinationId: string
  ): Promise<boolean> {
    return Promise.resolve(this.eventObservationMigrations.has(coordinationId));
  }

  completeEventObservationMigration(coordinationId: string): Promise<void> {
    this.eventObservationMigrations.add(coordinationId);
    return Promise.resolve();
  }

  useNip98Event(
    eventId: string,
    expiresAt: number,
    now: number
  ): Promise<boolean> {
    const existing = this.nip98Replay.get(eventId);
    if (existing !== undefined && existing >= now) {
      return Promise.resolve(false);
    }
    this.nip98Replay.set(eventId, expiresAt);
    return Promise.resolve(true);
  }
}
