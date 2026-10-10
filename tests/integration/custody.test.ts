import { setTimeout as delay } from 'node:timers/promises';

import { Wallet, getEncodedToken, sumProofs } from '@cashu/cashu-ts';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  CustodyEngine,
  type BoundAmounts,
  type CustodyPolicy,
} from '../../src/lib/cashu/custody.ts';
import { computeFees, type RefundFeeMode } from '../../src/lib/cashu/fees.ts';
import { CashuTsMint } from '../../src/lib/cashu/mint.ts';
import { createSigner } from '../../src/lib/pontmore/signer.ts';
import { CUSTOMER, OPERATOR } from '../unit/support/keys.ts';
import { MemoryCustodyStore } from '../unit/support/fake-custody.ts';

const MINT_URL = process.env.TEST_MINT_URL ?? 'http://127.0.0.1:3338';
const INVOICE_MINT_URL = process.env.TEST_INVOICE_MINT_URL ?? MINT_URL;
const operatorSigner = createSigner(OPERATOR.nsec);
const providerSecret = Buffer.from(CUSTOMER.secretKey).toString('hex');
let mint: CashuTsMint;

const basePolicy: CustodyPolicy = {
  feesEnabled: true,
  operatorFeeBps: 100,
  operatorMinFeeSats: 3,
  refundFeeMode: 'network_only',
  releaseSafetyMarginSeconds: 10,
  returnLnOverage: true,
  operatorLnAddress: 'operator@example.com',
};

beforeAll(async () => {
  mint = new CashuTsMint(MINT_URL);
  await mint.initialize();
});

