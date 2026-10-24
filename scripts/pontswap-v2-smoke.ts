import 'dotenv/config';

import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { Wallet, getEncodedToken, sumProofs } from '@cashu/cashu-ts';
import { nsecEncode } from 'nostr-tools/nip19';
import { generateSecretKey, type NostrEvent } from 'nostr-tools/pure';
import { z } from 'zod';

import { SignedQuote, quoteCommitment } from '../src/lib/cashu/quotes.ts';
import { CashuTsMint } from '../src/lib/cashu/mint.ts';
import { parseDescriptorEvent } from '../src/lib/pontmore/descriptor.ts';
import { unwrapPrivateMessage } from '../src/lib/pontmore/gift-wrap.ts';
import * as kinds from '../src/lib/pontmore/kinds.ts';
import { createRelayClient } from '../src/lib/pontmore/relay.ts';
import { createSigner } from '../src/lib/pontmore/signer.ts';
import * as profile from '../src/lib/profiles/swap-v1.ts';
import {
  CoordinationStatus,
  FundingInstructions,
} from '../src/service/schemas.ts';

const relayUrl = process.env.TEST_RELAY_URL ?? 'ws://127.0.0.1:17000';
const mintUrl = process.env.TEST_MINT_URL ?? 'http://127.0.0.1:3338';
const serviceUrl = process.env.TEST_ESCROW_URL ?? 'http://127.0.0.1:3000';

const resolverNsec = process.env.RESOLVER_NSEC;
if (!resolverNsec) throw new Error('RESOLVER_NSEC is required');

const SettlementPayload = z
  .object({
    version: z.literal(1),
    type: z.literal('settlement'),
    coordination_id: z.string().regex(/^[0-9a-f]{64}$/),
    token: z.string().min(1),
    overage_token: z.string().min(1).optional(),
  })
  .strict();
type FundingInstructionsValue = z.infer<typeof FundingInstructions>;
type CoordinationStatusValue = z.infer<typeof CoordinationStatus>;
type SettlementPayloadValue = z.infer<typeof SettlementPayload>;

const relay = createRelayClient([relayUrl]);
const customerSecret = generateSecretKey();
const agentSecret = generateSecretKey();
const customer = createSigner(nsecEncode(customerSecret));
const agent = createSigner(nsecEncode(agentSecret));
const resolver = createSigner(resolverNsec, 'resolver');

