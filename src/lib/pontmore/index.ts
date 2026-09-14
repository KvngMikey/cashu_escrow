/**
 * The Pontmore protocol layer: kinds and schemas, the state machine, the
 * signer, the relay seam and the private lane.
 *
 * This barrel is the module's public surface. It exports vocabulary,
 * validators and narrow interfaces — never a raw pool, wallet or key.
 * Callers import from here, not from the files behind it.
 */

export * from './kinds.ts';
export * from './states.ts';
export * from './signer.ts';
export * from './relay.ts';
export * from './gift-wrap.ts';
