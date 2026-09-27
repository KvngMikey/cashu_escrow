import { describe, expect, it } from 'vitest';

import {
  buildAgentDefinitionEvent,
  parseAgentDefinitionEvent,
} from '../../../src/lib/pontmore/agent.ts';
import {
  buildDescriptorEvent,
  buildDescriptorExpiryEvent,
  isDescriptorSelectableAt,
  parseDescriptorEvent,
} from '../../../src/lib/pontmore/descriptor.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { PROFILE_ID } from '../../../src/lib/profiles/swap-v1.ts';
import { OPERATOR } from '../support/keys.ts';

const signer = createSigner(OPERATOR.nsec);
const createdAt = 1_800_000_000;
const settings = {
  dTag: 'cashu-main',
  schemaUrl: 'https://escrow.example.com/v1/openapi.json',
};

describe('escrow descriptor', () => {
  it('builds the minimum content and mirrors each network in a tag', () => {
    const event = buildDescriptorEvent({
      signer,
      settings,
      ttlSeconds: 600,
      createdAt,
    });
    const descriptor = parseDescriptorEvent(event);

    expect(descriptor).not.toBeNull();
    expect(descriptor?.content).toEqual({
      version: 1,
      escrow_type: 'cashu_escrow',
      networks: ['cashu', 'lightning'],
      expires_at: createdAt + 600,
      service: {
        schema: {
          type: 'openapi',
          url: settings.schemaUrl,
        },
      },
    });
    expect(event.tags).toContainEqual(['d', settings.dTag]);
    expect(event.tags).toContainEqual(['t', 'pontmore-network:cashu']);
    expect(event.tags).toContainEqual(['t', 'pontmore-network:lightning']);
  });

  it('is selectable before expiry and not at or after expiry', () => {
    const event = buildDescriptorEvent({
      signer,
      settings,
      ttlSeconds: 600,
      createdAt,
    });

    expect(isDescriptorSelectableAt(event, createdAt + 599)).toBe(true);
    expect(isDescriptorSelectableAt(event, createdAt + 600)).toBe(false);
    expect(isDescriptorSelectableAt(event, createdAt + 601)).toBe(false);
  });

  it('publishes immediate expiry at the same address', () => {
    const event = buildDescriptorExpiryEvent({ signer, settings, createdAt });
    const descriptor = parseDescriptorEvent(event);

    expect(descriptor?.dTag).toBe(settings.dTag);
    expect(descriptor?.content.expires_at).toBe(createdAt);
    expect(isDescriptorSelectableAt(event, createdAt)).toBe(false);
  });

  it('renews by republishing the same address with a later expiry', () => {
    const first = buildDescriptorEvent({
      signer,
      settings,
      ttlSeconds: 600,
      createdAt,
    });
    const renewed = buildDescriptorEvent({
      signer,
      settings,
      ttlSeconds: 600,
      createdAt: createdAt + 300,
    });

    expect(parseDescriptorEvent(first)?.dTag).toBe(settings.dTag);
    expect(parseDescriptorEvent(renewed)?.dTag).toBe(settings.dTag);
    expect(parseDescriptorEvent(renewed)?.content.expires_at).toBe(
      createdAt + 900
    );
    expect(renewed.id).not.toBe(first.id);
  });

  it('rejects a network tag that is absent from canonical content', () => {
    const event = buildDescriptorEvent({
      signer,
      settings,
      ttlSeconds: 600,
      createdAt,
    });
    const tampered = signer.sign({
      kind: event.kind,
      created_at: event.created_at,
      tags: [...event.tags, ['t', 'pontmore-network:made-up']],
      content: event.content,
    });

    expect(parseDescriptorEvent(tampered)).toBeNull();
  });
});

describe('agent definition', () => {
  it('mirrors capabilities and references the escrow descriptor address', () => {
    const event = buildAgentDefinitionEvent({
      signer,
      capabilities: [PROFILE_ID],
      descriptorDTag: settings.dTag,
      descriptorRelay: 'wss://relay.example.com',
      createdAt,
    });
    const agent = parseAgentDefinitionEvent(event);

    expect(agent?.content).toEqual({
      version: 1,
      capabilities: [PROFILE_ID],
    });
    expect(event.tags).toContainEqual([
      't',
      `pontmore-capability:${PROFILE_ID}`,
    ]);
    expect(agent?.descriptorAddress).toBe(
      `30361:${OPERATOR.pubkey}:${settings.dTag}`
    );
  });

  it('rejects capability tags that disagree with canonical content', () => {
    const event = buildAgentDefinitionEvent({
      signer,
      capabilities: [PROFILE_ID],
      descriptorDTag: settings.dTag,
      createdAt,
    });
    const tampered = signer.sign({
      kind: event.kind,
      created_at: event.created_at,
      tags: event.tags.map((tag) =>
        tag[0] === 't' && tag[1]?.startsWith('pontmore-capability:') === true
          ? ['t', 'pontmore-capability:pontmore/swap@2']
          : tag
      ),
      content: event.content,
    });

    expect(parseAgentDefinitionEvent(tampered)).toBeNull();
  });
});
