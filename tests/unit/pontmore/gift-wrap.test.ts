import { describe, expect, it } from 'vitest';
import { getConversationKey, encrypt as nip44Encrypt } from 'nostr-tools/nip44';
import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  type NostrEvent,
} from 'nostr-tools/pure';
import {
  unwrapPrivateMessage,
  wrapPrivateMessage,
} from '../../../src/lib/pontmore/gift-wrap.ts';
import {
  KIND_GIFT_WRAP,
  KIND_RUMOR,
  KIND_SEAL,
} from '../../../src/lib/pontmore/kinds.ts';
import { isEscrowError } from '../../../src/lib/errors.ts';
import { PrivatePayload } from '../../../src/lib/private/payload.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import type { EventSigner } from '../../../src/lib/pontmore/signer.ts';
import { CUSTOMER, OPERATOR, STRANGER } from '../support/keys.ts';

const operator = createSigner(OPERATOR.nsec);
const customer = createSigner(CUSTOMER.nsec);
const stranger = createSigner(STRANGER.nsec);

const ROOT_ID = 'a'.repeat(64);
const fundingMessage = {
  version: 1 as const,
  profile: 'pontmore/swap@1',
  root: ROOT_ID,
  participants: [CUSTOMER.pubkey, OPERATOR.pubkey],
  type: 'escrow_funding',
  commitment_algorithm: 'sha256-bytes@1',
  payload: JSON.stringify({ token: `cashuB${'o'.repeat(64)}` }),
};

/**
 * Assemble the three NIP-59 layers by hand so a test can lie at any one of
 * them, that is the only way to prove unwrap catches the lie.
 */
function handCraftedWrap(options: {
  sealSigner: EventSigner;
  recipientPubkey: string;
  rumor: { pubkey: string; kind?: number; content: string; id?: string };
  tamperSeal?: (seal: NostrEvent) => NostrEvent;
}): NostrEvent {
  const rumorFields = {
    pubkey: options.rumor.pubkey,
    created_at: 1_800_000_000,
    kind: options.rumor.kind ?? KIND_RUMOR,
    tags: [['p', options.recipientPubkey]],
    content: options.rumor.content,
  };
  const rumor = {
    ...rumorFields,
    id: options.rumor.id ?? getEventHash(rumorFields),
  };

  const signed = options.sealSigner.sign({
    kind: KIND_SEAL,
    created_at: 1_800_000_000,
    tags: [],
    content: options.sealSigner.nip44Encrypt(
      options.recipientPubkey,
      JSON.stringify(rumor)
    ),
  });
  const seal = options.tamperSeal ? options.tamperSeal(signed) : signed;

  const ephemeralKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: 1_800_000_000,
      tags: [['p', options.recipientPubkey]],
      content: nip44Encrypt(
        JSON.stringify(seal),
        getConversationKey(ephemeralKey, options.recipientPubkey)
      ),
    },
    ephemeralKey
  );
}

/** Wrap an arbitrary string as if it were the seal layer. */
function wrapAroundSeal(sealJson: string): NostrEvent {
  const ephemeralKey = generateSecretKey();
  return finalizeEvent(
    {
      kind: KIND_GIFT_WRAP,
      created_at: 1_800_000_000,
      tags: [['p', OPERATOR.pubkey]],
      content: nip44Encrypt(
        sealJson,
        getConversationKey(ephemeralKey, OPERATOR.pubkey)
      ),
    },
    ephemeralKey
  );
}

describe('gift wrap round trip', () => {
  it('round trips JSON null without treating it as a parse error', () => {
    const result = unwrapPrivateMessage(
      customer,
      wrapPrivateMessage(operator, customer.pubkey, null)
    );
    expect(result.ok && result.envelope.payload).toBeNull();
  });
  it('delivers the payload and authenticates the sender', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, {
      hello: 'world',
    });
    const result = unwrapPrivateMessage(customer, wrap);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.payload).toEqual({ hello: 'world' });
    expect(result.envelope.senderPubkey).toBe(OPERATOR.pubkey);
    expect(result.envelope.sentAt).toBeGreaterThan(1_700_000_000);
  });

  it('carries a private-lane message the caller then validates', () => {
    const wrap = wrapPrivateMessage(customer, operator.pubkey, fundingMessage);
    const result = unwrapPrivateMessage(operator, wrap);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const parsed = PrivatePayload.safeParse(result.envelope.payload);
    expect(parsed.success && parsed.data.type).toBe('escrow_funding');
    expect(result.envelope.senderPubkey).toBe(CUSTOMER.pubkey);
  });

  it('leaks nothing on the public surface of the wrap', () => {
    const wrap = wrapPrivateMessage(customer, operator.pubkey, fundingMessage);

    expect(wrap.kind).toBe(KIND_GIFT_WRAP);
    expect(wrap.tags).toEqual([['p', OPERATOR.pubkey]]);
    // Signed by a throwaway key: the sender is not on the public surface.
    expect(wrap.pubkey).not.toBe(CUSTOMER.pubkey);
    expect(wrap.pubkey).not.toBe(OPERATOR.pubkey);

    const surface = JSON.stringify(wrap);
    expect(surface).not.toContain(ROOT_ID);
    expect(surface).not.toContain('cashuB');
    expect(surface).not.toContain('escrow_funding');
  });

  it('randomises the wrap timestamp into the past', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, { a: 1 });
    expect(wrap.created_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});

