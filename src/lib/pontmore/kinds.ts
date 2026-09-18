/**
 * PIP-02 v2 wire shapes: two event kinds, their content schemas, their tag
 * grammar, and the discovery events that bind a coordination to us.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

import { EscrowError } from '../errors.ts';
import {
  HexEventId,
  HexPubkey,
  HttpsUrl,
  OpaqueRef,
  UnixSeconds,
} from '../primitives.ts';

// ── Kinds ────────────────────────────────────────────────────────────────

/** Immutable coordination root. Its event id is the `coordination_id`. */
export const KIND_COORDINATION_ROOT = 7300 as const;
/** Immutable, `prev`-linked coordination action. */
export const KIND_COORDINATION_ACTION = 7301 as const;
/** PIP-00 agent definition (addressable). */
export const KIND_AGENT_DEFINITION = 30360 as const;
/** PIP-01 escrow descriptor (addressable). */
export const KIND_ESCROW_DESCRIPTOR = 30361 as const;

/** NIP-59 layers for the private lane. */
export const KIND_SEAL = 13 as const;
export const KIND_RUMOR = 14 as const;
export const KIND_GIFT_WRAP = 1059 as const;

/** PIP-02 content version implemented here. */
export const COORDINATION_VERSION = 2 as const;

// ── Identifiers ──────────────────────────────────────────────────────────

const NS = '[a-z0-9][a-z0-9-]*';
const NAME = '[a-z0-9][a-z0-9_-]*';

/** `<namespace>/<name>@<positive-integer>` — profile and capability ids. */
export const VersionedId = z
  .string()
  .regex(
    new RegExp(`^${NS}/${NAME}@[1-9][0-9]*$`),
    'expected <ns>/<name>@<version>'
  );

/** `<namespace>/<name>` — role and action identifiers. */
export const NamespacedId = z
  .string()
  .regex(new RegExp(`^${NS}/${NAME}$`), 'expected <ns>/<name>');

/** Lowercase identifier: escrow types, networks. */
export const LowerId = z
  .string()
  .regex(new RegExp(`^${NAME}$`), 'expected a lowercase id');

/** PIP-02 authority roles. A profile may not redefine these. */
export const ROLE_ESCROW = 'core/escrow' as const;
export const ROLE_RESOLVER = 'core/resolver' as const;

export const COMMITMENT_ALGORITHM = 'sha256-bytes@1' as const;

/** `sha256:` plus 64 lowercase hex characters. */
export const CommitmentDigest = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'expected sha256:<64 hex>');

export const Commitment = z
  .object({
    algorithm: z.literal(COMMITMENT_ALGORITHM),
    digest: CommitmentDigest,
  })
  .strict();
export type Commitment = z.infer<typeof Commitment>;

/** Commit to exact bytes. No reserialization, no canonicalization (PIP-02). */
export function commitBytes(bytes: Uint8Array): Commitment {
  return {
    algorithm: COMMITMENT_ALGORITHM,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  };
}

/** True when `bytes` are the bytes this commitment commits to. */
export function commitmentMatches(
  bytes: Uint8Array,
  commitment: Commitment
): boolean {
  return (
    Commitment.safeParse(commitment).success &&
    commitBytes(bytes).digest === commitment.digest
  );
}

// ── Root and action content ──────────────────────────────────────────────
//
// Both are strict: PIP-02 forbids duplicating the coordination id, actor,
// creation time or predecessor in content, and a strict object is how that
// MUST NOT is actually enforced.

const TermsObject = z.record(z.string(), z.unknown());

export const RootContent = z
  .object({
    version: z.literal(COORDINATION_VERSION),
    profile: VersionedId,
    terms: TermsObject,
    expires_at: UnixSeconds,
    commitments: z.record(z.string(), Commitment).optional(),
  })
  .strict();
export type RootContent = z.infer<typeof RootContent>;

export const ActionContent = z
  .object({
    version: z.literal(COORDINATION_VERSION),
    action: NamespacedId,
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ActionContent = z.infer<typeof ActionContent>;

// ── Kernel actions ───────────────────────────────────────────────────────

export const KERNEL_ACTIONS = [
  'core/accept',
  'core/decline',
  'core/secure',
  'core/authorize_settlement',
  'core/settle',
  'core/authorize_refund',
  'core/refund',
  'core/cancel',
  'core/expire',
  'core/open_dispute',
  'core/resolve_dispute',
] as const;
export type KernelAction = (typeof KERNEL_ACTIONS)[number];

export function isKernelAction(action: string): action is KernelAction {
  return (KERNEL_ACTIONS as readonly string[]).includes(action);
}

/** Actions only the bound `core/escrow` authority may sign. */
export const ESCROW_ONLY_ACTIONS = [
  'core/secure',
  'core/settle',
  'core/refund',
] as const;

export const RESOLUTION_EFFECTS = [
  'resume',
  'authorize_settlement',
  'authorize_refund',
  'cancel',
] as const;
export type ResolutionEffect = (typeof RESOLUTION_EFFECTS)[number];

export const EvidenceRef = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), value: HexEventId }).strict(),
  z.object({ type: z.literal('commitment'), value: CommitmentDigest }).strict(),
  z.object({ type: z.literal('opaque'), value: OpaqueRef }).strict(),
]);
export type EvidenceRef = z.infer<typeof EvidenceRef>;

