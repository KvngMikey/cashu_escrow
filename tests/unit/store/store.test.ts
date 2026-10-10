import { appendFile, readFile, stat } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  EncryptedCustodyStore,
  type CustodyRecord,
} from '../../../src/lib/store/store.ts';

const base: CustodyRecord = {
  coordinationId: 'swap-1',
  revision: 1,
  status: 'held',
  token: 'cashu-secret-token',
  mintUrl: 'http://mint.test',
  providerPubkey: '11'.repeat(32),
  grossSats: 1_000,
  inputFeeSats: 1,
  proofCount: 1,
  tokenFingerprint: 'aa'.repeat(32),
  networkCostSats: 1,
  locktime: 2_000,
  observedAt: 1_000,
};

describe('EncryptedCustodyStore', () => {
  it('round trips the latest encrypted append-only record', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedCustodyStore(path, new Uint8Array(32).fill(7));
    await store.append(base);
    await store.append({
      ...base,
      revision: 2,
      overlay: 'expired_recovery_available',
      observedAt: 2_001,
    });

    await expect(store.get('swap-1')).resolves.toMatchObject({
      revision: 2,
      overlay: 'expired_recovery_available',
    });
    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain(base.token);
    expect(raw.trim().split('\n')).toHaveLength(2);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('rejects the wrong key and stale revisions without leaking material', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedCustodyStore(path, new Uint8Array(32).fill(7));
    await store.append(base);
    const wrong = new EncryptedCustodyStore(path, new Uint8Array(32).fill(8));
    await expect(wrong.all()).rejects.toThrow(/wrong key/);
    await expect(store.append(base)).rejects.toMatchObject({
      category: 'custody_conflict',
    });
  });

  it('discards only an unframed torn final append', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const key = new Uint8Array(32).fill(7);
    const store = new EncryptedCustodyStore(path, key);
    await store.append(base);
    await appendFile(path, '{"v":1,"nonce":"torn');

    const restarted = new EncryptedCustodyStore(path, key);
    await expect(restarted.get(base.coordinationId)).resolves.toEqual(base);
    await expect(
      restarted.append({ ...base, revision: 2, observedAt: 1_001 })
    ).resolves.toBeUndefined();
  });

  it('rejects corruption in a newline-committed record', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedCustodyStore(path, new Uint8Array(32).fill(7));
    await store.append(base);
    await appendFile(path, '{"invalid":true}\n');

    await expect(store.all()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
  });
});
