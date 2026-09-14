/**
 * Pontmore event kinds and the zod schema for every payload this operator
 * publishes or reads.
 *
 * Shapes match the reference client so the two stay wire-compatible;
 * divergences are marked inline. Spec: PIP-00 (30360), PIP-01 (30361),
 * PIP-02 (7300-7304, 30362), PIP-03 (dispute grammar on 7303).
 *
 * Nostr events carry `content` as a string holding JSON. These schemas
 * validate the PARSED JSON, not the event envelope. Nothing here signs,
 * publishes or reads a relay, that is `signer.ts`, `relay.ts` and
 * the builders in `src/operator`.
 */

import { z } from 'zod';

import {
  HexEventId,
  HexPubkey,
  HexSha256,
  HttpUrl,
  parseUrl,
  PublicText,
  SatAmount,
  SwapId,
  UnixSeconds,
} from '../primitives.ts';
import { EscrowError } from '../errors.ts';
import {
  ACTOR_ROLES,
  DISPUTE_CLASSES,
  DISPUTE_STAGES,
  RESOLUTION_MODES,
  SWAP_STATES,
} from './states.ts';

// ── Kind numbers ─────────────────────────────────────────────────────────

/** PIP-00 agent definition. Addressable. */
export const KIND_AGENT_DEFINITION = 30360 as const;
/** PIP-01 escrow descriptor. Addressable. */
export const KIND_ESCROW_DESCRIPTOR = 30361 as const;
/** PIP-02 swap request. Immutable. */
export const KIND_SWAP_REQUEST = 7300 as const;
/** PIP-02 state transition. Immutable, append-only. */
export const KIND_TRANSITION = 7301 as const;
/** PIP-02 evidence, reveal-by-reference. Immutable. */
export const KIND_EVIDENCE = 7302 as const;
/** PIP-02 dispute, graded by PIP-03. Immutable. */
export const KIND_DISPUTE = 7303 as const;
/** PIP-02 operational note. Immutable. */
export const KIND_NOTE = 7304 as const;
/** PIP-02 snapshot: a replaceable materialized view, never a source of truth. */
export const KIND_SNAPSHOT = 30362 as const;

/** NIP-59 layers. */
export const KIND_SEAL = 13 as const;
export const KIND_RUMOR = 14 as const;
export const KIND_GIFT_WRAP = 1059 as const;

/** Content version this implementation publishes and accepts. */
export const CONTENT_VERSION = 1 as const;

// ── Protocol vocabulary ──────────────────────────────────────────────────

/** The canonical PIP-01 escrow subtype this operator implements. */
export const ESCROW_TYPE_CASHU = 'cashu_escrow' as const;
export const NETWORK_CASHU = 'cashu' as const;
export const NETWORK_LIGHTNING = 'lightning' as const;

/** Networks this operator settles across, in descriptor order. */
export const NETWORKS = [NETWORK_CASHU, NETWORK_LIGHTNING] as const;
export type Network = (typeof NETWORKS)[number];

/** NUT-11 P2PK with a locktime and a refund pubkey. */
export const LOCK_MECHANISM_P2PK_TIMELOCK = 'p2pk_timelock' as const;
/** The escrow expires with the P2PK locktime, there is no separate invoice. */
export const INVOICE_EXPIRY_RULE_P2PK = 'p2pk_timelock_expiry' as const;
/** How a swap refers to an escrow claim here: a Cashu v4 token string. */
export const REFERENCE_FORMAT_CASHU_V4 = 'cashu_v4_token' as const;
/** Conformance with PIP-03, the canonical `dispute_rules.policy` value. */
export const DISPUTE_POLICY_PIP03 = 'pip03' as const;

/** Who holds an authority in a descriptor. */
export const ESCROW_AUTHORITIES = [
  'escrow_operator',
  'customer',
  'agent',
] as const;
export type EscrowAuthority = (typeof ESCROW_AUTHORITIES)[number];

// ── Addressable coordinates (NIP-01 `kind:pubkey:d`) ─────────────────────

export const Coordinate = z
  .string()
  .regex(/^\d+:[0-9a-f]{64}:[!-~]*$/i, 'expected a kind:pubkey:d coordinate');

