import { createHash } from 'node:crypto';

import {
  Amount,
  CheckStateEnum,
  MeltQuoteState,
  OutputData,
  Wallet,
  deserializeProofs,
  deserializeSwapPreview,
  getEncodedToken,
  getP2PKSigFlag,
  getSecretKind,
  hasValidDleq,
  normalizeMintUrl,
  parseP2PKSecret,
  serializeProofs,
  serializeSwapPreview,
  sumProofs,
  type OutputDataLike,
  type Proof,
  type ProofState,
  type Secret,
  type SerializedOutputData,
  type SerializedSwapPreview,
} from '@cashu/cashu-ts';

import { EscrowError } from '../errors.ts';
import type { EventSigner } from '../pontmore/signer.ts';

export type MintProofState = 'unspent' | 'pending' | 'spent';

export type InspectedProof = {
  amount: number;
  secret: Secret;
  sigFlag: 'SIG_INPUTS' | 'SIG_ALL';
  dleqValid: boolean;
};

export type InspectedToken = {
  mint: string;
  unit: string;
  amount: number;
  inputFee: number;
  proofs: readonly InspectedProof[];
};

export type TokenSpendResult = {
  recipientToken: string;
  recipientAmount: number;
  changeToken?: string;
  changeAmount: number;
};

export type MeltResult = {
  paidAmount: number;
  feePaid: number;
  changeToken?: string;
  changeAmount: number;
};

export type SpendRecovery<T> =
  | { state: 'unspent' | 'pending' | 'spent' }
  | { state: 'inconsistent'; tokens?: readonly string[] }
  | { state: 'complete'; result: T };

export type PreparedP2pkSpend = {
  payload: string;
};

export type Bolt11MeltQuote = {
  id: string;
  amount: number;
  feeReserve: number;
  expiry: number;
};

export type PreparedMelt = {
  payload: string;
  quote: Bolt11MeltQuote;
  inputFee: number;
  maxChangeInputFee: number;
};

/** Narrow mint surface used by the profile-agnostic custody engine. */
export interface CustodyMint {
  readonly url: string;
  initialize(): Promise<void>;
  inspectToken(token: string): InspectedToken;
  states(token: string): Promise<readonly MintProofState[]>;
  createBolt11MeltQuote(input: {
    invoice: string;
    expectedAmount: number;
    maxFee: number;
  }): Promise<Bolt11MeltQuote>;
  prepareP2pkSpend(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<PreparedP2pkSpend>;
  completeP2pkSpend(prepared: PreparedP2pkSpend): Promise<TokenSpendResult>;
  recoverP2pkSpend(
    prepared: PreparedP2pkSpend
  ): Promise<SpendRecovery<TokenSpendResult>>;
  prepareMelt(input: {
    token: string;
    quote: Bolt11MeltQuote;
    signer: EventSigner;
  }): Promise<PreparedMelt>;
  completeMelt(prepared: PreparedMelt): Promise<SpendRecovery<MeltResult>>;
  recoverMelt(prepared: PreparedMelt): Promise<SpendRecovery<MeltResult>>;
}

export class CashuTsMint implements CustodyMint {
  readonly url: string;
  readonly #wallet: Wallet;
  #initialized = false;

  constructor(url: string) {
    this.url = normalizeMintUrl(url);
    this.#wallet = new Wallet(this.url, { unit: 'sat' });
  }

  async initialize(): Promise<void> {
    try {
      await this.#wallet.loadMint();
      const info = this.#wallet.getMintInfo();
      for (const nut of [7, 8, 9, 10, 11, 12] as const) {
        if (!info.isSupported(nut).supported) {
          throw new EscrowError(
            'mint_unavailable',
            `mint does not support required NUT-${String(nut)}`
          );
        }
      }
      void this.#wallet.keyChain;
      this.#initialized = true;
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError('mint_unavailable', 'mint initialization failed');
    }
  }

