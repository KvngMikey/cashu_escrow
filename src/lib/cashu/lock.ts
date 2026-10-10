import { normalizeMintUrl } from '@cashu/cashu-ts';
import { createHash } from 'node:crypto';

import { EscrowError } from '../errors.ts';
import { assertHexPubkey } from '../primitives.ts';
import type { CustodyMint, MintProofState } from './mint.ts';

export type LockExpectation = {
  coordinationId: string;
  mintUrl: string;
  operatorPubkey: string;
  providerPubkey: string;
  grossSats: number;
  networkCostSats: number;
  payoutType: 'cashu_p2pk' | 'bolt11';
  fiatConfirmBy: number;
  disputeWindowSeconds: number;
  releaseSafetyMarginSeconds: number;
  minimumLocktime?: number;
};

export type VerifiedLockedToken = {
  token: string;
  mintUrl: string;
  grossSats: number;
  inputFeeSats: number;
  proofCount: number;
  tokenFingerprint: string;
  locktime: number;
};

/** Verify the complete funding lock before custody promises anything. */
export async function verifyLockedToken(
  token: string,
  expectation: LockExpectation,
  mint: CustodyMint
): Promise<VerifiedLockedToken> {
  assertHexPubkey(expectation.operatorPubkey, 'operator pubkey');
  assertHexPubkey(expectation.providerPubkey, 'provider pubkey');
  const inspected = mint.inspectToken(token);

  if (
    normalizeMintUrl(inspected.mint) !== normalizeMintUrl(expectation.mintUrl)
  ) {
    invalid(expectation, 'locked token uses the wrong mint');
  }
  if (normalizeMintUrl(mint.url) !== normalizeMintUrl(expectation.mintUrl)) {
    invalid(expectation, 'custody mint does not match the expected mint');
  }
  if (inspected.unit !== 'sat') {
    invalid(expectation, 'locked token must use sat units');
  }
  if (inspected.amount !== expectation.grossSats) {
    invalid(expectation, 'locked token amount does not match the quote');
  }
  if (
    expectation.payoutType === 'cashu_p2pk' &&
    inspected.inputFee !== expectation.networkCostSats
  ) {
    invalid(expectation, 'locked token input fee does not match the quote');
  }
  if (
    expectation.payoutType === 'bolt11' &&
    inspected.inputFee > expectation.networkCostSats
  ) {
    invalid(
      expectation,
      'locked token input fee exceeds the quote network cost'
    );
  }
  if (inspected.proofs.length === 0) {
    invalid(expectation, 'locked token has no proofs');
  }

  const minimumLocktime = Math.max(
    expectation.fiatConfirmBy +
      expectation.disputeWindowSeconds +
      expectation.releaseSafetyMarginSeconds,
    expectation.minimumLocktime ?? 0
  );
  let commonLocktime: number | undefined;

  for (const proof of inspected.proofs) {
    const [kind, data] = proof.secret;
    if (kind !== 'P2PK') invalid(expectation, 'proof is not P2PK locked');
    if (!samePubkey(data.data, expectation.operatorPubkey)) {
      invalid(expectation, 'proof is not locked to this operator');
    }
    if (proof.sigFlag !== 'SIG_INPUTS') {
      invalid(expectation, 'proof signature mode is unsupported');
    }
    if (!proof.dleqValid)
      invalid(expectation, 'proof DLEQ verification failed');

    const tags = data.tags ?? [];
    if (tags.some((tag) => tag[0] === 'pubkeys')) {
      invalid(expectation, 'proof has an unexpected additional lock key');
    }
    assertUnitThreshold(tags, 'n_sigs', expectation);
    assertUnitThreshold(tags, 'n_sigs_refund', expectation);
    const locktime = singleTag(tags, 'locktime', expectation);
    const refund = singleTag(tags, 'refund', expectation);
    if (!/^\d+$/.test(locktime)) {
      invalid(expectation, 'proof locktime is invalid');
    }
    const parsedLocktime = Number(locktime);
    if (
      !Number.isSafeInteger(parsedLocktime) ||
      parsedLocktime < minimumLocktime
    ) {
      invalid(expectation, 'proof locktime is too early');
    }
    if (!samePubkey(refund, expectation.providerPubkey)) {
      invalid(expectation, 'proof refund key is not the Bitcoin provider');
    }
    if (commonLocktime !== undefined && parsedLocktime !== commonLocktime) {
      invalid(expectation, 'proof locktimes do not match');
    }
    commonLocktime = parsedLocktime;
  }

  const states = await mint.states(token);
  assertAllStates(states, 'unspent', expectation, inspected.proofs.length);

  return {
    token,
    mintUrl: inspected.mint,
    grossSats: inspected.amount,
    inputFeeSats: inspected.inputFee,
    proofCount: inspected.proofs.length,
    tokenFingerprint: fingerprintProofSecrets(
      inspected.proofs.map((proof) => proof.secret)
    ),
    locktime: commonLocktime as number,
  };
}

export function fingerprintProofSecrets(secrets: readonly unknown[]): string {
  const canonical = secrets.map((secret) => JSON.stringify(secret)).sort();
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assertUnitThreshold(
  tags: string[][],
  name: string,
  expectation: Pick<LockExpectation, 'coordinationId'>
): void {
  const matches = tags.filter((tag) => tag[0] === name);
  if (
    matches.length > 1 ||
    (matches.length === 1 &&
      (matches[0]?.length !== 2 || matches[0]?.[1] !== '1'))
  ) {
    invalid(expectation, `proof ${name} threshold is invalid`);
  }
}

export function assertAllStates(
  states: readonly MintProofState[],
  expected: MintProofState,
  expectation: Pick<LockExpectation, 'coordinationId'>,
  expectedCount: number
): void {
  if (
    states.length !== expectedCount ||
    states.some((state) => state !== expected)
  ) {
    invalid(expectation, `proofs are not all ${expected}`);
  }
}

function singleTag(
  tags: string[][],
  name: string,
  expectation: Pick<LockExpectation, 'coordinationId'>
): string {
  const matches = tags.filter((tag) => tag[0] === name);
  const value = matches[0]?.[1];
  if (matches.length !== 1 || matches[0]?.length !== 2 || value === undefined) {
    invalid(expectation, `proof ${name} tag is invalid`);
  }
  return value;
}

function samePubkey(left: string, right: string): boolean {
  return xOnly(left) === xOnly(right);
}

function xOnly(pubkey: string): string {
  return pubkey.length === 66
    ? pubkey.slice(2).toLowerCase()
    : pubkey.toLowerCase();
}

function invalid(
  expectation: Pick<LockExpectation, 'coordinationId'>,
  message: string
): never {
  throw new EscrowError('custody_invalid', message, {
    swapId: expectation.coordinationId,
  });
}