const EvidenceList = z.array(EvidenceRef).max(16);

/** Every kernel action may carry evidence and, apart from the two below, nothing else. */
const EvidenceOnlyData = z
  .object({ evidence: EvidenceList.optional() })
  .strict();

export const OpenDisputeData = z
  .object({ class: OpaqueRef.optional(), evidence: EvidenceList.optional() })
  .strict();
export type OpenDisputeData = z.infer<typeof OpenDisputeData>;

export const ResolveDisputeData = z
  .object({
    policy: OpaqueRef,
    effect: z.enum(RESOLUTION_EFFECTS),
    evidence: EvidenceList.optional(),
  })
  .strict();
export type ResolveDisputeData = z.infer<typeof ResolveDisputeData>;

/** The data schema PIP-02 defines for a kernel action. */
export function kernelDataSchema(action: KernelAction): z.ZodType {
  if (action === 'core/open_dispute') return OpenDisputeData;
  if (action === 'core/resolve_dispute') return ResolveDisputeData;
  return EvidenceOnlyData;
}

// ── Addressable coordinates ──────────────────────────────────────────────

export type EscrowAddress = { kind: number; pubkey: string; dTag: string };

/** `30361:<pubkey>:<d>`. */
export function formatAddress(
  kind: number,
  pubkey: string,
  dTag: string
): string {
  return `${kind}:${pubkey.toLowerCase()}:${dTag}`;
}

const ADDRESS = /^(\d{1,7}):([0-9a-f]{64}):([!-~]{0,128})$/i;

/** Parse an addressable coordinate, or null. */
export function parseAddress(value: string): EscrowAddress | null {
  const match = ADDRESS.exec(value);
  if (match === null) return null;
  const [, kind, pubkey, dTag] = match;
  if (kind === undefined || pubkey === undefined || dTag === undefined)
    return null;
  return { kind: Number(kind), pubkey: pubkey.toLowerCase(), dTag };
}

/** Parse an escrow coordinate. Only kind 30361 is an escrow descriptor. */
export function parseEscrowAddress(value: string): EscrowAddress | null {
  const address = parseAddress(value);
  return address !== null && address.kind === KIND_ESCROW_DESCRIPTOR
    ? address
    : null;
}

// ── Tag grammar ──────────────────────────────────────────────────────────

export const TAG_MARKER_ROOT = 'root' as const;
export const TAG_MARKER_PREV = 'prev' as const;
export const TAG_MARKER_ESCROW_VERSION = 'escrow-version' as const;
export const TAG_MARKER_ESCROW = 'escrow' as const;

export type Participant = { pubkey: string; relay: string; role: string };

export type RootTags = {
  participants: readonly Participant[];
  descriptorEventId: string;
  descriptorAddress: EscrowAddress;
};

export type ActionTags = { rootId: string; prevId: string };

export type TagsResult<T> = { ok: true; value: T } | { ok: false };

const tagsWith = (tags: readonly string[][], name: string, marker: string) =>
  tags.filter((tag) => tag[0] === name && tag[3] === marker);

export function buildRootTags(input: {
  participants: readonly { pubkey: string; relay?: string; role: string }[];
  descriptorEventId: string;
  descriptorAddress: string;
  descriptorRelay?: string;
}): string[][] {
  const relay = input.descriptorRelay ?? '';
  return [
    ...input.participants.map((p) => [
      'p',
      p.pubkey.toLowerCase(),
      p.relay ?? '',
      p.role,
    ]),
    [
      'e',
      input.descriptorEventId.toLowerCase(),
      relay,
      TAG_MARKER_ESCROW_VERSION,
    ],
    ['a', input.descriptorAddress, relay, TAG_MARKER_ESCROW],
  ];
}

/**
 * Read a root's participant bindings and descriptor references. Roles are the
 * only place authority comes from (I9), so a malformed tag set is fatal here
 * rather than something a later step tries to repair.
 */
