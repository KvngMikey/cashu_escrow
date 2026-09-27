import { createHash } from 'node:crypto';

import { schnorr } from '@noble/curves/secp256k1.js';
import { z } from 'zod';

import { EscrowError } from '../errors.ts';
import {
  CommitmentDigest,
  commitBytes,
  type Commitment,
} from '../pontmore/kinds.ts';
import { HexPubkey, MAX_SATS, UnixSeconds } from '../primitives.ts';
import type { EventSigner } from '../pontmore/signer.ts';
import { DIRECTIONS, PROFILE_ID, type Direction } from '../profiles/swap-v1.ts';
import { REFUND_FEE_MODES, computeFees, type RefundFeeMode } from './fees.ts';

export const PAYOUT_TYPES = ['cashu_p2pk', 'bolt11'] as const;
export type PayoutType = (typeof PAYOUT_TYPES)[number];

const NonNegativeSats = z.number().int().min(0).max(MAX_SATS);
const PositiveSats = z.number().int().positive().max(MAX_SATS);

const QuoteBase = z
  .object({
    profile: z.literal(PROFILE_ID),
    terms_digest: CommitmentDigest,
    direction: z.enum(DIRECTIONS),
    gross_sats: PositiveSats,
    operator_fee_sats: NonNegativeSats,
    network_cost_sats: NonNegativeSats,
    fee_bearer: z.literal('recipient'),
    refund_fee_mode: z.enum(REFUND_FEE_MODES),
    expires_at: UnixSeconds,
  })
  .strict();

const CashuQuote = QuoteBase.extend({
  payout_type: z.literal('cashu_p2pk'),
  payout_sats: PositiveSats,
});

const Bolt11Quote = QuoteBase.extend({
  payout_type: z.literal('bolt11'),
  payout_min_sats: PositiveSats,
});

export const Quote = z.discriminatedUnion('payout_type', [
  CashuQuote,
  Bolt11Quote,
]);
export type Quote = z.infer<typeof Quote>;

export const SignedQuote = z
  .object({
    quote: Quote,
    pubkey: HexPubkey,
    signature: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();
export type SignedQuote = z.infer<typeof SignedQuote>;

export type QuotePolicy = {
  feesEnabled: boolean;
  operatorFeeBps: number;
  operatorMinFeeSats: number;
  minCoordinationSats: number;
  refundFeeMode: RefundFeeMode;
  ttlSeconds: number;
};

export type QuoteRequest = {
  termsDigest: string;
  direction: Direction;
  grossSats: number;
  payoutType: PayoutType;
};

export function createSignedQuote(input: {
  request: QuoteRequest;
  policy: QuotePolicy;
  signer: EventSigner;
  createdAt: number;
  networkCostSats: number;
}): SignedQuote {
  const { request, policy } = input;
  if (
    !Number.isSafeInteger(policy.minCoordinationSats) ||
    policy.minCoordinationSats <= 0 ||
    request.grossSats < policy.minCoordinationSats
  ) {
    throw new EscrowError(
      'content_invalid',
      'gross amount is below the minimum coordination amount'
    );
  }
  if (!Number.isSafeInteger(policy.ttlSeconds) || policy.ttlSeconds <= 0) {
    throw new EscrowError('config_invalid', 'quote TTL is invalid');
  }
  if (!UnixSeconds.safeParse(input.createdAt).success) {
    throw new EscrowError('content_invalid', 'quote creation time is invalid');
  }

  const fees = computeFees({
    gross: request.grossSats,
    bps: policy.operatorFeeBps,
    minFee: policy.operatorMinFeeSats,
    enabled: policy.feesEnabled,
    networkCost: input.networkCostSats,
    operation: 'settlement',
    refundFeeMode: policy.refundFeeMode,
  });
  const common = {
    profile: PROFILE_ID,
    terms_digest: request.termsDigest,
    direction: request.direction,
    gross_sats: fees.gross,
    operator_fee_sats: fees.operatorFee,
    network_cost_sats: fees.networkCost,
    fee_bearer: 'recipient' as const,
    refund_fee_mode: policy.refundFeeMode,
    expires_at: input.createdAt + policy.ttlSeconds,
  };
  const quote = parseQuote(
    request.payoutType === 'cashu_p2pk'
      ? {
          ...common,
          payout_type: request.payoutType,
          payout_sats: fees.payout,
        }
      : {
          ...common,
          payout_type: request.payoutType,
          payout_min_sats: fees.payout,
        }
  );

  const signature = input.signer.signDigest(hash(canonicalQuoteBytes(quote)));
  return parseSignedQuote({
    quote,
    pubkey: input.signer.pubkey,
    signature,
  });
}

export function verifySignedQuote(
  input: unknown,
  expectedPubkey: string,
  at: number
): input is SignedQuote {
  const signed = SignedQuote.safeParse(input);
  const expected = HexPubkey.safeParse(expectedPubkey);
  if (
    !signed.success ||
    !expected.success ||
    !UnixSeconds.safeParse(at).success
  ) {
    return false;
  }
  if (
    signed.data.pubkey !== expected.data ||
    at >= signed.data.quote.expires_at
  ) {
    return false;
  }

  try {
    return schnorr.verify(
      Buffer.from(signed.data.signature, 'hex'),
      hash(canonicalQuoteBytes(signed.data.quote)),
      Buffer.from(signed.data.pubkey, 'hex')
    );
  } catch {
    return false;
  }
}

/** Exact bytes covered by the quote signature. */
export function canonicalQuoteBytes(input: unknown): Uint8Array {
  const quote = parseQuote(input);
  return Buffer.from(JSON.stringify(canonicalQuoteObject(quote)), 'utf8');
}

/** Commitment placed in the coordination root as `commitments.quote`. */
export function quoteCommitment(input: unknown): Commitment {
  const signed = parseSignedQuote(input);
  const bytes = Buffer.from(
    JSON.stringify({
      quote: canonicalQuoteObject(signed.quote),
      pubkey: signed.pubkey,
      signature: signed.signature,
    }),
    'utf8'
  );
  return commitBytes(bytes);
}

function canonicalQuoteObject(quote: Quote): Record<string, string | number> {
  const payout =
    quote.payout_type === 'cashu_p2pk'
      ? { payout_sats: quote.payout_sats }
      : { payout_min_sats: quote.payout_min_sats };
  return {
    profile: quote.profile,
    terms_digest: quote.terms_digest,
    direction: quote.direction,
    gross_sats: quote.gross_sats,
    operator_fee_sats: quote.operator_fee_sats,
    network_cost_sats: quote.network_cost_sats,
    ...payout,
    payout_type: quote.payout_type,
    fee_bearer: quote.fee_bearer,
    refund_fee_mode: quote.refund_fee_mode,
    expires_at: quote.expires_at,
  };
}

function hash(bytes: Uint8Array): Uint8Array {
  return createHash('sha256').update(bytes).digest();
}

function parseQuote(input: unknown): Quote {
  const quote = Quote.safeParse(input);
  if (!quote.success) {
    throw new EscrowError('content_invalid', 'quote failed its schema');
  }
  return quote.data;
}

function parseSignedQuote(input: unknown): SignedQuote {
  const signed = SignedQuote.safeParse(input);
  if (!signed.success) {
    throw new EscrowError('content_invalid', 'signed quote failed its schema');
  }
  return signed.data;
}
