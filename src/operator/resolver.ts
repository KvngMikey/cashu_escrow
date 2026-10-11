import type { NostrEvent } from 'nostr-tools/pure';
import { z } from 'zod';

import { EscrowError } from '../lib/errors.ts';
import {
  appendAction,
  deriveState,
  validateRoot,
} from '../lib/pontmore/chain.ts';
import {
  ActionContent,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  ROLE_ESCROW,
  ROLE_RESOLVER,
  RESOLUTION_EFFECTS,
  ResolveDisputeData,
  buildActionTags,
  buildEventContent,
  parseRootTags,
} from '../lib/pontmore/kinds.ts';
import type { RelayClient } from '../lib/pontmore/relay.ts';
import type { EventSigner } from '../lib/pontmore/signer.ts';
import {
  HexEventId,
  HexPubkey,
  OpaqueRef,
  UnixSeconds,
} from '../lib/primitives.ts';
import { swapV1 } from '../lib/profiles/swap-v1.ts';

export const ResolutionRequest = z
  .object({
    coordinationId: HexEventId,
    effect: z.enum(RESOLUTION_EFFECTS),
    policy: OpaqueRef,
    createdAt: UnixSeconds,
  })
  .strict();
export type ResolutionRequest = z.infer<typeof ResolutionRequest>;

/** Validate and publish one resolver-authorized dispute effect. */
export async function resolveDispute(input: {
  relay: RelayClient;
  signer: EventSigner;
  escrowPubkey: string;
  request: ResolutionRequest;
}): Promise<NostrEvent> {
  const request = ResolutionRequest.safeParse(input.request);
  const escrowPubkey = HexPubkey.safeParse(input.escrowPubkey);
  if (!request.success || !escrowPubkey.success) {
    throw new EscrowError('content_invalid', 'resolution request is invalid');
  }

  const roots = await input.relay.query([
    { ids: [request.data.coordinationId], kinds: [KIND_COORDINATION_ROOT] },
  ]);
  const rootEvent = roots.find(
    (candidate) => candidate.id === request.data.coordinationId
  );
  if (rootEvent === undefined) {
    throw new EscrowError(
      'coordination_not_found',
      'coordination was not found',
      { swapId: request.data.coordinationId }
    );
  }

  const tags = parseRootTags(rootEvent.tags);
  if (!tags.ok)
    invalid(request.data.coordinationId, 'coordination root is invalid');
  const descriptors = await input.relay.query([
    { ids: [tags.value.descriptorEventId] },
  ]);
  const descriptor = descriptors.find(
    (candidate) => candidate.id === tags.value.descriptorEventId
  );
  if (descriptor === undefined) {
    invalid(request.data.coordinationId, 'escrow descriptor is unavailable');
  }
  const root = validateRoot({ root: rootEvent, descriptor, profile: swapV1 });
  if (!root.ok)
    invalid(request.data.coordinationId, 'coordination root is invalid');
  if (
    descriptor.pubkey !== escrowPubkey.data ||
    root.value.participants.get(ROLE_ESCROW)?.pubkey !== escrowPubkey.data ||
    root.value.participants.get(ROLE_RESOLVER)?.pubkey !== input.signer.pubkey
  ) {
    throw new EscrowError(
      'request_unauthorized',
      'resolver is not bound to this escrow coordination',
      { swapId: request.data.coordinationId }
    );
  }

  const actions = await input.relay.query([
    {
      kinds: [KIND_COORDINATION_ACTION],
      '#e': [request.data.coordinationId],
    },
  ]);
  const state = deriveState({
    root: root.value,
    actions: actions.filter(
      (action) => action.created_at <= request.data.createdAt
    ),
    profile: swapV1,
  });
  if (state.forked !== null) {
    throw new EscrowError(
      'custody_conflict',
      'forked coordination requires manual recovery',
      { swapId: request.data.coordinationId }
    );
  }
  if (state.terminal || !state.disputed) {
    throw new EscrowError(
      'custody_conflict',
      'coordination is not awaiting dispute resolution',
      { swapId: request.data.coordinationId }
    );
  }

  const event = input.signer.sign({
    kind: KIND_COORDINATION_ACTION,
    created_at: request.data.createdAt,
    tags: buildActionTags({
      rootId: root.value.id,
      prevId: state.tip,
      relay: input.relay.relays[0] ?? '',
    }),
    content: buildEventContent(
      ActionContent,
      {
        version: 2,
        action: 'core/resolve_dispute',
        data: ResolveDisputeData.parse({
          policy: request.data.policy,
          effect: request.data.effect,
        }),
      },
      { label: 'dispute resolution', coordinationId: root.value.id }
    ),
  });
  const permitted = appendAction({
    root: root.value,
    state,
    event,
    profile: swapV1,
  });
  if (!permitted.ok) {
    invalid(request.data.coordinationId, 'dispute resolution is not permitted');
  }

  await input.relay.publish(event);
  const readBack = await input.relay.query([{ ids: [event.id] }]);
  if (!readBack.some((candidate) => candidate.id === event.id)) {
    throw new EscrowError(
      'relay_unavailable',
      'dispute resolution failed relay read-back',
      { swapId: request.data.coordinationId }
    );
  }
  return event;
}

function invalid(coordinationId: string, message: string): never {
  throw new EscrowError('event_invalid', message, { swapId: coordinationId });
}
