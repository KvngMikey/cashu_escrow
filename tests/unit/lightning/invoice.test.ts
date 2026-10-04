import { afterEach, describe, expect, it, vi } from 'vitest';

import { LnurlInvoiceSource } from '../../../src/lib/lightning/invoice.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LnurlInvoiceSource', () => {
  it('requests an exact-msat invoice from a Lightning Address', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            tag: 'payRequest',
            callback: 'https://pay.example.com/callback?nonce=1',
            minSendable: 1_000,
            maxSendable: 100_000,
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ pr: 'lnbc3fake' }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetch);

    await expect(
      new LnurlInvoiceSource().createInvoice('operator@example.com', 3)
    ).resolves.toBe('lnbc3fake');
    expect(fetch).toHaveBeenNthCalledWith(
      1,
      'https://example.com/.well-known/lnurlp/operator'
    );
    expect(String(fetch.mock.calls[1]?.[0])).toBe(
      'https://pay.example.com/callback?nonce=1&amount=3000'
    );
  });

  it('rejects invalid addresses and amounts outside provider limits', async () => {
    await expect(
      new LnurlInvoiceSource().createInvoice('invalid', 3)
    ).rejects.toMatchObject({ category: 'config_invalid' });

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            tag: 'payRequest',
            callback: 'https://pay.example.com/callback',
            minSendable: 5_000,
            maxSendable: 10_000,
          }),
          { status: 200 }
        )
      )
    );
    await expect(
      new LnurlInvoiceSource().createInvoice('operator@example.com', 3)
    ).rejects.toMatchObject({ category: 'custody_invalid' });
  });

  it('returns a typed error without exposing the failed endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('secret URL')));
    await expect(
      new LnurlInvoiceSource().createInvoice('operator@example.com', 3)
    ).rejects.toMatchObject({
      category: 'lightning_unavailable',
      message: 'operator Lightning invoice request failed',
    });
  });
});
