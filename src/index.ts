/** PIP-01 `escrow_type` this operator publishes. */
export const ESCROW_TYPE = 'cashu_escrow';

/** Networks this operator settles across. */
export const NETWORKS = ['cashu', 'lightning'] as const;
export type Network = (typeof NETWORKS)[number];

/** The only coordination profile this operator supports today. */
export { PROFILE_ID, swapV1 } from './lib/profiles/swap-v1.ts';
