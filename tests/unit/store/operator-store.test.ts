import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  createSignedQuote,
  quoteCommitment,
} from '../../../src/lib/cashu/quotes.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { EncryptedOperatorStore } from '../../../src/lib/store/operator-store.ts';
import { OPERATOR } from '../support/keys.ts';

const signer = createSigner(OPERATOR.nsec);

describe('EncryptedOperatorStore', () => {
  it('persists quotes, payout targets, and an idempotent encrypted outbox', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedOperatorStore(
      path,
      signer.deriveOperatorStoreKey()
    );
    const quote = createSignedQuote({
      request: {
        termsDigest: `sha256:${'aa'.repeat(32)}`,
        direction: 'btc_to_fiat',
        grossSats: 1_000,
        payoutType: 'bolt11',
      },
      policy: {
        feesEnabled: true,
        operatorFeeBps: 100,
        operatorMinFeeSats: 3,
        minCoordinationSats: 100,
        refundFeeMode: 'network_only',
        ttlSeconds: 600,
      },
      signer,
      createdAt: 1_800_000_000,
      networkCostSats: 2,
    });
    const key = await store.putQuote(quote);
    expect(key).toBe(quoteCommitment(quote).digest);
    await expect(store.getQuote(key)).resolves.toEqual(quote);

    const coordinationId = 'bb'.repeat(32);
    await store.putPayout(coordinationId, {
      type: 'bolt11',
      invoice: 'lnbc-private-invoice',
    });
    await expect(store.getPayout(coordinationId)).resolves.toEqual({
      type: 'bolt11',
      invoice: 'lnbc-private-invoice',
    });
    await expect(
      store.getOrCreateFundingLocktime(coordinationId, 1_800_001_000)
    ).resolves.toBe(1_800_001_000);
    await expect(
      store.getOrCreateFundingLocktime(coordinationId, 1_900_000_000)
    ).resolves.toBe(1_800_001_000);

    const event = signer.sign({
      kind: 1059,
      tags: [['p', OPERATOR.pubkey]],
      content: 'encrypted-private-message',
    });
    const staged = await store.stageOutbox(`refund:${coordinationId}`, event);
    const repeated = await store.stageOutbox(`refund:${coordinationId}`, {
      ...event,
      content: 'different',
    });
    expect(staged.published).toBe(false);
    expect(repeated.event).toEqual({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    });
    await store.markOutboxPublished(`refund:${coordinationId}`);
    await expect(
      store.stageOutbox(`refund:${coordinationId}`, event)
    ).resolves.toMatchObject({ published: true });

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('lnbc-private-invoice');
    expect(raw).not.toContain('encrypted-private-message');
  });
});
