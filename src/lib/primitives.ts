/**
 * Shared schema primitives and small value helpers used across the custody
 * layer. Protocol-shaped schemas live in `lib/pontmore/kinds.ts`; this file
 * holds only the pieces that more than one domain needs.
 */

import { z } from 'zod';

import { EscrowError } from './errors.ts';

/** 32-byte value in hex — Nostr pubkeys, event ids, sha256 digests. */
export const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

/** Printable, whitespace-free ASCII. Safe to carry in a Nostr tag value. */
const TAG_SAFE = /^[!-~]+$/;

const lower = (value: string): string => value.toLowerCase();

/** Nostr pubkey, normalised to lowercase hex so later comparisons are exact. */
export const HexPubkey = z
  .string()
  .regex(HEX_32_BYTES, 'expected a 64-character hex pubkey')
  .transform(lower);

/** Nostr event id, normalised to lowercase hex. */
export const HexEventId = z
  .string()
  .regex(HEX_32_BYTES, 'expected a 64-character hex event id')
  .transform(lower);

/** sha256 digest of a private artifact. */
export const HexSha256 = z
  .string()
  .regex(HEX_32_BYTES, 'expected a 64-character hex sha256 digest')
  .transform(lower);

export const UnixSeconds = z.number().int().positive();

/** Amounts on the bitcoin leg are whole satoshis. Never floats. */
export const SatAmount = z.number().int().positive();

/**
 * A swap id is also published as a `d` tag, so it stays tag-safe and bounded.
 */
export const SwapId = z.string().regex(TAG_SAFE).max(128);

/**
 * Free text that reaches a public event (a transition `reason`, a note).
 * Bounded so a caller cannot smuggle a token string into public state.
 */
export const PublicText = z.string().min(1).max(280);

/**
 * Parse a URL, or null if it is not one.
 */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/** Mint and service URLs. `http` stays allowed for a local Nutshell. */
export const HttpUrl = z.string().refine((value) => {
  const protocol = parseUrl(value)?.protocol;
  return protocol === 'https:' || protocol === 'http:';
}, 'expected an http(s) URL');

/** Current time in Nostr's unit. The single clock the protocol layer reads. */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Guard for values crossing into a crypto primitive that would otherwise fail
 * deep inside a dependency. `label` names the field, never its value.
 */
export function assertHexPubkey(value: string, label: string): void {
  if (!HEX_32_BYTES.test(value)) {
    throw new EscrowError(
      'content_invalid',
      `${label} is not a 64-character hex pubkey`
    );
  }
}