  inspectToken(token: string): InspectedToken {
    this.#assertInitialized();
    try {
      const decoded = this.#wallet.decodeToken(token);
      const proofs = decoded.proofs.map((proof) => {
        const secret = parseP2PKSecret(proof.secret);
        return {
          amount: proof.amount.toNumber(),
          secret,
          sigFlag: getP2PKSigFlag(secret),
          dleqValid: hasValidDleq(proof, this.#wallet.getKeyset(proof.id), {
            require: true,
          }),
        };
      });
      return {
        mint: normalizeMintUrl(decoded.mint),
        unit: decoded.unit ?? 'sat',
        amount: sumProofs(decoded.proofs).toNumber(),
        inputFee: this.#wallet.getFeesForProofs(decoded.proofs).toNumber(),
        proofs,
      };
    } catch {
      throw new EscrowError('custody_invalid', 'locked token is invalid');
    }
  }

  async states(token: string): Promise<readonly MintProofState[]> {
    const proofs = this.#decodeProofs(token);
    try {
      const states = await this.#wallet.checkProofsStates(proofs);
      if (states.length !== proofs.length) throw new Error();
      return states.map(mapState);
    } catch {
      throw new EscrowError('mint_unavailable', 'proof state check failed');
    }
  }

  async createBolt11MeltQuote(input: {
    invoice: string;
    expectedAmount: number;
    maxFee: number;
  }): Promise<Bolt11MeltQuote> {
    try {
      const quote = await this.#wallet.createMeltQuoteBolt11(input.invoice);
      const amount = quote.amount.toNumber();
      const feeReserve = quote.fee_reserve.toNumber();
      if (amount !== input.expectedAmount) {
        throw new EscrowError(
          'custody_invalid',
          'Lightning invoice amount does not match the bound quote'
        );
      }
      if (feeReserve > input.maxFee) {
        throw new EscrowError(
          'custody_invalid',
          'Lightning fee reserve exceeds the bound network budget'
        );
      }
      return { id: quote.quote, amount, feeReserve, expiry: quote.expiry };
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError(
        'mint_unavailable',
        'Lightning invoice validation failed'
      );
    }
  }

