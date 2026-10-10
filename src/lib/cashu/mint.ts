import { createHash } from 'node:crypto';

import {
  CheckStateEnum,
  Wallet,
  getEncodedToken,
  getP2PKSigFlag,
  getSecretKind,
  hasValidDleq,
  normalizeMintUrl,
  parseP2PKSecret,
  sumProofs,
  type Proof,
  type ProofState,
  type Secret,
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

/** Narrow mint surface used by the profile-agnostic custody engine. */
export interface CustodyMint {
  readonly url: string;
  initialize(): Promise<void>;
  inspectToken(token: string): InspectedToken;
  states(token: string): Promise<readonly MintProofState[]>;
  validateBolt11Amount(invoice: string, expectedAmount: number): Promise<void>;
  swapToP2pk(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<TokenSpendResult>;
  meltBolt11(input: {
    token: string;
    invoice: string;
    expectedAmount: number;
    signer: EventSigner;
  }): Promise<MeltResult>;
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
      for (const nut of [7, 10, 11] as const) {
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
            require: false,
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

  async validateBolt11Amount(
    invoice: string,
    expectedAmount: number
  ): Promise<void> {
    try {
      const quote = await this.#wallet.createMeltQuoteBolt11(invoice);
      if (quote.amount.toNumber() !== expectedAmount) {
        throw new EscrowError(
          'custody_invalid',
          'Lightning invoice amount does not match the bound quote'
        );
      }
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError(
        'mint_unavailable',
        'Lightning invoice validation failed'
      );
    }
  }

  async swapToP2pk(input: {
    token: string;
    amount: number;
    recipientPubkey: string;
    signer: EventSigner;
  }): Promise<TokenSpendResult> {
    const proofs = signInputProofs(
      this.#decodeProofs(input.token),
      input.signer
    );
    try {
      const result = await this.#wallet.ops
        .send(input.amount, proofs)
        .asP2PK({ pubkey: compressedPubkey(input.recipientPubkey) })
        .keepAsRandom()
        .includeFees(false)
        .run();
      return tokenSpendResult(this.url, result.send, result.keep);
    } catch {
      throw new EscrowError('mint_unavailable', 'mint swap failed');
    }
  }

  async meltBolt11(input: {
    token: string;
    invoice: string;
    expectedAmount: number;
    signer: EventSigner;
  }): Promise<MeltResult> {
    const proofs = signInputProofs(
      this.#decodeProofs(input.token),
      input.signer
    );
    try {
      const quote = await this.#wallet.createMeltQuoteBolt11(input.invoice);
      if (quote.amount.toNumber() !== input.expectedAmount) {
        throw new EscrowError(
          'custody_invalid',
          'Lightning invoice amount does not match the bound quote'
        );
      }
      const result = await this.#wallet.ops
        .meltBolt11(quote, proofs)
        .asRandom()
        .run();
      const changeAmount = sumProofs(result.change).toNumber();
      const gross = sumProofs(proofs).toNumber();
      return {
        paidAmount: quote.amount.toNumber(),
        feePaid: gross - quote.amount.toNumber() - changeAmount,
        ...(result.change.length > 0
          ? { changeToken: encodeToken(this.url, result.change) }
          : {}),
        changeAmount,
      };
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError('mint_unavailable', 'Lightning melt failed');
    }
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
