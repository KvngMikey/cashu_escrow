import { EscrowError } from '../errors.ts';
import type { EventSigner } from '../pontmore/signer.ts';
import type {
  CustodyRecord,
  CustodyStore,
  PendingCustodySpend,
} from '../store/store.ts';
import type { LightningInvoiceSource } from '../lightning/invoice.ts';
import {
  fingerprintProofSecrets,
  verifyLockedToken,
  type LockExpectation,
} from './lock.ts';
import type {
  CustodyMint,
  MeltResult,
  MintProofState,
  SpendRecovery,
  TokenSpendResult,
} from './mint.ts';

export type CustodyPolicy = {
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
  readonly #tokenBindings = new Map<string, string>();
  readonly #fingerprintBindings = new Map<string, string>();
  #custodyIndexReady = false;
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

  async reconcile(now: number): Promise<void> {
    const records = await this.#store.all();
    await this.#ensureCustodyIndex(records);
    const spending = records.filter((record) => record.status === 'spending');
    let firstError: Error | undefined;
    for (const record of spending) {
      try {
        await this.#exclusive(record.coordinationId, async () => {
          const current = await this.#requireRecord(record.coordinationId);
          if (current.status === 'spending') {
            await this.#recoverSpending(current, now, false);
          }
        });
      } catch (error) {
        firstError ??=
          error instanceof Error
            ? error
            : new EscrowError(
                'storage_unavailable',
                'custody reconciliation failed'
              );
      }
    }
    if (firstError !== undefined) throw firstError;
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
    await this.#ensureCustodyIndex();
    const duplicateId =
      this.#tokenBindings.get(request.token) ??
      this.#fingerprintBindings.get(verified.tokenFingerprint);
    if (
      duplicateId !== undefined &&
      duplicateId !== request.expectation.coordinationId
    ) {
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
    this.#indexRecord(record);
    return record;
  }

  async #ensureCustodyIndex(
    initialRecords?: readonly CustodyRecord[]
  ): Promise<void> {
    if (this.#custodyIndexReady) return;
    const records = await this.#backfillFingerprints(
      initialRecords ?? (await this.#store.all())
    );
    this.#tokenBindings.clear();
    this.#fingerprintBindings.clear();
    for (const record of records) this.#indexRecord(record);
    this.#custodyIndexReady = true;
  }

  #indexRecord(record: CustodyRecord): void {
    this.#tokenBindings.set(record.token, record.coordinationId);
    if (record.tokenFingerprint !== undefined) {
      this.#fingerprintBindings.set(
        record.tokenFingerprint,
        record.coordinationId
      );
    }
  }

  async #backfillFingerprints(
    records: readonly CustodyRecord[]
  ): Promise<readonly CustodyRecord[]> {
    const migrated: CustodyRecord[] = [];
    for (const record of records) {
      if (record.tokenFingerprint !== undefined) {
        migrated.push(record);
        continue;
      }
      const inspected = this.#mint.inspectToken(record.token);
      const next: CustodyRecord = {
        ...record,
        revision: record.revision + 1,
        tokenFingerprint: fingerprintProofSecrets(
          inspected.proofs.map((proof) => proof.secret)
        ),
      };
      await this.#store.append(next);
      migrated.push(next);
    }
    return migrated;
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
    let record = await this.#requireRecord(input.coordinationId);
    if (record.status === 'settled') return record;
    if (record.status === 'reconciliation_required') {
      mintMisbehavior(input.coordinationId, 'custody requires reconciliation');
    }
    if (record.status === 'spending') {
      record = await this.#recoverSpending(record, input.now, true);
      if (record.status === 'settled') return record;
      if (record.status === 'spending') {
        throw new EscrowError(
          'mint_unavailable',
          'custody spend is pending at the mint',
          { swapId: input.coordinationId }
        );
      }
    }
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
      const prepared = await this.#mint.prepareP2pkSpend({
        token: record.token,
        amount: fees.payout,
        recipientPubkey: input.payout.recipientPubkey,
        signer: this.#signer,
      });
      const spending = nextRecord(record, input.now, {
        status: 'spending',
        spend: {
          kind: 'settlement_p2pk',
          prepared,
          operatorFeeSats: fees.operatorFee,
          payoutSats: fees.payout,
        },
      });
      await this.#store.append(spending);
      const result = await this.#mint.completeP2pkSpend(prepared);
      return this.#finishP2pkSpend(spending, result, input.now);
    }

    const feeInvoice =
      fees.operatorFee === 0
        ? undefined
        : await this.#requireOperatorFeeInvoice(
            input.coordinationId,
            fees.operatorFee
          );
    const recipientQuote = await this.#mint.createBolt11MeltQuote({
      invoice: input.payout.invoice,
      expectedAmount: fees.payout,
      maxFee: fees.networkCost - record.inputFeeSats,
    });
    const prepared = await this.#mint.prepareMelt({
      token: record.token,
      quote: recipientQuote,
      signer: this.#signer,
    });
    if (prepared.inputFee !== record.inputFeeSats) {
      custodyInvalid(
        input.coordinationId,
        'mint input fee changed after funding verification'
      );
    }
    const operatorFeeBudget =
      fees.networkCost -
      prepared.inputFee -
      recipientQuote.feeReserve -
      (fees.operatorFee === 0 ? 0 : prepared.maxChangeInputFee);
    if (operatorFeeBudget < 0) {
      custodyInvalid(
        input.coordinationId,
        'Lightning fee reserves exceed the bound network budget'
      );
    }
    const operatorFeeQuote =
      feeInvoice === undefined
        ? undefined
        : await this.#mint.createBolt11MeltQuote({
            invoice: feeInvoice,
            expectedAmount: fees.operatorFee,
            maxFee: operatorFeeBudget,
          });
    const spending = nextRecord(record, input.now, {
      status: 'spending',
      spend: {
        kind: 'settlement_bolt11_recipient',
        prepared,
        ...(operatorFeeQuote === undefined ? {} : { operatorFeeQuote }),
        ...(feeInvoice === undefined ? {} : { operatorFeeInvoice: feeInvoice }),
        operatorFeeSats: fees.operatorFee,
        payoutSats: fees.payout,
        networkBudgetSats: fees.networkCost,
        returnOverage: this.#policy.returnLnOverage,
      },
    });
    await this.#store.append(spending);
    const outcome = await this.#mint.completeMelt(prepared);
    return this.#finishMeltOutcome(spending, outcome, input.now, true);
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
    let record = await this.#requireRecord(input.coordinationId);
    if (record.status === 'refunded') return record;
    if (record.status === 'reconciliation_required') {
      mintMisbehavior(input.coordinationId, 'custody requires reconciliation');
    }
    if (record.status === 'spending') {
      record = await this.#recoverSpending(record, input.now, true);
      if (record.status === 'refunded') return record;
      if (record.status === 'spending') {
        throw new EscrowError(
          'mint_unavailable',
          'custody spend is pending at the mint',
          { swapId: input.coordinationId }
        );
      }
    }
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
    const fees = boundAmounts(
      input.coordinationId,
      input.amounts,
      record.grossSats,
      record.inputFeeSats
    );
    const prepared = await this.#mint.prepareP2pkSpend({
      token: record.token,
      amount: fees.payout,
      recipientPubkey: record.providerPubkey,
      signer: this.#signer,
    });
    const spending = nextRecord(record, input.now, {
      status: 'spending',
      spend: {
        kind: 'refund_p2pk',
        prepared,
        operatorFeeSats: fees.operatorFee,
        payoutSats: fees.payout,
      },
    });
    await this.#store.append(spending);
    const result = await this.#mint.completeP2pkSpend(prepared);
    return this.#finishP2pkSpend(spending, result, input.now);
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

  async #recoverSpending(
    record: CustodyRecord,
    now: number,
    executeOperatorMelt: boolean
  ): Promise<CustodyRecord> {
    const spend = requirePendingSpend(record);
    if (spend.kind === 'settlement_p2pk' || spend.kind === 'refund_p2pk') {
      const outcome = await this.#mint.recoverP2pkSpend(spend.prepared);
      if (outcome.state === 'complete') {
        return this.#finishP2pkSpend(record, outcome.result, now);
      }
      if (outcome.state === 'inconsistent' || outcome.state === 'spent') {
        return this.#freezeForReconciliation(
          record,
          now,
          'mint swap recovery is inconsistent',
          outcome.state === 'inconsistent' ? outcome.tokens : undefined
        );
      }
      if (outcome.state === 'unspent') {
        const held = cleanNextRecord(record, now, { status: 'held' });
        await this.#store.append(held);
        return held;
      }
      return record;
    }

    if (
      spend.kind !== 'settlement_bolt11_recipient' &&
      spend.kind !== 'settlement_bolt11_operator'
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'Lightning melt intent is invalid'
      );
    }
    const outcome = await this.#mint.recoverMelt(spend.prepared);
    if (outcome.state === 'complete') {
      return this.#finishMeltOutcome(record, outcome, now, executeOperatorMelt);
    }
    if (outcome.state === 'inconsistent' || outcome.state === 'spent') {
      return this.#freezeForReconciliation(
        record,
        now,
        'Lightning melt recovery is inconsistent',
        outcome.state === 'inconsistent' ? outcome.tokens : undefined
      );
    }
    if (
      outcome.state === 'unspent' &&
      spend.kind === 'settlement_bolt11_recipient'
    ) {
      const held = cleanNextRecord(record, now, { status: 'held' });
      await this.#store.append(held);
      return held;
    }
    if (
      outcome.state === 'unspent' &&
      executeOperatorMelt &&
      spend.kind === 'settlement_bolt11_operator'
    ) {
      const current = await this.#refreshOperatorMelt(record, spend, now);
      const currentSpend = requirePendingSpend(current);
      if (currentSpend.kind !== 'settlement_bolt11_operator') {
        return this.#freezeForReconciliation(
          current,
          now,
          'operator fee melt intent is invalid'
        );
      }
      const completed = await this.#mint.completeMelt(currentSpend.prepared);
      return this.#finishMeltOutcome(current, completed, now, true);
    }
    return record;
  }

  async #finishP2pkSpend(
    record: CustodyRecord,
    result: TokenSpendResult,
    now: number
  ): Promise<CustodyRecord> {
    const spend = requirePendingSpend(record);
    if (spend.kind !== 'settlement_p2pk' && spend.kind !== 'refund_p2pk') {
      return this.#freezeForReconciliation(
        record,
        now,
        'mint swap intent is invalid'
      );
    }
    if (
      result.recipientAmount !== spend.payoutSats ||
      result.changeAmount !== spend.operatorFeeSats
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'mint swap accounting is invalid',
        [
          result.recipientToken,
          ...(result.changeToken === undefined ? [] : [result.changeToken]),
        ]
      );
    }
    const terminal = cleanNextRecord(record, now, {
      status: spend.kind === 'refund_p2pk' ? 'refunded' : 'settled',
      operatorFeeSats: spend.operatorFeeSats,
      payoutSats: spend.payoutSats,
      payoutToken: result.recipientToken,
      ...(result.changeToken === undefined
        ? {}
        : { operatorToken: result.changeToken }),
    });
    await this.#store.append(terminal);
    return terminal;
  }

  async #finishMeltOutcome(
    record: CustodyRecord,
    outcome: SpendRecovery<MeltResult>,
    now: number,
    executeOperatorMelt: boolean
  ): Promise<CustodyRecord> {
    if (outcome.state !== 'complete') {
      if (outcome.state === 'inconsistent' || outcome.state === 'spent') {
        return this.#freezeForReconciliation(
          record,
          now,
          'Lightning melt result is inconsistent',
          outcome.state === 'inconsistent' ? outcome.tokens : undefined
        );
      }
      throw new EscrowError(
        'mint_unavailable',
        'custody spend is pending at the mint',
        { swapId: record.coordinationId }
      );
    }
    const spend = requirePendingSpend(record);
    return spend.kind === 'settlement_bolt11_recipient'
      ? this.#finishRecipientMelt(
          record,
          spend,
          outcome.result,
          now,
          executeOperatorMelt
        )
      : this.#finishOperatorMelt(record, spend, outcome.result, now);
  }

  async #finishRecipientMelt(
    record: CustodyRecord,
    spend: Extract<
      PendingCustodySpend,
      { kind: 'settlement_bolt11_recipient' }
    >,
    result: MeltResult,
    now: number,
    executeOperatorMelt: boolean
  ): Promise<CustodyRecord> {
    const expectedChange =
      spend.operatorFeeSats + spend.networkBudgetSats - result.feePaid;
    if (
      result.paidAmount !== spend.payoutSats ||
      result.feePaid < spend.prepared.inputFee ||
      result.feePaid >
        spend.prepared.inputFee + spend.prepared.quote.feeReserve ||
      result.feePaid > spend.networkBudgetSats ||
      result.changeAmount !== expectedChange ||
      (result.changeAmount > 0 && result.changeToken === undefined)
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'Lightning recipient melt accounting is invalid',
        result.changeToken === undefined ? [] : [result.changeToken]
      );
    }

    if (spend.operatorFeeSats === 0) {
      return this.#finishLightningSettlement(
        record,
        spend.operatorFeeSats,
        spend.payoutSats,
        spend.networkBudgetSats,
        result.feePaid,
        result.changeAmount,
        result.changeToken,
        spend.returnOverage,
        now
      );
    }
    if (
      result.changeToken === undefined ||
      spend.operatorFeeQuote === undefined ||
      spend.operatorFeeInvoice === undefined
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'operator fee melt material is unavailable'
      );
    }
    let quote = spend.operatorFeeQuote;
    if (quoteExpired(quote, now)) {
      try {
        quote = await this.#mint.createBolt11MeltQuote({
          invoice: spend.operatorFeeInvoice,
          expectedAmount: spend.operatorFeeSats,
          maxFee: spend.networkBudgetSats - result.feePaid,
        });
      } catch (error) {
        if (
          error instanceof EscrowError &&
          error.category === 'custody_invalid'
        ) {
          return this.#freezeForReconciliation(
            record,
            now,
            'replacement operator fee quote exceeds the remaining network budget',
            [result.changeToken]
          );
        }
        throw error;
      }
    }
    const prepared = await this.#mint.prepareMelt({
      token: result.changeToken,
      quote,
      signer: this.#signer,
    });
    if (
      prepared.inputFee + prepared.quote.feeReserve >
      spend.networkBudgetSats - result.feePaid
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'operator fee melt exceeds the remaining network budget',
        [result.changeToken]
      );
    }
    const operatorSpend = nextRecord(record, now, {
      status: 'spending',
      spend: {
        kind: 'settlement_bolt11_operator',
        prepared,
        sourceToken: result.changeToken,
        operatorFeeInvoice: spend.operatorFeeInvoice,
        operatorFeeSats: spend.operatorFeeSats,
        payoutSats: spend.payoutSats,
        networkBudgetSats: spend.networkBudgetSats,
        networkSpentSats: result.feePaid,
        returnOverage: spend.returnOverage,
      },
    });
    await this.#store.append(operatorSpend);
    if (!executeOperatorMelt) return operatorSpend;
    const feeOutcome = await this.#mint.completeMelt(prepared);
    return this.#finishMeltOutcome(operatorSpend, feeOutcome, now, true);
  }

  async #refreshOperatorMelt(
    record: CustodyRecord,
    spend: Extract<PendingCustodySpend, { kind: 'settlement_bolt11_operator' }>,
    now: number
  ): Promise<CustodyRecord> {
    if (!quoteExpired(spend.prepared.quote, now)) return record;
    let quote;
    try {
      quote = await this.#mint.createBolt11MeltQuote({
        invoice: spend.operatorFeeInvoice,
        expectedAmount: spend.operatorFeeSats,
        maxFee:
          spend.networkBudgetSats -
          spend.networkSpentSats -
          spend.prepared.inputFee,
      });
    } catch (error) {
      if (
        error instanceof EscrowError &&
        error.category === 'custody_invalid'
      ) {
        return this.#freezeForReconciliation(
          record,
          now,
          'replacement operator fee quote exceeds the remaining network budget',
          [spend.sourceToken]
        );
      }
      throw error;
    }
    const prepared = await this.#mint.prepareMelt({
      token: spend.sourceToken,
      quote,
      signer: this.#signer,
    });
    if (
      prepared.inputFee + quote.feeReserve >
      spend.networkBudgetSats - spend.networkSpentSats
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'replacement operator fee quote exceeds the remaining network budget',
        [spend.sourceToken]
      );
    }
    const refreshed = nextRecord(record, now, {
      status: 'spending',
      spend: { ...spend, prepared },
    });
    await this.#store.append(refreshed);
    return refreshed;
  }

  async #finishOperatorMelt(
    record: CustodyRecord,
    spend: PendingCustodySpend,
    result: MeltResult,
    now: number
  ): Promise<CustodyRecord> {
    if (spend.kind !== 'settlement_bolt11_operator') {
      return this.#freezeForReconciliation(
        record,
        now,
        'operator fee melt intent is invalid'
      );
    }
    const networkSpent = spend.networkSpentSats + result.feePaid;
    const overage = spend.networkBudgetSats - networkSpent;
    if (
      result.paidAmount !== spend.operatorFeeSats ||
      result.feePaid < spend.prepared.inputFee ||
      result.feePaid >
        spend.prepared.inputFee + spend.prepared.quote.feeReserve ||
      networkSpent > spend.networkBudgetSats ||
      result.changeAmount !== overage ||
      (result.changeAmount > 0 && result.changeToken === undefined)
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'Lightning operator melt accounting is invalid',
        result.changeToken === undefined ? [] : [result.changeToken]
      );
    }
    return this.#finishLightningSettlement(
      record,
      spend.operatorFeeSats,
      spend.payoutSats,
      spend.networkBudgetSats,
      networkSpent,
      result.changeAmount,
      result.changeToken,
      spend.returnOverage,
      now
    );
  }

  async #finishLightningSettlement(
    record: CustodyRecord,
    operatorFeeSats: number,
    payoutSats: number,
    networkBudgetSats: number,
    networkSpentSats: number,
    changeAmount: number,
    changeToken: string | undefined,
    returnOverage: boolean,
    now: number
  ): Promise<CustodyRecord> {
    const overage = networkBudgetSats - networkSpentSats;
    if (
      overage < 0 ||
      changeAmount !== overage ||
      (overage > 0 && changeToken === undefined)
    ) {
      return this.#freezeForReconciliation(
        record,
        now,
        'Lightning final change is invalid',
        changeToken === undefined ? [] : [changeToken]
      );
    }
    const settled = cleanNextRecord(record, now, {
      status: 'settled',
      operatorFeeSats,
      payoutSats: payoutSats + (returnOverage ? overage : 0),
      ...(!returnOverage && changeToken !== undefined
        ? { operatorToken: changeToken }
        : {}),
      ...(returnOverage && changeToken !== undefined
        ? { overageToken: changeToken }
        : {}),
    });
    await this.#store.append(settled);
    return settled;
  }

  async #freezeForReconciliation(
    record: CustodyRecord,
    now: number,
    reason: string,
    tokens: readonly string[] | undefined = undefined
  ): Promise<never> {
    const frozen = cleanNextRecord(record, now, {
      status: 'reconciliation_required',
      reconciliationReason: reason,
      ...(tokens === undefined || tokens.length === 0
        ? {}
        : { reconciliationTokens: [...tokens] }),
    });
    await this.#store.append(frozen);
    mintMisbehavior(record.coordinationId, reason);
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
    return boundAmounts(
      record.coordinationId,
      amounts,
      record.grossSats,
      record.networkCostSats
    );
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

function cleanNextRecord(
  record: CustodyRecord,
  observedAt: number,
  change: Partial<CustodyRecord>
): CustodyRecord {
  const {
    spend: _spend,
    reconciliationReason: _reason,
    reconciliationTokens: _tokens,
    ...clean
  } = record;
  return {
    ...clean,
    ...change,
    revision: record.revision + 1,
    observedAt,
  };
}

function requirePendingSpend(record: CustodyRecord): PendingCustodySpend {
  if (record.status !== 'spending' || record.spend === undefined) {
    mintMisbehavior(record.coordinationId, 'custody spend intent is missing');
  }
  return record.spend;
}

function boundAmounts(
  coordinationId: string,
  bound: BoundAmounts,
  expectedGross: number,
  expectedNetworkCost: number
): {
  gross: number;
  operatorFee: number;
  networkCost: number;
  payout: number;
} {
  if (
    bound.grossSats !== expectedGross ||
    bound.networkCostSats !== expectedNetworkCost ||
    !Number.isSafeInteger(bound.operatorFeeSats) ||
    bound.operatorFeeSats < 0 ||
    !Number.isSafeInteger(bound.payoutSats) ||
    bound.payoutSats <= 0 ||
    bound.operatorFeeSats + bound.networkCostSats + bound.payoutSats !==
      bound.grossSats
  ) {
    custodyInvalid(coordinationId, 'bound quote accounting is invalid');
  }
  return {
    gross: bound.grossSats,
    operatorFee: bound.operatorFeeSats,
    networkCost: bound.networkCostSats,
    payout: bound.payoutSats,
  };
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

function quoteExpired(quote: { expiry: number }, now: number): boolean {
  return quote.expiry > 0 && now >= quote.expiry;
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

function mintMisbehavior(coordinationId: string, message: string): never {
  throw new EscrowError('mint_misbehavior', message, {
    swapId: coordinationId,
  });
}
