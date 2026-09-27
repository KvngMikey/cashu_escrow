import { readFile } from 'node:fs/promises';

import { validate } from '@scalar/openapi-parser';
import { describe, expect, it } from 'vitest';

const schemaPath = new URL('../../openapi/escrow-v1.json', import.meta.url);

describe('OpenAPI service contract', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const source = await readFile(schemaPath, 'utf8');
    const result = await validate(source);

    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('declares the complete M3 service surface and safety extensions', async () => {
    const document = JSON.parse(await readFile(schemaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const paths = document.paths as Record<string, unknown>;

    expect(Object.keys(paths).sort()).toEqual(
      [
        '/v1/coordinations/{id}',
        '/v1/coordinations/{id}/funding',
        '/v1/coordinations/{id}/funding-instructions',
        '/v1/coordinations/{id}/payout',
        '/v1/coordinations/{id}/refund',
        '/v1/openapi.json',
        '/v1/quotes',
      ].sort()
    );
    expect(document['x-pontmore-escrow-type']).toBe('cashu_escrow');
    expect(document['x-pontmore-profiles']).toEqual(['pontmore/swap@1']);
    expect(document['x-pontmore-payout-types']).toEqual([
      'cashu_p2pk',
      'bolt11',
    ]);
    expect(document['x-pontmore-lock-mechanism']).toEqual({
      type: 'p2pk_timelock',
      required_nuts: [7, 10, 11],
    });
    expect(document['x-pontmore-timing']).toEqual({
      min_locktime_seconds: 1800,
      release_safety_margin_seconds: 600,
      dispute_window_seconds: 3600,
      settlement_after_release_margin: 'unavailable',
    });
    expect(document['x-pontmore-resolution-effects']).toEqual([
      'resume',
      'authorize_settlement',
      'authorize_refund',
      'cancel',
    ]);
    expect(document['x-pontmore-quote']).toMatchObject({
      hash: 'sha256',
      signature: 'bip340-schnorr',
      public_key: 'the bound core/escrow Nostr pubkey',
    });
    expect(document['x-pontmore-expiry-recovery']).toMatchObject({
      public_refund_requires:
        'core/authorize_refund or a valid authorize_refund resolution effect',
    });
    expect(document).not.toHaveProperty('pricing_policy');

    const quoteRequest = (
      (document.components as Record<string, unknown>).schemas as Record<
        string,
        Record<string, unknown>
      >
    ).QuoteRequest;
    expect(quoteRequest?.properties).not.toHaveProperty('network_cost_sats');
  });
});