/** Build the addressable coordinate for kinds 30360 / 30361 / 30362. */
export function coordinate(kind: number, pubkey: string, dTag: string): string {
  return `${kind}:${pubkey.toLowerCase()}:${dTag}`;
}

export type ParsedCoordinate = { kind: number; pubkey: string; dTag: string };

/** Split a coordinate, or null if it is not one. `d` may legitimately be empty. */
export function parseCoordinate(value: string): ParsedCoordinate | null {
  if (!Coordinate.safeParse(value).success) return null;
  const firstSeparator = value.indexOf(':');
  const secondSeparator = value.indexOf(':', firstSeparator + 1);
  return {
    kind: Number(value.slice(0, firstSeparator)),
    pubkey: value.slice(firstSeparator + 1, secondSeparator).toLowerCase(),
    dTag: value.slice(secondSeparator + 1),
  };
}

// ── Shared sub-objects ───────────────────────────────────────────────────

export const SwapTypeSchema = z.enum(['fiat_to_btc', 'btc_to_fiat']);
export type SwapType = z.infer<typeof SwapTypeSchema>;

export const SwapStateSchema = z.enum(SWAP_STATES);
export const ActorRoleSchema = z.enum(ACTOR_ROLES);
export const DisputeStageSchema = z.enum(DISPUTE_STAGES);
export const DisputeClassSchema = z.enum(DISPUTE_CLASSES);
export const ResolutionModeSchema = z.enum(RESOLUTION_MODES);

/** Fiat amounts stay strings on the wire so no float drift crosses JSON. */
export const FiatLeg = z.object({
  currency: z.string().min(3).max(8),
  amount: z.string().regex(/^\d+(\.\d+)?$/),
  rail: z.string().min(1),
});
export type FiatLeg = z.infer<typeof FiatLeg>;

/** Sat amounts likewise. The custody layer converts once, to an integer. */
export const BitcoinLeg = z.object({
  amount_sats: z.string().regex(/^\d+$/),
  payout: z.string().min(1),
});
export type BitcoinLeg = z.infer<typeof BitcoinLeg>;

// ── PIP-02: public swap lifecycle ────────────────────────────────────────

/** kind 7300 — immutable swap request. */
export const SwapRequestContent = z.object({
  version: z.literal(CONTENT_VERSION),
  swap_id: SwapId,
  swap_type: SwapTypeSchema,
  agent: HexPubkey,
  customer: HexPubkey,
  /** Coordinate of the 30361 this swap is escrowed under. */
  escrow_reference: Coordinate,
  fiat: FiatLeg,
  bitcoin: BitcoinLeg,
  expiry: UnixSeconds,
});
export type SwapRequestContent = z.infer<typeof SwapRequestContent>;

/**
 * kind 7301 — append-only state transition.
 *
 * `policy` and `resolution` are ours: PIP-03 puts the resolution actor and
 * policy id on the public surface, and a resolving transition is where they
 * belong. Both are optional, and a consumer that strips unknown keys
 * still reads the transition correctly.
 */
export const TransitionContent = z.object({
  swap_id: SwapId,
  state: SwapStateSchema,
  prev_state: SwapStateSchema,
  actor_role: ActorRoleSchema,
  /** Short, public, and free of custody material (invariant I6). */
  reason: PublicText,
  created_at: UnixSeconds,
  policy: z.string().min(1).max(64).optional(),
  resolution: ResolutionModeSchema.optional(),
});
export type TransitionContent = z.infer<typeof TransitionContent>;

/**
 * kind 7302 — evidence. Reveal-by-reference only: `ref` is an opaque public
 * pointer, `ref_hash` the digest of an artifact that stays in the private
 * lane. The artifact itself never goes in a public event.
 */
export const EvidenceContent = z
  .object({
    swap_id: SwapId,
    type: z.string().min(1).max(64),
    ref: z.string().min(1).max(280).optional(),
    ref_hash: HexSha256.optional(),
    note: PublicText.optional(),
  })
  .refine((value) => value.ref !== undefined || value.ref_hash !== undefined, {
    message: 'evidence needs at least one of `ref` or `ref_hash`',
    path: ['ref'],
  });
