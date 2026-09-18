/**
 * The PIP-02 v2 coordination kernel: validate a root, append `prev`-linked
 * actions, derive state. Pure and deterministic relay order and timestamps
 * never decide anything, the `prev` link does.
 */

import type { NostrEvent } from 'nostr-tools/pure';

import {
  ActionContent,
  ESCROW_ONLY_ACTIONS,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  KIND_ESCROW_DESCRIPTOR,
  EscrowDescriptorContent,
  ROLE_ESCROW,
  ROLE_RESOLVER,
  RootContent,
  isKernelAction,
  kernelDataSchema,
  parseActionTags,
  parseEventContent,
  parseRootTags,
  type Participant,
  type ResolutionEffect,
} from './kinds.ts';
import { verifySignedEvent } from './signer.ts';

// ── Rejection vocabulary ─────────────────────────────────────────────────
//
// Closed set: the conformance vectors name these strings, so adding one is a
// change to the vector contract.

export const REJECTION_REASONS = [
  // root and descriptor
  'root_kind',
  'root_signature',
  'root_content',
  'root_version',
  'root_tags',
  'profile_mismatch',
  'participant_roles',
  'escrow_authority',
  'resolver_authority',
  'commitment_key',
  'terms_invalid',
  'expiry_ordering',
  'descriptor_kind',
  'descriptor_signature',
  'descriptor_content',
  'descriptor_tags',
  'descriptor_network',
  'descriptor_id_mismatch',
  'descriptor_address_mismatch',
  'descriptor_after_root',
  'descriptor_expired',
  // actions
  'action_kind',
  'action_signature',
  'action_content',
  'action_version',
  'action_tags',
  'action_unknown',
  'action_data',
  'root_reference',
  'prev_reference',
  'duplicate_event',
  'replayed_action',
  'unauthorized_signer',
  'precondition',
  'deadline_passed',
  'payment_reference_mismatch',
  'ordering',
  'terminal',
  'frozen_disputed',
  'frozen_forked',
  'resolution_restricted',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

export type ChainResult<T> =
  { ok: true; value: T } | { ok: false; reason: RejectionReason };

const fail = <T>(reason: RejectionReason): ChainResult<T> => ({
  ok: false,
  reason,
});
const succeed = <T>(value: T): ChainResult<T> => ({ ok: true, value });

// ── Facts and state ──────────────────────────────────────────────────────

/** What the kernel knows about a coordination, derived only from the chain. */
export type ChainFacts<P> = {
  accepted: boolean;
  declined: boolean;
  secured: boolean;
  settlementAuthorized: boolean;
  refundAuthorized: boolean;
  settled: boolean;
  refunded: boolean;
  cancelled: boolean;
  expired: boolean;
  disputed: boolean;
  /** Set by a resolution effect: only this escrow action may follow. */
  restrictedTo: 'core/settle' | 'core/refund' | null;
  profile: P;
};

export type AppliedAction = {
  id: string;
  action: string;
  signer: string;
  at: number;
};

export type ChainState<P> = {
  forked: { predecessor: string; branches: readonly string[] } | null;
  tip: string;
  facts: ChainFacts<P>;
  applied: readonly AppliedAction[];
};

export type DerivedState<P> = {
  /** Reporting label; terminal states win, then fork, then dispute. */
  state: string;
  terminal: boolean;
  disputed: boolean;
  forked: { predecessor: string; branches: readonly string[] } | null;
  tip: string;
  facts: ChainFacts<P>;
  applied: readonly AppliedAction[];
  rejected: readonly { id: string; reason: RejectionReason }[];
};

// ── Profile adapter ──────────────────────────────────────────────────────

export type ProfileResult<T> = ChainResult<T>;

export type ValidatedRoot<T> = {
  id: string;
  proposer: string;
  createdAt: number;
  content: RootContent;
  terms: T;
  /** role → participant, from the root's `p` tags. */
  participants: ReadonlyMap<string, Participant>;
  /** pubkey → role. Every pubkey holds exactly one role. */
  roleOf: ReadonlyMap<string, string>;
  descriptorEventId: string;
  descriptorExpiresAt: number;
};

export type AuthorizeInput<T, P> = {
  root: ValidatedRoot<T>;
  facts: ChainFacts<P>;
  action: string;
  data: unknown;
  signer: string;
  at: number;
};

export type ProfileAdapter<T, P> = {
  /** `<ns>/<name>@<version>`, matched against the root's pinned profile. */
  id: string;
  /** When true, a root must bind a `core/resolver`. */
  permitsDisputes: boolean;
  /** Application roles every root must bind exactly once, to distinct keys. */
  applicationRoles: readonly string[];
  /** Commitment keys the profile permits in root content. */
  commitmentKeys: readonly string[];
  /** Profile-owned action identifiers. */
  actions: readonly string[];
  initialFacts(): P;
  parseTerms(input: {
    terms: unknown;
    descriptor: EscrowDescriptorContent;
    expiresAt: number;
    proposer: string;
    participants: ReadonlyMap<string, Participant>;
  }): ProfileResult<T>;
  /** Profile conditions for any action, kernel or profile-owned. */
  authorize(input: AuthorizeInput<T, P>): ProfileResult<P>;
  /** Label for profile progress between `secured` and authorization. */
  label(facts: ChainFacts<P>): string | null;
};

// ── Root validation ──────────────────────────────────────────────────────

/**
 * Validate a root against the exact descriptor revision it binds.
 *
 * The descriptor event is required, not assumed: a root that names a
 * descriptor we cannot check is a root we cannot take custody under.
 */
export function validateRoot<T, P>(input: {
  root: NostrEvent;
  descriptor: NostrEvent;
  profile: ProfileAdapter<T, P>;
}): ChainResult<ValidatedRoot<T>> {
  const { root, descriptor, profile } = input;

  if (root.kind !== KIND_COORDINATION_ROOT) return fail('root_kind');
  if (!verifySignedEvent(root)) return fail('root_signature');
  if (descriptor.kind !== KIND_ESCROW_DESCRIPTOR)
    return fail('descriptor_kind');
  if (!verifySignedEvent(descriptor)) return fail('descriptor_signature');

  const descriptorContent = parseEventContent(
    EscrowDescriptorContent,
    descriptor.content
  );
  if (!descriptorContent.ok) return fail('descriptor_content');

  const version = readVersion(root.content);
  if (version === null) return fail('root_content');
  if (version !== RootContent.shape.version.value) return fail('root_version');

  const content = parseEventContent(RootContent, root.content);
  if (!content.ok) return fail('root_content');
  if (content.value.profile !== profile.id) return fail('profile_mismatch');

  const tags = parseRootTags(root.tags);
  if (!tags.ok) return fail('root_tags');

  // Descriptor binding: same event, same address, selectable when the root
  // was created (PIP-01 lifecycle, PIP-02 root requirements).
  if (tags.value.descriptorEventId !== descriptor.id.toLowerCase()) {
    return fail('descriptor_id_mismatch');
  }
  const address = tags.value.descriptorAddress;
  const dTags = descriptor.tags.filter((tag) => tag[0] === 'd');
  const descriptorDTag = dTags[0]?.[1];
  if (dTags.length !== 1 || descriptorDTag === undefined)
    return fail('descriptor_tags');
  const networkPrefix = 'pontmore-network:';
  if (
    descriptor.tags.some(
      (tag) =>
        tag[0] === 't' &&
        tag[1]?.startsWith(networkPrefix) &&
        !descriptorContent.value.networks.includes(
          tag[1].slice(networkPrefix.length)
        )
    )
  )
    return fail('descriptor_tags');
  if (
    address.pubkey !== descriptor.pubkey.toLowerCase() ||
    address.dTag !== descriptorDTag
  ) {
    return fail('descriptor_address_mismatch');
  }
  if (descriptor.created_at > root.created_at)
    return fail('descriptor_after_root');
  if (descriptorContent.value.expires_at <= root.created_at)
    return fail('descriptor_expired');

  const participants = new Map<string, Participant>();
  const roleOf = new Map<string, string>();
  for (const participant of tags.value.participants) {
    if (participants.has(participant.role)) return fail('participant_roles');
    // A pubkey holds one role only; this profile permits no doubling up.
    if (roleOf.has(participant.pubkey)) return fail('participant_roles');
    participants.set(participant.role, participant);
    roleOf.set(participant.pubkey, participant.role);
  }

  if (!participants.has(ROLE_ESCROW)) return fail('escrow_authority');
  if (profile.permitsDisputes && !participants.has(ROLE_RESOLVER)) {
    return fail('resolver_authority');
  }
  const known = new Set<string>([
    ROLE_ESCROW,
    ROLE_RESOLVER,
    ...profile.applicationRoles,
  ]);
  for (const role of participants.keys()) {
    if (!known.has(role)) return fail('participant_roles');
  }
  for (const role of profile.applicationRoles) {
    if (!participants.has(role)) return fail('participant_roles');
  }

  for (const key of Object.keys(content.value.commitments ?? {})) {
    if (!profile.commitmentKeys.includes(key)) return fail('commitment_key');
  }

  const terms = profile.parseTerms({
    terms: content.value.terms,
    descriptor: descriptorContent.value,
    expiresAt: content.value.expires_at,
    proposer: root.pubkey.toLowerCase(),
    participants,
  });
  if (!terms.ok) return terms;

  return succeed({
    id: root.id.toLowerCase(),
    proposer: root.pubkey.toLowerCase(),
    createdAt: root.created_at,
    content: content.value,
    terms: terms.value,
    participants,
    roleOf,
    descriptorEventId: tags.value.descriptorEventId,
    descriptorExpiresAt: descriptorContent.value.expires_at,
  });
}

function readVersion(content: string): number | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const version = (parsed as { version?: unknown }).version;
    return typeof version === 'number' ? version : null;
  } catch {
    return null;
  }
}

