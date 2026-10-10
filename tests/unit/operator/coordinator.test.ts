import { describe, expect, it } from 'vitest';

import type { NostrEvent } from 'nostr-tools/pure';

import { CustodyEngine } from '../../../src/lib/cashu/custody.ts';
import type { InspectedToken } from '../../../src/lib/cashu/mint.ts';
import type { SignedQuote } from '../../../src/lib/cashu/quotes.ts';
import {
  commitBytes,
  ActionContent,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  ROLE_ESCROW,
  ROLE_RESOLVER,
  RootContent,
  buildActionTags,
  buildEventContent,
  buildRootTags,
  formatAddress,
  KIND_ESCROW_DESCRIPTOR,
} from '../../../src/lib/pontmore/kinds.ts';
import { buildDescriptorEvent } from '../../../src/lib/pontmore/descriptor.ts';
import {
  createRelayClient,
  type RelayClient,
} from '../../../src/lib/pontmore/relay.ts';
import {
  createSigner,
  type EventSigner,
} from '../../../src/lib/pontmore/signer.ts';
import {
  ACTION_FIAT_CONFIRMED,
  ACTION_FIAT_SENT,
  PROFILE_ID,
  ROLE_AGENT,
  ROLE_CUSTOMER,
  type Direction,
} from '../../../src/lib/profiles/swap-v1.ts';
import {
  CoordinationOperator,
  type OperatorPolicy,
} from '../../../src/operator/coordinator.ts';
import {
  FakeCustodyMint,
  MemoryCustodyStore,
} from '../support/fake-custody.ts';
import { MemoryOperatorStore } from '../support/fake-operator.ts';
import {
  createFakeRelayPool,
  type FakeRelayPool,
} from '../support/fake-relay-pool.ts';
import { AGENT, CUSTOMER, OPERATOR, STRANGER } from '../support/keys.ts';

const T0 = 1_800_000_000;
const TIMES = {
  root: T0 + 10,
  accept: T0 + 20,
  expires: T0 + 100,
  fiatPayBy: T0 + 200,
  fiatConfirmBy: T0 + 300,
  locktime: T0 + 500,
};

