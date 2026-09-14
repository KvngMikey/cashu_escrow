import { describe, expect, it } from 'vitest';

import { EscrowError, isEscrowError } from '../../src/lib/errors.ts';

describe('EscrowError', () => {
  it('carries a category and the swap it belongs to', () => {
    const error = new EscrowError('relay_unavailable', 'every relay refused', {
      swapId: 'swap-1',
    });

    expect(error.category).toBe('relay_unavailable');
    expect(error.swapId).toBe('swap-1');
    expect(error.name).toBe('EscrowError');
    expect(error).toBeInstanceOf(Error);
    expect(isEscrowError(error)).toBe(true);
  });

  it('has no swap id when the failure has no swap', () => {
    expect(
      new EscrowError('config_invalid', 'no relays configured').swapId
    ).toBe(undefined);
  });

  it('exposes no cause channel for material to travel through', () => {
    const error = new EscrowError('content_invalid', 'failed at: token');
    expect(error.cause).toBe(undefined);
    expect(isEscrowError(new Error('plain'))).toBe(false);
  });
});