export type EvidenceContent = z.infer<typeof EvidenceContent>;

/**
 * kind 7303 — dispute. PIP-03 keeps the public surface to the stage, the
 * actor, the policy id and evidence references; the reasoning and the raw
 * material stay private.
 */
export const DisputeContent = z
  .object({
    version: z.literal(CONTENT_VERSION),
    swap_id: SwapId,
    stage: DisputeStageSchema,
    dispute_class: DisputeClassSchema,
    /** Policy identifier the resolution is made under, e.g. `pip03`. */
    policy: z.string().min(1).max(64),
    actor_role: ActorRoleSchema,
    /** Set on `resolved`, absent otherwise. */
    resolution: ResolutionModeSchema.optional(),
    evidence_refs: z.array(z.string().min(1).max(280)).max(32).optional(),
    note: PublicText.optional(),
  })
  .refine(
    (value) =>
      value.stage === 'resolved'
        ? value.resolution !== undefined
        : value.resolution === undefined,
    {
      message: 'a resolution belongs to stage `resolved` and only to it',
      path: ['resolution'],
    }
  );
export type DisputeContent = z.infer<typeof DisputeContent>;

/** kind 7304 — optional operational note. */
export const NoteContent = z.object({
  swap_id: SwapId,
  text: PublicText,
});
export type NoteContent = z.infer<typeof NoteContent>;

/** kind 30362 — replaceable materialized view of a swap. */
export const SnapshotContent = z.object({
  swap_id: SwapId,
  final_state: SwapStateSchema,
  agent: HexPubkey,
  customer: HexPubkey,
  swap_type: SwapTypeSchema,
  fiat: FiatLeg,
  bitcoin: BitcoinLeg,
  transitions: z.array(
    z.object({
      state: SwapStateSchema,
      actor_role: ActorRoleSchema,
      at: UnixSeconds,
      event_id: HexEventId.optional(),
    })
  ),
  evidence_refs: z.array(z.string().min(1).max(280)).optional(),
  completed_at: UnixSeconds,
});
export type SnapshotContent = z.infer<typeof SnapshotContent>;

// ── PIP-00 / PIP-01: identity and discovery ──────────────────────────────

const StringOrNumber = z.union([z.string(), z.number()]);

const AgentLimits = z.looseObject({
  min: StringOrNumber.optional(),
  max: StringOrNumber.optional(),
});

const AgentCapabilities = z.looseObject({
  swap_types: z.array(z.string()).optional(),
  fiat_currencies: z.array(z.string()).optional(),
  payment_channels: z.array(z.string()).optional(),
  settlement_networks: z.array(z.string()).optional(),
  regions: z.array(z.string()).optional(),
  limits: AgentLimits.optional(),
});

/**
 * `pricing_policy` is a bare string in PIP-00's examples
 * This operator's fee switch needs structure (a percentage, a
 * destination, a fee-free note), so both shapes parse here.
 */
const PricingPolicy = z.union([
  z.string().min(1),
  z.looseObject({
    fee_pct: z.number().min(0),
    fee_destination: z.string().min(1).optional(),
    fee_note: z.string().min(1).max(280).optional(),
  }),
]);

/** kind 30360 — agent definition (PIP-00). */
export const AgentDefinitionContent = z.looseObject({
  version: z.literal(CONTENT_VERSION),
  name: z.string().min(1).max(120),
  about: z.string().max(560).optional(),
  capabilities: AgentCapabilities,
  pricing_policy: PricingPolicy.optional(),
  escrow: z
    .looseObject({
      descriptor: Coordinate.optional(),
      notes: z.string().max(280).optional(),
    })
    .optional(),
  updated_at: UnixSeconds,
});
export type AgentDefinitionContent = z.infer<typeof AgentDefinitionContent>;

/** PIP-01 funding cardinality: `funding_threshold` of `participant_count`. */
const FundingRules = z
  .looseObject({
    funding_threshold: z.number().int().min(1),
    participant_count: z.number().int().min(1),
  })
  .refine((value) => value.participant_count >= value.funding_threshold, {
    message: 'participant_count must be >= funding_threshold',
    path: ['participant_count'],
  });

