import { EscrowError } from '../errors.ts';
import type { EventSigner } from '../pontmore/signer.ts';
import type { CustodyRecord, CustodyStore } from '../store/store.ts';
import type { LightningInvoiceSource } from '../lightning/invoice.ts';
import { computeFees, type RefundFeeMode } from './fees.ts';
import { verifyLockedToken, type LockExpectation } from './lock.ts';
import type { CustodyMint, MintProofState } from './mint.ts';

export type CustodyPolicy = {
  feesEnabled: boolean;
  operatorFeeBps: number;
  operatorMinFeeSats: number;
  refundFeeMode: RefundFeeMode;
  releaseSafetyMarginSeconds: number;
  returnLnOverage: boolean;
  operatorLnAddress: string;
};

export type BoundAmounts = {
  grossSats: number;
  operatorFeeSats: number;
  networkCostSats: number;
  payoutSats: number;
};

export type CashuPayout = {
  type: 'cashu_p2pk';
  recipientPubkey: string;
};

export type Bolt11Payout = {
  type: 'bolt11';
  invoice: string;
};

export type SettlementPayout = CashuPayout | Bolt11Payout;

export type HoldRequest = {
  token: string;
  expectation: LockExpectation;
  observedAt: number;
};

export class CustodyEngine {
  readonly #mint: CustodyMint;
  readonly #store: CustodyStore;
  readonly #signer: EventSigner;
  readonly #policy: CustodyPolicy;
  readonly #invoiceSource: LightningInvoiceSource | undefined;
  readonly #queues = new Map<string, Promise<void>>();
  #holdTail: Promise<void> = Promise.resolve();

  constructor(input: {
    mint: CustodyMint;
    store: CustodyStore;
    signer: EventSigner;
    policy: CustodyPolicy;
    invoiceSource?: LightningInvoiceSource;
  }) {
    this.#mint = input.mint;
    this.#store = input.store;
    this.#signer = input.signer;
    this.#policy = input.policy;
    this.#invoiceSource = input.invoiceSource;
  }