describe('CoordinationOperator', () => {
  it('ignores a root whose private terms do not match its issued quote', async () => {
    const setup = await createSetup({
      rootTermsDigest: `sha256:${'ff'.repeat(32)}`,
    });
    await expect(
      setup.operator.status(setup.root.id, CUSTOMER.pubkey)
    ).rejects.toMatchObject({ category: 'coordination_not_found' });
    expect(lastAction(setup.pool, 'core/secure')).toBeUndefined();
  });

  it('holds, secures, settles, delivers, and publishes in chain order', async () => {
    const setup = await createSetup();
    await setup.operator.fundingInstructions(
      setup.root.id,
      CUSTOMER.pubkey,
      T0 + 29
    );
    await setup.operator.submitFunding({
      coordinationId: setup.root.id,
      caller: CUSTOMER.pubkey,
      token: 'cashu-locked',
      now: T0 + 30,
    });
    const secure = lastAction(setup.pool, 'core/secure');
    expect(secure).toBeDefined();
    expect(setup.mint.swapCalls).toBe(0);

    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 31,
    });
    let prev = secure!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 40,
      data: { payment_reference: 'payment-1' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-1' },
    });
    await publishAction(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 60,
    });

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
      payoutSats: 989,
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeDefined();
    expect(
      setup.operatorStore.outbox.get(`settlement:${setup.root.id}`)?.published
    ).toBe(true);
  });

  it('settles fiat_to_btc over bolt11 with fees disabled', async () => {
    const setup = await createSetup({
      direction: 'fiat_to_btc',
      payoutType: 'bolt11',
      feesEnabled: false,
    });
    setup.mint.meltResult = {
      paidAmount: 999,
      feePaid: 1,
      changeAmount: 0,
    };
    await setup.operator.fundingInstructions(
      setup.root.id,
      AGENT.pubkey,
      T0 + 29
    );
    await setup.operator.submitFunding({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      token: 'cashu-locked',
      now: T0 + 30,
    });
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: CUSTOMER.pubkey,
      payout: { type: 'bolt11', invoice: 'lnbc-999' },
      now: T0 + 31,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 40,
      data: { payment_reference: 'payment-ln' },
    });
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-ln' },
    });
    await publishAction(setup, {
      signer: setup.agentSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 60,
    });

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
      operatorFeeSats: 0,
      payoutSats: 999,
    });
    expect(setup.mint.meltCalls).toBe(1);
    expect(lastAction(setup.pool, 'core/settle')).toBeDefined();
  });

  it('re-derives authorization before publishing when a dispute arrives during custody', async () => {
    const setup = await createSetup();
    await fund(setup);
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 31,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 40,
      data: { payment_reference: 'payment-race' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-race' },
    });
    const authorization = actionEvent(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 60,
    });
    const dispute = actionEvent(setup, {
      signer: setup.agentSigner,
      action: 'core/open_dispute',
      prev: authorization.id,
      at: T0 + 61,
      data: { class: 'timeout' },
    });
    setup.mint.beforeSwap = () => {
      setup.pool.seed(dispute);
      return Promise.resolve();
    };
    setup.clock.now = T0 + 61;
    setup.pool.seed(authorization);
    await setup.operator.tick(T0 + 61);

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeUndefined();
    expect(
      await setup.operator.status(setup.root.id, CUSTOMER.pubkey)
    ).toMatchObject({ public_state: 'disputed' });
  });

  it('re-derives authorization after staging a public action', async () => {
    const setup = await createSetup();
    await fund(setup);
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 31,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 40,
      data: { payment_reference: 'payment-outbox-race' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-outbox-race' },
    });
    const authorization = actionEvent(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 60,
    });
    const dispute = actionEvent(setup, {
      signer: setup.agentSigner,
      action: 'core/open_dispute',
      prev: authorization.id,
      at: T0 + 61,
      data: { class: 'timeout' },
    });
    setup.operatorStore.beforeStageOutbox = (key) => {
      if (key.includes(':core_settle:')) setup.pool.seed(dispute);
    };
    setup.clock.now = T0 + 61;
    setup.pool.seed(authorization);

    await setup.operator.tick(T0 + 61);
    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeUndefined();
    expect(
      await setup.operator.status(setup.root.id, CUSTOMER.pubkey)
    ).toMatchObject({ public_state: 'disputed' });
  });

  it('freezes economic actions when valid siblings fork the chain', async () => {
    const setup = await createSetup();
    await fund(setup);
    const secure = lastAction(setup.pool, 'core/secure')!;
    const first = actionEvent(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev: secure.id,
      at: T0 + 40,
      data: { payment_reference: 'fork-a' },
    });
    const second = actionEvent(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev: secure.id,
      at: T0 + 41,
      data: { payment_reference: 'fork-b' },
    });
    setup.clock.now = T0 + 41;
    setup.pool.seed(first);
    setup.pool.seed(second);
    await setup.operator.tick(T0 + 41);

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeUndefined();
    expect(lastAction(setup.pool, 'core/refund')).toBeUndefined();
    expect(
      await setup.operator.status(setup.root.id, CUSTOMER.pubkey)
    ).toMatchObject({ public_state: 'forked' });
  });

  it('executes an authorized pre-expiry refund and publishes only after delivery', async () => {
    const setup = await createSetup();
    await fund(setup);
    const secure = lastAction(setup.pool, 'core/secure')!;
    await publishAction(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_refund',
      prev: secure.id,
      at: T0 + 250,
    });

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'refunded',
    });
    expect(lastAction(setup.pool, 'core/refund')).toBeDefined();
    expect(
      setup.operatorStore.outbox.get(`refund:${setup.root.id}`)?.published
    ).toBe(true);
  });

  it('does not act on a future-dated authorization before local time reaches it', async () => {
    const setup = await createSetup();
    await fund(setup);
    const futureAuthorization = actionEvent(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_refund',
      prev: lastAction(setup.pool, 'core/secure')!.id,
      at: TIMES.locktime + 100,
    });

    setup.clock.now = T0 + 100;
    await setup.relay.publish(futureAuthorization);
    await setup.operator.tick(T0 + 100);

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
    });
    expect(lastAction(setup.pool, 'core/refund')).toBeUndefined();

    setup.clock.now = futureAuthorization.created_at;
    await setup.operator.tick(futureAuthorization.created_at);
    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
      overlay: 'expired_recovery_available',
    });
    expect(lastAction(setup.pool, 'core/refund')).toBeDefined();
  });

  it('persists one funding locktime and enforces it at submission', async () => {
    const setup = await createSetup({ minLocktimeSeconds: 1_000 });
    const first = await setup.operator.fundingInstructions(
      setup.root.id,
      CUSTOMER.pubkey,
      T0 + 29
    );
    const repeated = await setup.operator.fundingInstructions(
      setup.root.id,
      CUSTOMER.pubkey,
      T0 + 100
    );
    expect(repeated.locktime).toBe(first.locktime);
    await expect(
      setup.operator.submitFunding({
        coordinationId: setup.root.id,
        caller: CUSTOMER.pubkey,
        token: 'cashu-locked',
        now: T0 + 30,
      })
    ).rejects.toMatchObject({ category: 'custody_invalid' });
    expect(lastAction(setup.pool, 'core/secure')).toBeUndefined();
  });

  it('exposes bare expiry recovery privately without publishing core/refund', async () => {
    const setup = await createSetup();
    await fund(setup);
    await setup.operator.tick(TIMES.locktime);

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
      overlay: 'expired_recovery_available',
    });
    expect(lastAction(setup.pool, 'core/refund')).toBeUndefined();
    expect(
      setup.operatorStore.outbox.get(`expiry:${setup.root.id}`)?.published
    ).toBe(true);

    await expect(
      setup.operator.refund({
        coordinationId: setup.root.id,
        caller: CUSTOMER.pubkey,
        now: TIMES.locktime,
      })
    ).resolves.toMatchObject({ kind: 'expired_recovery_material' });
  });

  it('exposes private expiry recovery while a dispute freezes the public chain', async () => {
    const setup = await createSetup();
    await fund(setup);
    await publishAction(setup, {
      signer: setup.agentSigner,
      action: 'core/open_dispute',
      prev: lastAction(setup.pool, 'core/secure')!.id,
      at: T0 + 100,
      data: { class: 'timeout' },
    });

    await setup.operator.tick(TIMES.locktime);

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
      overlay: 'expired_recovery_available',
    });
    expect(lastAction(setup.pool, 'core/refund')).toBeUndefined();
    await expect(
      setup.operator.refund({
        coordinationId: setup.root.id,
        caller: CUSTOMER.pubkey,
        now: TIMES.locktime,
      })
    ).resolves.toMatchObject({ kind: 'expired_recovery_material' });
  });

  it('publishes a late authorized refund only while the original proofs remain unspent', async () => {
    const available = await createSetup();
    await fund(available);
    await available.operator.tick(TIMES.locktime);
    await publishAction(available, {
      signer: available.customerSigner,
      action: 'core/authorize_refund',
      prev: lastAction(available.pool, 'core/secure')!.id,
      at: TIMES.locktime + 1,
    });
    expect(lastAction(available.pool, 'core/refund')).toBeDefined();
    expect(available.mint.swapCalls).toBe(0);

    const spent = await createSetup();
    await fund(spent);
    spent.mint.proofStates = ['spent'];
    await spent.operator.tick(TIMES.locktime);
    await publishAction(spent, {
      signer: spent.customerSigner,
      action: 'core/authorize_refund',
      prev: lastAction(spent.pool, 'core/secure')!.id,
      at: TIMES.locktime + 1,
    });
    expect(await spent.custodyStore.get(spent.root.id)).toMatchObject({
      overlay: 'expired_spent_unattributed',
    });
    expect(lastAction(spent.pool, 'core/refund')).toBeUndefined();
  });

  it('replays the chain and completes settlement after an operator restart', async () => {
    const setup = await createSetup();
    await fund(setup);
    expect(actions(setup.pool, 'core/secure')).toHaveLength(1);
    setup.operator.stop();

    setup.clock.now = T0 + 40;
    const restarted = createOperator(setup);
    await restarted.start(T0 + 40);
    setup.operator = restarted;
    expect(actions(setup.pool, 'core/secure')).toHaveLength(1);
    expect(
      await restarted.status(setup.root.id, CUSTOMER.pubkey)
    ).toMatchObject({ public_state: 'secured' });
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 41,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-2' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 60,
      data: { payment_reference: 'payment-2' },
    });
    await publishAction(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 70,
    });

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeDefined();
  });

  it('resumes private delivery after custody completed but relay publication failed', async () => {
    const setup = await createSetup();
    await fund(setup);
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 41,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-recovery' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 60,
      data: { payment_reference: 'payment-recovery' },
    });
    const authorization = actionEvent(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: T0 + 70,
    });
    setup.pool.setRejecting(['wss://relay.test']);
    setup.clock.now = T0 + 70;
    setup.pool.seed(authorization);
    await expect(setup.operator.tick(T0 + 70)).rejects.toMatchObject({
      category: 'relay_unavailable',
    });
    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'settled',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeUndefined();

    setup.operator.stop();
    setup.pool.setRejecting([]);
    const restarted = createOperator(setup);
    await restarted.start(T0 + 80);
    setup.operator = restarted;
    expect(lastAction(setup.pool, 'core/settle')).toBeDefined();
  });

  it('records a settlement authorization that arrives after the release margin', async () => {
    const setup = await createSetup();
    await fund(setup);
    await setup.operator.putPayout({
      coordinationId: setup.root.id,
      caller: AGENT.pubkey,
      payout: { type: 'cashu_p2pk', pubkey: AGENT.pubkey },
      now: T0 + 40,
    });
    let prev = lastAction(setup.pool, 'core/secure')!.id;
    prev = await publishAction(setup, {
      signer: setup.agentSigner,
      action: ACTION_FIAT_SENT,
      prev,
      at: T0 + 50,
      data: { payment_reference: 'payment-late' },
    });
    prev = await publishAction(setup, {
      signer: setup.customerSigner,
      action: ACTION_FIAT_CONFIRMED,
      prev,
      at: T0 + 60,
      data: { payment_reference: 'payment-late' },
    });
    await publishAction(setup, {
      signer: setup.customerSigner,
      action: 'core/authorize_settlement',
      prev,
      at: TIMES.locktime - 49,
    });

    expect(await setup.custodyStore.get(setup.root.id)).toMatchObject({
      status: 'held',
      overlay: 'settlement_unfulfillable',
    });
    expect(lastAction(setup.pool, 'core/settle')).toBeUndefined();
  });
});

