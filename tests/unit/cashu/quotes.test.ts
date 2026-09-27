import { describe, expect, it } from 'vitest';

import {
  canonicalQuoteBytes,
  createSignedQuote,
  quoteCommitment,
  verifySignedQuote,
} from '../../../src/lib/cashu/quotes.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { OPERATOR } from '../support/keys.ts';

const signer = createSigner(OPERATOR.nsec);
const createdAt = 1_800_000_000;
const request = {
  termsDigest: `sha256:${'a'.repeat(64)}`,
  direction: 'btc_to_fiat' as const,
  grossSats: 10_000,
  payoutType: 'cashu_p2pk' as const,
};
const policy = {
  feesEnabled: true,
  operatorFeeBps: 100,
  operatorMinFeeSats: 3,
  minCoordinationSats: 100,
  refundFeeMode: 'network_only' as const,
  ttlSeconds: 600,
};
const createQuote = (
  overrides: Partial<Parameters<typeof createSignedQuote>[0]> = {}
) =>
  createSignedQuote({
    request,
    policy,
    signer,
    createdAt,
    networkCostSats: 2,
    ...overrides,
  });

describe('signed quotes', () => {
  it('signs exact Cashu payout amounts and verifies before expiry', () => {
    const signed = createQuote();

    expect(signed.quote).toEqual({
      profile: 'pontmore/swap@1',
      terms_digest: request.termsDigest,
      direction: request.direction,
      gross_sats: 10_000,
      operator_fee_sats: 100,
      network_cost_sats: 2,
      fee_bearer: 'recipient',
      refund_fee_mode: 'network_only',
      expires_at: createdAt + 600,
      payout_type: 'cashu_p2pk',
      payout_sats: 9_898,
    });
    expect(verifySignedQuote(signed, OPERATOR.pubkey, createdAt + 599)).toBe(
      true
    );
    expect(verifySignedQuote(signed, OPERATOR.pubkey, createdAt + 600)).toBe(
      false
    );
  });

  it('uses payout_min_sats for a Lightning quote', () => {
    const signed = createSignedQuote({
      request: { ...request, payoutType: 'bolt11' },
      policy: { ...policy, feesEnabled: false },
      signer,
      createdAt,
      networkCostSats: 2,
    });

    expect(signed.quote).toMatchObject({
      payout_type: 'bolt11',
      operator_fee_sats: 0,
      payout_min_sats: 9_998,
    });
    expect(signed.quote).not.toHaveProperty('payout_sats');
  });

  it('rejects amount and signature tampering', () => {
    const signed = createQuote();
    const amountTampered = {
      ...signed,
      quote: { ...signed.quote, gross_sats: 20_000 },
    };
    const signatureTampered = {
      ...signed,
      signature: `${signed.signature[0] === '0' ? '1' : '0'}${signed.signature.slice(1)}`,
    };

    expect(verifySignedQuote(amountTampered, OPERATOR.pubkey, createdAt)).toBe(
      false
    );
    expect(
      verifySignedQuote(signatureTampered, OPERATOR.pubkey, createdAt)
    ).toBe(false);
  });

  it('uses stable canonical bytes and binds the signed artifact', () => {
    const signed = createQuote();
    const bytes = canonicalQuoteBytes(signed.quote);
    const commitment = quoteCommitment(signed);

    expect(Buffer.from(bytes).toString('utf8')).toBe(
      `{"profile":"pontmore/swap@1","terms_digest":"${request.termsDigest}","direction":"btc_to_fiat","gross_sats":10000,"operator_fee_sats":100,"network_cost_sats":2,"payout_sats":9898,"payout_type":"cashu_p2pk","fee_bearer":"recipient","refund_fee_mode":"network_only","expires_at":1800000600}`
    );
    expect(commitment).toMatchObject({
      algorithm: 'sha256-bytes@1',
      digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
  });

  it('refuses uneconomic coordinations before signing', () => {
    expect(() =>
      createSignedQuote({
        request: { ...request, grossSats: 99 },
        policy,
        signer,
        createdAt,
        networkCostSats: 2,
      })
    ).toThrowError(/below the minimum/);
  });

  it('rejects invalid clocks at creation and verification', () => {
    expect(() => createQuote({ createdAt: Number.NaN })).toThrowError(
      /creation time/
    );

    const signed = createQuote();
    expect(verifySignedQuote(signed, OPERATOR.pubkey, Number.NaN)).toBe(false);
  });
});
