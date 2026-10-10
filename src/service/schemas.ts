import { z } from 'zod';

import { PAYOUT_TYPES } from '../lib/cashu/quotes.ts';
import { CommitmentDigest } from '../lib/pontmore/kinds.ts';
import { HexPubkey, MAX_SATS } from '../lib/primitives.ts';
import { DIRECTIONS, PROFILE_ID } from '../lib/profiles/swap-v1.ts';
import { PayoutTarget } from '../lib/store/operator-store.ts';

export const QuoteRequestBody = z
  .object({
    profile: z.literal(PROFILE_ID),
    terms_digest: CommitmentDigest,
    direction: z.enum(DIRECTIONS),
    gross_sats: z.number().int().positive().max(MAX_SATS),
    payout_type: z.enum(PAYOUT_TYPES),
  })
  .strict();
export type QuoteRequestBody = z.infer<typeof QuoteRequestBody>;

export const FundingSubmissionBody = z
  .object({
    token: z
      .string()
      .min(1)
      .max(256 * 1024),
  })
  .strict();

export const PayoutTargetBody = PayoutTarget;

export const CoordinationId = z.string().regex(/^[0-9a-f]{64}$/);

export const FundingInstructions = z
  .object({
    coordination_id: CoordinationId,
    mint_url: z.string().url(),
    amount_sats: z.number().int().positive().max(MAX_SATS),
    operator_pubkey: HexPubkey,
    refund_pubkey: HexPubkey,
    locktime: z.number().int().positive(),
  })
  .strict();

export const CoordinationStatus = z
  .object({
    coordination_id: CoordinationId,
    public_state: z.string().min(1),
    custody_overlay: z
      .enum([
        'expired_recovery_available',
        'expired_pending_unattributed',
        'expired_spent_unattributed',
        'settlement_unfulfillable',
      ])
      .nullable(),
  })
  .strict();

export const RefundToken = z
  .object({
    coordination_id: CoordinationId,
    kind: z.enum(['authorized_refund', 'expired_recovery_material']),
    token: z.string().min(1),
  })
  .strict();