  async hold(request: HoldRequest): Promise<CustodyRecord> {
    const previous = this.#holdTail;
    let release = (): void => undefined;
    this.#holdTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.#exclusive(request.expectation.coordinationId, () =>
        this.#hold(request)
      );
    } finally {
      release();
    }
  }

  async #hold(request: HoldRequest): Promise<CustodyRecord> {
    const existing = await this.#store.get(request.expectation.coordinationId);
    if (existing !== undefined) {
      if (
        existing.token === request.token &&
        existing.providerPubkey === request.expectation.providerPubkey &&
        existing.grossSats === request.expectation.grossSats &&
        existing.networkCostSats === request.expectation.networkCostSats
      ) {
        return existing;
      }
      conflict(
        request.expectation.coordinationId,
        'different token already held'
      );
    }

    const verified = await verifyLockedToken(
      request.token,
      request.expectation,
      this.#mint
    );
    const duplicate = (await this.#store.all()).find(
      (record) =>
        record.coordinationId !== request.expectation.coordinationId &&
        (record.token === request.token ||
          record.tokenFingerprint === verified.tokenFingerprint)
    );
    if (duplicate !== undefined) {
      conflict(
        request.expectation.coordinationId,
        'custody token is already bound to another coordination'
      );
    }
    const record: CustodyRecord = {
      coordinationId: request.expectation.coordinationId,
      revision: 1,
      status: 'held',
      token: verified.token,
      mintUrl: verified.mintUrl,
      providerPubkey: request.expectation.providerPubkey,
      grossSats: verified.grossSats,
      inputFeeSats: verified.inputFeeSats,
      proofCount: verified.proofCount,
      tokenFingerprint: verified.tokenFingerprint,
      networkCostSats: request.expectation.networkCostSats,
      locktime: verified.locktime,
      observedAt: request.observedAt,
    };
    await this.#store.append(record);
    return record;
  }

  async settle(input: {
    coordinationId: string;
    payout: SettlementPayout;
    amounts: BoundAmounts;
    now: number;
  }): Promise<CustodyRecord> {
    return this.#exclusive(input.coordinationId, () => this.#settle(input));
  }

  async #settle(input: {
    coordinationId: string;
    payout: SettlementPayout;
    amounts: BoundAmounts;
    now: number;
  }): Promise<CustodyRecord> {
    const record = await this.#requireRecord(input.coordinationId);
    if (record.status === 'settled') return record;
    if (record.status !== 'held') {
      conflict(input.coordinationId, 'custody is already refunded');
    }
    if (record.overlay === 'settlement_unfulfillable') {
      custodyInvalid(
        input.coordinationId,
        'settlement release window has closed'
      );
    }
    if (input.now > record.locktime - this.#policy.releaseSafetyMarginSeconds) {
      const overlaid = nextRecord(record, input.now, {
        overlay: 'settlement_unfulfillable',
      });
      await this.#store.append(overlaid);
      throw new EscrowError(
        'custody_invalid',
        'settlement release window has closed',
        { swapId: input.coordinationId }
      );
    }
    await this.#requireUnspent(record);
    const fees = this.#settlementFees(record, input.amounts);

    if (input.payout.type === 'cashu_p2pk') {
      const result = await this.#mint.swapToP2pk({
        token: record.token,
        amount: fees.payout,
        recipientPubkey: input.payout.recipientPubkey,
        signer: this.#signer,
      });
      if (
        result.recipientAmount !== fees.payout ||
        result.changeAmount !== fees.operatorFee
      ) {
        custodyInvalid(input.coordinationId, 'mint swap accounting is invalid');
      }
      const settled = nextRecord(record, input.now, {
        status: 'settled',
        operatorFeeSats: fees.operatorFee,
        payoutSats: fees.payout,
        payoutToken: result.recipientToken,
        ...(result.changeToken === undefined
          ? {}
          : { operatorToken: result.changeToken }),
      });
      await this.#store.append(settled);
      return settled;
    }

    const feeInvoice =
      fees.operatorFee === 0
        ? undefined
        : await this.#requireOperatorFeeInvoice(
            input.coordinationId,
            fees.operatorFee
          );
    await this.#mint.validateBolt11Amount(input.payout.invoice, fees.payout);
    if (feeInvoice !== undefined) {
      await this.#mint.validateBolt11Amount(feeInvoice, fees.operatorFee);
    }
    const melted = await this.#mint.meltBolt11({
      token: record.token,
      invoice: input.payout.invoice,
      expectedAmount: fees.payout,
      signer: this.#signer,
    });
    if (
      melted.paidAmount !== fees.payout ||
      melted.feePaid < 0 ||
      melted.feePaid > fees.networkCost
    ) {
      custodyInvalid(
        input.coordinationId,
        'Lightning melt accounting is invalid'
      );
    }
    let networkSpent = melted.feePaid;
    const initialOverage = fees.networkCost - networkSpent;
    const expectedChange = fees.operatorFee + initialOverage;
    if (melted.changeAmount !== expectedChange) {
      custodyInvalid(
        input.coordinationId,
        'Lightning change accounting is invalid'
      );
    }

    let changeToken = melted.changeToken;
    let changeAmount = melted.changeAmount;
    if (fees.operatorFee > 0) {
      if (changeToken === undefined || feeInvoice === undefined) {
        custodyInvalid(
          input.coordinationId,
          'operator fee token is unavailable'
        );
      }
      const feeMelt = await this.#mint.meltBolt11({
        token: changeToken,
        invoice: feeInvoice,
        expectedAmount: fees.operatorFee,
        signer: this.#signer,
      });
      if (feeMelt.paidAmount !== fees.operatorFee) {
        custodyInvalid(
          input.coordinationId,
          'operator fee melt amount is invalid'
        );
      }
      if (feeMelt.feePaid < 0) {
        custodyInvalid(
          input.coordinationId,
          'operator fee melt accounting is invalid'
        );
      }
      networkSpent += feeMelt.feePaid;
      changeToken = feeMelt.changeToken;
      changeAmount = feeMelt.changeAmount;
    }

    if (networkSpent > fees.networkCost) {
      custodyInvalid(
        input.coordinationId,
        'Lightning network budget was exceeded'
      );
    }
    const overage = fees.networkCost - networkSpent;
    if (changeAmount > 0 && changeToken === undefined) {
      custodyInvalid(input.coordinationId, 'Lightning change token is missing');
    }
    if (changeAmount !== overage) {
      custodyInvalid(input.coordinationId, 'Lightning final change is invalid');
    }

    let operatorToken = changeToken;
    let overageToken: string | undefined;
    if (this.#policy.returnLnOverage && overage > 0) {
      if (changeToken === undefined) {
        custodyInvalid(
          input.coordinationId,
          'Lightning overage token is missing'
        );
      }
      overageToken = changeToken;
      operatorToken = undefined;
    }

    const settled = nextRecord(record, input.now, {
      status: 'settled',
      operatorFeeSats: fees.operatorFee,
      payoutSats: fees.payout + (this.#policy.returnLnOverage ? overage : 0),
      ...(operatorToken === undefined ? {} : { operatorToken }),
      ...(overageToken === undefined ? {} : { overageToken }),
    });
    await this.#store.append(settled);
    return settled;
  }

  async refundAuthorized(input: {
    coordinationId: string;
    amounts: BoundAmounts;
    now: number;
  }): Promise<CustodyRecord> {
    return this.#exclusive(input.coordinationId, () =>
      this.#refundAuthorized(input)
    );
  }

  async #refundAuthorized(input: {
    coordinationId: string;
    amounts: BoundAmounts;
    now: number;
  }): Promise<CustodyRecord> {
    const record = await this.#requireRecord(input.coordinationId);
    if (record.status === 'refunded') return record;
    if (record.status !== 'held') {
      conflict(input.coordinationId, 'custody is already settled');
    }
    if (input.now >= record.locktime) {
      custodyInvalid(
        input.coordinationId,
        'authorized refund must use expiry recovery'
      );
    }
    await this.#requireUnspent(record);
    const fees = computeFees({
      gross: record.grossSats,
      bps: this.#policy.operatorFeeBps,
      minFee: this.#policy.operatorMinFeeSats,
      enabled: this.#policy.feesEnabled,
      networkCost: record.inputFeeSats,
      operation: 'refund',
      refundFeeMode: this.#policy.refundFeeMode,
    });
    assertBoundAmounts(input.coordinationId, input.amounts, fees);
    const result = await this.#mint.swapToP2pk({
      token: record.token,
      amount: fees.payout,
      recipientPubkey: record.providerPubkey,
      signer: this.#signer,
    });
    if (
      result.recipientAmount !== fees.payout ||
      result.changeAmount !== fees.operatorFee
    ) {
      custodyInvalid(input.coordinationId, 'refund accounting is invalid');
    }
    const refunded = nextRecord(record, input.now, {
      status: 'refunded',
      operatorFeeSats: fees.operatorFee,
      payoutSats: fees.payout,
      payoutToken: result.recipientToken,
      ...(result.changeToken === undefined
        ? {}
        : { operatorToken: result.changeToken }),
    });
    await this.#store.append(refunded);
    return refunded;
  }

  async observeExpiry(input: {
    coordinationId: string;
    now: number;
  }): Promise<CustodyRecord> {
    return this.#exclusive(input.coordinationId, () =>
      this.#observeExpiry(input)
    );
  }

  async markSettlementUnfulfillable(input: {
    coordinationId: string;
    now: number;
  }): Promise<CustodyRecord> {
    return this.#exclusive(input.coordinationId, async () => {
      const record = await this.#requireRecord(input.coordinationId);
      if (record.status !== 'held') {
        conflict(input.coordinationId, 'terminal custody cannot be overlaid');
      }
      if (
        input.now <=
        record.locktime - this.#policy.releaseSafetyMarginSeconds
      ) {
        custodyInvalid(
          input.coordinationId,
          'settlement release window remains open'
        );
      }
      if (record.overlay === 'settlement_unfulfillable') return record;
      const overlaid = nextRecord(record, input.now, {
        overlay: 'settlement_unfulfillable',
      });
      await this.#store.append(overlaid);
      return overlaid;
    });
  }

  async #observeExpiry(input: {
    coordinationId: string;
    now: number;
  }): Promise<CustodyRecord> {
    const record = await this.#requireRecord(input.coordinationId);
    if (record.status !== 'held') {
      conflict(input.coordinationId, 'terminal custody cannot expire');
    }
    if (input.now < record.locktime) {
      custodyInvalid(input.coordinationId, 'locktime has not passed');
    }
    const states = await this.#mint.states(record.token);
    const overlay = expiryOverlay(states, record.proofCount);
    if (record.overlay === overlay) return record;
    const observed = nextRecord(record, input.now, { overlay });
    await this.#store.append(observed);
    return observed;
  }

  async #requireRecord(coordinationId: string): Promise<CustodyRecord> {
    const record = await this.#store.get(coordinationId);
    if (record === undefined)
      conflict(coordinationId, 'custody record not found');
    return record;
  }

  async #requireUnspent(record: CustodyRecord): Promise<void> {
    const states = await this.#mint.states(record.token);
    if (
      states.length !== record.proofCount ||
      states.some((state) => state !== 'unspent')
    ) {
      custodyInvalid(record.coordinationId, 'custody proofs are not unspent');
    }
  }

  #settlementFees(record: CustodyRecord, amounts: BoundAmounts) {
    const fees = computeFees({
      gross: record.grossSats,
      bps: this.#policy.operatorFeeBps,
      minFee: this.#policy.operatorMinFeeSats,
      enabled: this.#policy.feesEnabled,
      networkCost: record.networkCostSats,
      operation: 'settlement',
      refundFeeMode: this.#policy.refundFeeMode,
    });
    assertBoundAmounts(record.coordinationId, amounts, fees);
    return fees;
  }

  async #requireOperatorFeeInvoice(
    coordinationId: string,
    amountSats: number
  ): Promise<string> {
    if (this.#invoiceSource === undefined) {
      custodyInvalid(coordinationId, 'operator fee invoice is unavailable');
    }
    return this.#invoiceSource.createInvoice(
      this.#policy.operatorLnAddress,
      amountSats
    );
  }

  async #exclusive<T>(
    coordinationId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.#queues.get(coordinationId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#queues.set(coordinationId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#queues.get(coordinationId) === tail) {
        this.#queues.delete(coordinationId);
      }
    }
  }
}