try {
  const discovery: NostrEvent[] = [
    ...(await relay.query([
      { kinds: [kinds.KIND_AGENT_DEFINITION], limit: 20 },
    ])),
    ...(await relay.query([
      { kinds: [kinds.KIND_ESCROW_DESCRIPTOR], limit: 20 },
    ])),
  ];
  const descriptorEvent = discovery
    .filter((event) => event.kind === kinds.KIND_ESCROW_DESCRIPTOR)
    .find((event) => parseDescriptorEvent(event) !== null);
  const agentDefinition = discovery.find(
    (event) => event.kind === kinds.KIND_AGENT_DEFINITION
  );
  if (!descriptorEvent || !agentDefinition) {
    throw new Error('operator discovery events were not found');
  }
  const descriptor = parseDescriptorEvent(descriptorEvent);
  if (!descriptor) throw new Error('operator descriptor is invalid');

  const now = unixNow();
  const terms = {
    direction: 'btc_to_fiat' as const,
    fiat: { currency: 'KES', amount: '1000.00' },
    bitcoin: { amount: '100', unit: 'sat' as const, network: 'cashu' },
    payment_channel: 'mpesa@1',
    deadlines: {
      fiat_pay_by: now + 300,
      fiat_confirm_by: now + 500,
    },
  };
  const termsBytes = Buffer.from(JSON.stringify(terms), 'utf8');
  const termsCommitment = kinds.commitBytes(termsBytes);
  const signedQuote = SignedQuote.parse(
    await api(customer, 'POST', '/v1/quotes', {
      profile: profile.PROFILE_ID,
      terms_digest: termsCommitment.digest,
      direction: terms.direction,
      gross_sats: 100,
      payout_type: 'cashu_p2pk',
    })
  );
  if (signedQuote.quote.payout_type !== 'cashu_p2pk') {
    throw new Error('operator returned an invalid quote');
  }

  const root = customer.sign({
    kind: kinds.KIND_COORDINATION_ROOT,
    created_at: now,
    tags: kinds.buildRootTags({
      participants: [
        { pubkey: agent.pubkey, role: profile.ROLE_AGENT },
        { pubkey: customer.pubkey, role: profile.ROLE_CUSTOMER },
        { pubkey: descriptorEvent.pubkey, role: kinds.ROLE_ESCROW },
        { pubkey: resolver.pubkey, role: kinds.ROLE_RESOLVER },
      ],
      descriptorEventId: descriptorEvent.id,
      descriptorAddress: kinds.formatAddress(
        kinds.KIND_ESCROW_DESCRIPTOR,
        descriptorEvent.pubkey,
        descriptor.dTag
      ),
      descriptorRelay: relayUrl,
    }),
    content: kinds.buildEventContent(kinds.RootContent, {
      version: 2,
      profile: profile.PROFILE_ID,
      terms,
      expires_at: now + 120,
      commitments: {
        private_terms: termsCommitment,
        quote: quoteCommitment(signedQuote),
      },
    }),
  });
  const accept = agent.sign({
    kind: kinds.KIND_COORDINATION_ACTION,
    created_at: now + 1,
    tags: kinds.buildActionTags({
      rootId: root.id,
      prevId: root.id,
      relay: relayUrl,
    }),
    content: kinds.buildEventContent(kinds.ActionContent, {
      version: 2,
      action: 'core/accept',
    }),
  });
  await relay.publish(root);
  await relay.publish(accept);

  const fundingInstructions = FundingInstructions.parse(
    await retry(
      () =>
        api(
          customer,
          'GET',
          `/v1/coordinations/${root.id}/funding-instructions`
        ),
      'operator did not ingest the v2 root and acceptance'
    )
  );
  await api(agent, 'PUT', `/v1/coordinations/${root.id}/payout`, {
    type: 'cashu_p2pk',
    pubkey: agent.pubkey,
  });

  const funding = await mintLockedToken(fundingInstructions, customerSecret);
  await api(customer, 'POST', `/v1/coordinations/${root.id}/funding`, {
    token: funding.token,
  });
  const secure = await waitForAction(root.id, 'core/secure');

  const paymentReference = `local-smoke-${root.id.slice(0, 12)}`;
  const fiatSent = action(agent, root.id, secure.id, 'swap/fiat_sent', {
    payment_reference: paymentReference,
  });
  await relay.publish(fiatSent);
  await waitForState(customer, root.id, 'fiat_sent');

  const fiatConfirmed = action(
    customer,
    root.id,
    fiatSent.id,
    'swap/fiat_confirmed',
    { payment_reference: paymentReference }
  );
  await relay.publish(fiatConfirmed);
  await waitForState(customer, root.id, 'fiat_confirmed');

  const authorized = action(
    customer,
    root.id,
    fiatConfirmed.id,
    'core/authorize_settlement'
  );
  await relay.publish(authorized);
  const settled = await waitForAction(root.id, 'core/settle', 30_000);
  const status = CoordinationStatus.parse(
    await api(customer, 'GET', `/v1/coordinations/${root.id}`)
  );

  const settlement = await waitForSettlement(
    root.id,
    agent,
    descriptorEvent.pubkey
  );
  const payoutToken = settlement.token;

  const recipientWallet = new Wallet(mintUrl, { unit: 'sat' });
  await recipientWallet.loadMint();
  const payoutProofAmount = sumProofs(
    recipientWallet.decodeToken(payoutToken).proofs
  ).toNumber();
  const receivedProofs = await recipientWallet.ops
    .receive(payoutToken)
    .asRandom()
    .privkey(Buffer.from(agentSecret).toString('hex'))
    .run();
  const receivedAmount = sumProofs(receivedProofs).toNumber();

  const custodyMint = new CashuTsMint(mintUrl);
  await custodyMint.initialize();
  const fundingStates = await custodyMint.states(funding.token);
  if (fundingStates.some((state: string) => state !== 'spent')) {
    throw new Error('funding proofs were not spent by settlement');
  }
  if (status.public_state !== 'settled' || receivedAmount <= 0) {
    throw new Error('settlement did not complete end to end');
  }

  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        pontswap_commit:
          process.env.PONTSWAP_COMMIT ??
          'c61cb1ad6216a2defd12fb5ad63f33f4afbbd8b0',
        coordination_id: root.id,
        terminal_action_id: settled.id,
        public_state: status.public_state,
        custody_overlay: status.custody_overlay,
        quote: {
          gross_sats: signedQuote.quote.gross_sats,
          operator_fee_sats: signedQuote.quote.operator_fee_sats,
          network_cost_sats: signedQuote.quote.network_cost_sats,
          payout_sats: signedQuote.quote.payout_sats,
        },
        payout_token_sats: payoutProofAmount,
        recipient_received_sats: receivedAmount,
        funding_proofs: fundingStates,
      },
      null,
      2
    )
  );
} finally {
  relay.close();
}

function unixNow(): number {
  return Math.floor(Date.now() / 1_000);
}

