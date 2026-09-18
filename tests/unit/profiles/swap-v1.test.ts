import { describe, expect, it } from 'vitest';

import {
  SwapTerms,
  deriveRoles,
  feeBearer,
  swapV1,
} from '../../../src/lib/profiles/swap-v1.ts';
import { AGENT, CUSTOMER } from '../support/keys.ts';

const terms = {
  direction: 'btc_to_fiat' as const,
  fiat: { currency: 'KES', amount: '15000.00' },
  bitcoin: { amount: '100000', unit: 'sat' as const, network: 'cashu' },
  payment_channel: 'mpesa-ke-kes@1',
  deadlines: { fiat_pay_by: 1_800_002_000, fiat_confirm_by: 1_800_003_000 },
};

describe('swap-v1 terms', () => {
  it('accepts the profile example shape', () => {
    expect(SwapTerms.safeParse(terms).success).toBe(true);
  });

  it('refuses stray fields, bad currency codes and non-sat units', () => {
    expect(SwapTerms.safeParse({ ...terms, note: 'hi' }).success).toBe(false);
    expect(
      SwapTerms.safeParse({ ...terms, fiat: { currency: 'kes', amount: '1' } })
        .success
    ).toBe(false);
    expect(
      SwapTerms.safeParse({
        ...terms,
        bitcoin: { amount: '100000', unit: 'msat', network: 'cashu' },
      }).success
    ).toBe(false);
  });
});

describe('direction-derived roles', () => {
  it('flips fiat and bitcoin sides with the direction', () => {
    const btcToFiat = deriveRoles('btc_to_fiat', AGENT.pubkey, CUSTOMER.pubkey);
    expect(btcToFiat).toEqual({
      fiatSender: AGENT.pubkey,
      fiatReceiver: CUSTOMER.pubkey,
      bitcoinProvider: CUSTOMER.pubkey,
      bitcoinRecipient: AGENT.pubkey,
    });

    const fiatToBtc = deriveRoles('fiat_to_btc', AGENT.pubkey, CUSTOMER.pubkey);
    expect(fiatToBtc).toEqual({
      fiatSender: CUSTOMER.pubkey,
      fiatReceiver: AGENT.pubkey,
      bitcoinProvider: AGENT.pubkey,
      bitcoinRecipient: CUSTOMER.pubkey,
    });
  });

  it('puts the fee on whoever receives the sats', () => {
    expect(
      feeBearer(deriveRoles('btc_to_fiat', AGENT.pubkey, CUSTOMER.pubkey))
    ).toBe(AGENT.pubkey);
    expect(
      feeBearer(deriveRoles('fiat_to_btc', AGENT.pubkey, CUSTOMER.pubkey))
    ).toBe(CUSTOMER.pubkey);
  });
});

describe('profile declaration', () => {
  it('pins the identifier, roles, actions and commitment keys', () => {
    expect(swapV1.id).toBe('pontmore/swap@1');
    expect(swapV1.permitsDisputes).toBe(true);
    expect([...swapV1.applicationRoles]).toEqual([
      'swap/agent',
      'swap/customer',
    ]);
    expect([...swapV1.actions]).toEqual([
      'swap/fiat_sent',
      'swap/fiat_confirmed',
    ]);
    expect([...swapV1.commitmentKeys]).toEqual(['private_terms', 'quote']);
  });
});
