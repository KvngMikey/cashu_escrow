import { describe, expect, it } from 'vitest';

import { isEscrowError } from '../../../src/lib/errors.ts';
import type { EscrowError } from '../../../src/lib/errors.ts';
import {
  AgentDefinitionContent,
  CashuEscrowDescriptorContent,
  DisputeContent,
  EscrowDescriptorContent,
  EscrowFundingMessage,
  EvidenceContent,
  KIND_AGENT_DEFINITION,
  KIND_DISPUTE,
  KIND_ESCROW_DESCRIPTOR,
  KIND_EVIDENCE,
  KIND_GIFT_WRAP,
  KIND_NOTE,
  KIND_SEAL,
  KIND_SNAPSHOT,
  KIND_SWAP_REQUEST,
  KIND_TRANSITION,
  PrivateMessage,
  SnapshotContent,
  SwapRequestContent,
  TransitionContent,
  buildEventContent,
  coordinate,
  parseCoordinate,
  parseEventContent,
} from '../../../src/lib/pontmore/kinds.ts';
import { AGENT, CUSTOMER, OPERATOR } from '../support/keys.ts';

const DESCRIPTOR = coordinate(
  KIND_ESCROW_DESCRIPTOR,
  OPERATOR.pubkey,
  'cashu-default'
);

/** Obviously fake, but shaped like the real thing. Never logged. */
const FAKE_TOKEN = `cashuB${'o'.repeat(64)}`;

const swapRequest = () => ({
  version: 1 as const,
  swap_id: 'b3c1f6d2-0f1e-4a6b-9c2d-7e5a1b3c4d5e',
  swap_type: 'btc_to_fiat' as const,
  agent: AGENT.pubkey,
  customer: CUSTOMER.pubkey,
  escrow_reference: DESCRIPTOR,
  fiat: { currency: 'KES', amount: '15000.00', rail: 'mpesa' },
  bitcoin: { amount_sats: '100000', payout: 'lightning' },
  expiry: 1_800_000_000,
});

const fundingMessage = () => ({
  version: 1 as const,
  type: 'escrow_funding' as const,
  swap_id: 'b3c1f6d2-0f1e-4a6b-9c2d-7e5a1b3c4d5e',
  token: FAKE_TOKEN,
  mint_url: 'http://localhost:3338',
  amount_sats: 100_000,
  locktime: 1_800_003_600,
  refund_pubkey: CUSTOMER.pubkey,
});

const descriptor = () => ({
  version: 1 as const,
  escrow_type: 'cashu_escrow' as const,
  networks: ['cashu', 'lightning'],
  funding_rules: { funding_threshold: 1, participant_count: 1 },
  dispute_rules: { policy: 'pip03' },
  reference_format: 'cashu_v4_token' as const,
  updated_at: 1_800_000_000,
  implementations: [
    {
      network: 'cashu' as const,
      mint_url: 'https://mint.example.com',
      lock_mechanism: 'p2pk_timelock' as const,
      invoice_expiry_rule: 'p2pk_timelock_expiry' as const,
      reference_format: 'cashu_v4_token' as const,
      payout_network: 'lightning' as const,
    },
  ],
});

describe('kind numbers', () => {
  it('are the numbers the PIPs assign', () => {
    expect([
      KIND_SWAP_REQUEST,
      KIND_TRANSITION,
      KIND_EVIDENCE,
      KIND_DISPUTE,
      KIND_NOTE,
      KIND_AGENT_DEFINITION,
      KIND_ESCROW_DESCRIPTOR,
      KIND_SNAPSHOT,
      KIND_SEAL,
      KIND_GIFT_WRAP,
    ]).toEqual([7300, 7301, 7302, 7303, 7304, 30360, 30361, 30362, 13, 1059]);
  });
});

describe('coordinates', () => {
  it('round trips an addressable coordinate', () => {
    expect(parseCoordinate(DESCRIPTOR)).toEqual({
      kind: KIND_ESCROW_DESCRIPTOR,
      pubkey: OPERATOR.pubkey,
      dTag: 'cashu-default',
    });
  });

  it('accepts an empty d tag and rejects a malformed coordinate', () => {
    expect(parseCoordinate('30361:' + OPERATOR.pubkey + ':')?.dTag).toBe('');
    expect(parseCoordinate('30361:not-a-pubkey:d')).toBeNull();
    expect(parseCoordinate(OPERATOR.pubkey)).toBeNull();
  });
});

