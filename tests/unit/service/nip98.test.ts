import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import {
  KIND_HTTP_AUTH,
  Nip98Authenticator,
} from '../../../src/service/nip98.ts';
import { MemoryOperatorStore } from '../support/fake-operator.ts';
import { OPERATOR } from '../support/keys.ts';

const signer = createSigner(OPERATOR.nsec);
const now = 1_800_000_000;
const url = 'https://escrow.example.com/v1/quotes';
const body = Buffer.from('{"gross_sats":1000}', 'utf8');

describe('NIP-98 authentication', () => {
  it('binds signer, URL, method, payload bytes, and one-time use', async () => {
    const authenticator = createAuthenticator();
    const authorization = auth({ body });
    await expect(
      authenticator.authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).resolves.toBe(OPERATOR.pubkey);
    await expect(
      authenticator.authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).rejects.toThrow(/authentication/);
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
  ])('rejects %s', async (_name, change) => {
    await expect(
      createAuthenticator().authenticate({
        authorization: auth({ body }),
        method: change.method ?? 'POST',
        url: change.requestUrl ?? url,
        body: change.requestBody ?? body,
        now: change.requestNow ?? now,
      })
    ).rejects.toThrow(/authentication/);
  });

  it('requires an empty-body request to omit the payload tag', async () => {
    await expect(
      createAuthenticator().authenticate({
        authorization: auth({ method: 'GET' }),
        method: 'GET',
        url,
        body: new Uint8Array(),
        now,
      })
    ).resolves.toBe(OPERATOR.pubkey);
  });

  it('keeps a future-dated authorization marked used through its full window', async () => {
    const authenticator = createAuthenticator();
    const authorization = auth({ body, createdAt: now + 60 });
    await authenticator.authenticate({
      authorization,
      method: 'POST',
      url,
      body,
      now,
    });

    await expect(
      authenticator.authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now: now + 61,
      })
    ).rejects.toThrow(/authentication/);
  });

  it('rejects a forged authorization signature', async () => {
    const encoded = auth({ body }).slice('Nostr '.length);
    const event = JSON.parse(
      Buffer.from(encoded, 'base64').toString('utf8')
    ) as {
      sig: string;
    };
    event.sig = '00'.repeat(64);
    const authorization = `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;

    await expect(
      createAuthenticator().authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now,
      })
    ).rejects.toThrow(/authentication/);
  });

  it('rejects replay after the authenticator restarts', async () => {
    const store = new MemoryOperatorStore();
    const authorization = auth({ body });
    await new Nip98Authenticator(store).authenticate({
      authorization,
      method: 'POST',
      url,
      body,
      now,
    });

    await expect(
      new Nip98Authenticator(store).authenticate({
        authorization,
        method: 'POST',
        url,
        body,
        now: now + 1,
      })
    ).rejects.toThrow(/authentication/);
  });
});

function createAuthenticator(): Nip98Authenticator {
  return new Nip98Authenticator(new MemoryOperatorStore());
}

function auth(input: {
  body?: Uint8Array;
  method?: string;
  createdAt?: number;
}): string {
  const event = signer.sign({
    kind: KIND_HTTP_AUTH,
    created_at: input.createdAt ?? now,
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
