import { describe, expect, it } from 'vitest';

import { isEscrowError } from '../../../src/lib/errors.ts';
import type { EscrowError } from '../../../src/lib/errors.ts';
import {
  ActionContent,
  AgentDefinitionContent,
  Commitment,
  EscrowDescriptorContent,
  EvidenceRef,
  KIND_AGENT_DEFINITION,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  KIND_ESCROW_DESCRIPTOR,
  OpenDisputeData,
  ResolveDisputeData,
  RootContent,
  buildActionTags,
  buildEventContent,
  buildRootTags,
  commitBytes,
  commitmentMatches,
  formatAddress,
  isKernelAction,
  kernelDataSchema,
  parseActionTags,
  parseEscrowAddress,
  parseEventContent,
  parseRootTags,
} from '../../../src/lib/pontmore/kinds.ts';
import { AGENT, CUSTOMER, OPERATOR } from '../support/keys.ts';

const ADDRESS = formatAddress(
  KIND_ESCROW_DESCRIPTOR,
  OPERATOR.pubkey,
  'cashu-main'
);
const DESCRIPTOR_ID = 'd'.repeat(64);

const root = () => ({
  version: 2 as const,
  profile: 'pontmore/swap@1',
  terms: { direction: 'btc_to_fiat' },
  expires_at: 1_800_000_000,
});

describe('kinds', () => {
  it('defines only the two v2 coordination kinds', () => {
    expect([
      KIND_COORDINATION_ROOT,
      KIND_COORDINATION_ACTION,
      KIND_AGENT_DEFINITION,
      KIND_ESCROW_DESCRIPTOR,
    ]).toEqual([7300, 7301, 30360, 30361]);
  });

  it('knows the kernel action namespace', () => {
    expect(isKernelAction('core/settle')).toBe(true);
    expect(isKernelAction('swap/fiat_sent')).toBe(false);
    expect(isKernelAction('core/made_up')).toBe(false);
  });
});

describe('root and action content', () => {
  it('accepts a v2 root and refuses another version', () => {
    expect(RootContent.safeParse(root()).success).toBe(true);
    expect(RootContent.safeParse({ ...root(), version: 1 }).success).toBe(
      false
    );
  });

  it('refuses content that duplicates event facts', () => {
    // PIP-02: the coordination id, actor, creation time and predecessor are
    // event facts and MUST NOT be repeated in content.
    expect(
      RootContent.safeParse({ ...root(), coordination_id: 'a'.repeat(64) })
        .success
    ).toBe(false);
    expect(
      ActionContent.safeParse({ version: 2, action: 'core/accept', prev: 'x' })
        .success
    ).toBe(false);
  });

  it('accepts an action with profile data and rejects an unnamespaced action', () => {
    expect(
      ActionContent.safeParse({
        version: 2,
        action: 'swap/fiat_sent',
        data: { payment_reference: 'pay-1' },
      }).success
    ).toBe(true);
    expect(
      ActionContent.safeParse({ version: 2, action: 'settle' }).success
    ).toBe(false);
  });
});

describe('kernel action data', () => {
  it('allows evidence on any kernel action and nothing else', () => {
    const schema = kernelDataSchema('core/secure');
    expect(
      schema.safeParse({ evidence: [{ type: 'opaque', value: 'ref-1' }] })
        .success
    ).toBe(true);
    expect(schema.safeParse({ note: 'anything' }).success).toBe(false);
  });

  it('binds policy and effect to a resolution', () => {
    expect(
      ResolveDisputeData.safeParse({
        policy: 'policy-1',
        effect: 'authorize_refund',
      }).success
    ).toBe(true);
    expect(ResolveDisputeData.safeParse({ policy: 'policy-1' }).success).toBe(
      false
    );
    expect(
      ResolveDisputeData.safeParse({ policy: 'policy-1', effect: 'pay_me' })
        .success
    ).toBe(false);
  });

  it('keeps a dispute class opaque', () => {
    expect(
      OpenDisputeData.safeParse({ class: 'fiat_not_received' }).success
    ).toBe(true);
    expect(
      OpenDisputeData.safeParse({ class: 'he never paid, see screenshot' })
        .success
    ).toBe(false);
  });

  it('types every evidence reference', () => {
    expect(
      EvidenceRef.safeParse({ type: 'event', value: 'a'.repeat(64) }).success
    ).toBe(true);
    expect(
      EvidenceRef.safeParse({
        type: 'commitment',
        value: `sha256:${'0'.repeat(64)}`,
      }).success
    ).toBe(true);
    expect(
      EvidenceRef.safeParse({ type: 'event', value: 'not-an-id' }).success
    ).toBe(false);
  });
});

