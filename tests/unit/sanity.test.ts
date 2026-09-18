import { describe, expect, it } from 'vitest';

import { ESCROW_TYPE, NETWORKS, PROFILE_ID } from '../../src/index.ts';

describe('toolchain', () => {
  it('resolves a strict-mode ESM import from src', () => {
    expect(ESCROW_TYPE).toBe('cashu_escrow');
    expect(PROFILE_ID).toBe('pontmore/swap@1');
  });

  it('settles across cashu and lightning', () => {
    expect([...NETWORKS]).toEqual(['cashu', 'lightning']);
  });
});
