import { describe, expect, it } from 'vitest';

import {
  DecimalAmountString,
  HttpUrl,
  HttpsUrl,
  OpaqueRef,
  SatAmount,
  SatAmountString,
  redactUrl,
} from '../../src/lib/primitives.ts';

describe('public-content primitives', () => {
  it('keeps an opaque reference opaque', () => {
    expect(OpaqueRef.safeParse('pay-ref_7f3a.91').success).toBe(true);
    // The shapes custody material actually takes: spaces, or simply too long
    // to be anything but a payload.
    for (const value of [
      'MPESA QGH7X2K9 254712345678',
      `cashuB${'o'.repeat(60)}`,
      `lnbc500u1p${'n'.repeat(80)}`,
      'acct 0123456789 Equity Bank',
      'a'.repeat(65),
      '',
    ]) {
      expect(OpaqueRef.safeParse(value).success).toBe(false);
    }
  });

  it('refuses zero and padded sat amounts', () => {
    expect(SatAmountString.safeParse('100000').success).toBe(true);
    for (const value of ['0', '000', '0100', '-1', '1.5', '1e6', '']) {
      expect(SatAmountString.safeParse(value).success).toBe(false);
    }
  });

  it('bounds sat amounts inside safe integer range', () => {
    expect(SatAmount.safeParse(2_100_000_000_000_000).success).toBe(true);
    expect(SatAmount.safeParse(2_100_000_000_000_001).success).toBe(false);
    expect(SatAmountString.safeParse('2100000000000001').success).toBe(false);
  });

  it('requires a positive decimal fiat amount', () => {
    expect(DecimalAmountString.safeParse('15000.00').success).toBe(true);
    expect(DecimalAmountString.safeParse(`0.${'0'.repeat(400)}1`).success).toBe(
      true
    );
    for (const value of ['0', '0.00', '.5', '1e3', '-2']) {
      expect(DecimalAmountString.safeParse(value).success).toBe(false);
    }
  });
});

describe('url handling', () => {
  it('allows plain http only to loopback', () => {
    expect(HttpUrl.safeParse('http://localhost:3338').success).toBe(true);
    expect(HttpUrl.safeParse('http://127.0.0.1:3338').success).toBe(true);
    expect(HttpUrl.safeParse('https://mint.example.com').success).toBe(true);
    expect(HttpUrl.safeParse('http://mint.example.com').success).toBe(false);
  });

  it('requires https where the spec does', () => {
    expect(
      HttpsUrl.safeParse('https://escrow.example.com/v1.json').success
    ).toBe(true);
    expect(HttpsUrl.safeParse('http://localhost/v1.json').success).toBe(false);
  });

  it('strips credentials and paths before a URL reaches an error', () => {
    expect(
      redactUrl('wss://user:password@relay.example.com/path?token=abc')
    ).toBe('wss://relay.example.com');
    expect(redactUrl('not a url')).toBe('<unparseable url>');
  });
});
