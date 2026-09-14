import { describe, expect, it } from 'vitest';

import {
  ACTOR_ROLES,
  CASHU_ESCROW_TRANSITIONS,
  SWAP_STATES,
  canTransition,
  holdsCustody,
  isTerminal,
  nextStatesFor,
  replayTransitions,
  type ActorRole,
  type SwapState,
  type TransitionStep,
} from '../../../src/lib/pontmore/states.ts';

let sequence = 0;
function step(
  from: SwapState,
  to: SwapState,
  role: ActorRole,
  at = 1_700_000_000 + sequence,
  id = `id-${String(sequence).padStart(3, '0')}`
): TransitionStep {
  sequence += 1;
  return { from, to, role, at, id };
}

/** The chain a clean swap leaves behind, in the order it happens. */
function happyPath(): TransitionStep[] {
  sequence = 0;
  return [
    step('requested', 'accepted', 'escrow'),
    step('accepted', 'funded', 'escrow'),
    step('funded', 'fiat_sent', 'agent'),
    step('fiat_sent', 'fiat_confirmed', 'customer'),
    step('fiat_confirmed', 'released', 'escrow'),
    step('released', 'completed', 'agent'),
  ];
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(
      (rest) => [item, ...rest]
    )
  );
}

describe('transition matrix', () => {
  it('covers every state in the vocabulary', () => {
    for (const state of SWAP_STATES) {
      expect(CASHU_ESCROW_TRANSITIONS[state]).toBeDefined();
    }
  });

  it('leaves terminal states with no outgoing transition for any role', () => {
    for (const state of SWAP_STATES.filter(isTerminal)) {
      for (const role of ACTOR_ROLES) {
        expect(nextStatesFor(state, role)).toEqual([]);
      }
    }
  });

  it('lets only the escrow publish a custody transition', () => {
    const custodyStates: SwapState[] = ['funded', 'released', 'refunded'];
    for (const from of SWAP_STATES) {
      for (const to of custodyStates) {
        expect(canTransition(from, to, 'customer')).toBe(false);
        expect(canTransition(from, to, 'agent')).toBe(false);
      }
    }
    expect(canTransition('accepted', 'funded', 'escrow')).toBe(true);
    expect(canTransition('fiat_confirmed', 'released', 'escrow')).toBe(true);
    expect(canTransition('funded', 'refunded', 'escrow')).toBe(true);
  });

  it('reaches `released` only from a confirmed fiat leg or a resolution', () => {
    const releasable = SWAP_STATES.filter((from) =>
      ACTOR_ROLES.some((role) => canTransition(from, 'released', role))
    );
    expect(releasable).toEqual(['fiat_confirmed', 'disputed', 'escalated']);
  });

  it('lets the escrow refund from every state where it holds custody', () => {
    for (const state of SWAP_STATES.filter(holdsCustody)) {
      expect(canTransition(state, 'refunded', 'escrow')).toBe(true);
    }
  });

  it('stops any party cancelling once the swap is funded', () => {
    for (const from of SWAP_STATES.filter(holdsCustody)) {
      for (const role of ACTOR_ROLES) {
        expect(canTransition(from, 'canceled', role)).toBe(false);
      }
    }
    expect(canTransition('accepted', 'canceled', 'customer')).toBe(true);
  });

  it('opens disputes from the counterparties and resolves them from the escrow', () => {
    expect(canTransition('funded', 'disputed', 'customer')).toBe(true);
    expect(canTransition('fiat_sent', 'disputed', 'agent')).toBe(true);
    expect(canTransition('funded', 'disputed', 'escrow')).toBe(false);

    expect(canTransition('disputed', 'released', 'escrow')).toBe(true);
    expect(canTransition('disputed', 'refunded', 'escrow')).toBe(true);
    expect(canTransition('disputed', 'escalated', 'escrow')).toBe(true);
    expect(canTransition('escalated', 'released', 'escrow')).toBe(true);

    expect(canTransition('disputed', 'released', 'agent')).toBe(false);
    expect(canTransition('disputed', 'completed', 'customer')).toBe(false);
  });

  it('refuses a transition the publishing role does not own', () => {
    expect(canTransition('fiat_sent', 'fiat_confirmed', 'agent')).toBe(false);
    expect(canTransition('funded', 'fiat_sent', 'customer')).toBe(false);
    expect(canTransition('requested', 'funded', 'escrow')).toBe(false);
    expect(canTransition('completed', 'released', 'escrow')).toBe(false);
  });

  it('marks exactly the states where funds are held', () => {
    expect(SWAP_STATES.filter(holdsCustody)).toEqual([
      'funded',
      'fiat_sent',
      'fiat_confirmed',
      'disputed',
      'escalated',
    ]);
  });
});