function nextRecord(
  record: CustodyRecord,
  observedAt: number,
  change: Partial<CustodyRecord>
): CustodyRecord {
  return {
    ...record,
    ...change,
    revision: record.revision + 1,
    observedAt,
  };
}

function assertBoundAmounts(
  coordinationId: string,
  bound: BoundAmounts,
  computed: {
    gross: number;
    operatorFee: number;
    networkCost: number;
    payout: number;
  }
): void {
  if (
    bound.grossSats !== computed.gross ||
    bound.operatorFeeSats !== computed.operatorFee ||
    bound.networkCostSats !== computed.networkCost ||
    bound.payoutSats !== computed.payout
  ) {
    custodyInvalid(
      coordinationId,
      'bound quote accounting does not match policy'
    );
  }
}

function expiryOverlay(
  states: readonly MintProofState[],
  expectedCount: number
) {
  if (states.length !== expectedCount) {
    throw new EscrowError('custody_invalid', 'mint returned no proof states');
  }
  if (states.every((state) => state === 'unspent')) {
    return 'expired_recovery_available' as const;
  }
  if (states.some((state) => state === 'pending')) {
    return 'expired_pending_unattributed' as const;
  }
  return 'expired_spent_unattributed' as const;
}

function conflict(coordinationId: string, message: string): never {
  throw new EscrowError('custody_conflict', message, {
    swapId: coordinationId,
  });
}

function custodyInvalid(coordinationId: string, message: string): never {
  throw new EscrowError('custody_invalid', message, {
    swapId: coordinationId,
  });
}