// ── Action append ────────────────────────────────────────────────────────

/** Actions that may legitimately occur more than once in a chain. */
const REPEATABLE_ACTIONS = new Set([
  'core/open_dispute',
  'core/resolve_dispute',
]);

export function initialState<T, P>(
  root: ValidatedRoot<T>,
  profile: ProfileAdapter<T, P>
): ChainState<P> {
  return {
    tip: root.id,
    forked: null,
    applied: [],
    facts: {
      accepted: false,
      declined: false,
      secured: false,
      settlementAuthorized: false,
      refundAuthorized: false,
      settled: false,
      refunded: false,
      cancelled: false,
      expired: false,
      disputed: false,
      restrictedTo: null,
      profile: profile.initialFacts(),
    },
  };
}

export function isTerminal<P>(facts: ChainFacts<P>): boolean {
  return (
    facts.settled ||
    facts.refunded ||
    facts.cancelled ||
    facts.declined ||
    facts.expired
  );
}

/**
 * PIP-02 chain validation steps 1-7 for one action, then the kernel
 * invariants, then the profile's conditions. Returns the next state.
 */
export function appendAction<T, P>(input: {
  root: ValidatedRoot<T>;
  state: ChainState<P>;
  event: NostrEvent;
  profile: ProfileAdapter<T, P>;
}): ChainResult<ChainState<P>> {
  const { root, state, event, profile } = input;

  if (state.forked !== null) return fail('frozen_forked');
  if (event.kind !== KIND_COORDINATION_ACTION) return fail('action_kind');
  if (!verifySignedEvent(event)) return fail('action_signature');
  if (state.applied.some((applied) => applied.id === event.id))
    return fail('duplicate_event');

  const version = readVersion(event.content);
  if (version === null) return fail('action_content');
  if (version !== ActionContent.shape.version.value)
    return fail('action_version');

  const content = parseEventContent(ActionContent, event.content);
  if (!content.ok) return fail('action_content');

  const tags = parseActionTags(event.tags);
  if (!tags.ok) return fail('action_tags');
  if (tags.value.rootId !== root.id) return fail('root_reference');
  if (tags.value.prevId !== state.tip) return fail('prev_reference');

  const action = content.value.action;
  const kernel = isKernelAction(action);
  if (!kernel && !profile.actions.includes(action))
    return fail('action_unknown');

  const data = content.value.data ?? {};
  if (kernel && !kernelDataSchema(action).safeParse(data).success) {
    return fail('action_data');
  }

  if (action === 'core/accept' && event.created_at >= root.descriptorExpiresAt)
    return fail('descriptor_expired');

  const facts = state.facts;
  if (isTerminal(facts)) return fail('terminal');

  // A dispute freezes everything but its own resolution (I7).
  if (facts.disputed && action !== 'core/resolve_dispute')
    return fail('frozen_disputed');

  // A resolution effect narrows the chain to one escrow action.
  if (facts.restrictedTo !== null && action !== facts.restrictedTo) {
    return fail('resolution_restricted');
  }

  if (
    !REPEATABLE_ACTIONS.has(action) &&
    state.applied.some((a) => a.action === action)
  ) {
    return fail('replayed_action');
  }

  const signer = event.pubkey.toLowerCase();
  if ((ESCROW_ONLY_ACTIONS as readonly string[]).includes(action)) {
    if (root.participants.get(ROLE_ESCROW)?.pubkey !== signer) {
      return fail('unauthorized_signer');
    }
  }
  if (action === 'core/resolve_dispute') {
    if (root.participants.get(ROLE_RESOLVER)?.pubkey !== signer) {
      return fail('unauthorized_signer');
    }
    if (!facts.disputed) return fail('precondition');
  }

  // Kernel ordering invariants.
  if (action === 'core/secure' && !facts.accepted) return fail('ordering');
  if (action === 'core/authorize_settlement' && !facts.secured)
    return fail('ordering');
  if (action === 'core/settle' && !facts.settlementAuthorized)
    return fail('ordering');
  if (action === 'core/refund' && !facts.refundAuthorized)
    return fail('ordering');

  const authorized = profile.authorize({
    root,
    facts,
    action,
    data,
    signer,
    at: event.created_at,
  });
  if (!authorized.ok) return authorized;

  const next = applyEffects(facts, action, data, authorized.value);
  return succeed({
    tip: event.id.toLowerCase(),
    forked: null,
    facts: next,
    applied: [
      ...state.applied,
      { id: event.id.toLowerCase(), action, signer, at: event.created_at },
    ],
  });
}