  async prepareP2pkSpend(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<PreparedP2pkSpend> {
    const proofs = signInputProofs(
      this.#decodeProofs(input.token),
      input.signer
    );
    try {
      const preview = await this.#wallet.ops
        .send(input.amount, proofs)
        .asP2PK({ pubkey: compressedPubkey(input.recipientPubkey) })
        .keepAsRandom()
        .includeFees(false)
        .prepare();
      return { payload: JSON.stringify(serializeSwapPreview(preview)) };
    } catch {
      throw new EscrowError('mint_unavailable', 'mint swap preparation failed');
    }
  }

  async completeP2pkSpend(
    prepared: PreparedP2pkSpend
  ): Promise<TokenSpendResult> {
    try {
      const preview = parseSwapPreview(prepared.payload);
      const result = await this.#wallet.completeSwap(preview);
      return tokenSpendResult(this.url, result.send, result.keep);
    } catch {
      throw new EscrowError('mint_unavailable', 'mint swap failed');
    }
  }

  async recoverP2pkSpend(
    prepared: PreparedP2pkSpend
  ): Promise<SpendRecovery<TokenSpendResult>> {
    try {
      const preview = parseSwapPreview(prepared.payload);
      const sendOutputs = preview.sendOutputs ?? [];
      const keepOutputs = preview.keepOutputs ?? [];
      const recovered = await this.#restoreOutputs([
        ...sendOutputs,
        ...keepOutputs,
      ]);
      const state = await this.#proofState(preview.inputs);
      if (recovered.length === sendOutputs.length + keepOutputs.length) {
        if (state === 'pending') return { state };
        const result = tokenSpendResult(
          this.url,
          recovered.slice(0, sendOutputs.length),
          recovered.slice(sendOutputs.length)
        );
        return state === 'spent'
          ? { state: 'complete', result }
          : {
              state: 'inconsistent',
              tokens: [
                result.recipientToken,
                ...(result.changeToken === undefined
                  ? []
                  : [result.changeToken]),
              ],
            };
      }
      if (state === 'pending') return { state };
      if (recovered.length > 0 || state !== 'unspent') {
        return {
          state: 'inconsistent',
          ...(recovered.length === 0
            ? {}
            : { tokens: [encodeToken(this.url, recovered)] }),
        };
      }
      return { state };
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError('mint_unavailable', 'mint swap recovery failed');
    }
  }

  async prepareMelt(input: {
    token: string;
    quote: Bolt11MeltQuote;
    signer: EventSigner;
  }): Promise<PreparedMelt> {
    const proofs = signInputProofs(
      this.#decodeProofs(input.token),
      input.signer
    );
    try {
      const preview = await this.#wallet.prepareMelt(
        'bolt11',
        { quote: input.quote.id, amount: Amount.from(input.quote.amount) },
        proofs,
        {},
        { type: 'random' }
      );
      const stored: StoredMeltPlan = {
        inputs: serializeProofs(preview.inputs),
        keysetId: preview.keysetId,
        outputs: preview.outputData.map((output) =>
          OutputData.serialize(output)
        ),
      };
      return {
        payload: JSON.stringify(stored),
        quote: input.quote,
        inputFee: this.#wallet.getFeesForProofs(proofs).toNumber(),
        maxChangeInputFee: this.#wallet
          .getFeesForKeyset(preview.outputData.length, preview.keysetId)
          .toNumber(),
      };
    } catch {
      throw new EscrowError(
        'mint_unavailable',
        'Lightning melt preparation failed'
      );
    }
  }

  async completeMelt(
    prepared: PreparedMelt
  ): Promise<SpendRecovery<MeltResult>> {
    try {
      const plan = parseMeltPlan(prepared.payload);
      const inputs = deserializeProofs(plan.inputs);
      const result = await this.#wallet.completeMelt({
        method: 'bolt11',
        inputs,
        outputData: plan.outputs.map((output) =>
          OutputData.deserialize(output)
        ),
        keysetId: plan.keysetId,
        quote: { quote: prepared.quote.id },
      });
      const quote = await this.#wallet.checkMeltQuoteBolt11(prepared.quote.id);
      if (quote.state !== MeltQuoteState.PAID) {
        return { state: 'pending' };
      }
      return {
        state: 'complete',
        result: meltResult(
          this.url,
          inputs,
          prepared.quote.amount,
          result.change
        ),
      };
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError('mint_unavailable', 'Lightning melt failed');
    }
  }

  async recoverMelt(
    prepared: PreparedMelt
  ): Promise<SpendRecovery<MeltResult>> {
    try {
      const plan = parseMeltPlan(prepared.payload);
      const inputs = deserializeProofs(plan.inputs);
      const quote = await this.#wallet.checkMeltQuoteBolt11(prepared.quote.id);
      if (quote.state === MeltQuoteState.PENDING) return { state: 'pending' };
      if (quote.state === MeltQuoteState.UNPAID) {
        return { state: await this.#proofState(inputs) };
      }
      const outputData = plan.outputs.map((output) =>
        OutputData.deserialize(output)
      );
      for (const signature of quote.change ?? []) {
        await this.#wallet.keyChain.ensureKeysetKeys(signature.id);
      }
      const change = this.#wallet.createMeltChangeProofs(
        outputData,
        quote.change ?? []
      );
      return {
        state: 'complete',
        result: meltResult(this.url, inputs, prepared.quote.amount, change),
      };
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError(
        'mint_unavailable',
        'Lightning melt recovery failed'
      );
    }
  }

  async #restoreOutputs(outputs: OutputDataLike[]): Promise<Proof[]> {
    if (outputs.length === 0) return [];
    const restored = await this.#wallet.mint.restore({
      outputs: outputs.map((output) => output.blindedMessage),
    });
    if (restored.outputs.length !== restored.signatures.length) {
      throw new Error();
    }
    const signatures = new Map(
      restored.outputs.map((output, index) => [
        output.B_,
        restored.signatures[index],
      ])
    );
    const proofs: Proof[] = [];
    for (const output of outputs) {
      const signature = signatures.get(output.blindedMessage.B_);
      if (signature === undefined) continue;
      await this.#wallet.keyChain.ensureKeysetKeys(signature.id);
      proofs.push(
        output.toProof(signature, this.#wallet.getKeyset(signature.id))
      );
    }
    return proofs;
  }

  async #proofState(proofs: Proof[]): Promise<MintProofState | 'inconsistent'> {
    const states = await this.#wallet.checkProofsStates(proofs);
    if (states.length !== proofs.length) throw new Error();
    const mapped = states.map(mapState);
    if (mapped.every((state) => state === 'unspent')) return 'unspent';
    if (mapped.every((state) => state === 'spent')) return 'spent';
    if (mapped.some((state) => state === 'pending')) return 'pending';
    return 'inconsistent';
  }

  #decodeProofs(token: string): Proof[] {
    this.#assertInitialized();
    try {
      const decoded = this.#wallet.decodeToken(token);
      if (normalizeMintUrl(decoded.mint) !== this.url) throw new Error();
      return decoded.proofs;
    } catch {
      throw new EscrowError('custody_invalid', 'custody token is invalid');
    }
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new EscrowError('mint_unavailable', 'mint is not initialized');
    }
  }
}