function authorization(
  signer: ReturnType<typeof createSigner>,
  method: string,
  url: string,
  body: Uint8Array
): string {
  const tags = [
    ['u', url],
    ['method', method],
    ['nonce', randomUUID()],
  ];
  if (body.length > 0) {
    tags.push(['payload', createHash('sha256').update(body).digest('hex')]);
  }
  const event = signer.sign({ kind: 27_235, tags, content: '' });
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64')}`;
}

async function api(
  signer: ReturnType<typeof createSigner>,
  method: string,
  path: string,
  value?: unknown
): Promise<unknown> {
  const body =
    value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value));
  const url = `${serviceUrl}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      authorization: authorization(signer, method, url, body),
      ...(body.length === 0 ? {} : { 'content-type': 'application/json' }),
    },
    ...(body.length === 0 ? {} : { body }),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    const category =
      typeof error === 'object' &&
      error !== null &&
      'category' in error &&
      typeof error.category === 'string'
        ? error.category
        : 'request_failed';
    throw new Error(`HTTP ${response.status} ${category}`);
  }
  return response.status === 204 ? undefined : await response.json();
}

function action(
  signer: ReturnType<typeof createSigner>,
  rootId: string,
  prevId: string,
  name: string,
  data?: Record<string, unknown>
) {
  return signer.sign({
    kind: kinds.KIND_COORDINATION_ACTION,
    tags: kinds.buildActionTags({ rootId, prevId, relay: relayUrl }),
    content: kinds.buildEventContent(kinds.ActionContent, {
      version: 2,
      action: name,
      ...(data === undefined ? {} : { data }),
    }),
  });
}

async function mintLockedToken(
  instructions: FundingInstructionsValue,
  refundSecret: Uint8Array
): Promise<{ token: string }> {
  const wallet = new Wallet(instructions.mint_url, { unit: 'sat' });
  await wallet.loadMint();
  const quote = await wallet.createMintQuoteBolt11(instructions.amount_sats);
  await delay(3_500);
  const proofs = await wallet.ops
    .mintBolt11(instructions.amount_sats, quote)
    .asP2PK({
      pubkey: `02${instructions.operator_pubkey}`,
      locktime: instructions.locktime,
      refundKeys: [`02${instructions.refund_pubkey}`],
    })
    .run();
  if (Buffer.from(refundSecret).length !== 32) {
    throw new Error('invalid refund key');
  }
  return {
    token: getEncodedToken({ mint: mintUrl, unit: 'sat', proofs }),
  };
}

async function retry<T>(
  operation: () => Promise<T>,
  failure: string,
  timeoutMs = 20_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      await delay(250);
    }
  }
  throw new Error(
    `${failure}: ${lastError instanceof Error ? lastError.message : 'unknown'}`
  );
}

async function waitForAction(rootId: string, name: string, timeoutMs = 20_000) {
  return retry(
    async () => {
      const events: NostrEvent[] = await relay.query([
        { kinds: [kinds.KIND_COORDINATION_ACTION], '#e': [rootId] },
      ]);
      const found = events.find((event) => {
        const content = kinds.parseEventContent(
          kinds.ActionContent,
          event.content
        );
        return content.ok && content.value.action === name;
      });
      if (!found) throw new Error(`${name} not observed`);
      return found;
    },
    `${name} was not published`,
    timeoutMs
  );
}

async function waitForState(
  signer: ReturnType<typeof createSigner>,
  rootId: string,
  expected: string
): Promise<CoordinationStatusValue> {
  return retry(async () => {
    const status = CoordinationStatus.parse(
      await api(signer, 'GET', `/v1/coordinations/${rootId}`)
    );
    if (status.public_state !== expected) {
      throw new Error(`state is ${status.public_state}`);
    }
    return status;
  }, `operator did not reach ${expected}`);
}

async function waitForSettlement(
  rootId: string,
  recipient: ReturnType<typeof createSigner>,
  operatorPubkey: string
): Promise<SettlementPayloadValue> {
  return retry(
    async () => {
      const wraps = await relay.query([
        { kinds: [kinds.KIND_GIFT_WRAP], '#p': [recipient.pubkey] },
      ]);
      for (const wrap of wraps) {
        const opened = unwrapPrivateMessage(recipient, wrap);
        if (!opened.ok || opened.envelope.senderPubkey !== operatorPubkey)
          continue;
        const payload = SettlementPayload.safeParse(opened.envelope.payload);
        if (payload.success && payload.data.coordination_id === rootId) {
          return payload.data;
        }
      }
      throw new Error('settlement gift wrap not observed');
    },
    'operator did not deliver settlement material',
    20_000
  );
}
