/**
 * Shared schema primitives. Protocol shapes live in `lib/pontmore/kinds.ts`;
 * this file holds what more than one domain needs.
 */

import { z } from 'zod';

import { EscrowError } from './errors.ts';

/** 32-byte value in hex — Nostr pubkeys, event ids, sha256 digests. */
export const HEX_32_BYTES = /^[0-9a-f]{64}$/i;

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

export const UnixSeconds = z.number().int().positive();

/**
 * Largest sat amount this operator will reason about. Below `Number.MAX_SAFE_INTEGER`
 * and far above any plausible coordination, so integer maths cannot silently lose
 * precision on a value that decides a payout.
 */
export const MAX_SATS = 2_100_000_000_000_000;

/** Sat amount as a number. Positive, integral, bounded. */
export const SatAmount = z.number().int().positive().max(MAX_SATS);

/**
 * Sat amount as it appears in public terms: a positive base-10 integer string
 * with no leading zeros, no sign, no exponent. `0` and `000` are not amounts.
 */
export const SatAmountString = z
  .string()
  .regex(/^[1-9][0-9]*$/, 'expected a positive integer sat amount')
  .refine((value) => Number(value) <= MAX_SATS, 'sat amount out of range');

/**
 * Positive base-10 decimal string, no exponent — the fiat amount shape the
 * profile requires. Rejects `0`, `0.00` and bare `.5`.
 */
export const DecimalAmountString = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/, 'expected a positive decimal amount')
  .refine((value) => /[1-9]/.test(value), 'amount must be greater than zero');

/**
 * The only free-form shape allowed in public content: an opaque reference.
 * This bounds syntax, not meaning: callers must use generated identifiers or
 * commitments, never account numbers, credentials, or other private values.
 */
export const OpaqueRef = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'expected an opaque reference');

/** Parse a URL, or null if it is not one. */
export function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/** True for a host that cannot leave the machine. */
export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Service and mint URLs. HTTPS anywhere; plain HTTP only to loopback, where a
 * local Nutshell lives and nothing crosses a wire.
 */
export const HttpUrl = z.string().refine((value) => {
  const url = parseUrl(value);
  if (url === null) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}, 'expected an https URL (http only for loopback)');

/** Absolute https URL. No loopback exception — PIP-01 schema URLs. */
export const HttpsUrl = z
  .string()
  .refine(
    (value) => parseUrl(value)?.protocol === 'https:',
    'expected an https URL'
  );

/**
 * A URL with any credentials and query removed, safe to name in an error.
 * Falls back to a constant when the value will not parse.
 */
export function redactUrl(value: string): string {
  const url = parseUrl(value);
  if (url === null) return '<unparseable url>';
  return `${url.protocol}//${url.host}`;
}

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