type StoredMeltPlan = {
  inputs: string[];
  keysetId: string;
  outputs: SerializedOutputData[];
};

function parseMeltPlan(payload: string): StoredMeltPlan {
  const parsed = JSON.parse(payload) as StoredMeltPlan;
  if (
    !Array.isArray(parsed.inputs) ||
    typeof parsed.keysetId !== 'string' ||
    !Array.isArray(parsed.outputs)
  ) {
    throw new Error();
  }
  return parsed;
}

function parseSwapPreview(payload: string) {
  const parsed: unknown = JSON.parse(payload);
  return deserializeSwapPreview(parsed as SerializedSwapPreview);
}

function signInputProofs(proofs: Proof[], signer: EventSigner): Proof[] {
  return proofs.map((proof) => {
    try {
      if (getSecretKind(proof.secret) !== 'P2PK') return proof;
    } catch {
      return proof;
    }
    if (getP2PKSigFlag(proof.secret) !== 'SIG_INPUTS') {
      throw new EscrowError(
        'custody_invalid',
        'unsupported Cashu signature mode'
      );
    }
    const digest = createHash('sha256').update(proof.secret, 'utf8').digest();
    return {
      ...proof,
      witness: JSON.stringify({ signatures: [signer.signDigest(digest)] }),
    };
  });
}

function tokenSpendResult(
  mint: string,
  recipient: Proof[],
  change: Proof[]
): TokenSpendResult {
  const recipientAmount = sumProofs(recipient).toNumber();
  const changeAmount = sumProofs(change).toNumber();
  return {
    recipientToken: encodeToken(mint, recipient),
    recipientAmount,
    ...(change.length > 0 ? { changeToken: encodeToken(mint, change) } : {}),
    changeAmount,
  };
}

function meltResult(
  mint: string,
  inputs: Proof[],
  paidAmount: number,
  change: Proof[]
): MeltResult {
  const changeAmount = sumProofs(change).toNumber();
  return {
    paidAmount,
    feePaid: sumProofs(inputs).toNumber() - paidAmount - changeAmount,
    ...(change.length > 0 ? { changeToken: encodeToken(mint, change) } : {}),
    changeAmount,
  };
}

function encodeToken(mint: string, proofs: Proof[]): string {
  return getEncodedToken({ mint, unit: 'sat', proofs });
}

function mapState(state: ProofState): MintProofState {
  if (state.state === CheckStateEnum.UNSPENT) return 'unspent';
  if (state.state === CheckStateEnum.PENDING) return 'pending';
  return 'spent';
}

function compressedPubkey(pubkey: string): string {
  return pubkey.length === 64 ? `02${pubkey}` : pubkey;
}