describe('replayTransitions', () => {
  it('derives the final state of a clean chain', () => {
    const result = replayTransitions(happyPath());
    expect(result.state).toBe('completed');
    expect(result.applied).toHaveLength(6);
    expect(result.rejected).toEqual([]);
  });

  it('starts from `requested` when there is nothing to replay', () => {
    expect(replayTransitions([]).state).toBe('requested');
  });

  it('is identical under every ordering of the same chain', () => {
    const chain = happyPath();
    const expected = replayTransitions(chain);

    for (const shuffled of permutations(chain)) {
      const result = replayTransitions(shuffled);
      expect(result.state).toBe(expected.state);
      expect(result.applied.map((s) => s.id)).toEqual(
        expected.applied.map((s) => s.id)
      );
      expect(result.rejected).toEqual([]);
    }
  });

  it('ignores a duplicate of an event it already applied', () => {
    const chain = happyPath();
    const duplicated = [...chain, ...chain.map((s) => ({ ...s }))];

    const result = replayTransitions(duplicated);
    expect(result.state).toBe('completed');
    expect(result.applied).toHaveLength(6);
    expect(result.rejected).toEqual([]);
  });

  it('rejects a republished transition that arrives with a fresh event id', () => {
    sequence = 0;
    const accepted = step('requested', 'accepted', 'escrow');
    const replayed = { ...accepted, id: 'id-replay', at: accepted.at + 5 };

    const result = replayTransitions([accepted, replayed]);
    expect(result.state).toBe('accepted');
    expect(result.rejected.map((s) => s.id)).toEqual(['id-replay']);
  });

  it('halts at the last valid state when a step is not permitted', () => {
    sequence = 0;
    const result = replayTransitions([
      step('requested', 'accepted', 'escrow'),
      step('accepted', 'funded', 'escrow'),
      // The agent cannot release; the chain stops here.
      step('funded', 'released', 'agent'),
    ]);

    expect(result.state).toBe('funded');
    expect(result.applied).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.to).toBe('released');
  });

  it('drops a stranger’s unlinked event without stranding the swap', () => {
    sequence = 0;
    const chain = [
      step('requested', 'accepted', 'escrow'),
      step('accepted', 'funded', 'escrow'),
    ];
    const junk = step(
      'released',
      'completed',
      'customer',
      1_700_000_000,
      'id-junk'
    );

    const result = replayTransitions([junk, ...chain]);
    expect(result.state).toBe('funded');
    expect(result.rejected.map((s) => s.id)).toEqual(['id-junk']);
  });

  it('resolves a fork as earliest-valid-wins and keeps the loser visible', () => {
    sequence = 0;
    const accepted = step(
      'requested',
      'accepted',
      'escrow',
      1_700_000_000,
      'id-a'
    );
    const funded = step('accepted', 'funded', 'escrow', 1_700_000_100, 'id-b');
    const disputeFirst = step(
      'funded',
      'disputed',
      'customer',
      1_700_000_200,
      'id-c'
    );
    const fiatSentLater = step(
      'funded',
      'fiat_sent',
      'agent',
      1_700_000_300,
      'id-d'
    );

    const result = replayTransitions([
      fiatSentLater,
      disputeFirst,
      funded,
      accepted,
    ]);
    expect(result.state).toBe('disputed');
    expect(result.rejected.map((s) => s.id)).toEqual(['id-d']);
  });

  it('breaks a same-second tie by event id, in both input orders', () => {
    sequence = 0;
    const accepted = step(
      'requested',
      'accepted',
      'escrow',
      1_700_000_000,
      'id-a'
    );
    const funded = step('accepted', 'funded', 'escrow', 1_700_000_100, 'id-b');
    const dispute = step(
      'funded',
      'disputed',
      'customer',
      1_700_000_200,
      'id-c'
    );
    const fiatSent = step(
      'funded',
      'fiat_sent',
      'agent',
      1_700_000_200,
      'id-d'
    );

    for (const order of [
      [accepted, funded, dispute, fiatSent],
      [fiatSent, dispute, funded, accepted],
    ]) {
      const result = replayTransitions(order);
      expect(result.state).toBe('disputed');
      expect(result.rejected.map((s) => s.id)).toEqual(['id-d']);
    }
  });
});