const DisputeRules = z.looseObject({
  policy: z.string().min(1).max(64),
});

/** PIP-01 `service` carries the schema pointer and nothing else. */
const ServiceBlock = z.object({
  schema: z.object({
    type: z.enum(['openapi', 'asyncapi']),
    url: z.string().refine((value) => parseUrl(value)?.protocol === 'https:', {
      message: 'a service schema URL must be https',
    }),
  }),
});

/**
 * kind 30361 — escrow descriptor (PIP-01), canonical minimum content.
 *
 * Fail-closed on `version`: a descriptor we cannot interpret is a descriptor
 * we must not take custody under.
 */
export const EscrowDescriptorContent = z.looseObject({
  version: z.literal(CONTENT_VERSION),
  escrow_type: z.string().min(1).max(64),
  networks: z.array(z.string().min(1)).min(1),
  funding_rules: FundingRules,
  dispute_rules: DisputeRules,
  reference_format: z.string().min(1).max(64),
  updated_at: UnixSeconds,
  service: ServiceBlock.optional(),
});
export type EscrowDescriptorContent = z.infer<typeof EscrowDescriptorContent>;

/**
 * One `implementations` entry describing the Cashu lock. This is where a
 * client learns which mint to mint at and how to lock, the facts it needs to
 * fund a swap without out-of-band negotiation.
 */
export const CashuImplementationEntry = z.looseObject({
  network: z.literal(NETWORK_CASHU),
  mint_url: HttpUrl,
  lock_mechanism: z.literal(LOCK_MECHANISM_P2PK_TIMELOCK),
  invoice_expiry_rule: z.literal(INVOICE_EXPIRY_RULE_P2PK).optional(),
  reference_format: z.literal(REFERENCE_FORMAT_CASHU_V4).optional(),
  payout_network: z.literal(NETWORK_LIGHTNING).optional(),
});
export type CashuImplementationEntry = z.infer<typeof CashuImplementationEntry>;

/**
 * kind 30361 for the `cashu_escrow` subtype.
 *
 * Required here: the canonical PIP-01 minimum plus `implementations`, which is
 * the only public place a mint URL and lock mechanism can live.
 *
 * On `refund_authority`: the operator refunds before locktime, and after
 * locktime the buyer self-recovers with the refund key. The buyer's power to
 * refund itself is declared by `lock_mechanism: p2pk_timelock`, not by this
 * field.
 */
export const CashuEscrowDescriptorContent = EscrowDescriptorContent.extend({
  escrow_type: z.literal(ESCROW_TYPE_CASHU),
  reference_format: z.literal(REFERENCE_FORMAT_CASHU_V4),
  implementations: z.array(CashuImplementationEntry).min(1),
  custody_authority: z.enum(ESCROW_AUTHORITIES).optional(),
  release_authority: z.enum(ESCROW_AUTHORITIES).optional(),
  refund_authority: z.enum(ESCROW_AUTHORITIES).optional(),
  release_rules: z
    .looseObject({
      release_trigger: z.string().min(1).max(64),
      refund_trigger: z.string().min(1).max(64),
    })
    .optional(),
}).refine((value) => value.networks.includes(NETWORK_CASHU), {
  message: 'a cashu_escrow descriptor must declare the `cashu` network',
  path: ['networks'],
});
export type CashuEscrowDescriptorContent = z.infer<
  typeof CashuEscrowDescriptorContent
>;

// ── Private lane (NIP-59) payloads ───────────────────────────────────────
//
// These NEVER appear in a public event. PIP-02 keeps invoices, payout
// instructions and settlement secrets in the gift-wrap lane, and PIP-01 keeps
// raw Cashu token strings out of the descriptor. Everything below is custody
// material: it is persisted encrypted, and never logged,
// never echoed in an error.
//
// `swap_id` lives inside the encrypted rumor, never as a public tag, so a
// swap's public chain structurally cannot surface its private messages.