function applyEffects<P>(
  facts: ChainFacts<P>,
  action: string,
  data: unknown,
  profileFacts: P
): ChainFacts<P> {
  const next: ChainFacts<P> = { ...facts, profile: profileFacts };

  switch (action) {
    case 'core/accept':
      next.accepted = true;
      break;
    case 'core/decline':
      next.declined = true;
      break;
    case 'core/secure':
      next.secured = true;
      break;
    case 'core/authorize_settlement':
      next.settlementAuthorized = true;
      break;
    case 'core/settle':
      next.settled = true;
      break;
    case 'core/authorize_refund':
      next.refundAuthorized = true;
      break;
    case 'core/refund':
      next.refunded = true;
      break;
    case 'core/cancel':
      next.cancelled = true;
      break;
    case 'core/expire':
      next.expired = true;
      break;
    case 'core/open_dispute':
      next.disputed = true;
      break;
    case 'core/resolve_dispute':
      applyResolution(next, resolutionEffect(data));
      break;
    default:
      break;
  }
  return next;
}

function resolutionEffect(data: unknown): ResolutionEffect {
  // The kernel data schema has already validated this action's data.
  return (data as { effect: ResolutionEffect }).effect;
}

function applyResolution<P>(
  facts: ChainFacts<P>,
  effect: ResolutionEffect
): void {
  facts.disputed = false;
  if (effect === 'authorize_settlement') {
    facts.settlementAuthorized = true;
    facts.restrictedTo = 'core/settle';
  } else if (effect === 'authorize_refund') {
    facts.refundAuthorized = true;
    facts.restrictedTo = 'core/refund';
  } else if (effect === 'cancel') {
    facts.cancelled = true;
  }
}

