/**
 * Generates the `pontmore/swap@1` conformance vectors under `vectors/`.
 *
 * Vectors hold fully signed events so any implementation can replay them
 * without our code or our keys. Keys and timestamps are fixed, so rebuilding
 * reproduces the same files byte for byte.
 *
 * Run: npm run vectors:build
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { format } from 'prettier';

import { schnorr } from '@noble/curves/secp256k1.js';
import { getEventHash, getPublicKey } from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

import {
  COORDINATION_VERSION,
  EscrowDescriptorContent,
  KIND_AGENT_DEFINITION,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  KIND_ESCROW_DESCRIPTOR,
  ROLE_ESCROW,
  ROLE_RESOLVER,
  buildActionTags,
  buildEventContent,
  buildRootTags,
  formatAddress,
} from '../src/lib/pontmore/kinds.ts';
import {
  ACTION_FIAT_CONFIRMED,
  ACTION_FIAT_SENT,
  PROFILE_ID,
  ROLE_AGENT,
  ROLE_CUSTOMER,
  type Direction,
} from '../src/lib/profiles/swap-v1.ts';

const SPEC_COMMIT = 'd9a1eb3';

/**
 * BIP-340 auxiliary randomness, fixed to zero. Signatures verify the same
 * either way, and fixing it makes a rebuild byte-identical, these files are a
 * published artifact, not scratch output.
 */
const ZERO_AUX = new Uint8Array(32);
const OUT_DIR = join(import.meta.dirname, '..', 'vectors');

function key(byte: number) {
  const secretKey = new Uint8Array(32).fill(byte);
  return { secretKey, pubkey: getPublicKey(secretKey) };
}

const KEYS = {
  agent: key(0xa1),
  customer: key(0xc1),
  escrow: key(0xe1),
  resolver: key(0x1e),
  stranger: key(0x5a),
};
type Key = (typeof KEYS)[keyof typeof KEYS];

type EventTemplate = {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
};

function signEvent(template: EventTemplate, key: Key): NostrEvent {
  const unsigned = { ...template, pubkey: key.pubkey };
  const id = getEventHash(unsigned);
  const sig = Buffer.from(
    schnorr.sign(Buffer.from(id, 'hex'), key.secretKey, ZERO_AUX)
  ).toString('hex');
  return { ...unsigned, id, sig };
}

// ── Fixed timeline ───────────────────────────────────────────────────────

const T0 = 1_800_000_000;
const TIME = {
  descriptorCreated: T0,
  descriptorExpires: T0 + 100_000,
  rootCreated: T0 + 100,
  accept: T0 + 200,
  secure: T0 + 300,
  expiresAt: T0 + 1_000,
  fiatSent: T0 + 1_500,
  fiatPayBy: T0 + 2_000,
  afterPayBy: T0 + 2_100,
  fiatConfirmed: T0 + 2_500,
  fiatConfirmBy: T0 + 3_000,
  authorize: T0 + 2_600,
  final: T0 + 2_700,
};

const D_TAG = 'cashu-main';
const PAYMENT_REF = 'pay-ref-7f3a91';

// ── Event builders ───────────────────────────────────────────────────────

type DescriptorOptions = {
  createdAt?: number;
  expiresAt?: number;
  dTag?: string;
};

function descriptorEvent(options: DescriptorOptions = {}): NostrEvent {
  const dTag = options.dTag ?? D_TAG;
  return signEvent(
    {
      kind: KIND_ESCROW_DESCRIPTOR,
      created_at: options.createdAt ?? TIME.descriptorCreated,
      tags: [
        ['d', dTag],
        ['t', 'pontmore-network:cashu'],
        ['t', 'pontmore-network:lightning'],
      ],
      content: buildEventContent(
        EscrowDescriptorContent,
        {
          version: 1,
          escrow_type: 'cashu_escrow',
          networks: ['cashu', 'lightning'],
          expires_at: options.expiresAt ?? TIME.descriptorExpires,
          service: {
            schema: {
              type: 'openapi',
              url: 'https://escrow.example.com/v1/openapi.json',
            },
          },
        },
        { label: 'descriptor' }
      ),
    },
    KEYS.escrow
  );
}

function terms(direction: Direction, overrides: Record<string, unknown> = {}) {
  return {
    direction,
    fiat: { currency: 'KES', amount: '15000.00' },
    bitcoin: { amount: '100000', unit: 'sat', network: 'cashu' },
    payment_channel: 'mpesa-ke-kes@1',
    deadlines: {
      fiat_pay_by: TIME.fiatPayBy,
      fiat_confirm_by: TIME.fiatConfirmBy,
    },
    ...overrides,
  };
}