describe('swap lifecycle schemas', () => {
  it('accepts a well-formed swap request and normalises pubkeys', () => {
    const parsed = SwapRequestContent.parse({
      ...swapRequest(),
      agent: AGENT.pubkey.toUpperCase(),
    });
    expect(parsed.agent).toBe(AGENT.pubkey);
  });

  it('refuses a request it cannot interpret', () => {
    const cases = [
      { ...swapRequest(), version: 2 },
      { ...swapRequest(), agent: 'nope' },
      { ...swapRequest(), escrow_reference: 'not-a-coordinate' },
      {
        ...swapRequest(),
        bitcoin: { amount_sats: '10.5', payout: 'lightning' },
      },
      { ...swapRequest(), expiry: -1 },
    ];
    for (const value of cases) {
      expect(SwapRequestContent.safeParse(value).success).toBe(false);
    }
  });

  it('accepts a transition and refuses an unknown state or an oversized reason', () => {
    const transition = {
      swap_id: 'swap-1',
      state: 'funded' as const,
      prev_state: 'accepted' as const,
      actor_role: 'escrow' as const,
      reason: 'locked token verified and persisted',
      created_at: 1_800_000_000,
    };
    expect(TransitionContent.safeParse(transition).success).toBe(true);
    expect(
      TransitionContent.safeParse({ ...transition, state: 'settled' }).success
    ).toBe(false);
    expect(
      TransitionContent.safeParse({ ...transition, reason: 'x'.repeat(281) })
        .success
    ).toBe(false);
  });

  it('carries a resolution and its policy on a resolving transition', () => {
    const parsed = TransitionContent.parse({
      swap_id: 'swap-1',
      state: 'refunded',
      prev_state: 'disputed',
      actor_role: 'escrow',
      reason: 'dispute resolved in favour of the customer',
      created_at: 1_800_000_000,
      policy: 'pip03',
      resolution: 'confirm_customer_claim',
    });
    expect(parsed.resolution).toBe('confirm_customer_claim');
  });

  it('requires evidence to reference something', () => {
    expect(
      EvidenceContent.safeParse({ swap_id: 'swap-1', type: 'payout_proof' })
        .success
    ).toBe(false);
    expect(
      EvidenceContent.safeParse({
        swap_id: 'swap-1',
        type: 'payout_proof',
        ref: 'QGH7X2K9',
      }).success
    ).toBe(true);
  });

  it('binds a dispute resolution to the resolved stage', () => {
    const dispute = {
      version: 1 as const,
      swap_id: 'swap-1',
      stage: 'opened' as const,
      dispute_class: 'payout_not_sent' as const,
      policy: 'pip03',
      actor_role: 'agent' as const,
    };
    expect(DisputeContent.safeParse(dispute).success).toBe(true);
    expect(
      DisputeContent.safeParse({
        ...dispute,
        resolution: 'confirm_agent_claim',
      }).success
    ).toBe(false);
    expect(
      DisputeContent.safeParse({ ...dispute, stage: 'resolved' }).success
    ).toBe(false);
    expect(
      DisputeContent.safeParse({
        ...dispute,
        stage: 'resolved',
        resolution: 'confirm_agent_claim',
      }).success
    ).toBe(true);
  });

  it('accepts a snapshot built from a replayed chain', () => {
    const request = swapRequest();
    expect(
      SnapshotContent.safeParse({
        swap_id: request.swap_id,
        final_state: 'completed',
        agent: request.agent,
        customer: request.customer,
        swap_type: request.swap_type,
        fiat: request.fiat,
        bitcoin: request.bitcoin,
        transitions: [
          { state: 'accepted', actor_role: 'escrow', at: 1_800_000_001 },
          { state: 'funded', actor_role: 'escrow', at: 1_800_000_002 },
        ],
        completed_at: 1_800_000_100,
      }).success
    ).toBe(true);
  });
});

