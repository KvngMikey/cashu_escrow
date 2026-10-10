import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { EscrowError } from '../../../src/lib/errors.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { KIND_HTTP_AUTH } from '../../../src/service/nip98.ts';
import { EscrowHttpService } from '../../../src/service/server.ts';
import { OPERATOR } from '../support/keys.ts';

const now = 1_800_000_000;
const baseUrl = 'https://escrow.example.com';
const signer = createSigner(OPERATOR.nsec);

describe('EscrowHttpService', () => {
  it('serves OpenAPI without authentication', async () => {
    const { service } = setup();
    await expect(
      service.handle({ method: 'GET', path: '/v1/openapi.json' })
    ).resolves.toMatchObject({ status: 200, body: '{"openapi":"3.1.0"}' });
  });

  it('authenticates and validates exact quote request bytes', async () => {
    const { service, operator } = setup();
    const payload = {
      profile: 'pontmore/swap@1',
      terms_digest: `sha256:${'aa'.repeat(32)}`,
      direction: 'btc_to_fiat',
      gross_sats: 1_000,
      payout_type: 'cashu_p2pk',
    };
    const body = Buffer.from(JSON.stringify(payload));
    const path = '/v1/quotes';
    const response = await service.handle({
      method: 'POST',
      path,
      authorization: authorization('POST', path, body),
      body,
    });

    expect(response.status).toBe(200);
    expect(operator.createQuote).toHaveBeenCalledWith(payload, now);
  });

  it('returns safe errors without internal messages or private material', async () => {
    const { service, operator } = setup();
    const id = 'bb'.repeat(32);
    operator.refund.mockRejectedValueOnce(
      new EscrowError('custody_conflict', 'token cashu-private unavailable', {
        swapId: id,
      })
    );
    const path = `/v1/coordinations/${id}/refund`;
    const response = await service.handle({
      method: 'GET',
      path,
      authorization: authorization('GET', path),
    });

    expect(response.status).toBe(409);
    expect(response.body).toBe(
      JSON.stringify({ category: 'custody_conflict', coordination_id: id })
    );
    expect(response.body).not.toContain('cashu-private');
  });
});

function setup() {
  const operator = {
    createQuote: vi.fn().mockResolvedValue({ quote: true }),
    fundingInstructions: vi.fn(),
    submitFunding: vi.fn(),
    putPayout: vi.fn(),
    status: vi.fn(),
    refund: vi.fn(),
  };
  const service = new EscrowHttpService({
    operator,
    serviceBaseUrl: baseUrl,
    openApi: { openapi: '3.1.0' },
    clock: () => now,
  });
  return { service, operator };
}

function authorization(
  method: string,
  path: string,
  body?: Uint8Array
): string {
  const event = signer.sign({
    kind: KIND_HTTP_AUTH,
    created_at: now,
    tags: [
      ['u', `${baseUrl}${path}`],
      ['method', method],
      ...(body === undefined
        ? []
        : [['payload', createHash('sha256').update(body).digest('hex')]]),
    ],
    content: '',
  });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}
