import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import {
  KIND_HTTP_AUTH,
  Nip98Authenticator,
} from '../../../src/service/nip98.ts';
import { OPERATOR } from '../support/keys.ts';

const signer = createSigner(OPERATOR.nsec);
const now = 1_800_000_000;
const url = 'https://escrow.example.com/v1/quotes';
const body = Buffer.from('{"gross_sats":1000}', 'utf8');

describe('NIP-98 authentication', () => {
  it('binds signer, URL, method, payload bytes, and one-time use', () => {
    const authenticator = new Nip98Authenticator();
    const authorization = auth({ body });
    expect(
      authenticator.authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).toBe(OPERATOR.pubkey);
    expect(() =>
      authenticator.authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).toThrow(/authentication/);
  });

  it.each<
    [
      string,
      {
        requestUrl?: string;
        method?: string;
        requestBody?: Uint8Array;
        requestNow?: number;
      },
    ]
  >([
    ['wrong URL', { requestUrl: `${url}/other` }],
    ['wrong method', { method: 'PUT' }],
    ['wrong payload', { requestBody: Buffer.from('{}') }],
    ['stale', { requestNow: now + 61 }],
    ['future-dated', { requestNow: now - 61 }],
  ])('rejects %s', (_name, change) => {
    expect(() =>
      new Nip98Authenticator().authenticate({
        authorization: auth({ body }),
        method: change.method ?? 'POST',
        url: change.requestUrl ?? url,
        body: change.requestBody ?? body,
        now: change.requestNow ?? now,
      })
    ).toThrow(/authentication/);
  });

  it('requires an empty-body request to omit the payload tag', () => {
    expect(
      new Nip98Authenticator().authenticate({
        authorization: auth({ method: 'GET' }),
        method: 'GET',
        url,
        body: new Uint8Array(),
        now,
      })
    ).toBe(OPERATOR.pubkey);
  });

  it('rejects a forged authorization signature', () => {
    const encoded = auth({ body }).slice('Nostr '.length);
    const event = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    ) as {
      sig: string;
    };
    event.sig = '00'.repeat(64);
    const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;

    expect(() =>
      new Nip98Authenticator().authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).toThrow(/authentication/);
  });
});

function auth(input: { body?: Uint8Array; method?: string }): string {
  const event = signer.sign({
    kind: KIND_HTTP_AUTH,
    created_at: now,
    tags: [
      ['u', url],
      ['method', input.method ?? 'POST'],
      ...(input.body === undefined
        ? []
        : [['payload', createHash('sha256').update(input.body).digest('hex')]]),
    ],
    content: '',
  });
  return `Nostr ${Buffer.from(JSON.stringify(event), 'utf8').toString('base64')}`;
}