type RootOptions = {
  direction?: Direction;
  proposer?: Key;
  descriptor: NostrEvent;
  createdAt?: number;
  expiresAt?: number;
  termsOverride?: Record<string, unknown>;
  commitments?: Record<string, { algorithm: string; digest: string }>;
  profile?: string;
  version?: number;
  tags?: string[][];
  descriptorEventId?: string;
  descriptorAddress?: string;
  participants?: { pubkey: string; role: string }[];
};

function rootEvent(options: RootOptions): NostrEvent {
  const direction = options.direction ?? 'btc_to_fiat';
  const proposer = options.proposer ?? KEYS.customer;
  const participants = options.participants ?? [
    { pubkey: KEYS.agent.pubkey, role: ROLE_AGENT },
    { pubkey: KEYS.customer.pubkey, role: ROLE_CUSTOMER },
    { pubkey: KEYS.escrow.pubkey, role: ROLE_ESCROW },
    { pubkey: KEYS.resolver.pubkey, role: ROLE_RESOLVER },
  ];

  const content = {
    version: options.version ?? COORDINATION_VERSION,
    profile: options.profile ?? PROFILE_ID,
    terms: options.termsOverride ?? terms(direction),
    expires_at: options.expiresAt ?? TIME.expiresAt,
    ...(options.commitments === undefined
      ? {}
      : { commitments: options.commitments }),
  };

  return signEvent(
    {
      kind: KIND_COORDINATION_ROOT,
      created_at: options.createdAt ?? TIME.rootCreated,
      tags:
        options.tags ??
        buildRootTags({
          participants,
          descriptorEventId: options.descriptorEventId ?? options.descriptor.id,
          descriptorAddress:
            options.descriptorAddress ??
            formatAddress(KIND_ESCROW_DESCRIPTOR, KEYS.escrow.pubkey, D_TAG),
        }),
      content: JSON.stringify(content),
    },
    proposer
  );
}

type ActionOptions = {
  signer: Key;
  action: string;
  at: number;
  root: string;
  prev: string;
  data?: unknown;
  version?: number;
};

function actionEvent(options: ActionOptions): NostrEvent {
  const content = {
    version: options.version ?? COORDINATION_VERSION,
    action: options.action,
    ...(options.data === undefined ? {} : { data: options.data }),
  };
  return signEvent(
    {
      kind: KIND_COORDINATION_ACTION,
      created_at: options.at,
      tags: buildActionTags({ rootId: options.root, prevId: options.prev }),
      content: JSON.stringify(content),
    },
    options.signer
  );
}

/** Sign a list of actions, linking each to the previous one automatically. */
function chain(
  root: NostrEvent,
  steps: readonly (Omit<ActionOptions, 'root' | 'prev'> & { prev?: string })[]
): NostrEvent[] {
  const events: NostrEvent[] = [];
  let prev = root.id;
  for (const step of steps) {
    const event = actionEvent({
      ...step,
      root: root.id,
      prev: step.prev ?? prev,
    });
    events.push(event);
    prev = event.id;
  }
  return events;
}

const paymentData = (reference: string = PAYMENT_REF) => ({
  payment_reference: reference,
});

// ── Vector shape ─────────────────────────────────────────────────────────

type Expectation = {
  root?: 'valid' | { rejected: string };
  state?: string;
  terminal?: boolean;
  disputed?: boolean;
  forked?: { branches: number } | null;
  rejected?: { action_index: number; reason: string }[];
};

type Vector = {
  name: string;
  description: string;
  spec: { commit: string; pip02_version: number; profile: string };
  descriptor: NostrEvent;
  root: NostrEvent;
  actions: NostrEvent[];
  expect: Expectation;
};

const vectors: Vector[] = [];

function vector(
  name: string,
  description: string,
  parts: { descriptor: NostrEvent; root: NostrEvent; actions?: NostrEvent[] },
  expect: Expectation
): void {
  vectors.push({
    name,
    description,
    spec: {
      commit: SPEC_COMMIT,
      pip02_version: COORDINATION_VERSION,
      profile: PROFILE_ID,
    },
    descriptor: parts.descriptor,
    root: parts.root,
    actions: parts.actions ?? [],
    expect: {
      root: 'valid',
      terminal: false,
      disputed: false,
      forked: null,
      rejected: [],
      ...expect,
    },
  });
}