describe('gift wrap rejection', () => {
  it('redacts JSON serialization failures, including private object keys', () => {
    const secretKeyName = 'synthetic-private-field';
    const cycle: Record<string, unknown> = {};
    cycle[secretKeyName] = cycle;
    for (const value of [cycle, undefined, 1n]) {
      try {
        wrapPrivateMessage(operator, customer.pubkey, value);
        throw new Error('expected invalid JSON');
      } catch (error) {
        expect(isEscrowError(error) && error.category).toBe(
          'private_lane_invalid'
        );
        expect(String(error)).not.toContain(secretKeyName);
      }
    }
  });

  it('verifies the outer wrap before decrypting', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, null);
    expect(
      unwrapPrivateMessage(customer, { ...wrap, sig: '0'.repeat(128) })
    ).toEqual({ ok: false, reason: 'forged_wrap' });
  });
  it('will not open a wrap addressed to someone else', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, { a: 1 });
    expect(unwrapPrivateMessage(stranger, wrap)).toEqual({
      ok: false,
      reason: 'undecryptable',
    });
  });

  it('refuses an event that is not a gift wrap', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, { a: 1 });
    expect(unwrapPrivateMessage(customer, { ...wrap, kind: 1 })).toEqual({
      ok: false,
      reason: 'not_a_gift_wrap',
    });
  });

  it('refuses an oversized layer before decrypting it', () => {
    const wrap = wrapPrivateMessage(operator, customer.pubkey, { a: 1 });
    expect(
      unwrapPrivateMessage(customer, { ...wrap, content: 'x'.repeat(200_000) })
    ).toEqual({ ok: false, reason: 'oversized' });
  });

  it('refuses a seal whose signature no longer matches it', () => {
    const wrap = handCraftedWrap({
      sealSigner: stranger,
      recipientPubkey: operator.pubkey,
      rumor: { pubkey: STRANGER.pubkey, content: JSON.stringify({ a: 1 }) },
      // Signed, then edited: the content still decrypts, the signature no longer holds.
      tamperSeal: (seal) => ({ ...seal, created_at: seal.created_at + 1 }),
    });

    expect(unwrapPrivateMessage(operator, wrap)).toEqual({
      ok: false,
      reason: 'forged_seal',
    });
  });

  it('refuses a rumor that claims an author the seal did not sign for', () => {
    const wrap = handCraftedWrap({
      sealSigner: stranger,
      recipientPubkey: operator.pubkey,
      // The stranger seals a rumor that names the customer as its author.
      rumor: {
        pubkey: CUSTOMER.pubkey,
        content: JSON.stringify(fundingMessage),
      },
    });

    expect(unwrapPrivateMessage(operator, wrap)).toEqual({
      ok: false,
      reason: 'sender_mismatch',
    });
  });

  it('refuses a rumor whose id does not match its own fields', () => {
    const wrap = handCraftedWrap({
      sealSigner: customer,
      recipientPubkey: operator.pubkey,
      rumor: {
        pubkey: CUSTOMER.pubkey,
        content: JSON.stringify(fundingMessage),
        id: 'f'.repeat(64),
      },
    });

    expect(unwrapPrivateMessage(operator, wrap)).toEqual({
      ok: false,
      reason: 'sender_mismatch',
    });
  });

  it('refuses a wrap that does not hold a seal', () => {
    const notAnEvent = wrapAroundSeal('not an event');
    expect(unwrapPrivateMessage(operator, notAnEvent)).toEqual({
      ok: false,
      reason: 'malformed_seal',
    });

    // A properly signed event of the wrong kind is not a seal either.
    const wrongKind = wrapAroundSeal(
      JSON.stringify(customer.sign({ kind: 1, tags: [], content: 'hi' }))
    );
    expect(unwrapPrivateMessage(operator, wrongKind)).toEqual({
      ok: false,
      reason: 'malformed_seal',
    });
  });

  it('refuses an inner event that is not a rumor', () => {
    const wrap = handCraftedWrap({
      sealSigner: customer,
      recipientPubkey: operator.pubkey,
      rumor: { pubkey: CUSTOMER.pubkey, kind: 1, content: '{}' },
    });

    expect(unwrapPrivateMessage(operator, wrap)).toEqual({
      ok: false,
      reason: 'malformed_rumor',
    });
  });

  it('refuses a rumor whose payload is not JSON', () => {
    const wrap = handCraftedWrap({
      sealSigner: customer,
      recipientPubkey: operator.pubkey,
      rumor: { pubkey: CUSTOMER.pubkey, content: 'plain text' },
    });

    expect(unwrapPrivateMessage(operator, wrap)).toEqual({
      ok: false,
      reason: 'malformed_payload',
    });
  });

  it('refuses a recipient pubkey that is not hex', () => {
    expect(() => wrapPrivateMessage(operator, 'nope', { a: 1 })).toThrowError(
      /hex pubkey/
    );
  });
});
