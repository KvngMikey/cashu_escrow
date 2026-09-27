import { readFileSync } from 'node:fs';

import { parse } from 'dotenv';
import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../src/config/index.ts';
import { isEscrowError } from '../../src/lib/errors.ts';
import { CUSTOMER, OPERATOR } from './support/keys.ts';

const environment = () => ({
  NOSTR_RELAYS: 'wss://relay.one, wss://relay.two',
  OPERATOR_NSEC: OPERATOR.nsec,
  RESOLVER_NSEC: CUSTOMER.nsec,
  MINT_URL: 'http://localhost:3338',
  DESCRIPTOR_D_TAG: 'cashu-main',
  DESCRIPTOR_TTL_SECONDS: '2592000',
  SERVICE_BASE_URL: 'https://escrow.example.com',
  SCHEMA_URL: 'https://escrow.example.com/v1/openapi.json',
  FEES_ENABLED: 'false',
  OPERATOR_FEE_BPS: '100',
  OPERATOR_MIN_FEE_SATS: '3',
  MIN_COORDINATION_SATS: '100',
  REFUND_FEE_MODE: 'network_only',
  RETURN_LN_OVERAGE: 'true',
  OPERATOR_LN_ADDRESS: 'operator@example.com',
  QUOTE_TTL_SECONDS: '600',
  DEFAULT_PAYOUT_TYPE: 'cashu_p2pk',
  RELEASE_SAFETY_MARGIN_SECONDS: '600',
  DISPUTE_WINDOW_SECONDS: '3600',
  MIN_LOCKTIME_SECONDS: '1800',
  CUSTODY_STORE_PATH: './data/custody.enc',
});

describe('configuration', () => {
  it('keeps .env.example in sync with the required environment', () => {
    const example = parse(
      readFileSync(new URL('../../.env.example', import.meta.url))
    );

    expect(() =>
      loadConfig({
        ...example,
        OPERATOR_NSEC: OPERATOR.nsec,
        RESOLVER_NSEC: CUSTOMER.nsec,
      })
    ).not.toThrow();
  });

  it('parses booleans, enums, numbers, relays, and signer identities', () => {
    const config = loadConfig(environment());

    expect(config.nostrRelays).toEqual(['wss://relay.one', 'wss://relay.two']);
    expect(config.feesEnabled).toBe(false);
    expect(config.returnLnOverage).toBe(true);
    expect(config.refundFeeMode).toBe('network_only');
    expect(config.operatorFeeBps).toBe(100);
    expect(config.operatorSigner.pubkey).toBe(OPERATOR.pubkey);
    expect(config.resolverSigner.pubkey).toBe(CUSTOMER.pubkey);
  });

  it('fails fast when operator and resolver are the same identity', () => {
    const failure = capture(() =>
      loadConfig({ ...environment(), RESOLVER_NSEC: OPERATOR.nsec })
    );

    expect(isEscrowError(failure) && failure.category).toBe('config_invalid');
    expect(isEscrowError(failure) && failure.message).toMatch(/must differ/);
  });

  it('rejects an impossible minimum fee policy', () => {
    const failure = capture(() =>
      loadConfig({
        ...environment(),
        OPERATOR_MIN_FEE_SATS: '101',
        MIN_COORDINATION_SATS: '100',
      })
    );

    expect(isEscrowError(failure) && failure.category).toBe('config_invalid');
  });

  it('does not coerce arbitrary strings to true', () => {
    const failure = capture(() =>
      loadConfig({ ...environment(), FEES_ENABLED: 'yes' })
    );

    expect(isEscrowError(failure) && failure.category).toBe('config_invalid');
  });
});

function capture(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}
