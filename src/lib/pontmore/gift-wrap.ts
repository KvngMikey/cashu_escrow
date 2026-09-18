/**
 * NIP-59 Gift Wrap, the private lane PIP-02 requires for invoices, payout
 * instructions and, here, the locked Cashu token itself.
 *
 * Three layers:
 *   rumor (kind 14)   unsigned inner message; content is the payload JSON
 *   seal  (kind 13)   signed by the SENDER; content is nip44(sender → recipient, rumor)
 *   wrap  (kind 1059) signed by a throwaway EPHEMERAL key; content is
 *                     nip44(ephemeral → recipient, seal)
 *
 * Built on `EventSigner` rather than nostr-tools' `nip59` helpers because
 * those take a raw private key and this operator's key never leaves its
 * closure (see signer.ts). The crypto primitives are still nostr-tools'
 * NIP-44 — nothing here is hand-rolled.
 *
 * The seal and wrap timestamps are randomised into the past, per NIP-59, so a
 * relay timeline leaks nothing about when a swap was funded. The only public
 * tag is `["p", recipient]`: the `swap_id` stays inside the encrypted rumor,
 * so a swap's public chain cannot be joined to its private messages.
 *
 * This module is transport. It moves an opaque payload and authenticates the
 * sender; it does not know what a payload means. Callers validate what comes
 * back with the private-lane envelope and the selected service schema.
 */

import { z } from 'zod';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  type NostrEvent,
} from 'nostr-tools/pure';

import { EscrowError } from '../errors.ts';
import { assertHexPubkey, nowSeconds } from '../primitives.ts';
import { KIND_GIFT_WRAP, KIND_RUMOR, KIND_SEAL } from './kinds.ts';
import type { EventSigner } from './signer.ts';
import { verifySignedEvent } from './signer.ts';

const TWO_DAYS_SECONDS = 2 * 24 * 60 * 60;

/**
 * Ceiling on an encrypted layer before it is handed to NIP-44 decryption,
 * which nostr-tools asks callers to bound. A funding message carrying a Cashu
 * token is a few kilobytes; anything near this is not ours.
 */
const MAX_LAYER_CHARS = 128 * 1024;

const TagArray = z.array(z.array(z.string()));

/** Structural shape of a signed event arriving from outside this process. */
const SignedEventShape = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number(),
  kind: z.number(),
  tags: TagArray,
  content: z.string(),
  sig: z.string(),
});

/** A rumor is an unsigned event: it carries an id but no signature. */
const RumorShape = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number(),
  kind: z.number(),
  tags: TagArray,
  content: z.string(),
});

export type PrivateEnvelope = {
  /** Authenticated sender, taken from the signed seal, never from the rumor. */
  senderPubkey: string;
  /** The payload as JSON. The caller validates it. */
  payload: unknown;
  /** Real send time, recovered from the rumor, not the randomised wrap time. */
  sentAt: number;
};

/**
 * Why a wrap was not opened.
 */
export type UnwrapFailure =
  | 'not_a_gift_wrap'
  | 'forged_wrap'
  | 'oversized'
  | 'undecryptable'
  | 'malformed_seal'
  | 'forged_seal'
  | 'malformed_rumor'
  | 'sender_mismatch'
  | 'malformed_payload';

export type UnwrapResult =
  | { ok: true; envelope: PrivateEnvelope }
  | { ok: false; reason: UnwrapFailure };

/** A timestamp up to two days in the past, per NIP-59 timing privacy. */
function randomPastTimestamp(): number {
  return nowSeconds() - Math.floor(Math.random() * TWO_DAYS_SECONDS);
}

/**
 * Wrap `payload` for `recipientPubkey`. Returns the kind-1059 event, ready to
 * publish. Nothing is published here, the caller owns the relay.
 */
