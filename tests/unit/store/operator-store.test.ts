import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
    await expect(store.getQuote(key, OPERATOR.pubkey)).resolves.toEqual(quote);
    await expect(store.getQuote(key, '22'.repeat(32))).resolves.toBeUndefined();

    const coordinationId = 'bb'.repeat(32);
    await expect(store.bindQuote(key, coordinationId)).resolves.toBe(true);
    await expect(store.bindQuote(key, coordinationId)).resolves.toBe(true);
    await expect(store.bindQuote(key, 'cc'.repeat(32))).resolves.toBe(false);
    await expect(store.getQuoteBindingMode(key, coordinationId)).resolves.toBe(
      'first_seen_v1'
    );

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
    await expect(
      store.getQuote(oldKey, OPERATOR.pubkey)
    ).resolves.toBeUndefined();
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
    await expect(restarted.getQuote(oldKey, OPERATOR.pubkey)).resolves.toEqual(
      old
    );
  });

  it('persists the first complete fork evidence across restart', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const key = signer.deriveOperatorStoreKey();
    const store = new EncryptedOperatorStore(path, key);
    const coordinationId = 'bb'.repeat(32);
    const predecessor = 'cc'.repeat(32);
    const first = signer.sign({ kind: 7301, tags: [], content: 'branch-one' });
    const second = signer.sign({ kind: 7301, tags: [], content: 'branch-two' });

    await store.putFork({
      coordinationId,
      predecessor,
      branches: [second.id, first.id],
      actions: [first, second],
    });
    const restarted = new EncryptedOperatorStore(path, key);
    await expect(restarted.getFork(coordinationId)).resolves.toMatchObject({
      coordinationId,
      predecessor,
      branches: [first.id, second.id].sort(),
    });

    const later = signer.sign({ kind: 7301, tags: [], content: 'later-event' });
    await expect(
      restarted.putFork({
        coordinationId,
        predecessor: 'dd'.repeat(32),
        branches: [first.id, later.id],
        actions: [first, later],
      })
    ).resolves.toBeUndefined();
    await expect(restarted.getFork(coordinationId)).resolves.toMatchObject({
      predecessor,
      actions: expect.not.arrayContaining([
        expect.objectContaining({ id: later.id }),
      ]),
    });

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('branch-one');
    expect(raw).not.toContain('branch-two');
  });

  it('persists event observations and NIP-98 replay protection across restart', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const key = signer.deriveOperatorStoreKey();
    const eventId = 'aa'.repeat(32);
    const authId = 'bb'.repeat(32);
    const store = new EncryptedOperatorStore(path, key);

    await expect(store.observeEvent(eventId, 100)).resolves.toBe(100);
    await expect(store.observeEvent(eventId, 200)).resolves.toBe(100);
    await expect(store.useNip98Event(authId, 160, 100)).resolves.toBe(true);

    const restarted = new EncryptedOperatorStore(path, key);
    await expect(restarted.observeEvent(eventId, 300)).resolves.toBe(100);
    await expect(restarted.useNip98Event(authId, 160, 101)).resolves.toBe(
      false
    );
    await expect(restarted.useNip98Event(authId, 221, 161)).resolves.toBe(true);
    await restarted.completeEventObservationMigration(eventId);
    await expect(
      restarted.isEventObservationMigrationComplete(eventId)
    ).resolves.toBe(true);
    expect((await readFile(path, 'utf8')).trim().split('\n')).toHaveLength(4);

    const reloaded = new EncryptedOperatorStore(path, key);
    await expect(
      reloaded.isEventObservationMigrationComplete(eventId)
    ).resolves.toBe(true);
  });

  it('reloads the journal after an uncertain append outcome', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const key = signer.deriveOperatorStoreKey();
    const store = new EncryptedOperatorStore(path, key);
    const quote = quoteAt(1_800_000_000, 1);
    const commitment = quoteCommitment(quote).digest;
    await mkdir(dirname(path), { recursive: true });
    const probe = await open(path, 'a');
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync(): Promise<void>;
    };
    await probe.close();
    const sync = vi
      .spyOn(fileHandlePrototype, 'sync')
      .mockRejectedValueOnce(new Error('simulated sync failure'));

    await expect(
      store.putQuote(quote, OPERATOR.pubkey, 1_800_000_000)
    ).rejects.toMatchObject({ category: 'storage_unavailable' });
    sync.mockRestore();

    await expect(store.getQuote(commitment, OPERATOR.pubkey)).resolves.toEqual(
      quote
    );
    await expect(
      store.getOrCreateFundingLocktime('bb'.repeat(32), 1_800_001_000)
    ).resolves.toBe(1_800_001_000);

    const restarted = new EncryptedOperatorStore(path, key);
    await expect(restarted.initialize()).resolves.toBeUndefined();
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

    const restarted = new EncryptedOperatorStore(
      path,
      signer.deriveOperatorStoreKey()
    );
    await expect(restarted.initialize()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
  });

  it('does not truncate an unframed operator record that fails authentication', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-operator-${crypto.randomUUID()}/store.jsonl`;
    const key = signer.deriveOperatorStoreKey();
    const store = new EncryptedOperatorStore(path, key);
    await store.putQuote(
      quoteAt(1_800_000_000, 1),
      OPERATOR.pubkey,
      1_800_000_000
    );
    const line = JSON.parse((await readFile(path, 'utf8')).trim()) as {
      tag: string;
    };
    line.tag = `${line.tag[0] === '0' ? '1' : '0'}${line.tag.slice(1)}`;
    const corrupted = JSON.stringify(line);
    await writeFile(path, corrupted);

    const restarted = new EncryptedOperatorStore(path, key);
    await expect(restarted.initialize()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupted);
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
