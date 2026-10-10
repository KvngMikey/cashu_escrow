import type { NostrEvent } from 'nostr-tools/pure';

import type {
  BoundAmounts,
  CustodyEngine,
  SettlementPayout,
} from '../lib/cashu/custody.ts';
import { computeFees } from '../lib/cashu/fees.ts';
import {
  createSignedQuote,
  quoteCommitment,
  verifySignedQuote,
  type QuotePolicy,
  type SignedQuote,
} from '../lib/cashu/quotes.ts';
import { EscrowError } from '../lib/errors.ts';
import {
  appendAction,
  deriveState,
  validateRoot,
  type DerivedState,
  type ValidatedRoot,
} from '../lib/pontmore/chain.ts';
import { wrapPrivateMessage } from '../lib/pontmore/gift-wrap.ts';
import {
  ActionContent,
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
  ROLE_ESCROW,
  buildActionTags,
  buildEventContent,
  parseRootTags,
  type KernelAction,
} from '../lib/pontmore/kinds.ts';
import type { RelayClient, RelaySubscription } from '../lib/pontmore/relay.ts';
import type { EventSigner } from '../lib/pontmore/signer.ts';
import {
  deriveRoles,
  ROLE_AGENT,
  ROLE_CUSTOMER,
  swapV1,
  type SwapFacts,
  type SwapTerms,
} from '../lib/profiles/swap-v1.ts';
import type { CustodyRecord, CustodyStore } from '../lib/store/store.ts';
import type {
  OperatorStore,
  PayoutTarget,
} from '../lib/store/operator-store.ts';
import type { QuoteRequestBody } from '../service/schemas.ts';

type Custody = Pick<
  CustodyEngine,
  | 'hold'
  | 'settle'
  | 'refundAuthorized'
  | 'observeExpiry'
  | 'markSettlementUnfulfillable'
>;

export type OperatorPolicy = {
  mintUrl: string;
  disputeWindowSeconds: number;
  releaseSafetyMarginSeconds: number;
  minLocktimeSeconds: number;
  quoteNetworkCostSats: number;
  quote: QuotePolicy;
};

export type SafeCoordinationStatus = {
  coordination_id: string;
  public_state: string;
  custody_overlay: CustodyRecord['overlay'] | null;
};

export type RefundPickup = {
  coordination_id: string;
  kind: 'authorized_refund' | 'expired_recovery_material';
  token: string;
};

type Coordination = {
  rootEvent: NostrEvent;
  root: ValidatedRoot<SwapTerms>;
  quote: SignedQuote;
  actions: Map<string, NostrEvent>;
  subscription: RelaySubscription;
};

export class CoordinationOperator {
  readonly #relay: RelayClient;
  readonly #signer: EventSigner;
  readonly #custody: Custody;
  readonly #custodyStore: CustodyStore;
  readonly #store: OperatorStore;
  readonly #policy: OperatorPolicy;
  readonly #onError: (error: unknown) => void;
  readonly #clock: () => number;
  readonly #coordinations = new Map<string, Coordination>();
  readonly #rootLoads = new Map<string, Promise<void>>();
  readonly #queues = new Map<string, Promise<void>>();
  readonly #rootQueue: Promise<void>[] = [];
  #rootSubscription: RelaySubscription | undefined;

  constructor(input: {
    relay: RelayClient;
    signer: EventSigner;
    custody: Custody;
    custodyStore: CustodyStore;
    store: OperatorStore;
    policy: OperatorPolicy;
    onError?: (error: unknown) => void;
    clock?: () => number;
  }) {
    this.#relay = input.relay;
    this.#signer = input.signer;
    this.#custody = input.custody;
    this.#custodyStore = input.custodyStore;
    this.#store = input.store;
    this.#policy = input.policy;
    this.#onError = input.onError ?? ((): void => undefined);
    this.#clock = input.clock ?? (() => Math.floor(Date.now() / 1_000));
  }