// ── Happy paths ──────────────────────────────────────────────────────────

function settlementChain(direction: Direction) {
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor, direction });
  // btc_to_fiat: the agent sends fiat, the customer confirms receipt.
  const fiatSender = direction === 'fiat_to_btc' ? KEYS.customer : KEYS.agent;
  const fiatReceiver = direction === 'fiat_to_btc' ? KEYS.agent : KEYS.customer;
  const acceptor = KEYS.agent;

  const actions = chain(root, [
    { signer: acceptor, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: fiatSender,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: fiatReceiver,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed,
      data: paymentData(),
    },
    {
      signer: fiatReceiver,
      action: 'core/authorize_settlement',
      at: TIME.authorize,
    },
    { signer: KEYS.escrow, action: 'core/settle', at: TIME.final },
  ]);
  return { descriptor, root, actions };
}

{
  const parts = settlementChain('btc_to_fiat');
  vector(
    'settle-btc-to-fiat',
    'Customer provides Bitcoin, agent sends fiat, customer confirms, escrow settles.',
    parts,
    { state: 'settled', terminal: true, disputed: false, forked: null }
  );

  // Determinism: the same chain, shuffled on the wire, derives the same state.
  vector(
    'settle-out-of-order-delivery',
    'The settlement chain delivered in reverse order still derives settled.',
    { ...parts, actions: [...parts.actions].reverse() },
    { state: 'settled', terminal: true }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({
    descriptor,
    direction: 'fiat_to_btc',
    proposer: KEYS.agent,
  });
  const actions = chain(root, [
    { signer: KEYS.customer, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.customer,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed,
      data: paymentData(),
    },
    {
      signer: KEYS.agent,
      action: 'core/authorize_settlement',
      at: TIME.authorize,
    },
    { signer: KEYS.escrow, action: 'core/settle', at: TIME.final },
  ]);
  vector(
    'settle-fiat-to-btc',
    'Customer sends fiat, agent provides Bitcoin, agent confirms receipt, escrow settles.',
    { descriptor, root, actions },
    { state: 'settled', terminal: true, disputed: false, forked: null }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.customer,
      action: 'core/authorize_refund',
      at: TIME.afterPayBy,
    },
    { signer: KEYS.escrow, action: 'core/refund', at: TIME.final },
  ]);
  vector(
    'refund-no-payment',
    'Payment window closes with no fiat claimed sent; the provider authorizes refund.',
    { descriptor, root, actions },
    { state: 'refunded', terminal: true, forked: null }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
  ]);
  vector(
    'accept-before-expiry',
    'Acceptance inside the acceptance window moves the coordination to accepted.',
    { descriptor, root, actions },
    { state: 'accepted', terminal: false }
  );
}

// ── Root-level rejections ────────────────────────────────────────────────

{
  const descriptor = descriptorEvent({ expiresAt: TIME.rootCreated });
  vector(
    'descriptor-expired-before-root',
    'A descriptor whose expiry is not later than the root creation is unselectable.',
    { descriptor, root: rootEvent({ descriptor }) },
    { root: { rejected: 'descriptor_expired' } }
  );
}

