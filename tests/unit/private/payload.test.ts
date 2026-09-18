import { describe, expect, it } from 'vitest';

import {
  openPrivatePayload,
  satisfiesCommitment,
  sealPrivatePayload,
  type PrivatePayload,
} from '../../../src/lib/private/payload.ts';
import { commitBytes } from '../../../src/lib/pontmore/kinds.ts';
import { CUSTOMER, OPERATOR } from '../support/keys.ts';

const payload = (): PrivatePayload => ({
  version: 1,
  profile: 'pontmore/swap@1',
  root: 'a'.repeat(64),
  participants: [CUSTOMER.pubkey, OPERATOR.pubkey],
  commitment_key: 'private_terms',
  type: 'payment_terms',
  commitment_algorithm: 'sha256-bytes@1',
  payload: '{ "till": "123456", "account": "redacted" }',
});

describe('private payload envelope', () => {
  it('preserves exact payload bytes independently of the root-bound envelope', () => {
    const sealed = sealPrivatePayload(payload());
    expect(sealed.ok).toBe(true);
    if (!sealed.ok) return;

    expect(
      satisfiesCommitment(sealed.value.committedBytes, sealed.value.commitment)
    ).toBe(true);

    const opened = openPrivatePayload(sealed.value.bytes);
    expect(opened.ok && opened.value.type).toBe('payment_terms');
    expect(opened.ok && opened.value.root).toBe('a'.repeat(64));
  });

  it('can commit before the root exists and attach the resulting root later', () => {
    const input = payload();
    const expected = commitBytes(new TextEncoder().encode(input.payload));
    const first = sealPrivatePayload(input);
    const second = sealPrivatePayload({ ...input, root: 'b'.repeat(64) });
    expect(first.ok && first.value.commitment).toEqual(expected);
    expect(second.ok && second.value.commitment).toEqual(expected);
    if (!second.ok) return;
    const opened = openPrivatePayload(second.value.bytes);
    expect(opened.ok && opened.value.payload).toBe(input.payload);
  });

  it('rejects malformed UTF-8 instead of silently replacing bytes', () => {
    const bytes = new TextEncoder().encode(JSON.stringify(payload()));
    const at = bytes.indexOf('t'.charCodeAt(0));
    bytes[at] = 255;
    expect(openPrivatePayload(bytes).ok).toBe(false);
  });

  it('fails the commitment when a byte changes', () => {
    const sealed = sealPrivatePayload(payload());
    if (!sealed.ok) return;

    const tampered = new TextEncoder().encode(
      new TextDecoder()
        .decode(sealed.value.committedBytes)
        .replace('123456', '654321')
    );
    expect(satisfiesCommitment(tampered, sealed.value.commitment)).toBe(false);
  });

  it('refuses an envelope that names no coordination', () => {
    const { root: _root, ...withoutRoot } = payload();
    expect(sealPrivatePayload(withoutRoot as PrivatePayload).ok).toBe(false);
    expect(openPrivatePayload(new TextEncoder().encode('not json')).ok).toBe(
      false
    );
  });
});
