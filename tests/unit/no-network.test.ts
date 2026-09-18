import { describe, expect, it } from 'vitest';

// The unit suite's no-network guard (tests/unit/setup.ts) is only worth
// anything if it is actually installed. This proves it is.
describe('unit suite isolation', () => {
  it('blocks fetch', () => {
    expect(() => fetch('https://example.com')).toThrowError(/must not touch/);
  });

  it('blocks WebSocket', () => {
    expect(() => new WebSocket('wss://relay.example.com')).toThrowError(
      /must not touch/
    );
  });
});