type SetupBase = {
  relay: RelayClient;
  pool: FakeRelayPool;
  operatorSigner: EventSigner;
  customerSigner: EventSigner;
  agentSigner: EventSigner;
  resolverSigner: EventSigner;
  custodyStore: MemoryCustodyStore;
  operatorStore: MemoryOperatorStore;
  custody: CustodyEngine;
  mint: FakeCustodyMint;
  policy: OperatorPolicy;
  clock: { now: number };
};

type Setup = SetupBase & {
  operator: CoordinationOperator;
  root: NostrEvent;
  quote: SignedQuote;
};

async function createSetup(
  input: {
    direction?: Direction;
    payoutType?: 'cashu_p2pk' | 'bolt11';
    feesEnabled?: boolean;
    minLocktimeSeconds?: number;
    rootTermsDigest?: string;
  } = {}
): Promise<Setup> {
  const direction = input.direction ?? 'btc_to_fiat';
  const payoutType = input.payoutType ?? 'cashu_p2pk';
  const feesEnabled = input.feesEnabled ?? true;
  const operatorSigner = createSigner(OPERATOR.nsec);
  const customerSigner = createSigner(CUSTOMER.nsec);
  const agentSigner = createSigner(AGENT.nsec);
  const resolverSigner = createSigner(STRANGER.nsec);
  const pool = createFakeRelayPool();
  const relay = createRelayClient(['wss://relay.test'], { pool });
  const custodyStore = new MemoryCustodyStore();
  const operatorStore = new MemoryOperatorStore();
  const mint = new FakeCustodyMint(inspected(operatorSigner, direction));
  const custody = new CustodyEngine({
    mint,
    store: custodyStore,
    signer: operatorSigner,
    policy: {
      feesEnabled,
      operatorFeeBps: 100,
      operatorMinFeeSats: 3,
      refundFeeMode: 'network_only',
      releaseSafetyMarginSeconds: 50,
      returnLnOverage: true,
      operatorLnAddress: 'operator@example.com',
    },
  });
  const clock = { now: T0 + 25 };
  const base: SetupBase = {
    relay,
    pool,
    operatorSigner,
    customerSigner,
    agentSigner,
    resolverSigner,
    custodyStore,
    operatorStore,
    custody,
    mint,
    clock,
    policy: {
      mintUrl: 'http://mint.test',
      disputeWindowSeconds: 100,
      releaseSafetyMarginSeconds: 50,
      minLocktimeSeconds: input.minLocktimeSeconds ?? 60,
      quoteNetworkCostSats: 1,
      quote: {
        feesEnabled,
        operatorFeeBps: 100,
        operatorMinFeeSats: 3,
        minCoordinationSats: 100,
        refundFeeMode: 'network_only' as const,
        ttlSeconds: 1_000,
      },
    },
  };
  const operator = createOperator(base);
  const terms = {
    direction,
    fiat: { currency: 'KES', amount: '15000.00' },
    bitcoin: { amount: '1000', unit: 'sat', network: 'cashu' },
    payment_channel: 'mpesa@1',
    deadlines: {
      fiat_pay_by: TIMES.fiatPayBy,
      fiat_confirm_by: TIMES.fiatConfirmBy,
    },
  };
  const termsDigest = commitBytes(
    Buffer.from(JSON.stringify(terms), 'utf8')
  ).digest;
  const quote = await operator.createQuote(
    {
      profile: PROFILE_ID,
      terms_digest: termsDigest,
      direction,
      gross_sats: 1_000,
      payout_type: payoutType,
    },
    T0,
    OPERATOR.pubkey
  );
  const descriptor = buildDescriptorEvent({
    signer: operatorSigner,
    settings: {
      dTag: 'cashu-main',
      schemaUrl: 'https://escrow.example.com/v1/openapi.json',
    },
    ttlSeconds: 10_000,
    createdAt: T0,
  });
  const root = customerSigner.sign({
    kind: KIND_COORDINATION_ROOT,
    created_at: TIMES.root,
    tags: buildRootTags({
      participants: [
        { pubkey: AGENT.pubkey, role: ROLE_AGENT },
        { pubkey: CUSTOMER.pubkey, role: ROLE_CUSTOMER },
        { pubkey: OPERATOR.pubkey, role: ROLE_ESCROW },
        { pubkey: STRANGER.pubkey, role: ROLE_RESOLVER },
      ],
      descriptorEventId: descriptor.id,
      descriptorAddress: formatAddress(
        KIND_ESCROW_DESCRIPTOR,
        OPERATOR.pubkey,
        'cashu-main'
      ),
    }),
    content: buildEventContent(RootContent, {
      version: 2,
      profile: PROFILE_ID,
      terms,
      expires_at: TIMES.expires,
      commitments: {
        private_terms: {
          algorithm: 'sha256-bytes@1',
          digest: input.rootTermsDigest ?? termsDigest,
        },
        quote: {
          algorithm: 'sha256-bytes@1',
          digest: await operatorStore.putQuote(quote, OPERATOR.pubkey, T0),
        },
      },
    }),
  });
  const accept = agentSigner.sign({
    kind: KIND_COORDINATION_ACTION,
    created_at: TIMES.accept,
    tags: buildActionTags({ rootId: root.id, prevId: root.id }),
    content: buildEventContent(ActionContent, {
      version: 2,
      action: 'core/accept',
    }),
  });
  pool.seed(descriptor);
  pool.seed(root);
  pool.seed(accept);
  await operator.start(T0 + 25);
  return { ...base, operator, root, quote };
}

