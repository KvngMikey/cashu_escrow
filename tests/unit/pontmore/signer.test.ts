import { describe, expect, it } from 'vitest';
import { nsecEncode, npubEncode } from 'nostr-tools/nip19';
import { verifyEvent } from 'nostr-tools/pure';

import { isEscrowError } from '../../../src/lib/errors.ts';
import {
  createSigner,
  verifySignedEvent,
} from '../../../src/lib/pontmore/signer.ts';
import { KIND_COORDINATION_ACTION } from '../../../src/lib/pontmore/kinds.ts';
import { CUSTOMER, OPERATOR } from '../support/keys.ts';

const note = {
  kind: KIND_COORDINATION_ACTION,
  tags: [['d', 'swap-1']],
  content: 'hello',
};

describe('createSigner', () => {
  it('derives the operator identity from the nsec', () => {
    expect(createSigner(OPERATOR.nsec).pubkey).toBe(OPERATOR.pubkey);
  });

  it('signs an event that verifies', () => {
    const signed = createSigner(OPERATOR.nsec).sign(note);

    expect(signed.pubkey).toBe(OPERATOR.pubkey);
    expect(signed.kind).toBe(KIND_COORDINATION_ACTION);
    expect(verifyEvent(signed)).toBe(true);
    expect(verifySignedEvent(signed)).toBe(true);
  });

  it('stamps now unless the caller sets a time', () => {
    const signer = createSigner(OPERATOR.nsec);
    const now = Math.floor(Date.now() / 1000);

    expect(signer.sign(note).created_at).toBeGreaterThanOrEqual(now);
    expect(signer.sign({ ...note, created_at: 1_700_000_000 }).created_at).toBe(
      1_700_000_000
    );
  });

  it('fails verification once an event is tampered with', () => {
    const signed = createSigner(OPERATOR.nsec).sign(note);

    expect(verifySignedEvent({ ...signed, content: 'goodbye' })).toBe(false);
    expect(verifySignedEvent({ ...signed, kind: 1 })).toBe(false);
    expect(verifySignedEvent({ ...signed, tags: [['d', 'swap-2']] })).toBe(
      false
    );
    expect(
      verifySignedEvent({ ...signed, created_at: signed.created_at + 1 })
    ).toBe(false);
    expect(verifySignedEvent({ ...signed, pubkey: CUSTOMER.pubkey })).toBe(
      false
    );
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects a signed invalid timestamp %s',
    (created_at) => {
      const event = createSigner(OPERATOR.nsec).sign({ ...note, created_at });
      expect(verifySignedEvent(event)).toBe(false);
    }
  );

  it('reports a malformed event as unverified rather than throwing', () => {
    const signed = createSigner(OPERATOR.nsec).sign(note);
    expect(verifySignedEvent({ ...signed, sig: 'zz' })).toBe(false);
    expect(verifySignedEvent({ ...signed, pubkey: '' })).toBe(false);
  });

  it('round trips a NIP-44 payload between two identities', () => {
    const operator = createSigner(OPERATOR.nsec);
    const customer = createSigner(CUSTOMER.nsec);

    const ciphertext = operator.nip44Encrypt(customer.pubkey, 'payout ready');
    expect(ciphertext).not.toContain('payout ready');
    expect(customer.nip44Decrypt(operator.pubkey, ciphertext)).toBe(
      'payout ready'
    );
  });

  it('refuses a peer pubkey that is not hex', () => {
    const signer = createSigner(OPERATOR.nsec);
    expect(() => signer.nip44Encrypt('nope', 'x')).toThrowError(/hex pubkey/);
    try {
      signer.nip44Decrypt('nope', 'x');
    } catch (error) {
      expect(isEscrowError(error) && error.category).toBe('content_invalid');
    }
  });

  it('rejects a key that is not an nsec, without echoing it', () => {
    const attempts = [
      { value: 'not-a-key', expected: /valid nsec/ },
      { value: npubEncode(OPERATOR.pubkey), expected: /not an nsec/ },
      { value: '', expected: /valid nsec/ },
    ];

    for (const { value, expected } of attempts) {
      let thrown: unknown;
      try {
        createSigner(value);
      } catch (error) {
        thrown = error;
      }

      expect(isEscrowError(thrown)).toBe(true);
      const error = thrown as Error;
      expect(error.message).toMatch(expected);
      if (value.length > 0) expect(error.message).not.toContain(value);
    }
  });

  it.each([0, 255])(
    'reports an invalid nsec scalar as a typed error (%s)',
    (byte) => {
      const nsec = nsecEncode(new Uint8Array(32).fill(byte));
      try {
        createSigner(nsec);
        throw new Error('expected invalid key');
      } catch (error) {
        expect(isEscrowError(error) && error.category).toBe('config_invalid');
        expect(String(error)).not.toContain(nsec);
      }
    }
  );

  it('never exposes the secret key', () => {
    const signer = createSigner(OPERATOR.nsec);
    const secretHex = Buffer.from(OPERATOR.secretKey).toString('hex');

    expect(Object.keys(signer)).toEqual([
      'pubkey',
      'sign',
      'nip44Encrypt',
      'nip44Decrypt',
    ]);
    expect(JSON.stringify(signer)).toBe(
      JSON.stringify({ pubkey: OPERATOR.pubkey })
    );
    expect(Object.isFrozen(signer)).toBe(true);

    const reachable = Object.values(signer)
      .map((value) => String(value))
      .join(' ');
    expect(reachable).not.toContain(secretHex);
    expect(reachable).not.toContain(OPERATOR.nsec);
  });
});