{
  const descriptor = descriptorEvent({ createdAt: TIME.rootCreated + 1 });
  vector(
    'descriptor-created-after-root',
    'A descriptor published after the root cannot be the revision the root accepted.',
    { descriptor, root: rootEvent({ descriptor }) },
    { root: { rejected: 'descriptor_after_root' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'descriptor-id-mismatch',
    'The exact-event reference names a different event than the descriptor supplied.',
    {
      descriptor,
      root: rootEvent({ descriptor, descriptorEventId: 'b'.repeat(64) }),
    },
    { root: { rejected: 'descriptor_id_mismatch' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'descriptor-address-mismatch',
    'The addressable reference points at a different d-tag than the bound descriptor.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        descriptorAddress: formatAddress(
          KIND_ESCROW_DESCRIPTOR,
          KEYS.escrow.pubkey,
          'other'
        ),
      }),
    },
    { root: { rejected: 'descriptor_address_mismatch' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'escrow-coordinate-wrong-kind',
    'An escrow coordinate must be kind 30361; a 30360 address is not a descriptor.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        descriptorAddress: formatAddress(
          KIND_AGENT_DEFINITION,
          KEYS.escrow.pubkey,
          D_TAG
        ),
      }),
    },
    { root: { rejected: 'root_tags' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'profile-not-supported',
    'A root pinning a profile version we do not implement is refused before any action.',
    { descriptor, root: rootEvent({ descriptor, profile: 'pontmore/swap@2' }) },
    { root: { rejected: 'profile_mismatch' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'coordination-version-unsupported',
    'A version 1 root is not silently reinterpreted as version 2.',
    { descriptor, root: rootEvent({ descriptor, version: 1 }) },
    { root: { rejected: 'root_version' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'terms-zero-bitcoin-amount',
    'A zero-satoshi swap is not an economic coordination.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        termsOverride: terms('btc_to_fiat', {
          bitcoin: { amount: '0', unit: 'sat', network: 'cashu' },
        }),
      }),
    },
    { root: { rejected: 'terms_invalid' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'terms-expiry-ordering',
    'Acceptance must close before the fiat payment window opens.',
    {
      descriptor,
      root: rootEvent({ descriptor, expiresAt: TIME.fiatPayBy + 1 }),
    },
    { root: { rejected: 'expiry_ordering' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'commitment-key-not-permitted',
    'The profile permits only private_terms and quote commitment keys.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        commitments: {
          payout_instructions: {
            algorithm: 'sha256-bytes@1',
            digest: `sha256:${'0'.repeat(64)}`,
          },
        },
      }),
    },
    { root: { rejected: 'commitment_key' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'duplicate-application-role',
    'One pubkey may not hold two roles in this profile.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        participants: [
          { pubkey: KEYS.agent.pubkey, role: ROLE_AGENT },
          { pubkey: KEYS.agent.pubkey, role: ROLE_CUSTOMER },
          { pubkey: KEYS.escrow.pubkey, role: ROLE_ESCROW },
          { pubkey: KEYS.resolver.pubkey, role: ROLE_RESOLVER },
        ],
      }),
    },
    { root: { rejected: 'participant_roles' } }
  );
}

{
  const descriptor = descriptorEvent();
  vector(
    'missing-resolver-authority',
    'A profile that permits disputes requires a bound resolver.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        participants: [
          { pubkey: KEYS.agent.pubkey, role: ROLE_AGENT },
          { pubkey: KEYS.customer.pubkey, role: ROLE_CUSTOMER },
          { pubkey: KEYS.escrow.pubkey, role: ROLE_ESCROW },
        ],
      }),
    },
    { root: { rejected: 'resolver_authority' } }
  );
}

