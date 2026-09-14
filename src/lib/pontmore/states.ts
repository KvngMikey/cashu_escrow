/**
 * PIP-02 state vocabulary and transition matrix for the `cashu_escrow` subtype.
 *
 * Two things differ from the reference `fiat_to_btc` vocabulary:
 *
 *   1. **Direction.** A cashu escrow swap runs the other way: the customer locks ecash
 *      and the agent is paid in sats on release, i.e. `btc_to_fiat`. The fiat
 *      leg roles therefore invert, the AGENT publishes `fiat_sent`, the
 *      CUSTOMER publishes `fiat_confirmed`.
 *   2. **Custody is escrow-attested.** Here role-play transitions are
 *      the public record of a real custody action, so only the escrow
 *      operator may publish them.
 *
 * This module is pure vocabulary. It knows nothing about WHY a release was
 * triggered and it does not authenticate anybody: an `actor_role` on a
 * 7301 is self-asserted, so the caller MUST bind the role to the event's
 * pubkey (from the 7300's `customer` / `agent` fields and the
 * escrow's own pubkey) before replaying a chain.
 */

export const SWAP_STATES = [
  'requested',
  'accepted',
  'funded',
  'fiat_sent',
  'fiat_confirmed',
  'released',
  'completed',
  'expired',
  'canceled',
  'refunded',
  'disputed',
  'escalated',
] as const;

export type SwapState = (typeof SWAP_STATES)[number];

/** The state every swap chain starts from, established by the 7300 itself. */
export const INITIAL_STATE: SwapState = 'requested';

export const ACTOR_ROLES = ['customer', 'agent', 'escrow'] as const;
export type ActorRole = (typeof ACTOR_ROLES)[number];

/** PIP-03 public dispute surface: opened, escalated, resolved. */
export const DISPUTE_STAGES = ['opened', 'escalated', 'resolved'] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

/** PIP-03 dispute classes. */
export const DISPUTE_CLASSES = [
  'payment_not_received',
  'payment_amount_mismatch',
  'payout_not_sent',
  'payout_amount_mismatch',
  'escrow_funding_failure',
  'conflicting_external_confirmations',
  'fraud_or_impersonation_risk',
  'timeout_or_abandonment',
] as const;
export type DisputeClass = (typeof DISPUTE_CLASSES)[number];

/**
 * PIP-03 resolution modes. `split_outcome` is listed by the spec but a
 * P2PK-locked token is released or refunded whole, so this operator never
 * publishes it; it is here so a foreign resolution still parses.
 */
export const RESOLUTION_MODES = [
  'confirm_customer_claim',
  'confirm_agent_claim',
  'split_outcome',
  'cancel_and_refund',
  'escalate_to_manual_review',
] as const;
export type ResolutionMode = (typeof RESOLUTION_MODES)[number];

const TERMINAL_STATES: ReadonlySet<SwapState> = new Set<SwapState>([
  'completed',
  'expired',
  'canceled',
  'refunded',
]);

/** States with no outgoing transition for any role. */
export function isTerminal(state: SwapState): boolean {
  return TERMINAL_STATES.has(state);
}

/**
 * States in which the operator is holding the buyer's locked proofs: from the
 * moment funding is attested until release or refund is published. Restart
 * recovery uses this to decide which swaps still need a custody decision.
 */
const CUSTODY_STATES: ReadonlySet<SwapState> = new Set<SwapState>([
  'funded',
  'fiat_sent',
  'fiat_confirmed',
  'disputed',
  'escalated',
]);

export function holdsCustody(state: SwapState): boolean {
  return CUSTODY_STATES.has(state);
}

/**
 * Transition matrix. Outer key: current state. Inner key: the actor role
 * permitted to drive the move. Value: the states that role may move to.
 */
export type TransitionMatrix = Readonly<
  Record<SwapState, Readonly<Partial<Record<ActorRole, readonly SwapState[]>>>>
>;

/**
 * The `cashu_escrow` matrix.
 *
 * Deliberate properties, each of which a test pins:
 *
 *   - Custody transitions (`funded`, `released`, `refunded`) are escrow-only.
 *   - `released` is reachable only from `fiat_confirmed` or from an explicit
 *     dispute resolution — the operator can never release on its own say-so
 *     before the customer confirms the fiat leg.
 *   - `refunded` is reachable by the escrow from every custody state,
 *     including `disputed` and `escalated`: locktime expiry dominates a
 *     dispute and a missed release window is a refund.
 *   - Once funded, no party can unilaterally cancel. Backing out goes through
 *     refund or dispute.
 *   - A dispute is opened by a counterparty, never by the escrow; only the
 *     escrow resolves one.
 */