  async start(now: number): Promise<void> {
    await Promise.all([this.#store.initialize(), this.#custodyStore.all()]);
    const rootFilter = {
      kinds: [KIND_COORDINATION_ROOT],
      '#p': [this.#signer.pubkey],
    };
    this.#rootSubscription = this.#relay.subscribe([rootFilter], (event) => {
      const task = this.#ingestRoot(event, this.#clock()).catch(this.#onError);
      this.#rootQueue.push(task);
      void task.finally(() => {
        const index = this.#rootQueue.indexOf(task);
        if (index >= 0) void this.#rootQueue.splice(index, 1);
      });
    });
    const roots = await this.#relay.query([rootFilter]);
    for (const root of roots) await this.#ingestRoot(root, now);
    await Promise.all(this.#rootQueue);
  }

  stop(): void {
    this.#rootSubscription?.close();
    for (const coordination of this.#coordinations.values()) {
      coordination.subscription.close();
    }
    this.#coordinations.clear();
  }

  async tick(now: number): Promise<void> {
    for (const id of this.#coordinations.keys()) {
      await this.#exclusive(id, () => this.#evaluate(id, now));
    }
  }

  async createQuote(
    request: QuoteRequestBody,
    createdAt: number
  ): Promise<SignedQuote> {
    const signed = createSignedQuote({
      request: {
        termsDigest: request.terms_digest,
        direction: request.direction,
        grossSats: request.gross_sats,
        payoutType: request.payout_type,
      },
      policy: this.#policy.quote,
      signer: this.#signer,
      createdAt,
      networkCostSats: this.#policy.quoteNetworkCostSats,
    });
    await this.#store.putQuote(signed);
    return signed;
  }

  async fundingInstructions(
    coordinationId: string,
    caller: string,
    now: number
  ) {
    const coordination = this.#requireCoordination(coordinationId);
    this.#requireCaller(coordination, caller, [
      this.#roles(coordination).bitcoinProvider,
    ]);
    const state = this.#requireAccepted(coordination, now);
    this.#requireLive(state, coordinationId);
    const locktime = await this.#store.getOrCreateFundingLocktime(
      coordinationId,
      Math.max(
        coordination.root.terms.deadlines.fiat_confirm_by +
          this.#policy.disputeWindowSeconds +
          this.#policy.releaseSafetyMarginSeconds,
        now + this.#policy.minLocktimeSeconds
      )
    );
    if (locktime === undefined) {
      throw new EscrowError(
        'storage_unavailable',
        'funding instructions could not be persisted',
        { swapId: coordinationId }
      );
    }
    return {
      coordination_id: coordinationId,
      mint_url: this.#policy.mintUrl,
      amount_sats: coordination.quote.quote.gross_sats,
      operator_pubkey: this.#signer.pubkey,
      refund_pubkey: this.#roles(coordination).bitcoinProvider,
      locktime,
    };
  }

  async submitFunding(input: {
    coordinationId: string;
    caller: string;
    token: string;
    now: number;
  }): Promise<SafeCoordinationStatus> {
    return this.#exclusive(input.coordinationId, async () => {
      const coordination = this.#requireCoordination(input.coordinationId);
      const roles = this.#roles(coordination);
      this.#requireCaller(coordination, input.caller, [roles.bitcoinProvider]);
      const state = this.#requireAccepted(coordination, input.now);
      this.#requireLive(state, input.coordinationId);
      const quote = coordination.quote.quote;
      const instructedLocktime = await this.#store.getOrCreateFundingLocktime(
        input.coordinationId
      );
      if (instructedLocktime === undefined) {
        throw new EscrowError(
          'custody_conflict',
          'funding instructions have not been issued',
          { swapId: input.coordinationId }
        );
      }
      await this.#custody.hold({
        token: input.token,
        observedAt: input.now,
        expectation: {
          coordinationId: input.coordinationId,
          mintUrl: this.#policy.mintUrl,
          operatorPubkey: this.#signer.pubkey,
          providerPubkey: roles.bitcoinProvider,
          grossSats: quote.gross_sats,
          networkCostSats: quote.network_cost_sats,
          payoutType: quote.payout_type,
          fiatConfirmBy: coordination.root.terms.deadlines.fiat_confirm_by,
          disputeWindowSeconds: this.#policy.disputeWindowSeconds,
          releaseSafetyMarginSeconds: this.#policy.releaseSafetyMarginSeconds,
          minimumLocktime: instructedLocktime,
        },
      });
      await this.#evaluate(input.coordinationId, input.now);
      return this.#status(coordination, input.now);
    });
  }

  async putPayout(input: {
    coordinationId: string;
    caller: string;
    payout: PayoutTarget;
    now: number;
  }): Promise<void> {
    await this.#exclusive(input.coordinationId, async () => {
      const coordination = this.#requireCoordination(input.coordinationId);
      const roles = this.#roles(coordination);
      this.#requireCaller(coordination, input.caller, [roles.bitcoinRecipient]);
      const state = this.#requireAccepted(coordination, input.now);
      this.#requireLive(state, input.coordinationId);
      if (input.payout.type !== coordination.quote.quote.payout_type) {
        throw new EscrowError(
          'custody_conflict',
          'payout type does not match the bound quote',
          { swapId: input.coordinationId }
        );
      }
      await this.#store.putPayout(input.coordinationId, input.payout);
      await this.#evaluate(input.coordinationId, input.now);
    });
  }

  async status(
    coordinationId: string,
    caller: string
  ): Promise<SafeCoordinationStatus> {
    const coordination = this.#requireCoordination(coordinationId);
    this.#requireCaller(coordination, caller, [
      ...coordination.root.roleOf.keys(),
    ]);
    return this.#status(coordination);
  }

  async refund(input: {
    coordinationId: string;
    caller: string;
    now: number;
  }): Promise<RefundPickup> {
    return this.#exclusive(input.coordinationId, async () => {
      const coordination = this.#requireCoordination(input.coordinationId);
      const provider = this.#roles(coordination).bitcoinProvider;
      this.#requireCaller(coordination, input.caller, [provider]);
      await this.#evaluate(input.coordinationId, input.now);
      let record = await this.#custodyStore.get(input.coordinationId);
      if (record?.status === 'refunded' && record.payoutToken !== undefined) {
        return {
          coordination_id: input.coordinationId,
          kind: 'authorized_refund',
          token: record.payoutToken,
        };
      }
      if (
        record?.status === 'held' &&
        input.now >= record.locktime &&
        record.overlay === 'expired_recovery_available'
      ) {
        record = await this.#custody.observeExpiry({
          coordinationId: input.coordinationId,
          now: input.now,
        });
        if (record.overlay === 'expired_recovery_available') {
          return {
            coordination_id: input.coordinationId,
            kind: 'expired_recovery_material',
            token: record.token,
          };
        }
      }
      throw new EscrowError(
        'custody_conflict',
        'refund material is not available',
        { swapId: input.coordinationId }
      );
    });
  }

  async #ingestRoot(event: NostrEvent, now: number): Promise<void> {
    if (this.#coordinations.has(event.id)) return;
    const pending = this.#rootLoads.get(event.id);
    if (pending !== undefined) {
      await pending;
      return;
    }
    const load = this.#loadRoot(event, now);
    this.#rootLoads.set(event.id, load);
    try {
      await load;
    } finally {
      this.#rootLoads.delete(event.id);
    }
  }

  async #loadRoot(event: NostrEvent, now: number): Promise<void> {
    const tags = parseRootTags(event.tags);
    if (!tags.ok) return;
    const descriptors = await this.#relay.query([
      { ids: [tags.value.descriptorEventId] },
    ]);
    const descriptor = descriptors.find(
      (candidate) => candidate.id === tags.value.descriptorEventId
    );
    if (descriptor === undefined) return;
    const validated = validateRoot({
      root: event,
      descriptor,
      profile: swapV1,
    });
    if (!validated.ok) return;
    if (
      validated.value.participants.get(ROLE_ESCROW)?.pubkey !==
      this.#signer.pubkey
    ) {
      return;
    }

    const commitment = validated.value.content.commitments?.quote;
    if (commitment === undefined) return;
    const quote = await this.#store.getQuote(commitment.digest);
    if (
      quote === undefined ||
      quoteCommitment(quote).digest !== commitment.digest ||
      !verifySignedQuote(quote, this.#signer.pubkey, event.created_at) ||
      !quoteMatchesRoot(quote, validated.value)
    ) {
      return;
    }

    const existing = await this.#relay.query([
      { kinds: [KIND_COORDINATION_ACTION], '#e': [event.id] },
    ]);
    const actions = new Map(
      existing.map((action) => [action.id, action] as const)
    );
    const coordination: Coordination = {
      rootEvent: event,
      root: validated.value,
      quote,
      actions,
      subscription: { close: (): void => undefined },
    };
    this.#coordinations.set(event.id, coordination);
    coordination.subscription = this.#relay.subscribe(
      [{ kinds: [KIND_COORDINATION_ACTION], '#e': [event.id] }],
      (action) => {
        const coordination = this.#coordinations.get(event.id);
        if (coordination === undefined) return;
        coordination.actions.set(action.id, action);
        void this.#exclusive(event.id, async () => {
          await this.#evaluate(event.id, this.#clock());
        }).catch(this.#onError);
      }
    );
    await this.#exclusive(event.id, () => this.#evaluate(event.id, now));
  }

  async #evaluate(coordinationId: string, now: number): Promise<void> {
    const coordination = this.#requireCoordination(coordinationId);
    let state = this.#derive(coordination, now);
    if (state.terminal || state.disputed || state.forked !== null) return;

    let record = await this.#custodyStore.get(coordinationId);
    if (
      record?.status === 'held' &&
      state.facts.accepted &&
      !state.facts.secured
    ) {
      await this.#publishAction(coordination, 'core/secure', now);
      state = this.#derive(coordination, now);
    }
    if (state.terminal || record === undefined) return;

    if (record.status === 'refunded') {
      if (!state.facts.refundAuthorized || record.payoutToken === undefined) {
        return;
      }
      await this.#deliver(
        `refund:${coordinationId}`,
        this.#roles(coordination).bitcoinProvider,
        {
          version: 1,
          type: 'authorized_refund',
          coordination_id: coordinationId,
          token: record.payoutToken,
        }
      );
      await this.#publishAction(coordination, 'core/refund', now);
      return;
    }

    if (record.status === 'settled') {
      if (!state.facts.settlementAuthorized) return;
      await this.#deliver(
        `settlement:${coordinationId}`,
        this.#roles(coordination).bitcoinRecipient,
        {
          version: 1,
          type: 'settlement',
          coordination_id: coordinationId,
          ...(record.payoutToken === undefined
            ? {}
            : { token: record.payoutToken }),
          ...(record.overageToken === undefined
            ? {}
            : { overage_token: record.overageToken }),
        }
      );
      await this.#publishAction(coordination, 'core/settle', now);
      return;
    }

    if (now >= record.locktime) {
      record = await this.#custody.observeExpiry({ coordinationId, now });
      if (record.overlay === 'expired_recovery_available') {
        await this.#deliver(
          `expiry:${coordinationId}`,
          this.#roles(coordination).bitcoinProvider,
          {
            version: 1,
            type: 'expired_recovery_material',
            coordination_id: coordinationId,
            token: record.token,
          }
        );
        await this.#notifyParticipants(coordination, 'custody_expired', now);
        if (state.facts.refundAuthorized) {
          await this.#publishAction(coordination, 'core/refund', now);
        }
      }
      return;
    }

    if (state.facts.refundAuthorized) {
      record = await this.#custody.refundAuthorized({
        coordinationId,
        amounts: refundAmounts(record, coordination.quote, this.#policy.quote),
        now,
      });
      if (record.payoutToken === undefined) {
        throw new EscrowError(
          'custody_invalid',
          'refund token is unavailable',
          {
            swapId: coordinationId,
          }
        );
      }
      await this.#deliver(
        `refund:${coordinationId}`,
        this.#roles(coordination).bitcoinProvider,
        {
          version: 1,
          type: 'authorized_refund',
          coordination_id: coordinationId,
          token: record.payoutToken,
        }
      );
      await this.#publishAction(coordination, 'core/refund', now);
      return;
    }

    if (!state.facts.settlementAuthorized) return;
    if (now > record.locktime - this.#policy.releaseSafetyMarginSeconds) {
      await this.#custody.markSettlementUnfulfillable({ coordinationId, now });
      await this.#notifyParticipants(
        coordination,
        'settlement_unfulfillable',
        now,
        true
      );
      return;
    }
    const storedPayout = await this.#store.getPayout(coordinationId);
    if (storedPayout === undefined) return;
    const settled = await this.#custody.settle({
      coordinationId,
      payout: settlementPayout(storedPayout),
      amounts: boundAmounts(coordination.quote),
      now,
    });
    await this.#deliver(
      `settlement:${coordinationId}`,
      this.#roles(coordination).bitcoinRecipient,
      {
        version: 1,
        type: 'settlement',
        coordination_id: coordinationId,
        ...(settled.payoutToken === undefined
          ? {}
          : { token: settled.payoutToken }),
        ...(settled.overageToken === undefined
          ? {}
          : { overage_token: settled.overageToken }),
      }
    );
    await this.#publishAction(coordination, 'core/settle', now);
  }

  async #publishAction(
    coordination: Coordination,
    action: Extract<
      KernelAction,
      'core/secure' | 'core/settle' | 'core/refund'
    >,
    createdAt: number
  ): Promise<void> {
    const state = this.#derive(coordination, createdAt);
    const event = this.#signer.sign({
      kind: KIND_COORDINATION_ACTION,
      created_at: createdAt,
      tags: buildActionTags({
        rootId: coordination.root.id,
        prevId: state.tip,
        relay: this.#relay.relays[0] ?? '',
      }),
      content: buildEventContent(
        ActionContent,
        { version: 2, action },
        { label: 'coordination action', coordinationId: coordination.root.id }
      ),
    });
    const key = `action:${coordination.root.id}:${action.replace('/', '_')}:${state.tip}`;
    const staged = await this.#store.stageOutbox(key, event);
    const publicationState = this.#derive(coordination, createdAt);
    const permitted = appendAction({
      root: coordination.root,
      state: chainState(publicationState),
      event: staged.event,
      profile: swapV1,
    });
    if (!permitted.ok) {
      throw new EscrowError(
        'event_invalid',
        'operator action is not authorized by the derived chain',
        { swapId: coordination.root.id }
      );
    }
    await this.#relay.publish(staged.event);
    await this.#store.markOutboxPublished(key);
    coordination.actions.set(staged.event.id, staged.event);
  }

  async #deliver(
    key: string,
    recipient: string,
    payload: unknown
  ): Promise<void> {
    const staged = await this.#store.stageOutbox(
      key,
      wrapPrivateMessage(this.#signer, recipient, payload)
    );
    if (staged.published) return;
    await this.#relay.publish(staged.event);
    await this.#store.markOutboxPublished(key);
  }

  async #notifyParticipants(
    coordination: Coordination,
    type: string,
    observedAt: number,
    includeResolver = false
  ): Promise<void> {
    const recipients = [
      coordination.root.participants.get(ROLE_AGENT)?.pubkey,
      coordination.root.participants.get(ROLE_CUSTOMER)?.pubkey,
      ...(includeResolver
        ? [coordination.root.participants.get('core/resolver')?.pubkey]
        : []),
    ].filter((value): value is string => value !== undefined);
    for (const recipient of new Set(recipients)) {
      await this.#deliver(
        `${type}:${coordination.root.id}:${recipient}`,
        recipient,
        {
          version: 1,
          type,
          coordination_id: coordination.root.id,
          observed_at: observedAt,
        }
      );
    }
  }

  async #status(
    coordination: Coordination,
    at = this.#clock()
  ): Promise<SafeCoordinationStatus> {
    const record = await this.#custodyStore.get(coordination.root.id);
    return {
      coordination_id: coordination.root.id,
      public_state: this.#derive(coordination, at).state,
      custody_overlay: record?.overlay ?? null,
    };
  }

  #derive(
    coordination: Coordination,
    at = this.#clock()
  ): DerivedState<SwapFacts> {
    return deriveState({
      root: coordination.root,
      actions: [...coordination.actions.values()].filter(
        (action) => action.created_at <= at
      ),
      profile: swapV1,
    });
  }

  #requireAccepted(
    coordination: Coordination,
    at: number
  ): DerivedState<SwapFacts> {
    const state = this.#derive(coordination, at);
    const accepted = state.applied.find(
      (applied) => applied.action === 'core/accept'
    );
    if (
      !state.facts.accepted ||
      accepted === undefined ||
      accepted.at >= coordination.quote.quote.expires_at
    ) {
      throw new EscrowError(
        'custody_conflict',
        'coordination is not accepted under the bound quote',
        { swapId: coordination.root.id }
      );
    }
    return state;
  }

  #requireLive(state: DerivedState<SwapFacts>, coordinationId: string): void {
    if (state.terminal || state.disputed || state.forked !== null) {
      throw new EscrowError(
        'custody_conflict',
        'coordination is frozen or terminal',
        { swapId: coordinationId }
      );
    }
  }

  #requireCoordination(coordinationId: string): Coordination {
    const coordination = this.#coordinations.get(coordinationId);
    if (coordination === undefined) {
      throw new EscrowError(
        'coordination_not_found',
        'coordination was not found',
        { swapId: coordinationId }
      );
    }
    return coordination;
  }

  #requireCaller(
    coordination: Coordination,
    caller: string,
    allowed: readonly string[]
  ): void {
    if (!allowed.includes(caller.toLowerCase())) {
      throw new EscrowError(
        'request_unauthorized',
        'request signer is not authorized for this coordination',
        { swapId: coordination.root.id }
      );
    }
  }

  #roles(coordination: Coordination) {
    return deriveRoles(
      coordination.root.terms.direction,
      coordination.root.participants.get(ROLE_AGENT)?.pubkey ?? '',
      coordination.root.participants.get(ROLE_CUSTOMER)?.pubkey ?? ''
    );
  }

  async #exclusive<T>(
    coordinationId: string,
    action: () => Promise<T>
  ): Promise<T> {
    const previous = this.#queues.get(coordinationId) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#queues.set(coordinationId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.#queues.get(coordinationId) === tail) {
        this.#queues.delete(coordinationId);
      }
    }
  }
}