/** A Cashu v4 token string (`cashuB…`), bounded so a wrap stays sane. */
const CashuToken = z
  .string()
  .regex(/^cashuB[A-Za-z0-9_-]+={0,2}$/, 'expected a cashu v4 token')
  .max(32_768);

const Bolt11 = z
  .string()
  .regex(
    /^ln(bc|tbs?|bcrt)[0-9]*[munp]?1[ac-hj-np-z02-9]+$/i,
    'expected a bolt11 invoice'
  )
  .max(2_048);

/**
 * customer → escrow: the locked token itself, with the lock the buyer claims
 * to have applied. The custody layer verifies every one of these claims
 * against the mint before it holds anything.
 */
export const EscrowFundingMessage = z.object({
  version: z.literal(CONTENT_VERSION),
  type: z.literal('escrow_funding'),
  swap_id: SwapId,
  token: CashuToken,
  mint_url: HttpUrl,
  amount_sats: SatAmount,
  /** NUT-11 locktime, unix seconds. */
  locktime: UnixSeconds,
  /** NUT-11 refund key: the only key that can spend after the locktime. */
  refund_pubkey: HexPubkey,
});
export type EscrowFundingMessage = z.infer<typeof EscrowFundingMessage>;

/** agent → escrow: where the sats go on release. */
export const PayoutInstructionsMessage = z.object({
  version: z.literal(CONTENT_VERSION),
  type: z.literal('payout_instructions'),
  swap_id: SwapId,
  bolt11: Bolt11,
  amount_sats: SatAmount,
});
export type PayoutInstructionsMessage = z.infer<
  typeof PayoutInstructionsMessage
>;

/**
 * escrow → customer: the refunded token.
 *
 * `refund_path` names which of the two explicit refund paths ran:
 * `locktime_expiry` returns the ORIGINAL token, which the buyer spends
 * with the refund key; `relock` returns a NEW token locked to the buyer's
 * pubkey with no locktime.
 */
export const EscrowRefundMessage = z.object({
  version: z.literal(CONTENT_VERSION),
  type: z.literal('escrow_refund'),
  swap_id: SwapId,
  token: CashuToken,
  mint_url: HttpUrl,
  amount_sats: SatAmount,
  refund_path: z.enum(['locktime_expiry', 'relock']),
});
export type EscrowRefundMessage = z.infer<typeof EscrowRefundMessage>;

export const PrivateMessage = z.discriminatedUnion('type', [
  EscrowFundingMessage,
  PayoutInstructionsMessage,
  EscrowRefundMessage,
]);
export type PrivateMessage = z.infer<typeof PrivateMessage>;

// ── Parse / build helpers ────────────────────────────────────────────────

export type ContentResult<T> =
  { ok: true; value: T } | { ok: false; paths: readonly string[] };

/**
 * Field paths of a zod failure — never the values that failed.
 *
 * This is the seam that keeps invariant I6 honest: a malformed private
 * message reports `token`, not the token.
 */
function issuePaths(error: z.ZodError): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    paths.add(
      issue.path.length > 0
        ? issue.path.map((part) => String(part)).join('.')
        : '<root>'
    );
  }
  return [...paths];
}

/**
 * Parse an event's `content` string against a schema. Returns a result rather
 * than throwing: an operator subscribed to a public tag sees other people's
 * junk routinely, and junk is ignored, not raised.
 */
export function parseEventContent<S extends z.ZodType>(
  schema: S,
  content: string
): ContentResult<z.output<S>> {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return { ok: false, paths: ['<json>'] };
  }

  const parsed = schema.safeParse(json);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, paths: issuePaths(parsed.error) };
}

/**
 * Validate a payload and serialise it for an event's `content`. Every payload
 * this operator publishes goes through here, so nothing unvalidated is ever
 * signed.
 */
export function buildEventContent<S extends z.ZodType>(
  schema: S,
  value: z.input<S>,
  context: { label: string; swapId?: string } = { label: 'content' }
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EscrowError(
      'content_invalid',
      `${context.label} failed its schema at: ${issuePaths(parsed.error).join(', ')}`,
      context.swapId === undefined ? {} : { swapId: context.swapId }
    );
  }
  return JSON.stringify(parsed.data);
}
