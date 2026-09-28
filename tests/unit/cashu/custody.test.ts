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
  feesEnabled: true,
  operatorFeeBps: 100,
  operatorMinFeeSats: 3,
  refundFeeMode: 'network_only',
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

  it('settles cashu with fees disabled', async () => {
    const { engine } = setup({ feesEnabled: false });
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

  it.each([
    ['network_only', 0, 999],
    ['full', 10, 989],
  ] as const)('executes an authorized %s refund', async (mode, fee, payout) => {
    const { engine } = setup({ refundFeeMode: mode });
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
