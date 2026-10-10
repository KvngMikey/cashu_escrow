import { createHash } from 'node:crypto';

import type { NostrEvent } from 'nostr-tools/pure';
import { z } from 'zod';

import { EscrowError } from '../lib/errors.ts';
import { verifySignedEvent } from '../lib/pontmore/signer.ts';

export const KIND_HTTP_AUTH = 27_235 as const;
const AUTH_WINDOW_SECONDS = 60;
const MAX_AUTHORIZATION_CHARS = 16 * 1024;

const AuthEvent = z
  .object({
    id: z.string().regex(/^[0-9a-f]{64}$/),
    pubkey: z.string().regex(/^[0-9a-f]{64}$/),
    created_at: z.number().int().nonnegative(),
    kind: z.literal(KIND_HTTP_AUTH),
    tags: z.array(z.array(z.string())).max(16),
    content: z.literal(''),
    sig: z.string().regex(/^[0-9a-f]{128}$/),
  })
  .strict();

export type Nip98Request = {
  authorization: string | undefined;
  method: string;
  url: string;
  body: Uint8Array;
  now: number;
};

/** Verifies NIP-98 and rejects reuse of one authorization event. */
export class Nip98Authenticator {
  readonly #used = new Map<string, number>();

  authenticate(request: Nip98Request): string {
    this.#prune(request.now);
    const event = decodeAuthorization(request.authorization);
    if (
      Math.abs(event.created_at - request.now) > AUTH_WINDOW_SECONDS ||
      this.#used.has(event.id) ||
      !verifySignedEvent(event)
    ) {
      unauthorized();
    }

    const url = singleTag(event.tags, 'u');
    const method = singleTag(event.tags, 'method');
    if (url !== request.url || method !== request.method.toUpperCase()) {
      unauthorized();
    }

    const payloadTags = event.tags.filter((tag) => tag[0] === 'payload');
    if (request.body.length === 0) {
      if (payloadTags.length !== 0) unauthorized();
    } else {
      const expected = createHash('sha256').update(request.body).digest('hex');
      if (
        payloadTags.length !== 1 ||
        payloadTags[0]?.length !== 2 ||
        payloadTags[0]?.[1] !== expected
      ) {
        unauthorized();
      }
    }

    this.#used.set(event.id, event.created_at + AUTH_WINDOW_SECONDS);
    return event.pubkey;
  }

  #prune(now: number): void {
    for (const [id, expiresAt] of this.#used) {
      if (expiresAt < now) this.#used.delete(id);
    }
  }
}

function decodeAuthorization(header: string | undefined): NostrEvent {
  if (
    header === undefined ||
    header.length > MAX_AUTHORIZATION_CHARS ||
    !header.startsWith('Nostr ')
  ) {
    unauthorized();
  }
  const encoded = header.slice('Nostr '.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) unauthorized();

  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch {
    unauthorized();
  }
  const parsed = AuthEvent.safeParse(value);
  if (!parsed.success) unauthorized();
  return parsed.data;
}

function singleTag(tags: readonly string[][], name: string): string {
  const matches = tags.filter((tag) => tag[0] === name);
  const value = matches[0]?.[1];
  if (matches.length !== 1 || matches[0]?.length !== 2 || value === undefined) {
    unauthorized();
  }
  return value;
}

function unauthorized(): never {
  throw new EscrowError('request_unauthorized', 'NIP-98 authentication failed');
}
