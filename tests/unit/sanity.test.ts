import { describe, expect, it } from 'vitest';

import { ESCROW_SUBTYPE, NETWORKS } from '../../src/index.ts';

// Toolchain sanity: proves TypeScript, nodenext ESM resolution and vitest are
// wired together before any custody code depends on them.
describe('toolchain', () => {
  it('resolves a strict-mode ESM import from src', () => {
    expect(ESCROW_SUBTYPE).toBe('cashu_escrow');
  });

  it('settles across cashu and lightning', () => {
    expect([...NETWORKS]).toEqual(['cashu', 'lightning']);
  });
});