export function wrapPrivateMessage(
  signer: EventSigner,
  recipientPubkey: string,
  payload: unknown
): NostrEvent {
  assertHexPubkey(recipientPubkey, 'recipient pubkey');
  const recipient = recipientPubkey.toLowerCase();

  const rumorBase = {
    pubkey: signer.pubkey,
    created_at: nowSeconds(),
    kind: KIND_RUMOR,
    tags: [['p', recipient]],
    content: serializePayload(payload),
  };
  const rumor = { ...rumorBase, id: getEventHash(rumorBase) };

  const seal = signer.sign({
    kind: KIND_SEAL,
    created_at: randomPastTimestamp(),
    tags: [],
    content: signer.nip44Encrypt(recipient, JSON.stringify(rumor)),
  });

  const ephemeralKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: randomPastTimestamp(),
      tags: [['p', recipient]],
      content: nip44Encrypt(
        JSON.stringify(seal),
        getConversationKey(ephemeralKey, recipient)
      ),
    },
    ephemeralKey
  );
}

/**
 * Open a kind-1059 wrap addressed to the signer.
 */
export function unwrapPrivateMessage(
  signer: EventSigner,
  wrap: NostrEvent
): UnwrapResult {
  if (wrap.kind !== KIND_GIFT_WRAP)
    return { ok: false, reason: 'not_a_gift_wrap' };
  if (wrap.content.length > MAX_LAYER_CHARS)
    return { ok: false, reason: 'oversized' };

  if (!verifySignedEvent(wrap)) return { ok: false, reason: 'forged_wrap' };

  const sealJson = decryptOrNull(signer, wrap.pubkey, wrap.content);
  if (sealJson === null) return { ok: false, reason: 'undecryptable' };

  const sealJsonValue = parseJson(sealJson);
  const seal = SignedEventShape.safeParse(
    sealJsonValue.ok ? sealJsonValue.value : undefined
  );
  if (!seal.success || seal.data.kind !== KIND_SEAL) {
    return { ok: false, reason: 'malformed_seal' };
  }
  if (seal.data.content.length > MAX_LAYER_CHARS) {
    return { ok: false, reason: 'oversized' };
  }
  if (!verifySignedEvent(seal.data))
    return { ok: false, reason: 'forged_seal' };

  const rumorJson = decryptOrNull(signer, seal.data.pubkey, seal.data.content);
  if (rumorJson === null) return { ok: false, reason: 'undecryptable' };

  const rumorJsonValue = parseJson(rumorJson);
  const rumor = RumorShape.safeParse(
    rumorJsonValue.ok ? rumorJsonValue.value : undefined
  );
  if (!rumor.success || rumor.data.kind !== KIND_RUMOR) {
    return { ok: false, reason: 'malformed_rumor' };
  }

  // The seal's signature is the only proof of authorship. A rumor claiming a
  // different author, or one whose id does not match its own fields, has been
  // rewritten somewhere between the sender and here.
  const { id, ...rumorFields } = rumor.data;
  if (
    rumor.data.pubkey !== seal.data.pubkey ||
    getEventHash(rumorFields) !== id
  ) {
    return { ok: false, reason: 'sender_mismatch' };
  }

  // Tagged, so a payload that is literally `null` is told apart from one that
  // did not parse.
  const payload = parseJson(rumor.data.content);
  if (!payload.ok) return { ok: false, reason: 'malformed_payload' };

  return {
    ok: true,
    envelope: {
      senderPubkey: seal.data.pubkey,
      payload: payload.value,
      sentAt: rumor.data.created_at,
    },
  };
}

function decryptOrNull(
  signer: EventSigner,
  peerPubkey: string,
  ciphertext: string
): string | null {
  try {
    return signer.nip44Decrypt(peerPubkey, ciphertext);
  } catch {
    return null;
  }
}

type JsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(raw: string): JsonResult {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** JSON failures may name private object keys, so never expose native errors. */
function serializePayload(payload: unknown): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    throw new EscrowError(
      'private_lane_invalid',
      'private payload is not serializable JSON'
    );
  }
  if (json === undefined)
    throw new EscrowError(
      'private_lane_invalid',
      'private payload is not serializable JSON'
    );
  return json;
}
