/** Synthetic keys for the unit suite. Fixed, fake, never used elsewhere. */

import { nsecEncode } from 'nostr-tools/nip19';
import { getPublicKey } from 'nostr-tools/pure';

function keyFromByte(byte: number) {
  const secretKey = new Uint8Array(32).fill(byte);
  return {
    secretKey,
    nsec: nsecEncode(secretKey),
    pubkey: getPublicKey(secretKey),
  };
}

export const OPERATOR = keyFromByte(0x11);
export const CUSTOMER = keyFromByte(0x22);
export const AGENT = keyFromByte(0x33);
export const STRANGER = keyFromByte(0x44);
