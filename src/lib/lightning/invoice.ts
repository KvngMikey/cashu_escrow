import { z } from 'zod';

import { EscrowError } from '../errors.ts';

export interface LightningInvoiceSource {
  createInvoice(address: string, amountSats: number): Promise<string>;
}

const Address = /^([a-zA-Z0-9._-]+)@([a-zA-Z0-9.-]+)$/;
const PayMetadata = z
  .object({
    tag: z.literal('payRequest'),
    callback: z.string().url(),
    minSendable: z.number().int().nonnegative(),
    maxSendable: z.number().int().nonnegative(),
  })
  .passthrough();
const InvoiceResponse = z.object({ pr: z.string().min(1) }).passthrough();
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_BACKOFF_MS = [250, 750] as const;

/** Resolve a Lightning Address and request a fixed-amount LNURL-pay invoice. */
export class LnurlInvoiceSource implements LightningInvoiceSource {
  async createInvoice(address: string, amountSats: number): Promise<string> {
    if (!Number.isSafeInteger(amountSats) || amountSats <= 0) {
      throw new EscrowError('content_invalid', 'invoice amount is invalid');
    }
    const match = Address.exec(address);
    const name = match?.[1];
    const domain = match?.[2];
    if (name === undefined || domain === undefined) {
      throw new EscrowError(
        'config_invalid',
        'operator Lightning address is invalid'
      );
    }
    const amountMsat = amountSats * 1_000;
    if (!Number.isSafeInteger(amountMsat)) {
      throw new EscrowError('content_invalid', 'invoice amount is invalid');
    }
    try {
      const metadataResponse = await fetchLnurl(
        `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`
      );
      if (!metadataResponse.ok) throw new Error();
      const metadata = PayMetadata.parse(await metadataResponse.json());
      if (
        metadata.minSendable > metadata.maxSendable ||
        amountMsat < metadata.minSendable ||
        amountMsat > metadata.maxSendable
      ) {
        throw new EscrowError(
          'custody_invalid',
          'operator fee is outside the Lightning address limits'
        );
      }
      const callback = new URL(metadata.callback);
      if (callback.protocol !== 'https:') throw new Error();
      callback.searchParams.set('amount', String(amountMsat));
      const invoiceResponse = await fetchLnurl(callback);
      if (!invoiceResponse.ok) throw new Error();
      return InvoiceResponse.parse(await invoiceResponse.json()).pr;
    } catch (error) {
      if (error instanceof EscrowError) throw error;
      throw new EscrowError(
        'lightning_unavailable',
        'operator Lightning invoice request failed'
      );
    }
  }
}

async function fetchLnurl(url: string | URL): Promise<Response> {
  for (let attempt = 0; attempt <= RETRY_BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) {
      await delay(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok || !retryableStatus(response.status)) return response;
    } catch {
      if (attempt === RETRY_BACKOFF_MS.length) throw new Error();
      continue;
    }
    if (attempt === RETRY_BACKOFF_MS.length) throw new Error();
  }
  throw new Error();
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