export function parseRootTags(tags: readonly string[][]): TagsResult<RootTags> {
  const participants: Participant[] = [];
  for (const tag of tags) {
    if (tag[0] !== 'p') continue;
    const [, pubkey, relay, role] = tag;
    if (pubkey === undefined || role === undefined) return { ok: false };
    if (!HexPubkey.safeParse(pubkey).success) return { ok: false };
    if (!NamespacedId.safeParse(role).success) return { ok: false };
    participants.push({
      pubkey: pubkey.toLowerCase(),
      relay: relay ?? '',
      role,
    });
  }
  if (participants.length === 0) return { ok: false };

  const escrowVersion = tagsWith(tags, 'e', TAG_MARKER_ESCROW_VERSION);
  const escrow = tagsWith(tags, 'a', TAG_MARKER_ESCROW);
  if (escrowVersion.length !== 1 || escrow.length !== 1) return { ok: false };

  const descriptorEventId = escrowVersion[0]?.[1];
  const addressValue = escrow[0]?.[1];
  if (descriptorEventId === undefined || addressValue === undefined)
    return { ok: false };
  if (!HexEventId.safeParse(descriptorEventId).success) return { ok: false };

  const descriptorAddress = parseEscrowAddress(addressValue);
  if (descriptorAddress === null) return { ok: false };

  return {
    ok: true,
    value: {
      participants,
      descriptorEventId: descriptorEventId.toLowerCase(),
      descriptorAddress,
    },
  };
}

export function buildActionTags(input: {
  rootId: string;
  prevId: string;
  relay?: string;
}): string[][] {
  const relay = input.relay ?? '';
  return [
    ['e', input.rootId.toLowerCase(), relay, TAG_MARKER_ROOT],
    ['e', input.prevId.toLowerCase(), relay, TAG_MARKER_PREV],
  ];
}

/** An action carries exactly one `root` and one `prev` reference. */
export function parseActionTags(
  tags: readonly string[][]
): TagsResult<ActionTags> {
  const roots = tagsWith(tags, 'e', TAG_MARKER_ROOT);
  const prevs = tagsWith(tags, 'e', TAG_MARKER_PREV);
  if (roots.length !== 1 || prevs.length !== 1) return { ok: false };

  const rootId = roots[0]?.[1];
  const prevId = prevs[0]?.[1];
  if (rootId === undefined || prevId === undefined) return { ok: false };
  if (!HexEventId.safeParse(rootId).success) return { ok: false };
  if (!HexEventId.safeParse(prevId).success) return { ok: false };

  return {
    ok: true,
    value: { rootId: rootId.toLowerCase(), prevId: prevId.toLowerCase() },
  };
}

// ── Discovery events ─────────────────────────────────────────────────────

/** kind 30361. Strict: a descriptor must not carry custody-backend details. */
export const EscrowDescriptorContent = z
  .object({
    version: z.literal(1),
    escrow_type: LowerId,
    networks: z.array(LowerId).min(1).max(16),
    expires_at: UnixSeconds,
    service: z
      .object({
        schema: z
          .object({ type: z.enum(['openapi', 'asyncapi']), url: HttpsUrl })
          .strict(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(
    (descriptor) =>
      (descriptor.escrow_type !== 'cashu_escrow' ||
        descriptor.networks.includes('cashu')) &&
      (descriptor.escrow_type !== 'lightning_hold_invoice' ||
        descriptor.networks.includes('lightning')),
    'networks must support the escrow mechanism'
  );
export type EscrowDescriptorContent = z.infer<typeof EscrowDescriptorContent>;

/** kind 30360. `capabilities` is canonical; the `t` tags mirror it. */
export const AgentDefinitionContent = z
  .object({
    version: z.literal(1),
    capabilities: z.array(VersionedId).min(1).max(32),
  })
  .strict();
export type AgentDefinitionContent = z.infer<typeof AgentDefinitionContent>;

// ── Content parse / build ────────────────────────────────────────────────

export type ContentResult<T> =
  { ok: true; value: T } | { ok: false; paths: readonly string[] };

/** Input-controlled record keys can contain secrets too: never echo paths (I6). */
function issuePaths(error: z.ZodError): string[] {
  const paths = new Set<string>();
  for (const issue of error.issues) {
    paths.add(issue.path.length > 0 ? '<field>' : '<root>');
  }
  return [...paths];
}

/** Parse an event's `content`. Returns a result: other people's junk is ignored, not raised. */
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

/** Validate and serialise content. Nothing unvalidated is ever signed. */
export function buildEventContent<S extends z.ZodType>(
  schema: S,
  value: z.input<S>,
  context: { label: string; coordinationId?: string } = { label: 'content' }
): string {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new EscrowError(
      'content_invalid',
      `${context.label} failed its schema at: ${issuePaths(parsed.error).join(', ')}`,
      context.coordinationId === undefined
        ? {}
        : { swapId: context.coordinationId }
    );
  }
  return JSON.stringify(parsed.data);
}
