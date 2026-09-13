/**
 * cashu_escrow — escrow operator for the `cashu_escrow` canonical subtype of
 * Pontmore PIP-01.
 *
 * Spec: https://github.com/pontmore/protocol
 */

/** The canonical Pontmore PIP-01 escrow subtype this operator implements. */
export const ESCROW_SUBTYPE = 'cashu_escrow';

/** Networks this operator settles across, in the order the descriptor lists them. */
export const NETWORKS = ['cashu', 'lightning'] as const;

export type Network = (typeof NETWORKS)[number];
