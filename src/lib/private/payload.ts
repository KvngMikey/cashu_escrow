/**
 * Delivery envelope for exact UTF-8 private payload bytes. The root commits to
 * the payload string's bytes, not this envelope: including the root ID in its
 * own commitment would create an impossible circular hash dependency.
 */

import { z } from 'zod';

import {
  COMMITMENT_ALGORITHM,
  VersionedId,
  commitBytes,
  commitmentMatches,
} from '../pontmore/kinds.ts';
import type { Commitment } from '../pontmore/kinds.ts';
import { HexEventId, HexPubkey, OpaqueRef } from '../primitives.ts';

export const PRIVATE_PAYLOAD_VERSION = 1 as const;

/** Identifies the profile, the coordination, who may read it, and what it commits to. */
export const PrivatePayload = z
  .object({
    version: z.literal(PRIVATE_PAYLOAD_VERSION),
    profile: VersionedId,
    /** Coordination root event id. */
    root: HexEventId,
    /** Intended participants, by pubkey. */
    participants: z.array(HexPubkey).min(1).max(8),
    /** Which root commitment key these bytes satisfy, when they satisfy one. */
    commitment_key: OpaqueRef.optional(),
    /** Payload discriminator, defined by the profile or service. */
    type: OpaqueRef,
    commitment_algorithm: z.literal(COMMITMENT_ALGORITHM),
    /** Exact UTF-8 JSON text. Preserve whitespace and key order on delivery. */
    payload: z.string(),
  })
  .strict();
export type PrivatePayload = z.infer<typeof PrivatePayload>;

export type SealedPayload = {
  bytes: Uint8Array;
  committedBytes: Uint8Array;
  commitment: Commitment;
};

export type PayloadResult<T> = { ok: true; value: T } | { ok: false };

/** Serialize the envelope; hash the original payload text without reserialization. */
export function sealPrivatePayload(
  payload: PrivatePayload
): PayloadResult<SealedPayload> {
  const parsed = PrivatePayload.safeParse(payload);
  if (!parsed.success) return { ok: false };

  const bytes = new TextEncoder().encode(JSON.stringify(parsed.data));
  const committedBytes = new TextEncoder().encode(parsed.data.payload);
  return {
    ok: true,
    value: { bytes, committedBytes, commitment: commitBytes(committedBytes) },
  };
}

/** Read received bytes back. The caller still checks them against the root. */
export function openPrivatePayload(
  bytes: Uint8Array
): PayloadResult<PrivatePayload> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return { ok: false };
  }
  const parsed = PrivatePayload.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

/** True when these bytes are the ones the root committed to under `commitment`. */
export function satisfiesCommitment(
  bytes: Uint8Array,
  commitment: Commitment
): boolean {
  return commitmentMatches(bytes, commitment);
}
