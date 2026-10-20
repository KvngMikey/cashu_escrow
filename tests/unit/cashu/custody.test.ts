import { describe, expect, it } from 'vitest';

import {
  CustodyEngine,
  type BoundAmounts,
  type CustodyPolicy,
} from '../../../src/lib/cashu/custody.ts';
import type { InspectedToken } from '../../../src/lib/cashu/mint.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { CUSTOMER, OPERATOR } from '../support/keys.ts';
import {
  FakeCustodyMint,
  FakeInvoiceSource,
  MemoryCustodyStore,
} from '../support/fake-custody.ts';

const policy: CustodyPolicy = {
  releaseSafetyMarginSeconds: 50,
  returnLnOverage: true,
  operatorLnAddress: 'operator@example.com',
};

const settlementAmounts: BoundAmounts = {
  grossSats: 1_000,
  operatorFeeSats: 10,
  networkCostSats: 1,
  payoutSats: 989,
};

function inspected(): InspectedToken {
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

function setup(change: Partial<CustodyPolicy> = {}) {
  const mint = new FakeCustodyMint(inspected());
  const store = new MemoryCustodyStore();
  const invoiceSource = new FakeInvoiceSource();
  const engine = new CustodyEngine({
    mint,
    store,
    signer: createSigner(OPERATOR.nsec),
    policy: { ...policy, ...change },
    invoiceSource,
  });
  return { mint, store, engine, invoiceSource };
}

async function hold(
  engine: CustodyEngine,
  payoutType: 'cashu_p2pk' | 'bolt11' = 'cashu_p2pk',
  networkCostSats = 1
) {
  return engine.hold({
    token: 'cashu-locked',
    observedAt: 1_000,
    expectation: {
      coordinationId: 'swap-1',
      mintUrl: 'http://mint.test',
      operatorPubkey: OPERATOR.pubkey,
      providerPubkey: CUSTOMER.pubkey,
      grossSats: 1_000,
      networkCostSats,
      payoutType,
      fiatConfirmBy: 2_000,
      disputeWindowSeconds: 100,
      releaseSafetyMarginSeconds: 50,
    },
  });
}

describe('CustodyEngine', () => {
  it('holds without swapping and makes an identical hold idempotent', async () => {
    const { engine, mint } = setup();
    const first = await hold(engine);
    const second = await hold(engine);
    expect(first).toEqual(second);
    expect(first.status).toBe('held');
    expect(mint.swapCalls).toBe(0);
  });

  it('does not treat changed hold authority as an idempotent retry', async () => {
    const { engine } = setup();
    await hold(engine);
    await expect(
      engine.hold({
        token: 'cashu-locked',
        observedAt: 1_001,
        expectation: {
          coordinationId: 'swap-1',
          mintUrl: 'http://mint.test',
          operatorPubkey: OPERATOR.pubkey,
          providerPubkey: OPERATOR.pubkey,
          grossSats: 1_000,
          networkCostSats: 1,
          payoutType: 'cashu_p2pk',
          fiatConfirmBy: 2_000,
          disputeWindowSeconds: 100,
          releaseSafetyMarginSeconds: 50,
        },
      })
    ).rejects.toMatchObject({ category: 'custody_conflict' });
  });

  it('backfills legacy fingerprints before checking another token encoding', async () => {
    const { engine, mint, store, invoiceSource } = setup();
    const held = await hold(engine);
    const { tokenFingerprint: _legacyMissing, ...legacy } = held;
    store.records.set(held.coordinationId, legacy);
    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
      invoiceSource,
    });
    await expect(
      restarted.hold({
        token: 'same-proofs-different-encoding',
        observedAt: 1_001,
        expectation: {
          coordinationId: 'swap-2',
          mintUrl: 'http://mint.test',
          operatorPubkey: OPERATOR.pubkey,
          providerPubkey: CUSTOMER.pubkey,
          grossSats: 1_000,
          networkCostSats: 1,
          payoutType: 'cashu_p2pk',
          fiatConfirmBy: 2_000,
          disputeWindowSeconds: 100,
          releaseSafetyMarginSeconds: 50,
        },
      })
    ).rejects.toMatchObject({ category: 'custody_conflict' });
    expect(await store.get('swap-1')).toMatchObject({
      revision: 2,
      tokenFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('settles cashu P2PK exactly at the release boundary', async () => {
    const { engine, mint } = setup();
    await hold(engine);
    const settled = await engine.settle({
      coordinationId: 'swap-1',
      payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
      amounts: settlementAmounts,
      now: 2_100,
    });
    expect(settled).toMatchObject({
      status: 'settled',
      payoutSats: 989,
      operatorFeeSats: 10,
    });
    expect(mint.swapCalls).toBe(1);

    const repeated = await engine.settle({
      coordinationId: 'swap-1',
      payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
      amounts: settlementAmounts,
      now: 2_100,
    });
    expect(repeated).toEqual(settled);
    expect(mint.swapCalls).toBe(1);
  });

  it('serializes concurrent settlement attempts by coordination id', async () => {
    const { engine, mint } = setup();
    await hold(engine);
    const input = {
      coordinationId: 'swap-1',
      payout: {
        type: 'cashu_p2pk' as const,
        recipientPubkey: CUSTOMER.pubkey,
      },
      amounts: settlementAmounts,
      now: 2_000,
    };
    const [first, second] = await Promise.all([
      engine.settle(input),
      engine.settle(input),
    ]);
    expect(first).toEqual(second);
    expect(mint.swapCalls).toBe(1);
  });

  it('persists a recoverable P2PK intent before calling the mint', async () => {
    const { engine, mint, store } = setup();
    await hold(engine);
    mint.beforeSwap = async () => {
      expect(await store.get('swap-1')).toMatchObject({
        status: 'spending',
        spend: { kind: 'settlement_p2pk' },
      });
    };

    await engine.settle({
      coordinationId: 'swap-1',
      payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
      amounts: settlementAmounts,
      now: 2_000,
    });
  });

  it('recovers P2PK outputs after a crash before the terminal append', async () => {
    const { engine, mint, store } = setup();
    await hold(engine);
    const recovered = {
      recipientToken: 'cashu-recovered-recipient',
      recipientAmount: 989,
      changeToken: 'cashu-recovered-operator',
      changeAmount: 10,
    };
    mint.beforeSwap = () => {
      mint.p2pkRecovery = { state: 'complete', result: recovered };
      return Promise.reject(new Error('simulated process loss'));
    };
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts: settlementAmounts,
        now: 2_000,
      })
    ).rejects.toThrow(/process loss/);
    expect(await store.get('swap-1')).toMatchObject({ status: 'spending' });

    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
    });
    await restarted.reconcile(2_001);
    expect(await store.get('swap-1')).toMatchObject({
      status: 'settled',
      payoutToken: recovered.recipientToken,
      operatorToken: recovered.changeToken,
    });
    expect(mint.swapCalls).toBe(0);
  });

  it('recovers an authorized refund after a crash before append', async () => {
    const { engine, mint, store } = setup();
    await hold(engine);
    const recovered = {
      recipientToken: 'cashu-recovered-refund',
      recipientAmount: 999,
      changeAmount: 0,
    };
    mint.beforeSwap = () => {
      mint.p2pkRecovery = { state: 'complete', result: recovered };
      return Promise.reject(new Error('simulated process loss'));
    };
    await expect(
      engine.refundAuthorized({
        coordinationId: 'swap-1',
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 0,
          networkCostSats: 1,
          payoutSats: 999,
        },
        now: 2_100,
      })
    ).rejects.toThrow(/process loss/);

    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
    });
    await restarted.reconcile(2_101);
    expect(await store.get('swap-1')).toMatchObject({
      status: 'refunded',
      payoutToken: recovered.recipientToken,
    });
  });

  it('rolls an unexecuted prepared spend back to held on restart', async () => {
    const { engine, mint, store } = setup();
    await hold(engine);
    mint.beforeSwap = () => Promise.reject(new Error('simulated process loss'));
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts: settlementAmounts,
        now: 2_000,
      })
    ).rejects.toThrow(/process loss/);

    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
    });
    await restarted.reconcile(2_001);
    expect(await store.get('swap-1')).toMatchObject({ status: 'held' });
  });

  it('settles a quote with no operator fee', async () => {
    const { engine } = setup();
    await hold(engine);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 0,
          networkCostSats: 1,
          payoutSats: 999,
        },
        now: 2_100,
      })
    ).resolves.toMatchObject({ payoutSats: 999, operatorFeeSats: 0 });
  });

  it('refuses settlement one second after the margin and records the overlay', async () => {
    const { engine, store, mint } = setup();
    await hold(engine);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts: settlementAmounts,
        now: 2_101,
      })
    ).rejects.toThrow(/window/);
    expect((await store.get('swap-1'))?.overlay).toBe(
      'settlement_unfulfillable'
    );
    expect(mint.swapCalls).toBe(0);
  });

  it('records an unfulfillable late authorization without a payout target', async () => {
    const { engine, store, mint } = setup();
    await hold(engine);
    await expect(
      engine.markSettlementUnfulfillable({
        coordinationId: 'swap-1',
        now: 2_101,
      })
    ).resolves.toMatchObject({ overlay: 'settlement_unfulfillable' });
    expect((await store.get('swap-1'))?.overlay).toBe(
      'settlement_unfulfillable'
    );
    expect(mint.swapCalls).toBe(0);
  });

  it('settles bolt11 and returns unused reserve as a P2PK token', async () => {
    const { engine, mint, invoiceSource } = setup();
    mint.meltResults = [
      {
        paidAmount: 987,
        feePaid: 1,
        changeToken: 'cashu-change',
        changeAmount: 12,
      },
      {
        paidAmount: 10,
        feePaid: 1,
        changeToken: 'cashu-overage-change',
        changeAmount: 1,
      },
    ];
    await hold(engine, 'bolt11', 3);
    const settled = await engine.settle({
      coordinationId: 'swap-1',
      payout: {
        type: 'bolt11',
        invoice: 'lnbc1fake',
      },
      amounts: {
        grossSats: 1_000,
        operatorFeeSats: 10,
        networkCostSats: 3,
        payoutSats: 987,
      },
      now: 2_000,
    });
    expect(settled).toMatchObject({
      status: 'settled',
      payoutSats: 988,
      overageToken: 'cashu-overage-change',
    });
    expect(mint.meltCalls).toBe(2);
    expect(mint.swapCalls).toBe(0);
    expect(invoiceSource.calls).toEqual([
      { address: 'operator@example.com', amountSats: 10 },
    ]);
  });

  it('requires the operator fee invoice before spending the recipient melt', async () => {
    const mint = new FakeCustodyMint(inspected());
    const engine = new CustodyEngine({
      mint,
      store: new MemoryCustodyStore(),
      signer: createSigner(OPERATOR.nsec),
      policy: { ...policy, operatorLnAddress: 'operator@example.com' },
    });
    await hold(engine, 'bolt11', 2);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: {
          type: 'bolt11',
          invoice: 'lnbc1fake',
        },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 2,
          payoutSats: 988,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/invoice/);
    expect(mint.meltCalls).toBe(0);
  });

  it('rejects a recipient invoice for a different amount before spending', async () => {
    const { engine, mint } = setup();
    mint.invoiceAmounts.set('lnbc-wrong-amount', 500);
    await hold(engine, 'bolt11', 2);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: {
          type: 'bolt11',
          invoice: 'lnbc-wrong-amount',
        },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 2,
          payoutSats: 988,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/amount/);
    expect(mint.meltCalls).toBe(0);
  });

  it('validates the operator fee invoice before spending the recipient melt', async () => {
    const { engine, mint } = setup();
    mint.invoiceAmounts.set('lnbc-10', 9);
    await hold(engine, 'bolt11', 2);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: {
          type: 'bolt11',
          invoice: 'lnbc-recipient',
        },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 2,
          payoutSats: 988,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/amount/);
    expect(mint.meltCalls).toBe(0);
  });

  it('rejects an excessive recipient fee reserve before spending', async () => {
    const { engine, mint, store } = setup();
    mint.invoiceFeeReserves.set('lnbc-recipient', 2);
    await hold(engine, 'bolt11', 1);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'bolt11', invoice: 'lnbc-recipient' },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 0,
          networkCostSats: 1,
          payoutSats: 999,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/reserve/);
    expect(mint.meltCalls).toBe(0);
    expect(await store.get('swap-1')).toMatchObject({ status: 'held' });
  });

  it('preflights both Lightning fee reserves before the recipient melt', async () => {
    const { engine, mint, store } = setup();
    mint.invoiceFeeReserves.set('lnbc-recipient', 1);
    mint.invoiceFeeReserves.set('lnbc-10', 2);
    await hold(engine, 'bolt11', 2);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'bolt11', invoice: 'lnbc-recipient' },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 2,
          payoutSats: 988,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/reserve/);
    expect(mint.quoteCalls).toBe(2);
    expect(mint.meltCalls).toBe(0);
    expect(await store.get('swap-1')).toMatchObject({ status: 'held' });
  });

  it('reserves the worst-case input fee for the operator-fee change', async () => {
    const { engine, mint, store } = setup();
    mint.maxChangeInputFee = 2;
    mint.invoiceFeeReserves.set('lnbc-10', 1);
    await hold(engine, 'bolt11', 3);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'bolt11', invoice: 'lnbc-recipient' },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 3,
          payoutSats: 987,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/reserve/);
    expect(mint.meltCalls).toBe(0);
    expect(await store.get('swap-1')).toMatchObject({ status: 'held' });
  });

  it('recovers a paid Lightning melt after a crash before append', async () => {
    const { engine, mint, store } = setup();
    const recovered = {
      paidAmount: 999,
      feePaid: 1,
      changeAmount: 0,
    };
    mint.meltResult = recovered;
    mint.beforeMelt = () => {
      mint.meltRecovery = { state: 'complete', result: recovered };
      return Promise.reject(new Error('simulated process loss'));
    };
    await hold(engine, 'bolt11', 1);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'bolt11', invoice: 'lnbc-recipient' },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 0,
          networkCostSats: 1,
          payoutSats: 999,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/process loss/);

    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
    });
    await restarted.reconcile(2_001);
    expect(await store.get('swap-1')).toMatchObject({ status: 'settled' });
    expect(mint.meltCalls).toBe(0);
  });

  it('keeps a pending Lightning melt unresolved until mint recovery completes', async () => {
    const { engine, mint, store } = setup();
    mint.meltCompletion = { state: 'pending' };
    await hold(engine, 'bolt11', 1);
    const input = {
      coordinationId: 'swap-1',
      payout: { type: 'bolt11' as const, invoice: 'lnbc-recipient' },
      amounts: {
        grossSats: 1_000,
        operatorFeeSats: 0,
        networkCostSats: 1,
        payoutSats: 999,
      },
      now: 2_000,
    };

    await expect(engine.settle(input)).rejects.toMatchObject({
      category: 'mint_unavailable',
    });
    expect(await store.get('swap-1')).toMatchObject({ status: 'spending' });

    mint.meltRecovery = {
      state: 'complete',
      result: {
        paidAmount: 999,
        feePaid: 1,
        changeAmount: 0,
      },
    };
    await expect(
      engine.settle({ ...input, now: 2_101 })
    ).resolves.toMatchObject({ status: 'settled' });
  });

  it('recovers the operator-fee melt after a crash before append', async () => {
    const { engine, mint, store } = setup();
    const recipientResult = {
      paidAmount: 987,
      feePaid: 1,
      changeToken: 'cashu-change',
      changeAmount: 12,
    };
    const operatorResult = {
      paidAmount: 10,
      feePaid: 1,
      changeToken: 'cashu-overage-change',
      changeAmount: 1,
    };
    mint.meltResults = [recipientResult, operatorResult];
    let attempts = 0;
    mint.beforeMelt = () => {
      attempts += 1;
      if (attempts === 2) {
        mint.meltRecovery = { state: 'complete', result: operatorResult };
        return Promise.reject(new Error('simulated process loss'));
      }
      return Promise.resolve();
    };
    await hold(engine, 'bolt11', 3);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'bolt11', invoice: 'lnbc-recipient' },
        amounts: {
          grossSats: 1_000,
          operatorFeeSats: 10,
          networkCostSats: 3,
          payoutSats: 987,
        },
        now: 2_000,
      })
    ).rejects.toThrow(/process loss/);
    expect(await store.get('swap-1')).toMatchObject({
      status: 'spending',
      spend: { kind: 'settlement_bolt11_operator' },
    });

    const restarted = new CustodyEngine({
      mint,
      store,
      signer: createSigner(OPERATOR.nsec),
      policy,
    });
    await restarted.reconcile(2_001);
    expect(await store.get('swap-1')).toMatchObject({
      status: 'settled',
      overageToken: operatorResult.changeToken,
    });
    expect(mint.meltCalls).toBe(1);
  });

  it('freezes an impossible post-melt result instead of retrying it', async () => {
    const { engine, mint, store } = setup();
    mint.meltResult = {
      paidAmount: 997,
      feePaid: 2,
      changeToken: 'cashu-reconciliation-change',
      changeAmount: 1,
    };
    await hold(engine, 'bolt11', 3);
    const input = {
      coordinationId: 'swap-1',
      payout: { type: 'bolt11' as const, invoice: 'lnbc-recipient' },
      amounts: {
        grossSats: 1_000,
        operatorFeeSats: 0,
        networkCostSats: 3,
        payoutSats: 997,
      },
      now: 2_000,
    };
    await expect(engine.settle(input)).rejects.toMatchObject({
      category: 'mint_misbehavior',
    });
    expect(await store.get('swap-1')).toMatchObject({
      status: 'reconciliation_required',
      reconciliationTokens: ['cashu-reconciliation-change'],
    });
    await expect(engine.settle(input)).rejects.toMatchObject({
      category: 'mint_misbehavior',
    });
    expect(mint.meltCalls).toBe(1);
  });

  it.each([
    ['network_only', 0, 999],
    ['full', 10, 989],
  ] as const)('executes an authorized %s refund', async (mode, fee, payout) => {
    const { engine } = setup();
    await hold(engine);
    const refunded = await engine.refundAuthorized({
      coordinationId: 'swap-1',
      amounts: {
        grossSats: 1_000,
        operatorFeeSats: fee,
        networkCostSats: 1,
        payoutSats: payout,
      },
      now: 2_149,
    });
    expect(refunded).toMatchObject({
      status: 'refunded',
      operatorFeeSats: fee,
      payoutSats: payout,
    });
  });

  it('observes expiry without spending or marking the record refunded', async () => {
    const { engine, mint } = setup();
    await hold(engine);
    const available = await engine.observeExpiry({
      coordinationId: 'swap-1',
      now: 2_150,
    });
    expect(available).toMatchObject({
      status: 'held',
      overlay: 'expired_recovery_available',
      token: 'cashu-locked',
    });
    expect(mint.swapCalls).toBe(0);

    mint.proofStates = ['pending'];
    expect(
      await engine.observeExpiry({ coordinationId: 'swap-1', now: 2_151 })
    ).toMatchObject({ overlay: 'expired_pending_unattributed' });
    mint.proofStates = ['spent'];
    expect(
      await engine.observeExpiry({ coordinationId: 'swap-1', now: 2_152 })
    ).toMatchObject({ overlay: 'expired_spent_unattributed' });
    expect(mint.swapCalls).toBe(0);
  });

  it('rejects changed quote arithmetic before spending', async () => {
    const { engine, mint } = setup();
    await hold(engine);
    await expect(
      engine.settle({
        coordinationId: 'swap-1',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts: { ...settlementAmounts, payoutSats: 990 },
        now: 2_000,
      })
    ).rejects.toThrow(/bound quote accounting/);
    expect(mint.swapCalls).toBe(0);
  });
});
