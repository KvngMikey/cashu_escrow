/**
 * The operator's signing identity.
 *
 * One rule shapes this module: the secret key never leaves it. It is decoded
 * once from the configured nsec into a closure and the returned object exposes
 * no accessor, no export, no serialisation of it — `JSON.stringify(signer)` is
 * `{"pubkey":"…"}`. That is why gift-wrap.ts assembles the NIP-59 layers
 * through this interface instead of calling nostr-tools' `nip59.wrapEvent`,
 * which takes a raw private key.
 */

import { decode } from 'nostr-tools/nip19';
import { decrypt, encrypt, getConversationKey } from 'nostr-tools/nip44';
import {
  finalizeEvent,
  getPublicKey,
  verifyEvent,
  type NostrEvent,
} from 'nostr-tools/pure';
import { EscrowError } from '../errors.ts';
import { assertHexPubkey, nowSeconds } from '../primitives.ts';

/** An event to be signed. `created_at` defaults to now. */
export type SignTemplate = {
  kind: number;
  tags: string[][];
  content: string;
  created_at?: number;
};

export interface EventSigner {
  /** The operator's public identity, lowercase hex. */
  readonly pubkey: string;
  sign(template: SignTemplate): NostrEvent;
  nip44Encrypt(peerPubkey: string, plaintext: string): string;
  nip44Decrypt(peerPubkey: string, ciphertext: string): string;
}

/**
 * Build a signer from an `nsec1…` key.
 *
 * Only the bech32 form is accepted: a raw hex key in the environment is
 * indistinguishable from a pubkey at a glance, and nsec is what a human hands
 * over. The key is never echoed, not even on failure.
 */
export function createSigner(nsec: string): EventSigner {
  const secretKey = decodeNsec(nsec);
  const pubkey = getPublicKey(secretKey);

  const signer: EventSigner = {
    pubkey,

    sign(template) {
      return finalizeEvent(
        {
          kind: template.kind,
          tags: template.tags,
          content: template.content,
          created_at: template.created_at ?? nowSeconds(),
        },
        secretKey
      );
    },

    nip44Encrypt(peerPubkey, plaintext) {
      assertHexPubkey(peerPubkey, 'recipient pubkey');
      return encrypt(plaintext, getConversationKey(secretKey, peerPubkey));
    },

    nip44Decrypt(peerPubkey, ciphertext) {
      assertHexPubkey(peerPubkey, 'sender pubkey');
      return decrypt(ciphertext, getConversationKey(secretKey, peerPubkey));
    },
  };

  return Object.freeze(signer);
}

function decodeNsec(nsec: string): Uint8Array {
  let decoded: ReturnType<typeof decode>;
  try {
    decoded = decode(nsec);
  } catch {
    throw new EscrowError('config_invalid', 'operator key is not a valid nsec');
  }
  if (decoded.type !== 'nsec') {
    throw new EscrowError(
      'config_invalid',
      `operator key is an ${decoded.type}, not an nsec`
    );
  }
  return decoded.data;
}

/**
 * True when an event's id matches its content and its signature matches its
 * pubkey. Every event that arrives from outside this process passes through
 * here before it is believed.
 */
export function verifySignedEvent(event: NostrEvent): boolean {
  try {
    return verifyEvent({
      id: event.id,
      pubkey: event.pubkey,
      created_at: event.created_at,
      kind: event.kind,
      tags: event.tags,
      content: event.content,
      sig: event.sig,
    });
  } catch {
    // Malformed hex in id/sig/pubkey makes the primitives throw; that is a
    // failed verification, not an exception the caller should handle.
    return false;
  }
}