export const CASHU_ESCROW_TRANSITIONS: TransitionMatrix = {
  requested: {
    customer: ['canceled'],
    agent: ['accepted', 'canceled'],
    escrow: ['accepted', 'expired'],
  },
  accepted: {
    customer: ['canceled'],
    agent: ['canceled'],
    // Funding timeout: the buyer never sent a locked token.
    escrow: ['funded', 'expired'],
  },
  funded: {
    customer: ['disputed'],
    agent: ['fiat_sent', 'disputed'],
    escrow: ['refunded'],
  },
  fiat_sent: {
    customer: ['fiat_confirmed', 'disputed'],
    agent: ['disputed'],
    escrow: ['refunded'],
  },
  fiat_confirmed: {
    customer: ['disputed'],
    agent: ['disputed'],
    escrow: ['released', 'refunded'],
  },
  released: {
    customer: ['completed'],
    agent: ['completed'],
    escrow: ['completed'],
  },
  disputed: {
    escrow: ['escalated', 'released', 'refunded'],
  },
  escalated: {
    escrow: ['released', 'refunded'],
  },
  completed: {},
  expired: {},
  canceled: {},
  refunded: {},
};

export function canTransition(
  from: SwapState,
  to: SwapState,
  role: ActorRole,
  matrix: TransitionMatrix = CASHU_ESCROW_TRANSITIONS
): boolean {
  return matrix[from][role]?.includes(to) ?? false;
}

export function nextStatesFor(
  state: SwapState,
  role: ActorRole,
  matrix: TransitionMatrix = CASHU_ESCROW_TRANSITIONS
): readonly SwapState[] {
  return matrix[state][role] ?? [];
}

/** One 7301, reduced to the facts replay needs. */
export type TransitionStep = {
  /** `prev_state` from the transition content. */
  from: SwapState;
  /** `state` from the transition content. */
  to: SwapState;
  /** Role of the publisher, already bound to the event pubkey by the caller. */
  role: ActorRole;
  /** Unix seconds; used only to order the chain. */
  at: number;
  /** Event id; makes the ordering total, so replay is deterministic. */
  id: string;
};

export type ReplayResult = {
  /** State derived by walking the chain from `requested`. */
  state: SwapState;
  /** The steps that linked and were legal, in applied order. */
  applied: readonly TransitionStep[];
  /**
   * Steps that never linked to the walk or that the matrix refused: forks,
   * duplicates, replays, and transitions published by a role without the
   * authority to make them. Never fatal, anyone can publish a 7301 into a
   * swap's `d` tag, and a stranger's junk must not strand a funded swap.
   */
  rejected: readonly TransitionStep[];
};

const byTimeThenId = (a: TransitionStep, b: TransitionStep): number =>
  a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Derive the current state of a swap from its 7301 chain.
 *
 * Relays return events unordered and `created_at` is only second-resolution,
 * so the chain is walked by `prev_state → state` linkage from `requested`,
 * with (`at`, `id`) as the tiebreak when several candidates link to the same
 * state. The result is therefore identical for any input ordering, which is
 * what makes restart recovery safe.
 */
export function replayTransitions(
  steps: Iterable<TransitionStep>,
  matrix: TransitionMatrix = CASHU_ESCROW_TRANSITIONS
): ReplayResult {
  const unique = new Map<string, TransitionStep>();
  for (const step of steps) {
    if (!unique.has(step.id)) unique.set(step.id, step);
  }

  const pending = [...unique.values()].sort(byTimeThenId);
  const applied: TransitionStep[] = [];
  let state: SwapState = INITIAL_STATE;

  for (;;) {
    const index = pending.findIndex(
      (step) =>
        step.from === state &&
        canTransition(step.from, step.to, step.role, matrix)
    );
    if (index === -1) break;

    const [step] = pending.splice(index, 1);
    // findIndex returned a hit, so the splice always yields one step.
    if (!step) break;
    applied.push(step);
    state = step.to;
  }

  return { state, applied, rejected: pending };
}
