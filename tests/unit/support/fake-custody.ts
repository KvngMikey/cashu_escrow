import type { EventSigner } from '../../../src/lib/pontmore/signer.ts';
import type { LightningInvoiceSource } from '../../../src/lib/lightning/invoice.ts';
import type {
  CustodyMint,
  InspectedToken,
  MeltResult,
  MintProofState,
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
  meltResult: MeltResult = {
    paidAmount: 989,
    feePaid: 1,
    changeToken: 'cashu-change',
    changeAmount: 10,
  };
  meltResults: MeltResult[] = [];
  invoiceAmounts = new Map<string, number>();
  beforeSwap: (() => Promise<void>) | undefined;

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

  validateBolt11Amount(invoice: string, expectedAmount: number): Promise<void> {
    const actual = this.invoiceAmounts.get(invoice);
    return actual === undefined || actual === expectedAmount
      ? Promise.resolve()
      : Promise.reject(
          new Error('Lightning invoice amount does not match the bound quote')
        );
  }

  async swapToP2pk(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<TokenSpendResult> {
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

  meltBolt11(input: {
    token: string;
    invoice: string;
    expectedAmount: number;
    signer: EventSigner;
  }): Promise<MeltResult> {
    const result = this.meltResults[0] ?? this.meltResult;
    if (result.paidAmount !== input.expectedAmount) {
      return Promise.reject(
        new Error('Lightning invoice amount does not match the bound quote')
      );
    }
    this.meltCalls += 1;
    return Promise.resolve(this.meltResults.shift() ?? this.meltResult);
  }
}

export class FakeInvoiceSource implements LightningInvoiceSource {
  calls: Array<{ address: string; amountSats: number }> = [];

  createInvoice(address: string, amountSats: number): Promise<string> {
    this.calls.push({ address, amountSats });
    return Promise.resolve(`lnbc-${String(amountSats)}`);
  }
}
