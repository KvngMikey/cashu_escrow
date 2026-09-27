/** PIP-01 discovery facts published by this operator. */
export {
  ESCROW_TYPE,
  ESCROW_NETWORKS as NETWORKS,
} from './lib/pontmore/descriptor.ts';
export type { EscrowNetwork as Network } from './lib/pontmore/descriptor.ts';

/** The only coordination profile this operator supports today. */
export { PROFILE_ID, swapV1 } from './lib/profiles/swap-v1.ts';