function quoteMatchesRoot(
  signed: SignedQuote,
  root: ValidatedRoot<SwapTerms>
): boolean {
  const quote = signed.quote;
  const committedTerms = root.content.commitments?.private_terms?.digest;
  return (
    quote.profile === root.content.profile &&
    quote.direction === root.terms.direction &&
    quote.gross_sats === Number(root.terms.bitcoin.amount) &&
    quote.terms_digest === committedTerms
  );
}

function boundAmounts(signed: SignedQuote): BoundAmounts {
  const quote = signed.quote;
  return {
    grossSats: quote.gross_sats,
    operatorFeeSats: quote.operator_fee_sats,
    networkCostSats: quote.network_cost_sats,
    payoutSats:
      quote.payout_type === 'cashu_p2pk'
        ? quote.payout_sats
        : quote.payout_min_sats,
  };
}

function refundAmounts(
  record: CustodyRecord,
  signed: SignedQuote,
  policy: QuotePolicy
): BoundAmounts {
  const fees = computeFees({
    gross: record.grossSats,
    bps: policy.operatorFeeBps,
    minFee: policy.operatorMinFeeSats,
    enabled: policy.feesEnabled,
    networkCost: record.inputFeeSats,
    operation: 'refund',
    refundFeeMode: signed.quote.refund_fee_mode,
  });
  return {
    grossSats: fees.gross,
    operatorFeeSats: fees.operatorFee,
    networkCostSats: fees.networkCost,
    payoutSats: fees.payout,
  };
}

function settlementPayout(target: PayoutTarget): SettlementPayout {
  return target.type === 'cashu_p2pk'
    ? { type: target.type, recipientPubkey: target.pubkey }
    : { type: target.type, invoice: target.invoice };
}

function chainState(state: DerivedState<SwapFacts>) {
  return {
    forked: state.forked,
    tip: state.tip,
    facts: state.facts,
    applied: state.applied,
  };
}