function createOperator(input: SetupBase): CoordinationOperator {
  return new CoordinationOperator({
    relay: input.relay,
    signer: input.operatorSigner,
    custody: input.custody,
    custodyStore: input.custodyStore,
    store: input.operatorStore,
    policy: input.policy,
    clock: () => input.clock.now,
  });
}

function inspected(
  operatorSigner: EventSigner,
  direction: Direction
): InspectedToken {
  const provider = direction === 'btc_to_fiat' ? CUSTOMER.pubkey : AGENT.pubkey;
  return {
    mint: 'http://mint.test',
    unit: 'sat',
    amount: 1_000,
    inputFee: 1,
    proofs: [
      {
        amount: 1_000,
        secret: [
          'P2PK',
          {
            nonce: 'nonce',
            data: operatorSigner.pubkey,
            tags: [
              ['locktime', String(TIMES.locktime)],
              ['refund', provider],
            ],
          },
        ],
        sigFlag: 'SIG_INPUTS',
        dleqValid: true,
      },
    ],
  };
}

async function fund(setup: Setup): Promise<void> {
  await setup.operator.fundingInstructions(
    setup.root.id,
    CUSTOMER.pubkey,
    T0 + 29
  );
  await setup.operator.submitFunding({
    coordinationId: setup.root.id,
    caller: CUSTOMER.pubkey,
    token: 'cashu-locked',
    now: T0 + 30,
  });
}

