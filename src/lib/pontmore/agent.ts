import type { NostrEvent } from 'nostr-tools/pure';

import { EscrowError } from '../errors.ts';
import { nowSeconds } from '../primitives.ts';
import {
  AgentDefinitionContent,
  KIND_AGENT_DEFINITION,
  KIND_ESCROW_DESCRIPTOR,
  buildEventContent,
  formatAddress,
  parseEscrowAddress,
  parseEventContent,
  type AgentDefinitionContent as DefinitionContent,
} from './kinds.ts';
import { verifySignedEvent, type EventSigner } from './signer.ts';

export type ParsedAgentDefinition = {
  dTag: string;
  descriptorAddress: string;
  content: DefinitionContent;
};

export function buildAgentDefinitionEvent(input: {
  signer: EventSigner;
  capabilities: readonly string[];
  descriptorDTag: string;
  descriptorRelay?: string;
  dTag?: string;
  createdAt?: number;
}): NostrEvent {
  const dTag = input.dTag ?? 'agent';
  if (!validDTag(dTag) || !validDTag(input.descriptorDTag)) {
    throw new EscrowError(
      'config_invalid',
      'agent definition d tag is invalid'
    );
  }

  const capabilities = [...input.capabilities];
  const descriptorAddress = formatAddress(
    KIND_ESCROW_DESCRIPTOR,
    input.signer.pubkey,
    input.descriptorDTag
  );

  return input.signer.sign({
    kind: KIND_AGENT_DEFINITION,
    created_at: input.createdAt ?? nowSeconds(),
    tags: [
      ['d', dTag],
      ['t', 'agent'],
      ...capabilities.map((capability) => [
        't',
        `pontmore-capability:${capability}`,
      ]),
      ['a', descriptorAddress, input.descriptorRelay ?? '', 'escrow'],
    ],
    content: buildEventContent(
      AgentDefinitionContent,
      { version: 1, capabilities },
      { label: 'agent definition' }
    ),
  });
}

export function parseAgentDefinitionEvent(
  event: NostrEvent
): ParsedAgentDefinition | null {
  if (event.kind !== KIND_AGENT_DEFINITION || !verifySignedEvent(event)) {
    return null;
  }

  const content = parseEventContent(AgentDefinitionContent, event.content);
  if (!content.ok) return null;

  const dTags = event.tags.filter((tag) => tag[0] === 'd');
  const dTag = dTags[0]?.[1];
  if (dTags.length !== 1 || dTag === undefined || !validDTag(dTag)) {
    return null;
  }
  if (!event.tags.some((tag) => tag[0] === 't' && tag[1] === 'agent')) {
    return null;
  }

  const taggedCapabilities = event.tags
    .filter(
      (tag) =>
        tag[0] === 't' && tag[1]?.startsWith('pontmore-capability:') === true
    )
    .map((tag) => tag[1]?.slice('pontmore-capability:'.length) ?? '');
  if (!sameValues(taggedCapabilities, content.value.capabilities)) {
    return null;
  }

  const escrowTags = event.tags.filter(
    (tag) => tag[0] === 'a' && tag[3] === 'escrow'
  );
  const descriptorAddress = escrowTags[0]?.[1];
  if (
    escrowTags.length !== 1 ||
    descriptorAddress === undefined ||
    parseEscrowAddress(descriptorAddress) === null
  ) {
    return null;
  }

  return { dTag, descriptorAddress, content: content.value };
}

function sameValues(
  left: readonly string[],
  right: readonly string[]
): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function validDTag(value: string): boolean {
  return /^[!-~]{1,128}$/.test(value);
}
