import type { NostrEvent } from 'nostr-tools/pure';

import {
  quoteCommitment,
  type SignedQuote,
} from '../../../src/lib/cashu/quotes.ts';
import type {
  OperatorStore,
  PayoutTarget,
} from '../../../src/lib/store/operator-store.ts';
import { OPERATOR } from './keys.ts';

export class MemoryOperatorStore implements OperatorStore {
  beforeStageOutbox: ((key: string) => Promise<void> | void) | undefined;
  readonly quotes = new Map<string, SignedQuote>();
  readonly payouts = new Map<string, PayoutTarget>();
  readonly fundingLocktimes = new Map<string, number>();
  readonly outbox = new Map<
    string,
    { key: string; event: NostrEvent; published: boolean }
  >();

  initialize(): Promise<void> {
    return Promise.resolve();
  }

  putQuote(
    quote: SignedQuote,
    _caller = OPERATOR.pubkey,
    _storedAt = quote.quote.expires_at - 1
  ): Promise<string> {
    const key = quoteCommitment(quote).digest;
    this.quotes.set(key, quote);
    return Promise.resolve(key);
  }

  bindQuote(key: string, coordinationId: string): Promise<void> {
    if (!this.quotes.has(key))
      return Promise.reject(new Error('missing quote'));
    void coordinationId;
    return Promise.resolve();
  }

  getQuote(key: string): Promise<SignedQuote | undefined> {
    return Promise.resolve(this.quotes.get(key));
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
}
