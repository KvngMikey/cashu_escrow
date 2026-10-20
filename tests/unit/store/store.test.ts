import {
  appendFile,
  mkdir,
  open,
  readFile,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CustodyEngine } from '../../../src/lib/cashu/custody.ts';
import type { InspectedToken } from '../../../src/lib/cashu/mint.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import {
  EncryptedCustodyStore,
  type CustodyRecord,
} from '../../../src/lib/store/store.ts';
import { FakeCustodyMint } from '../support/fake-custody.ts';
import { CUSTOMER, OPERATOR } from '../support/keys.ts';

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

  it('round trips encrypted prepared spend recovery material', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const store = new EncryptedCustodyStore(path, new Uint8Array(32).fill(7));
    await store.append(base);
    await store.append({
      ...base,
      revision: 2,
      status: 'spending',
      spend: {
        kind: 'settlement_p2pk',
        prepared: { payload: 'recoverable-blinded-output-data' },
        operatorFeeSats: 10,
        payoutSats: 989,
      },
      observedAt: 1_001,
    });

    await expect(store.get(base.coordinationId)).resolves.toMatchObject({
      status: 'spending',
      spend: { kind: 'settlement_p2pk' },
    });
    expect(await readFile(path, 'utf8')).not.toContain(
      'recoverable-blinded-output-data'
    );
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

    const restarted = new EncryptedCustodyStore(
      path,
      new Uint8Array(32).fill(7)
    );
    await expect(restarted.all()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
  });

  it('does not truncate an unframed record that fails authentication', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const key = new Uint8Array(32).fill(7);
    const store = new EncryptedCustodyStore(path, key);
    await store.append(base);
    const line = JSON.parse((await readFile(path, 'utf8')).trim()) as {
      tag: string;
    };
    line.tag = `${line.tag[0] === '0' ? '1' : '0'}${line.tag.slice(1)}`;
    const corrupted = JSON.stringify(line);
    await writeFile(path, corrupted);

    const restarted = new EncryptedCustodyStore(path, key);
    await expect(restarted.all()).rejects.toMatchObject({
      category: 'storage_unavailable',
    });
    await expect(readFile(path, 'utf8')).resolves.toBe(corrupted);
  });

  it('fails closed after an uncertain hold and rejects its token after restart', async () => {
    const path = `${process.env.TMPDIR ?? '/tmp'}/cashu-store-${crypto.randomUUID()}/store.jsonl`;
    const key = new Uint8Array(32).fill(7);
    const store = new EncryptedCustodyStore(path, key);
    const mint = new FakeCustodyMint(lockedToken());
    const engine = custodyEngine(store, mint);
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
      engine.hold(holdRequest('swap-uncertain'))
    ).rejects.toMatchObject({ category: 'storage_unavailable' });
    sync.mockRestore();
    await expect(engine.hold(holdRequest('swap-retry'))).rejects.toThrow(
      /restart is required/
    );

    const restartedStore = new EncryptedCustodyStore(path, key);
    const restarted = custodyEngine(restartedStore, mint);
    await expect(
      restarted.hold(holdRequest('swap-duplicate'))
    ).rejects.toMatchObject({ category: 'custody_conflict' });
    await expect(restartedStore.get('swap-uncertain')).resolves.toMatchObject({
      revision: 1,
      status: 'held',
    });
  });
});

function lockedToken(): InspectedToken {
  return {
    mint: 'http://mint.test',
    unit: 'sat',
    amount: 1_000,
    inputFee: 1,
    proofs: [
      {
        amount: 1_000,
        secret: [
          'P2PK',
          {
            nonce: 'nonce',
            data: OPERATOR.pubkey,
            tags: [
              ['locktime', '2150'],
              ['refund', CUSTOMER.pubkey],
            ],
          },
        ],
        sigFlag: 'SIG_INPUTS',
        dleqValid: true,
      },
    ],
  };
}

function custodyEngine(store: EncryptedCustodyStore, mint: FakeCustodyMint) {
  return new CustodyEngine({
    mint,
    store,
    signer: createSigner(OPERATOR.nsec),
    policy: {
      releaseSafetyMarginSeconds: 50,
      returnLnOverage: true,
      operatorLnAddress: 'operator@example.com',
    },
  });
}

function holdRequest(coordinationId: string) {
  return {
    token: 'cashu-locked',
    observedAt: 1_000,
    expectation: {
      coordinationId,
      mintUrl: 'http://mint.test',
      operatorPubkey: OPERATOR.pubkey,
      providerPubkey: CUSTOMER.pubkey,
      grossSats: 1_000,
      networkCostSats: 1,
      payoutType: 'cashu_p2pk' as const,
      fiatConfirmBy: 2_000,
      disputeWindowSeconds: 100,
      releaseSafetyMarginSeconds: 50,
    },
  };
}
