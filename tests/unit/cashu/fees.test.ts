import { describe, expect, it } from 'vitest';

import { computeFees } from '../../../src/lib/cashu/fees.ts';

const base = {
  gross: 10_000,
  bps: 100,
  minFee: 3,
  enabled: true,
  networkCost: 2,
  operation: 'settlement' as const,
  refundFeeMode: 'network_only' as const,
};

describe('computeFees', () => {
  it('charges a percentage above the floor', () => {
    expect(computeFees(base)).toEqual({
      gross: 10_000,
      operatorFee: 100,
      networkCost: 2,
      payout: 9_898,
    });
  });

  it('uses the sat floor when the percentage is lower', () => {
    expect(computeFees({ ...base, gross: 100, bps: 1 })).toMatchObject({
      operatorFee: 3,
      payout: 95,
    });
  });

  it('rounds the percentage up to a whole sat', () => {
    expect(
      computeFees({ ...base, gross: 101, bps: 100, minFee: 0, networkCost: 0 })
    ).toMatchObject({ operatorFee: 2, payout: 99 });
  });

  it('zeroes the operator fee when fees are disabled', () => {
    expect(computeFees({ ...base, enabled: false })).toMatchObject({
      operatorFee: 0,
      payout: 9_998,
    });
  });

  it('applies only network cost to a network-only refund', () => {
    expect(computeFees({ ...base, operation: 'refund' })).toMatchObject({
      operatorFee: 0,
      payout: 9_998,
    });
  });

  it('applies the operator fee to a full-fee refund', () => {
    expect(
      computeFees({
        ...base,
        operation: 'refund',
        refundFeeMode: 'full',
      })
    ).toMatchObject({ operatorFee: 100, payout: 9_898 });
  });

  it('rejects a payout exhausted by fees', () => {
    expect(() =>
      computeFees({ ...base, gross: 3, minFee: 3, networkCost: 0 })
    ).toThrowError(/exhaust/);
  });
});