// ── Action-level rejections ──────────────────────────────────────────────

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.expiresAt },
  ]);
  vector(
    'accept-after-expiry',
    'Acceptance at or after expires_at is too late.',
    { descriptor, root, actions },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'deadline_passed' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.stranger, action: 'core/accept', at: TIME.accept },
  ]);
  vector(
    'accept-by-stranger',
    'Only the non-proposing application participant may accept.',
    { descriptor, root, actions },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'unauthorized_signer' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.customer, action: 'core/accept', at: TIME.accept },
  ]);
  vector(
    'accept-by-proposer',
    'The proposer cannot accept its own proposal.',
    { descriptor, root, actions },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'unauthorized_signer' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.customer, action: 'core/secure', at: TIME.secure },
  ]);
  vector(
    'secure-by-non-escrow',
    'Only the bound escrow authority may record core/secure.',
    { descriptor, root, actions },
    {
      state: 'accepted',
      rejected: [{ action_index: 1, reason: 'unauthorized_signer' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    { signer: KEYS.escrow, action: 'core/settle', at: TIME.final },
  ]);
  vector(
    'settle-without-authorization',
    'Settlement requires a settlement authorization first.',
    { descriptor, root, actions },
    { state: 'secured', rejected: [{ action_index: 2, reason: 'ordering' }] }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.customer,
      action: 'core/authorize_refund',
      at: TIME.fiatSent,
    },
  ]);
  vector(
    'authorize-refund-too-early',
    'Refund authorization waits for the payment window to close.',
    { descriptor, root, actions },
    {
      state: 'secured',
      rejected: [{ action_index: 2, reason: 'precondition' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed,
      data: paymentData('pay-ref-other'),
    },
  ]);
  vector(
    'payment-reference-mismatch',
    'The confirmation must name the same payment the sender claimed.',
    { descriptor, root, actions },
    {
      state: 'fiat_sent',
      rejected: [{ action_index: 3, reason: 'payment_reference_mismatch' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: { payment_reference: 'MPESA QGH7X2K9 254712345678 KES 15,000' },
    },
  ]);
  vector(
    'public-private-separation',
    'A payment reference is an opaque id; raw payment detail is refused in public content.',
    { descriptor, root, actions },
    { state: 'secured', rejected: [{ action_index: 2, reason: 'action_data' }] }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const accepted = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
  ]);
  const first = accepted[0];
  if (first === undefined) throw new Error('accept action missing');
  const replay = actionEvent({
    signer: KEYS.agent,
    action: 'core/accept',
    at: TIME.accept + 5,
    root: root.id,
    prev: first.id,
  });
  vector(
    'replayed-accept',
    'A second acceptance linked to the first is a replay, not progress.',
    { descriptor, root, actions: [...accepted, replay] },
    {
      state: 'accepted',
      rejected: [{ action_index: 1, reason: 'replayed_action' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
  ]);
  const first = actions[0];
  if (first === undefined) throw new Error('accept action missing');
  vector(
    'duplicate-event-id',
    'The same event delivered twice is counted once.',
    { descriptor, root, actions: [first, first] },
    {
      state: 'accepted',
      rejected: [{ action_index: 1, reason: 'duplicate_event' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const dangling = actionEvent({
    signer: KEYS.escrow,
    action: 'core/secure',
    at: TIME.secure,
    root: root.id,
    prev: 'c'.repeat(64),
  });
  vector(
    'dangling-prev-reference',
    'An action whose predecessor is not in the chain never links.',
    { descriptor, root, actions: [dangling] },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'prev_reference' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const other = rootEvent({ descriptor, createdAt: TIME.rootCreated + 1 });
  const root = rootEvent({ descriptor });
  const foreign = actionEvent({
    signer: KEYS.agent,
    action: 'core/accept',
    at: TIME.accept,
    root: other.id,
    prev: root.id,
  });
  vector(
    'root-reference-mismatch',
    'An action must name the root it belongs to.',
    { descriptor, root, actions: [foreign] },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'root_reference' }],
    }
  );
}

// ── Disputes ─────────────────────────────────────────────────────────────

function disputedTo(
  effect: 'resume' | 'authorize_settlement' | 'authorize_refund' | 'cancel'
) {
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const steps = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: 'core/open_dispute',
      at: TIME.fiatConfirmed,
      data: { class: 'fiat_not_received' },
    },
    {
      signer: KEYS.resolver,
      action: 'core/resolve_dispute',
      at: TIME.authorize,
      data: { policy: 'service-policy-1', effect },
    },
  ]);
  return { descriptor, root, steps };
}

{
  const { descriptor, root, steps } = disputedTo('authorize_settlement');
  const last = steps.at(-1);
  if (last === undefined) throw new Error('resolution missing');
  const settle = actionEvent({
    signer: KEYS.escrow,
    action: 'core/settle',
    at: TIME.final,
    root: root.id,
    prev: last.id,
  });
  vector(
    'dispute-resolved-to-settlement',
    'A resolution authorizes settlement; only the escrow then records core/settle.',
    { descriptor, root, actions: [...steps, settle] },
    { state: 'settled', terminal: true, disputed: false }
  );
}

{
  const { descriptor, root, steps } = disputedTo('authorize_refund');
  const last = steps.at(-1);
  if (last === undefined) throw new Error('resolution missing');
  const refund = actionEvent({
    signer: KEYS.escrow,
    action: 'core/refund',
    at: TIME.final,
    root: root.id,
    prev: last.id,
  });
  vector(
    'dispute-resolved-to-refund',
    'A resolution authorizes refund; only the escrow then records core/refund.',
    { descriptor, root, actions: [...steps, refund] },
    { state: 'refunded', terminal: true, disputed: false }
  );
}

{
  const { descriptor, root, steps } = disputedTo('resume');
  vector(
    'dispute-resolved-to-resume',
    'A resume resolution returns the coordination to its pre-dispute state.',
    { descriptor, root, actions: steps },
    { state: 'fiat_sent', disputed: false, terminal: false }
  );
}

{
  const { descriptor, root, steps } = disputedTo('cancel');
  vector(
    'dispute-resolved-to-cancel',
    'A cancel resolution is terminal and moves no funds.',
    { descriptor, root, actions: steps },
    { state: 'cancelled', terminal: true, disputed: false }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: 'core/open_dispute',
      at: TIME.fiatConfirmed,
    },
    {
      signer: KEYS.customer,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed + 10,
      data: paymentData(),
    },
  ]);
  vector(
    'dispute-freezes-progress',
    'While disputed, ordinary profile progress is frozen.',
    { descriptor, root, actions },
    {
      state: 'disputed',
      disputed: true,
      rejected: [{ action_index: 4, reason: 'frozen_disputed' }],
    }
  );
}

