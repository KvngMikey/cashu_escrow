import { appendFile, readFile } from 'node:fs/promises';

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
    const key = await store.putQuote(quote, OPERATOR.pubkey, 1_800_000_000);
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

  it('rate-limits one caller and compacts expired unbound quotes', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedOperatorStore(
      path,
      signer.deriveOperatorStoreKey()
    );
    const old = quoteAt(1_800_000_000, 1);
    const oldKey = await store.putQuote(old, OPERATOR.pubkey, 1_800_000_000);
    for (let index = 2; index <= 10; index += 1) {
      await store.putQuote(
        quoteAt(1_800_000_000, index),
        OPERATOR.pubkey,
        1_800_000_000
      );
    }
    await expect(
      store.putQuote(quoteAt(1_800_000_000, 11), OPERATOR.pubkey, 1_800_000_000)
    ).rejects.toMatchObject({ category: 'rate_limited' });

    const later = 1_800_000_000 + 24 * 60 * 60 + 601;
    await store.putQuote(quoteAt(later, 12), OPERATOR.pubkey, later);
    await expect(store.getQuote(oldKey)).resolves.toBeUndefined();
  });

  it('retains a bound quote through compaction and recovers a torn tail', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const key = signer.deriveOperatorStoreKey();
    const store = new EncryptedOperatorStore(path, key);
    const old = quoteAt(1_800_000_000, 1);
    const oldKey = await store.putQuote(old, OPERATOR.pubkey, 1_800_000_000);
    await store.bindQuote(oldKey, 'bb'.repeat(32));
    const later = 1_800_000_000 + 24 * 60 * 60 + 601;
    await store.putQuote(quoteAt(later, 2), OPERATOR.pubkey, later);
    await appendFile(path, '{"v":1,"nonce":"torn');

    const restarted = new EncryptedOperatorStore(path, key);
    await expect(restarted.initialize()).resolves.toBeUndefined();
    await expect(restarted.getQuote(oldKey)).resolves.toEqual(old);
  });

  it('rejects corruption in a newline-committed operator record', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedOperatorStore(
      path,
      signer.deriveOperatorStoreKey()
    );
    await store.putQuote(
      quoteAt(1_800_000_000, 1),
      OPERATOR.pubkey,
      1_800_000_000
    );
    await appendFile(path, '{"invalid":true}\n');

    await expect(store.initialize()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
  });
});

function quoteAt(createdAt: number, discriminator: number) {
  return createSignedQuote({
    request: {
      termsDigest: `sha256:${discriminator.toString(16).padStart(64, '0')}`,
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
    createdAt,
    networkCostSats: 2,
  });
}