// ── Derivation ───────────────────────────────────────────────────────────

/**
 * Replay a set of actions onto a validated root.
 *
 * Input order is irrelevant: actions are followed by their `prev` link. Two
 * valid actions on the same predecessor are a fork both are retained, the
 * coordination freezes, and no winner is chosen.
 */
export function deriveState<T, P>(input: {
  root: ValidatedRoot<T>;
  actions: readonly NostrEvent[];
  profile: ProfileAdapter<T, P>;
}): DerivedState<P> {
  const { root, profile } = input;
  const rejected: { id: string; reason: RejectionReason }[] = [];

  const byId = new Map<string, NostrEvent>();
  for (const event of input.actions) {
    const id = event.id.toLowerCase();
    // Authenticate before deduplication: an invalid copy cannot reserve an ID.
    if (!verifySignedEvent(event)) {
      rejected.push({ id, reason: 'action_signature' });
      continue;
    }
    if (byId.has(id)) {
      rejected.push({ id, reason: 'duplicate_event' });
      continue;
    }
    byId.set(id, event);
  }

  let state = initialState(root, profile);
  let forked: DerivedState<P>['forked'] = null;
  const consumed = new Set<string>();

  for (;;) {
    const candidates = [...byId.entries()].filter(
      ([id, event]) =>
        !consumed.has(id) &&
        parseActionTags(event.tags).ok === true &&
        prevOf(event) === state.tip
    );
    if (candidates.length === 0) break;

    const outcomes = candidates.map(([id, event]) => ({
      id,
      event,
      result: appendAction({ root, state, event, profile }),
    }));
    const valid = outcomes.filter((outcome) => outcome.result.ok);

    if (valid.length > 1) {
      for (const outcome of outcomes) {
        consumed.add(outcome.id);
        if (!outcome.result.ok)
          rejected.push({ id: outcome.id, reason: outcome.result.reason });
      }
      forked = {
        predecessor: state.tip,
        branches: valid.map((outcome) => outcome.id).sort(),
      };
      break;
    }

    for (const outcome of outcomes) {
      consumed.add(outcome.id);
      if (!outcome.result.ok)
        rejected.push({ id: outcome.id, reason: outcome.result.reason });
    }

    const winner = valid[0];
    if (winner === undefined || !winner.result.ok) break;
    state = winner.result.value;
  }

  // Anything never reached never linked to the chain.
  for (const [id, event] of byId) {
    if (consumed.has(id)) continue;
    rejected.push({
      id,
      reason: parseActionTags(event.tags).ok ? 'prev_reference' : 'action_tags',
    });
  }

  return {
    state: label(state.facts, forked !== null, profile),
    terminal: isTerminal(state.facts),
    disputed: state.facts.disputed,
    forked,
    tip: state.tip,
    facts: state.facts,
    applied: state.applied,
    rejected,
  };
}

function prevOf(event: NostrEvent): string | null {
  const tags = parseActionTags(event.tags);
  return tags.ok ? tags.value.prevId : null;
}

function label<T, P>(
  facts: ChainFacts<P>,
  forked: boolean,
  profile: ProfileAdapter<T, P>
): string {
  if (facts.settled) return 'settled';
  if (facts.refunded) return 'refunded';
  if (facts.cancelled) return 'cancelled';
  if (facts.declined) return 'declined';
  if (facts.expired) return 'expired';
  if (forked) return 'forked';
  if (facts.disputed) return 'disputed';
  if (facts.refundAuthorized) return 'refund_authorized';
  if (facts.settlementAuthorized) return 'settlement_authorized';
  return (
    profile.label(facts) ??
    (facts.secured ? 'secured' : facts.accepted ? 'accepted' : 'proposed')
  );
}