{
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const actions = chain(root, [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: 'core/open_dispute',
      at: TIME.fiatConfirmed,
    },
    {
      signer: KEYS.agent,
      action: 'core/resolve_dispute',
      at: TIME.authorize,
      data: { policy: 'service-policy-1', effect: 'authorize_settlement' },
    },
  ]);
  vector(
    'resolution-by-non-resolver',
    'Only the bound resolver may record a resolution.',
    { descriptor, root, actions },
    {
      state: 'disputed',
      disputed: true,
      rejected: [{ action_index: 4, reason: 'unauthorized_signer' }],
    }
  );
}

{
  const { descriptor, root, steps } = disputedTo('authorize_settlement');
  const last = steps.at(-1);
  if (last === undefined) throw new Error('resolution missing');
  const refund = actionEvent({
    signer: KEYS.escrow,
    action: 'core/refund',
    at: TIME.final,
    root: root.id,
    prev: last.id,
  });
  vector(
    'resolution-restricts-to-one-outcome',
    'After a settlement resolution, a refund is not the permitted recovery path.',
    { descriptor, root, actions: [...steps, refund] },
    {
      state: 'settlement_authorized',
      rejected: [{ action_index: 5, reason: 'resolution_restricted' }],
    }
  );
}

// ── Terminal exclusivity and forks ───────────────────────────────────────

{
  const parts = settlementChain('btc_to_fiat');
  const settle = parts.actions.at(-1);
  if (settle === undefined) throw new Error('settle missing');
  const refund = actionEvent({
    signer: KEYS.escrow,
    action: 'core/refund',
    at: TIME.final + 10,
    root: parts.root.id,
    prev: settle.id,
  });
  vector(
    'settle-and-refund-in-one-history',
    'Settlement and refund are mutually exclusive final outcomes.',
    { ...parts, actions: [...parts.actions, refund] },
    {
      state: 'settled',
      terminal: true,
      rejected: [{ action_index: 6, reason: 'terminal' }],
    }
  );
}

function forkAt(
  name: string,
  description: string,
  prefix: readonly Omit<ActionOptions, 'root' | 'prev'>[],
  siblings: readonly Omit<ActionOptions, 'root' | 'prev'>[]
) {
  const descriptor = descriptorEvent();
  const root = rootEvent({ descriptor });
  const applied = chain(root, prefix);
  const tip = applied.at(-1)?.id ?? root.id;
  const branches = siblings.map((sibling) =>
    actionEvent({ ...sibling, root: root.id, prev: tip })
  );
  vector(
    name,
    description,
    { descriptor, root, actions: [...applied, ...branches] },
    { state: 'forked', forked: { branches: branches.length }, terminal: false }
  );
}

forkAt(
  'fork-at-secure',
  'Two valid core/secure actions on one predecessor freeze the coordination.',
  [{ signer: KEYS.agent, action: 'core/accept', at: TIME.accept }],
  [
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure + 1 },
  ]
);

forkAt(
  'fork-at-settlement-gate',
  'A dispute and a fiat confirmation on the same predecessor is a fork, not a race.',
  [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
  ],
  [
    {
      signer: KEYS.customer,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: 'core/open_dispute',
      at: TIME.fiatConfirmed + 1,
    },
  ]
);