describe('custody against Nutshell FakeWallet', () => {
  it.each([true, false])(
    'holds and settles a cashu P2PK payout with fees enabled=%s',
    async (feesEnabled) => {
      const now = unixNow();
      const funding = await mintLocked(100, now + 120);
      const policy = { ...basePolicy, feesEnabled };
      const amounts = settlementAmounts(100, funding.inputFee, policy);
      const { engine } = await heldEngine(
        `cashu-${String(feesEnabled)}`,
        funding,
        policy,
        now,
        'cashu_p2pk'
      );

      const settled = await engine.settle({
        coordinationId: `cashu-${String(feesEnabled)}`,
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts,
        now,
      });
      expect(settled.payoutSats).toBe(amounts.payoutSats);
      expect(settled.operatorFeeSats).toBe(amounts.operatorFeeSats);
      const received = await receiveP2pk(settled.payoutToken!, providerSecret);
      expect(received).toBe(
        amounts.payoutSats - tokenInputFee(settled.payoutToken!)
      );
    }
  );

  it.each([
    ['network_only', 0],
    ['full', 3],
  ] as const)(
    'executes an authorized %s refund to the provider',
    async (refundFeeMode, expectedOperatorFee) => {
      const now = unixNow();
      const funding = await mintLocked(100, now + 120);
      const policy = { ...basePolicy, refundFeeMode };
      const amounts = refundAmounts(
        100,
        funding.inputFee,
        policy,
        refundFeeMode
      );
      expect(amounts.operatorFeeSats).toBe(expectedOperatorFee);
      const id = `refund-${refundFeeMode}`;
      const { engine } = await heldEngine(
        id,
        funding,
        policy,
        now,
        'cashu_p2pk'
      );
      const refunded = await engine.refundAuthorized({
        coordinationId: id,
        amounts,
        now,
      });
      expect(refunded.status).toBe('refunded');
      expect(refunded.payoutSats).toBe(amounts.payoutSats);
      expect(await mint.states(funding.token)).toEqual(
        funding.states.map(() => 'spent')
      );
    }
  );

  it('melts a bolt11 payout and accounts for fee reserve and change', async () => {
    const now = unixNow();
    const recipient = new Wallet(INVOICE_MINT_URL, { unit: 'sat' });
    await recipient.loadMint();
    const funding = await mintLocked(100, now + 120);
    const externalInvoices = INVOICE_MINT_URL !== MINT_URL;
    const networkCost = funding.inputFee + (externalInvoices ? 5 : 1);
    const expectedPayout = 100 - 3 - networkCost;
    const invoiceQuote = await recipient.createMintQuoteBolt11(expectedPayout);
    const operatorFeeWallet = new Wallet(INVOICE_MINT_URL, { unit: 'sat' });
    await operatorFeeWallet.loadMint();
    let operatorFeeQuote:
      Awaited<ReturnType<Wallet['createMintQuoteBolt11']>> | undefined;
    const invoiceSource = {
      async createInvoice(_address: string, amountSats: number) {
        operatorFeeQuote =
          await operatorFeeWallet.createMintQuoteBolt11(amountSats);
        return operatorFeeQuote.request;
      },
    };
    const amounts = settlementAmounts(100, networkCost, basePolicy);
    expect(amounts.payoutSats).toBe(expectedPayout);
    const { engine } = await heldEngine(
      'bolt11',
      funding,
      basePolicy,
      now,
      'bolt11',
      networkCost,
      10,
      invoiceSource
    );
    const settled = await engine.settle({
      coordinationId: 'bolt11',
      payout: {
        type: 'bolt11',
        invoice: invoiceQuote.request,
      },
      amounts,
      now,
    });
    expect(settled.status).toBe('settled');
    expect(settled.operatorFeeSats).toBe(3);
    if (externalInvoices) {
      expect(settled.overageToken).toBeDefined();
      const overageWallet = new Wallet(MINT_URL, { unit: 'sat' });
      await overageWallet.loadMint();
      const overage = sumProofs(
        overageWallet.decodeToken(settled.overageToken!).proofs
      ).toNumber();
      expect(overage).toBeGreaterThan(0);
      expect(settled.payoutSats).toBe(expectedPayout + overage);
    }
    const paidProofs = await recipient.mintProofsBolt11(
      expectedPayout,
      invoiceQuote
    );
    expect(sumProofs(paidProofs).toNumber()).toBe(expectedPayout);
    expect(operatorFeeQuote).toBeDefined();
    const feeProofs = await operatorFeeWallet.mintProofsBolt11(
      3,
      operatorFeeQuote!
    );
    expect(sumProofs(feeProofs).toNumber()).toBe(3);
  });

  it('exposes the original token after expiry and records provider self-spend without attribution', async () => {
    const now = unixNow();
    const funding = await mintLocked(100, now + 2);
    const policy = { ...basePolicy, releaseSafetyMarginSeconds: 1 };
    const { engine } = await heldEngine(
      'expiry',
      funding,
      policy,
      now,
      'cashu_p2pk',
      funding.inputFee,
      1
    );
    await delay(2_500);
    const available = await engine.observeExpiry({
      coordinationId: 'expiry',
      now: unixNow(),
    });
    expect(available.overlay).toBe('expired_recovery_available');
    expect(available.status).toBe('held');
    expect(available.token).toBe(funding.token);

    await receiveP2pk(funding.token, providerSecret);
    const spent = await engine.observeExpiry({
      coordinationId: 'expiry',
      now: unixNow(),
    });
    expect(spent.overlay).toBe('expired_spent_unattributed');
    expect(spent.status).toBe('held');
  });

  it('refuses late settlement even though the mint still accepts the operator key', async () => {
    const now = unixNow();
    const funding = await mintLocked(100, now + 10);
    const policy = { ...basePolicy, releaseSafetyMarginSeconds: 8 };
    const amounts = settlementAmounts(100, funding.inputFee, policy);
    const { engine } = await heldEngine(
      'late',
      funding,
      policy,
      now,
      'cashu_p2pk',
      funding.inputFee,
      8
    );
    await delay(1_500);
    await expect(
      engine.settle({
        coordinationId: 'late',
        payout: { type: 'cashu_p2pk', recipientPubkey: CUSTOMER.pubkey },
        amounts,
        now: unixNow(),
      })
    ).rejects.toThrow(/window/);

    const mintAccepted = await mint.swapToP2pk({
      token: funding.token,
      amount: amounts.payoutSats,
      recipientPubkey: CUSTOMER.pubkey,
      signer: operatorSigner,
    });
    expect(mintAccepted.recipientAmount).toBe(amounts.payoutSats);
  });
});

