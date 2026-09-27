import type { NostrEvent } from 'nostr-tools/pure';

import { EscrowError } from '../errors.ts';
import { nowSeconds } from '../primitives.ts';
import {
  EscrowDescriptorContent,
  KIND_ESCROW_DESCRIPTOR,
  buildEventContent,
  parseEventContent,
  type EscrowDescriptorContent as DescriptorContent,
} from './kinds.ts';
import { verifySignedEvent, type EventSigner } from './signer.ts';

export const ESCROW_TYPE = 'cashu_escrow' as const;
export const ESCROW_NETWORKS = ['cashu', 'lightning'] as const;
export type EscrowNetwork = (typeof ESCROW_NETWORKS)[number];

export type DescriptorSettings = {
  dTag: string;
  schemaUrl: string;
};

export type ParsedDescriptor = {
  dTag: string;
  content: DescriptorContent;
};

export function buildDescriptorEvent(input: {
  signer: EventSigner;
  settings: DescriptorSettings;
  ttlSeconds: number;
  createdAt?: number;
}): NostrEvent {
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds <= 0) {
    throw new EscrowError('config_invalid', 'descriptor TTL is invalid');
  }
  const createdAt = input.createdAt ?? nowSeconds();
  return signDescriptor(
    input.signer,
    input.settings,
    createdAt,
    createdAt + input.ttlSeconds
  );
}

/** Publish at the same address to stop new coordinations immediately. */
export function buildDescriptorExpiryEvent(input: {
  signer: EventSigner;
  settings: DescriptorSettings;
  createdAt?: number;
}): NostrEvent {
  const createdAt = input.createdAt ?? nowSeconds();
  return signDescriptor(input.signer, input.settings, createdAt, createdAt);
}

export function parseDescriptorEvent(
  event: NostrEvent
): ParsedDescriptor | null {
  if (event.kind !== KIND_ESCROW_DESCRIPTOR || !verifySignedEvent(event)) {
    return null;
  }

  const content = parseEventContent(EscrowDescriptorContent, event.content);
  if (!content.ok) return null;

  const dTags = event.tags.filter((tag) => tag[0] === 'd');
  const dTag = dTags[0]?.[1];
  if (dTags.length !== 1 || dTag === undefined || !validDTag(dTag)) {
    return null;
  }

  const networks = new Set(content.value.networks);
  for (const tag of event.tags) {
    const value = tag[1];
    if (tag[0] !== 't' || value === undefined) continue;
    if (
      value.startsWith('pontmore-network:') &&
      !networks.has(value.slice('pontmore-network:'.length))
    ) {
      return null;
    }
  }

  return { dTag, content: content.value };
}

export function isDescriptorSelectableAt(
  event: NostrEvent,
  at: number
): boolean {
  const descriptor = parseDescriptorEvent(event);
  return descriptor !== null && at < descriptor.content.expires_at;
}

function signDescriptor(
  signer: EventSigner,
  settings: DescriptorSettings,
  createdAt: number,
  expiresAt: number
): NostrEvent {
  if (!validDTag(settings.dTag)) {
    throw new EscrowError('config_invalid', 'descriptor d tag is invalid');
  }

  return signer.sign({
    kind: KIND_ESCROW_DESCRIPTOR,
    created_at: createdAt,
    tags: [
      ['d', settings.dTag],
      ...ESCROW_NETWORKS.map((network) => ['t', `pontmore-network:${network}`]),
    ],
    content: buildEventContent(
      EscrowDescriptorContent,
      {
        version: 1,
        escrow_type: ESCROW_TYPE,
        networks: [...ESCROW_NETWORKS],
        expires_at: expiresAt,
        service: { schema: { type: 'openapi', url: settings.schemaUrl } },
      },
      { label: 'escrow descriptor' }
    ),
  });
}

function validDTag(value: string): boolean {
  return /^[!-~]{1,128}$/.test(value);
}