forkAt(
  'fork-at-settle',
  'Two escrow settlements on one predecessor freeze rather than pick a winner.',
  [
    { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
    { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
    {
      signer: KEYS.agent,
      action: ACTION_FIAT_SENT,
      at: TIME.fiatSent,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: ACTION_FIAT_CONFIRMED,
      at: TIME.fiatConfirmed,
      data: paymentData(),
    },
    {
      signer: KEYS.customer,
      action: 'core/authorize_settlement',
      at: TIME.authorize,
    },
  ],
  [
    { signer: KEYS.escrow, action: 'core/settle', at: TIME.final },
    { signer: KEYS.escrow, action: 'core/settle', at: TIME.final + 1 },
  ]
);

// Each authorization case starts from a valid predecessor, so a wrong signer
// cannot be hidden by an earlier ordering or data error.
const ordinary = settlementChain('btc_to_fiat');
const refundPrefix = chain(ordinary.root, [
  { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
  { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
  {
    signer: KEYS.customer,
    action: 'core/authorize_refund',
    at: TIME.afterPayBy,
  },
]);
const authorizationCases = [
  { action: 'core/decline', prefix: [], at: TIME.accept, state: 'proposed' },
  { action: 'core/cancel', prefix: [], at: TIME.accept, state: 'proposed' },
  {
    action: 'core/expire',
    prefix: [],
    at: TIME.expiresAt + 1,
    state: 'proposed',
  },
  {
    action: 'core/authorize_settlement',
    prefix: ordinary.actions.slice(0, 4),
    at: TIME.authorize,
    state: 'fiat_confirmed',
  },
  {
    action: 'core/settle',
    prefix: ordinary.actions.slice(0, 5),
    at: TIME.final,
    state: 'settlement_authorized',
  },
  {
    action: 'core/authorize_refund',
    prefix: refundPrefix.slice(0, 2),
    at: TIME.afterPayBy,
    state: 'secured',
  },
  {
    action: 'core/refund',
    prefix: refundPrefix,
    at: TIME.final,
    state: 'refund_authorized',
  },
  {
    action: 'core/open_dispute',
    prefix: ordinary.actions.slice(0, 2),
    at: TIME.fiatSent,
    state: 'secured',
  },
  {
    action: ACTION_FIAT_SENT,
    prefix: ordinary.actions.slice(0, 2),
    at: TIME.fiatSent,
    state: 'secured',
    data: paymentData(),
  },
  {
    action: ACTION_FIAT_CONFIRMED,
    prefix: ordinary.actions.slice(0, 3),
    at: TIME.fiatConfirmed,
    state: 'fiat_sent',
    data: paymentData(),
  },
];
for (const entry of authorizationCases) {
  const bad = actionEvent({
    ...entry,
    signer: KEYS.stranger,
    root: ordinary.root.id,
    prev: entry.prefix.at(-1)?.id ?? ordinary.root.id,
  });
  vector(
    `${entry.action.replace('/', '-')}-by-stranger`,
    `${entry.action} rejects a signer not bound to its authority.`,
    { ...ordinary, actions: [...entry.prefix, bad] },
    {
      state: entry.state,
      rejected: [
        { action_index: entry.prefix.length, reason: 'unauthorized_signer' },
      ],
    }
  );
}

for (const action of [
  'core/authorize_settlement',
  'core/authorize_refund',
  'core/refund',
]) {
  const prefix =
    action === 'core/authorize_settlement'
      ? ordinary.actions.slice(0, 4)
      : action === 'core/authorize_refund'
        ? refundPrefix.slice(0, 2)
        : refundPrefix;
  const signer = action === 'core/refund' ? KEYS.escrow : KEYS.customer;
  const branches = [0, 1].map((offset) =>
    actionEvent({
      signer,
      action,
      at: TIME.final + offset,
      root: ordinary.root.id,
      prev: prefix.at(-1)!.id,
    })
  );
  vector(
    `fork-at-${action.slice(5).replaceAll('_', '-')}`,
    `Sibling ${action} actions freeze the economic gate.`,
    { ...ordinary, actions: [...prefix, ...branches] },
    { state: 'forked', forked: { branches: 2 } }
  );
}

// Signed descriptors with invalid discovery facts, still correctly referenced
// by the root: these test validation, not a trivial ID mismatch.
for (const [name, changes, reason] of [
  [
    'descriptor-version-unsupported',
    {
      content: JSON.stringify({
        ...(JSON.parse(ordinary.descriptor.content) as Record<string, unknown>),
        version: 2,
      }),
    },
    'descriptor_content',
  ],
  ['descriptor-missing-d-tag', { tags: [] }, 'descriptor_tags'],
  [
    'descriptor-duplicate-d-tag',
    { tags: [...ordinary.descriptor.tags, ['d', 'other']] },
    'descriptor_tags',
  ],
  [
    'descriptor-network-tag-mismatch',
    { tags: [...ordinary.descriptor.tags, ['t', 'pontmore-network:other']] },
    'descriptor_tags',
  ],
  [
    'descriptor-mechanism-network-mismatch',
    {
      content: JSON.stringify({
        ...(JSON.parse(ordinary.descriptor.content) as Record<string, unknown>),
        networks: ['lightning'],
      }),
    },
    'descriptor_content',
  ],
] as const) {
  const descriptor = signEvent(
    {
      ...ordinary.descriptor,
      ...changes,
      tags: ('tags' in changes ? changes.tags : ordinary.descriptor.tags).map(
        (tag) => [...tag]
      ),
    },
    KEYS.escrow
  );
  vector(
    name,
    'The exact descriptor must satisfy PIP-01 discovery requirements.',
    { descriptor, root: rootEvent({ descriptor }) },
    { root: { rejected: reason } }
  );
}
{
  const descriptor = descriptorEvent();
  vector(
    'terms-descriptor-network-mismatch',
    'The swap network must be supported by the descriptor.',
    {
      descriptor,
      root: rootEvent({
        descriptor,
        termsOverride: terms('btc_to_fiat', {
          bitcoin: { amount: '100000', unit: 'sat', network: 'other' },
        }),
      }),
    },
    { root: { rejected: 'descriptor_network' } }
  );
}
{
  const descriptor = descriptorEvent({ expiresAt: TIME.accept });
  const root = rootEvent({ descriptor });
  vector(
    'descriptor-expires-at-acceptance',
    'A descriptor valid at root creation must still be unexpired at acceptance.',
    {
      descriptor,
      root,
      actions: chain(root, [
        { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
      ]),
    },
    {
      state: 'proposed',
      rejected: [{ action_index: 0, reason: 'descriptor_expired' }],
    }
  );
}
{
  const descriptor = descriptorEvent({ expiresAt: TIME.accept + 1 });
  const root = rootEvent({ descriptor });
  vector(
    'descriptor-expires-after-acceptance',
    'Descriptor expiry after acceptance does not stop an accepted coordination.',
    {
      descriptor,
      root,
      actions: chain(root, [
        { signer: KEYS.agent, action: 'core/accept', at: TIME.accept },
        { signer: KEYS.escrow, action: 'core/secure', at: TIME.secure },
      ]),
    },
    { state: 'secured' }
  );
}
{
  const prefix = ordinary.actions.slice(0, 2);
  const bad = actionEvent({
    signer: KEYS.customer,
    action: 'core/open_dispute',
    at: TIME.fiatSent,
    root: ordinary.root.id,
    prev: prefix.at(-1)!.id,
    data: { class: 'made_up' },
  });
  vector(
    'dispute-class-unknown',
    'Dispute classes come from the pinned profile.',
    { ...ordinary, actions: [...prefix, bad] },
    { state: 'secured', rejected: [{ action_index: 2, reason: 'action_data' }] }
  );
}
for (const forgedFirst of [true, false]) {
  const valid = ordinary.actions[0]!;
  const forged = { ...valid, sig: '0'.repeat(128) };
  vector(
    `forged-duplicate-${forgedFirst ? 'first' : 'last'}`,
    'An invalid copy cannot suppress a valid event with the same claimed ID.',
    { ...ordinary, actions: forgedFirst ? [forged, valid] : [valid, forged] },
    {
      state: 'accepted',
      rejected: [
        { action_index: forgedFirst ? 0 : 1, reason: 'action_signature' },
      ],
    }
  );
}
{
  const prefix = ordinary.actions.slice(0, 1);
  const tip = prefix.at(-1)!.id;
  const siblings = [KEYS.escrow, KEYS.escrow, KEYS.stranger].map(
    (signer, index) =>
      actionEvent({
        signer,
        action: 'core/secure',
        at: TIME.secure + index,
        root: ordinary.root.id,
        prev: tip,
      })
  );
  vector(
    'fork-with-invalid-sibling',
    'A fork retains valid branches and reports an unauthorized sibling.',
    { ...ordinary, actions: [...prefix, ...siblings] },
    {
      state: 'forked',
      forked: { branches: 2 },
      rejected: [{ action_index: 3, reason: 'unauthorized_signer' }],
    }
  );
}

// ── Write ────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });
for (const file of readdirSync(OUT_DIR)) {
  if (file.endsWith('.json')) rmSync(join(OUT_DIR, file));
}

const names = new Set<string>();
for (const entry of vectors) {
  if (names.has(entry.name))
    throw new Error(`duplicate vector name: ${entry.name}`);
  names.add(entry.name);
  writeFileSync(
    join(OUT_DIR, `${entry.name}.json`),
    await format(JSON.stringify(entry), { parser: 'json' })
  );
}

console.log(`wrote ${String(vectors.length)} vectors to vectors/`);