async function mintLocked(gross: number, locktime: number) {
  const wallet = new Wallet(MINT_URL, { unit: 'sat' });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(gross);
  await delay(2_200);
  const proofs = await wallet.ops
    .mintBolt11(gross, quote)
    .asP2PK({
      pubkey: `02${OPERATOR.pubkey}`,
      locktime,
      refundKeys: [`02${CUSTOMER.pubkey}`],
    })
    .run();
  const token = getEncodedToken({ mint: MINT_URL, unit: 'sat', proofs });
  const inspected = mint.inspectToken(token);
  return {
    token,
    inputFee: inspected.inputFee,
    states: await mint.states(token),
    locktime,
  };
}

async function heldEngine(
  coordinationId: string,
  funding: Awaited<ReturnType<typeof mintLocked>>,
  policy: CustodyPolicy,
  now: number,
  payoutType: 'cashu_p2pk' | 'bolt11',
  networkCost = funding.inputFee,
  disputeWindowSeconds = 10,
  invoiceSource?: {
    createInvoice(address: string, amountSats: number): Promise<string>;
  }
) {
  const store = new MemoryCustodyStore();
  const engine = new CustodyEngine({
    mint,
    store,
    signer: operatorSigner,
    policy,
    ...(invoiceSource === undefined ? {} : { invoiceSource }),
  });
  await engine.hold({
    token: funding.token,
    observedAt: now,
    expectation: {
      coordinationId,
      mintUrl: MINT_URL,
      operatorPubkey: OPERATOR.pubkey,
      providerPubkey: CUSTOMER.pubkey,
      grossSats: 100,
      networkCostSats: networkCost,
      payoutType,
      fiatConfirmBy:
        funding.locktime -
        disputeWindowSeconds -
        policy.releaseSafetyMarginSeconds,
      disputeWindowSeconds,
      releaseSafetyMarginSeconds: policy.releaseSafetyMarginSeconds,
    },
  });
  return { engine, store };
}

async function receiveP2pk(token: string, privateKey: string): Promise<number> {
  const wallet = new Wallet(MINT_URL, { unit: 'sat' });
  await wallet.loadMint();
  const proofs = await wallet.ops
    .receive(token)
    .asRandom()
    .privkey(privateKey)
    .run();
  return sumProofs(proofs).toNumber();
}

function tokenInputFee(token: string): number {
  return mint.inspectToken(token).inputFee;
}

function settlementAmounts(
  gross: number,
  networkCost: number,
  policy: CustodyPolicy
): BoundAmounts {
  const fees = computeFees({
    gross,
    bps: policy.operatorFeeBps,
    minFee: policy.operatorMinFeeSats,
    enabled: policy.feesEnabled,
    networkCost,
    operation: 'settlement',
    refundFeeMode: policy.refundFeeMode,
  });
  return {
    grossSats: fees.gross,
    operatorFeeSats: fees.operatorFee,
    networkCostSats: fees.networkCost,
    payoutSats: fees.payout,
  };
}

function refundAmounts(
  gross: number,
  networkCost: number,
  policy: CustodyPolicy,
  refundFeeMode: RefundFeeMode
): BoundAmounts {
  const fees = computeFees({
    gross,
    bps: policy.operatorFeeBps,
    minFee: policy.operatorMinFeeSats,
    enabled: policy.feesEnabled,
    networkCost,
    operation: 'refund',
    refundFeeMode,
  });
  return {
    grossSats: fees.gross,
    operatorFeeSats: fees.operatorFee,
    networkCostSats: fees.networkCost,
    payoutSats: fees.payout,
  };
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}