async function publishAction(
  setup: Setup,
  input: {
    signer: EventSigner;
    action: string;
    prev: string;
    at: number;
    data?: Record<string, unknown>;
  }
): Promise<string> {
  setup.clock.now = input.at;
  const event = actionEvent(setup, input);
  await setup.relay.publish(event);
  await setup.operator.tick(input.at);
  return event.id;
}

function actionEvent(
  setup: Setup,
  input: {
    signer: EventSigner;
    action: string;
    prev: string;
    at: number;
    data?: Record<string, unknown>;
  }
): NostrEvent {
  return input.signer.sign({
    kind: KIND_COORDINATION_ACTION,
    created_at: input.at,
    tags: buildActionTags({ rootId: setup.root.id, prevId: input.prev }),
    content: buildEventContent(ActionContent, {
      version: 2,
      action: input.action,
      ...(input.data === undefined ? {} : { data: input.data }),
    }),
  });
}

function lastAction(
  pool: Setup['pool'],
  action: string
): NostrEvent | undefined {
  return [...pool.stored].reverse().find((event) => {
    if (event.kind !== KIND_COORDINATION_ACTION) return false;
    const content = JSON.parse(event.content) as { action?: string };
    return content.action === action;
  });
}

function actions(pool: Setup['pool'], action: string): NostrEvent[] {
  return pool.stored.filter((event) => {
    if (event.kind !== KIND_COORDINATION_ACTION) return false;
    const content = JSON.parse(event.content) as { action?: string };
    return content.action === action;
  });
}