describe('commitments', () => {
  it('commits to exact bytes and verifies them', () => {
    const bytes = new TextEncoder().encode('{"account":"redacted"}');
    const commitment = commitBytes(bytes);

    expect(Commitment.safeParse(commitment).success).toBe(true);
    expect(commitment.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(commitmentMatches(bytes, commitment)).toBe(true);
    expect(
      commitmentMatches(
        new TextEncoder().encode('{"account":"other"}'),
        commitment
      )
    ).toBe(false);
  });
});

describe('tags', () => {
  it('round trips root participant and descriptor bindings', () => {
    const tags = buildRootTags({
      participants: [
        { pubkey: AGENT.pubkey, role: 'swap/agent' },
        { pubkey: CUSTOMER.pubkey, role: 'swap/customer' },
        { pubkey: OPERATOR.pubkey, role: 'core/escrow' },
      ],
      descriptorEventId: DESCRIPTOR_ID,
      descriptorAddress: ADDRESS,
    });

    const parsed = parseRootTags(tags);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.participants).toHaveLength(3);
    expect(parsed.value.descriptorEventId).toBe(DESCRIPTOR_ID);
    expect(parsed.value.descriptorAddress.kind).toBe(KIND_ESCROW_DESCRIPTOR);
  });

  it('refuses an unnamespaced role and a missing descriptor reference', () => {
    const base = buildRootTags({
      participants: [{ pubkey: AGENT.pubkey, role: 'swap/agent' }],
      descriptorEventId: DESCRIPTOR_ID,
      descriptorAddress: ADDRESS,
    });

    expect(
      parseRootTags([['p', AGENT.pubkey, '', 'agent'], ...base.slice(1)]).ok
    ).toBe(false);
    expect(parseRootTags(base.slice(0, 2)).ok).toBe(false);
  });

  it('only accepts kind 30361 as an escrow coordinate', () => {
    expect(parseEscrowAddress(ADDRESS)?.dTag).toBe('cashu-main');
    expect(
      parseEscrowAddress(
        formatAddress(KIND_AGENT_DEFINITION, OPERATOR.pubkey, 'agent')
      )
    ).toBeNull();
  });

  it('round trips root and prev references', () => {
    const tags = buildActionTags({
      rootId: 'a'.repeat(64),
      prevId: 'b'.repeat(64),
    });
    const parsed = parseActionTags(tags);

    expect(parsed.ok && parsed.value).toEqual({
      rootId: 'a'.repeat(64),
      prevId: 'b'.repeat(64),
    });
    expect(parseActionTags([tags[0] ?? []]).ok).toBe(false);
  });
});

describe('discovery content', () => {
  it('accepts a current descriptor and refuses custody-backend detail in it', () => {
    const descriptor = {
      version: 1,
      escrow_type: 'cashu_escrow',
      networks: ['cashu'],
      expires_at: 1_800_000_000,
      service: {
        schema: {
          type: 'openapi' as const,
          url: 'https://escrow.example.com/v1.json',
        },
      },
    };
    expect(EscrowDescriptorContent.safeParse(descriptor).success).toBe(true);
    expect(
      EscrowDescriptorContent.safeParse({
        ...descriptor,
        mint_url: 'https://mint.example.com',
      }).success
    ).toBe(false);
    expect(
      EscrowDescriptorContent.safeParse({
        ...descriptor,
        service: {
          schema: { type: 'openapi', url: 'http://escrow.example.com/v1.json' },
        },
      }).success
    ).toBe(false);
  });

  it('takes capabilities as versioned identifiers', () => {
    expect(
      AgentDefinitionContent.safeParse({
        version: 1,
        capabilities: ['pontmore/swap@1'],
      }).success
    ).toBe(true);
    expect(
      AgentDefinitionContent.safeParse({
        version: 1,
        capabilities: ['pontmore/swap'],
      }).success
    ).toBe(false);
    expect(
      AgentDefinitionContent.safeParse({ version: 1, capabilities: [] }).success
    ).toBe(false);
  });
});

describe('content helpers', () => {
  it('reports failing paths, never failing values (I6)', () => {
    const content = JSON.stringify({
      version: 2,
      action: 'swap/fiat_sent',
      data: { payment_reference: 'MPESA 254712345678' },
      note: 'cashuBsecrettoken',
    });

    const result = parseEventContent(ActionContent, content);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.paths.join(' ')).not.toContain('cashuB');
    expect(result.paths.join(' ')).not.toContain('254712345678');
  });

  it('does not echo private values hidden in record keys', () => {
    const secret = 'private-value-in-a-key';
    const value = {
      ...root(),
      commitments: { [secret]: { algorithm: 'bad' } },
    };
    const result = parseEventContent(RootContent, JSON.stringify(value));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(() => buildEventContent(RootContent, value as never)).toThrowError(
      'failed its schema'
    );
    try {
      buildEventContent(RootContent, value as never);
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });

  it('rejects an unsupported commitment algorithm even with a matching digest', () => {
    const bytes = new TextEncoder().encode('abc');
    const valid = commitBytes(bytes);
    expect(valid.digest).toBe(
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
    expect(
      commitmentMatches(bytes, { ...valid, algorithm: 'unknown' } as never)
    ).toBe(false);
  });

  it('rejects unsupported discovery versions', () => {
    expect(
      AgentDefinitionContent.safeParse({
        version: 2,
        capabilities: ['pontmore/swap@1'],
      }).success
    ).toBe(false);
  });

  it('refuses to serialise an invalid payload', () => {
    let thrown: unknown;
    try {
      buildEventContent(RootContent, { ...root(), version: 1 } as never, {
        label: 'root',
        coordinationId: 'a'.repeat(64),
      });
    } catch (error) {
      thrown = error;
    }
    expect(isEscrowError(thrown)).toBe(true);
    expect((thrown as EscrowError).category).toBe('content_invalid');
  });
});