describe('discovery schemas', () => {
  it('takes a pricing policy as a string or as the fee-switch object', () => {
    const agent = {
      version: 1 as const,
      name: 'cashu escrow operator',
      capabilities: { settlement_networks: ['cashu', 'lightning'] },
      updated_at: 1_800_000_000,
    };
    expect(
      AgentDefinitionContent.safeParse({
        ...agent,
        pricing_policy: '1% of the swap',
      }).success
    ).toBe(true);
    expect(
      AgentDefinitionContent.safeParse({
        ...agent,
        pricing_policy: { fee_pct: 0, fee_note: 'fee-free while in beta' },
      }).success
    ).toBe(true);
  });

  it('enforces PIP-01 funding cardinality', () => {
    const { implementations: _implementations, ...base } = descriptor();
    expect(EscrowDescriptorContent.safeParse(base).success).toBe(true);
    expect(
      EscrowDescriptorContent.safeParse({
        ...base,
        funding_rules: { funding_threshold: 2, participant_count: 1 },
      }).success
    ).toBe(false);
  });

  it('refuses a descriptor version it cannot interpret', () => {
    expect(
      EscrowDescriptorContent.safeParse({ ...descriptor(), version: 2 }).success
    ).toBe(false);
  });

  it('requires a cashu descriptor to declare the mint it locks against', () => {
    expect(CashuEscrowDescriptorContent.safeParse(descriptor()).success).toBe(
      true
    );

    const { implementations: _dropped, ...withoutImplementations } =
      descriptor();
    expect(
      CashuEscrowDescriptorContent.safeParse(withoutImplementations).success
    ).toBe(false);

    expect(
      CashuEscrowDescriptorContent.safeParse({
        ...descriptor(),
        implementations: [
          { ...descriptor().implementations[0], lock_mechanism: 'htlc' },
        ],
      }).success
    ).toBe(false);
  });

  it('requires the cashu network on a cashu descriptor', () => {
    expect(
      CashuEscrowDescriptorContent.safeParse({
        ...descriptor(),
        networks: ['lightning'],
      }).success
    ).toBe(false);
  });

  it('keeps the authority fields optional, as the spec left them', () => {
    expect(
      CashuEscrowDescriptorContent.safeParse({
        ...descriptor(),
        custody_authority: 'escrow_operator',
        release_authority: 'escrow_operator',
        refund_authority: 'escrow_operator',
        release_rules: {
          release_trigger: 'customer_fiat_receipt_confirmed',
          refund_trigger: 'locktime_expiry_or_resolution',
        },
      }).success
    ).toBe(true);
  });
});

describe('private lane schemas', () => {
  it('accepts a funding message and discriminates the union on `type`', () => {
    expect(EscrowFundingMessage.safeParse(fundingMessage()).success).toBe(true);

    const parsed = PrivateMessage.parse(fundingMessage());
    expect(parsed.type).toBe('escrow_funding');
  });

  it('refuses anything that is not a cashu v4 token', () => {
    for (const token of ['cashuAeyJ0b2tlbiI6W119', 'not-a-token', '']) {
      expect(
        EscrowFundingMessage.safeParse({ ...fundingMessage(), token }).success
      ).toBe(false);
    }
  });

  it('names the two refund paths invariant I4 defines', () => {
    const refund = {
      version: 1 as const,
      type: 'escrow_refund' as const,
      swap_id: 'swap-1',
      token: FAKE_TOKEN,
      mint_url: 'http://localhost:3338',
      amount_sats: 100_000,
    };
    expect(
      PrivateMessage.safeParse({ ...refund, refund_path: 'locktime_expiry' })
        .success
    ).toBe(true);
    expect(
      PrivateMessage.safeParse({ ...refund, refund_path: 'relock' }).success
    ).toBe(true);
    expect(
      PrivateMessage.safeParse({ ...refund, refund_path: 'operator_keeps_it' })
        .success
    ).toBe(false);
  });
});

describe('content helpers', () => {
  it('parses an event content string against its schema', () => {
    const content = JSON.stringify(swapRequest());
    const result = parseEventContent(SwapRequestContent, content);
    expect(result.ok && result.value.swap_type).toBe('btc_to_fiat');
  });

  it('reports malformed JSON without throwing', () => {
    const result = parseEventContent(SwapRequestContent, '{not json');
    expect(result).toEqual({ ok: false, paths: ['<json>'] });
  });

  it('reports the failing field paths and never the failing values (I6)', () => {
    const content = JSON.stringify({
      ...fundingMessage(),
      token: `${FAKE_TOKEN}!!`,
      refund_pubkey: 'not-a-pubkey',
    });

    const result = parseEventContent(EscrowFundingMessage, content);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect([...result.paths].sort()).toEqual(['refund_pubkey', 'token']);
    expect(result.paths.join(' ')).not.toContain('cashuB');
    expect(result.paths.join(' ')).not.toContain('not-a-pubkey');
  });

  it('validates and serialises content on the way out', () => {
    const content = buildEventContent(
      SwapRequestContent,
      { ...swapRequest(), customer: CUSTOMER.pubkey.toUpperCase() },
      { label: 'swap request' }
    );
    expect(JSON.parse(content)).toMatchObject({ customer: CUSTOMER.pubkey });
  });

  it('refuses to serialise an invalid payload, carrying paths not material', () => {
    let thrown: unknown;
    try {
      buildEventContent(
        EscrowFundingMessage,
        { ...fundingMessage(), token: 'leaky-secret-token-value' },
        { label: 'funding message', swapId: 'swap-1' }
      );
    } catch (error) {
      thrown = error;
    }

    expect(isEscrowError(thrown)).toBe(true);
    const error = thrown as EscrowError;
    expect(error.category).toBe('content_invalid');
    expect(error.swapId).toBe('swap-1');
    expect(error.message).toContain('token');
    expect(error.message).not.toContain('leaky-secret-token-value');
  });
});
