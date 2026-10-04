import { describe, expect, it } from 'vitest';

import {
  verifyLockedToken,
  type LockExpectation,
} from '../../../src/lib/cashu/lock.ts';
import type { InspectedToken } from '../../../src/lib/cashu/mint.ts';
import { CUSTOMER, OPERATOR } from '../support/keys.ts';
import { FakeCustodyMint } from '../support/fake-custody.ts';

const expectation: LockExpectation = {
  coordinationId: 'swap-1',
  mintUrl: 'http://mint.test',
  operatorPubkey: OPERATOR.pubkey,
  providerPubkey: CUSTOMER.pubkey,
  grossSats: 1_000,
  networkCostSats: 1,
  payoutType: 'cashu_p2pk',
  fiatConfirmBy: 2_000,
  disputeWindowSeconds: 100,
  releaseSafetyMarginSeconds: 50,
};

function inspected(
  change: Partial<InspectedToken> = {},
  tags: string[][] = [
    ['locktime', '2150'],
    ['refund', CUSTOMER.pubkey],
  ]
): InspectedToken {
  return {
    mint: 'http://mint.test',
    unit: 'sat',
    amount: 1_000,
    inputFee: 1,
    proofs: [
      {
        amount: 1_000,
        secret: ['P2PK', { nonce: 'nonce', data: OPERATOR.pubkey, tags }],
        sigFlag: 'SIG_INPUTS',
        dleqValid: true,
      },
    ],
    ...change,
  };
}

describe('verifyLockedToken', () => {
  it('accepts an exact operator lock with the provider refund path', async () => {
    const mint = new FakeCustodyMint(inspected());
    await expect(
      verifyLockedToken('cashu-token', expectation, mint)
    ).resolves.toMatchObject({ grossSats: 1_000, locktime: 2_150 });
  });

  it.each([
    ['wrong mint', { mint: 'http://other.test' }, undefined],
    ['wrong unit', { unit: 'usd' }, undefined],
    ['wrong amount', { amount: 999 }, undefined],
    ['wrong input fee', { inputFee: 2 }, undefined],
    ['no proofs', { proofs: [] }, undefined],
    ['invalid DLEQ', {}, 'invalid-dleq'],
    ['wrong operator', {}, 'wrong-operator'],
    ['SIG_ALL', {}, 'sig-all'],
    ['short locktime', {}, 'short-locktime'],
    ['wrong refund key', {}, 'wrong-refund'],
    ['extra main key', {}, 'extra-key'],
  ])('rejects %s', async (_label, change, tagCase) => {
    const token = inspected(change);
    const proof = token.proofs[0]!;
    if (tagCase === 'invalid-dleq') proof.dleqValid = false;
    if (tagCase === 'wrong-operator') {
      proof.secret[1].data = CUSTOMER.pubkey;
    }
    if (tagCase === 'sig-all') proof.sigFlag = 'SIG_ALL';
    if (tagCase === 'short-locktime') {
      proof.secret[1].tags = [
        ['locktime', '2149'],
        ['refund', CUSTOMER.pubkey],
      ];
    }
    if (tagCase === 'wrong-refund') {
      proof.secret[1].tags = [
        ['locktime', '2150'],
        ['refund', OPERATOR.pubkey],
      ];
    }
    if (tagCase === 'extra-key') {
      proof.secret[1].tags = [
        ['locktime', '2150'],
        ['refund', CUSTOMER.pubkey],
        ['pubkeys', CUSTOMER.pubkey],
      ];
    }
    await expect(
      verifyLockedToken('cashu-token', expectation, new FakeCustodyMint(token))
    ).rejects.toMatchObject({ category: 'custody_invalid', swapId: 'swap-1' });
  });

  it('rejects a token that is already spent', async () => {
    const mint = new FakeCustodyMint(inspected());
    mint.proofStates = ['spent'];
    await expect(
      verifyLockedToken('cashu-token', expectation, mint)
    ).rejects.toThrow(/unspent/);
  });

  it('rejects an incomplete NUT-07 response', async () => {
    const token = inspected({
      proofs: [inspected().proofs[0]!, inspected().proofs[0]!],
    });
    const mint = new FakeCustodyMint(token);
    mint.proofStates = ['unspent'];
    await expect(
      verifyLockedToken('cashu-token', expectation, mint)
    ).rejects.toThrow(/unspent/);
  });
});
