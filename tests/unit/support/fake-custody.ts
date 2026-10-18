import type { EventSigner } from '../../../src/lib/pontmore/signer.ts';
import type { LightningInvoiceSource } from '../../../src/lib/lightning/invoice.ts';
import type {
  CustodyMint,
  Bolt11MeltQuote,
  InspectedToken,
  MeltResult,
  MintProofState,
  PreparedMelt,
  PreparedP2pkSpend,
  SpendRecovery,
  TokenSpendResult,
} from '../../../src/lib/cashu/mint.ts';
import type {
  CustodyRecord,
  CustodyStore,
} from '../../../src/lib/store/store.ts';

export class MemoryCustodyStore implements CustodyStore {
  readonly records = new Map<string, CustodyRecord>();

  get(coordinationId: string): Promise<CustodyRecord | undefined> {
    return Promise.resolve(this.records.get(coordinationId));
  }

  append(record: CustodyRecord): Promise<void> {
    const current = this.records.get(record.coordinationId);
    if (record.revision !== (current?.revision ?? 0) + 1) throw new Error();
    this.records.set(record.coordinationId, structuredClone(record));
    return Promise.resolve();
  }

  all(): Promise<readonly CustodyRecord[]> {
    return Promise.resolve([...this.records.values()]);
  }
}

export class FakeCustodyMint implements CustodyMint {
  readonly url = 'http://mint.test';
  inspected: InspectedToken;
  proofStates: MintProofState[] = ['unspent'];
  swapCalls = 0;
  meltCalls = 0;
  quoteCalls = 0;
  meltResult: MeltResult = {
    paidAmount: 989,
    feePaid: 1,
    changeToken: 'cashu-change',
    changeAmount: 10,
  };
  meltResults: MeltResult[] = [];
  invoiceAmounts = new Map<string, number>();
  invoiceFeeReserves = new Map<string, number>();
  p2pkRecovery: SpendRecovery<TokenSpendResult> | undefined;
  meltRecovery: SpendRecovery<MeltResult> | undefined;
  changeInputFee = 0;
  maxChangeInputFee = 0;
  beforeSwap: (() => Promise<void>) | undefined;
  beforeMelt: (() => Promise<void>) | undefined;

  constructor(inspected: InspectedToken) {
    this.inspected = inspected;
  }

  async initialize(): Promise<void> {}

  inspectToken(_token: string): InspectedToken {
    return this.inspected;
  }

  states(_token: string): Promise<readonly MintProofState[]> {
    return Promise.resolve(this.proofStates);
  }

  createBolt11MeltQuote(input: {
    invoice: string;
    expectedAmount: number;
    maxFee: number;
  }): Promise<Bolt11MeltQuote> {
    this.quoteCalls += 1;
    const actual = this.invoiceAmounts.get(input.invoice);
    if (actual !== undefined && actual !== input.expectedAmount) {
      return Promise.reject(
        new Error('Lightning invoice amount does not match the bound quote')
      );
    }
    const feeReserve =
      this.invoiceFeeReserves.get(input.invoice) ??
      (input.invoice === 'lnbc-10' ? 1 : 0);
    if (feeReserve > input.maxFee) {
      return Promise.reject(new Error('Lightning fee reserve exceeds budget'));
    }
    return Promise.resolve({
      id: `quote-${input.invoice}`,
      amount: input.expectedAmount,
      feeReserve,
      expiry: 9_999_999_999,
    });
  }

  prepareP2pkSpend(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<PreparedP2pkSpend> {
    return Promise.resolve({
      payload: JSON.stringify({
        token: input.token,
        amount: input.amount,
        recipientPubkey: input.recipientPubkey,
      }),
    });
  }

  async completeP2pkSpend(
    prepared: PreparedP2pkSpend
  ): Promise<TokenSpendResult> {
    const input = JSON.parse(prepared.payload) as {
      token: string;
      amount: number;
      recipientPubkey: string;
    };
    await this.beforeSwap?.();
    this.swapCalls += 1;
    const sourceAmount =
      input.token === 'cashu-change'
        ? this.meltResult.changeAmount
        : this.inspected.amount;
    const inputFee =
      input.token === 'cashu-change' ? 0 : this.inspected.inputFee;
    const changeAmount = sourceAmount - input.amount - inputFee;
    return {
      recipientToken: `cashu-to-${input.recipientPubkey}`,
      recipientAmount: input.amount,
      ...(changeAmount > 0 ? { changeToken: 'cashu-operator' } : {}),
      changeAmount,
    };
  }

  recoverP2pkSpend(
    _prepared: PreparedP2pkSpend
  ): Promise<SpendRecovery<TokenSpendResult>> {
    return Promise.resolve(
      this.p2pkRecovery ?? { state: this.proofStates[0] ?? 'inconsistent' }
    );
  }

  prepareMelt(input: {
    token: string;
    quote: Bolt11MeltQuote;
    signer: EventSigner;
  }): Promise<PreparedMelt> {
    return Promise.resolve({
      payload: JSON.stringify({ token: input.token }),
      quote: input.quote,
      inputFee:
        input.token === 'cashu-change'
          ? this.changeInputFee
          : this.inspected.inputFee,
      maxChangeInputFee: this.maxChangeInputFee,
    });
  }

  completeMelt(input: PreparedMelt): Promise<SpendRecovery<MeltResult>> {
    return this.#completeMelt(input);
  }

  async #completeMelt(input: PreparedMelt): Promise<SpendRecovery<MeltResult>> {
    const result = this.meltResults[0] ?? this.meltResult;
    if (result.paidAmount !== input.quote.amount) {
      return Promise.reject(
        new Error('Lightning invoice amount does not match the bound quote')
      );
    }
    await this.beforeMelt?.();
    this.meltCalls += 1;
    return {
      state: 'complete',
      result: this.meltResults.shift() ?? this.meltResult,
    };
  }

  recoverMelt(_prepared: PreparedMelt): Promise<SpendRecovery<MeltResult>> {
    return Promise.resolve(
      this.meltRecovery ?? { state: this.proofStates[0] ?? 'inconsistent' }
    );
  }
}

export class FakeInvoiceSource implements LightningInvoiceSource {
  calls: Array<{ address: string; amountSats: number }> = [];

  createInvoice(address: string, amountSats: number): Promise<string> {
    this.calls.push({ address, amountSats });
    return Promise.resolve(`lnbc-${String(amountSats)}`);
  }
}
