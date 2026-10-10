import 'dotenv/config';

import { readFile } from 'node:fs/promises';

import type { NostrEvent } from 'nostr-tools/pure';

import { loadConfig } from '../config/index.ts';
import { CustodyEngine } from '../lib/cashu/custody.ts';
import { CashuTsMint } from '../lib/cashu/mint.ts';
import { isEscrowError } from '../lib/errors.ts';
import { LnurlInvoiceSource } from '../lib/lightning/invoice.ts';
import { buildAgentDefinitionEvent } from '../lib/pontmore/agent.ts';
import { buildDescriptorEvent } from '../lib/pontmore/descriptor.ts';
import { createRelayClient, type RelayClient } from '../lib/pontmore/relay.ts';
import { PROFILE_ID } from '../lib/profiles/swap-v1.ts';
import { EncryptedCustodyStore } from '../lib/store/store.ts';
import { EncryptedOperatorStore } from '../lib/store/operator-store.ts';
import { EscrowHttpService, startHttpServer } from '../service/server.ts';
import { CoordinationOperator } from './coordinator.ts';

const config = loadConfig();
const relay = createRelayClient(config.nostrRelays);
const mint = new CashuTsMint(config.mintUrl);

try {
  await mint.initialize();
  await publishDiscovery(relay);

  const custodyStore = new EncryptedCustodyStore(
    config.custodyStorePath,
    config.operatorSigner.deriveCustodyStoreKey()
  );
  const operatorStore = new EncryptedOperatorStore(
    config.operatorStorePath,
    config.operatorSigner.deriveOperatorStoreKey()
  );
  const custody = new CustodyEngine({
    mint,
    store: custodyStore,
    signer: config.operatorSigner,
    policy: {
      feesEnabled: config.feesEnabled,
      operatorFeeBps: config.operatorFeeBps,
      operatorMinFeeSats: config.operatorMinFeeSats,
      refundFeeMode: config.refundFeeMode,
      releaseSafetyMarginSeconds: config.releaseSafetyMarginSeconds,
      returnLnOverage: config.returnLnOverage,
      operatorLnAddress: config.operatorLnAddress,
    },
    invoiceSource: new LnurlInvoiceSource(),
  });
  const operator = new CoordinationOperator({
    relay,
    signer: config.operatorSigner,
    custody,
    custodyStore,
    store: operatorStore,
    policy: {
      mintUrl: config.mintUrl,
      disputeWindowSeconds: config.disputeWindowSeconds,
      releaseSafetyMarginSeconds: config.releaseSafetyMarginSeconds,
      minLocktimeSeconds: config.minLocktimeSeconds,
      quoteNetworkCostSats: config.quoteNetworkCostSats,
      quote: {
        feesEnabled: config.feesEnabled,
        operatorFeeBps: config.operatorFeeBps,
        operatorMinFeeSats: config.operatorMinFeeSats,
        minCoordinationSats: config.minCoordinationSats,
        refundFeeMode: config.refundFeeMode,
        ttlSeconds: config.quoteTtlSeconds,
      },
    },
    onError: reportError,
  });
  const now = (): number => Math.floor(Date.now() / 1_000);
  await operator.start(now());

  const openApi = await loadOpenApi();
  const service = new EscrowHttpService({
    operator,
    serviceBaseUrl: config.serviceBaseUrl,
    openApi,
    clock: now,
  });
  const server = await startHttpServer({
    service,
    host: config.serviceListenHost,
    port: config.serviceListenPort,
  });
  const tick = setInterval(() => {
    void operator.tick(now()).catch(reportError);
  }, 5_000);
  const refresh = setInterval(
    () => {
      void publishDiscovery(relay).catch(reportError);
    },
    Math.max(60_000, Math.floor(config.descriptorTtlSeconds / 2) * 1_000)
  );

  console.log(
    `operator ready on ${config.serviceListenHost}:${String(config.serviceListenPort)}`
  );

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(tick);
    clearInterval(refresh);
    await new Promise<void>((resolve, reject) => {
      server.close((error) =>
        error === undefined ? resolve() : reject(error)
      );
    });
    operator.stop();
    relay.close();
  };
  process.once('SIGINT', () => void shutdown().catch(reportError));
  process.once('SIGTERM', () => void shutdown().catch(reportError));
} catch (error) {
  reportError(error);
  relay.close();
  process.exitCode = 1;
}

async function publishDiscovery(relayClient: RelayClient): Promise<void> {
  const descriptor = buildDescriptorEvent({
    signer: config.operatorSigner,
    settings: {
      dTag: config.descriptorDTag,
      schemaUrl: config.schemaUrl,
    },
    ttlSeconds: config.descriptorTtlSeconds,
  });
  const agent = buildAgentDefinitionEvent({
    signer: config.operatorSigner,
    capabilities: [PROFILE_ID],
    descriptorDTag: config.descriptorDTag,
    descriptorRelay: config.nostrRelays[0] ?? '',
  });
  const profile = config.operatorSigner.sign({
    kind: 0,
    tags: [],
    content: JSON.stringify({
      name: 'cashu_escrow',
      about: 'Standalone Cashu escrow operator for Pontmore',
    }),
  });
  for (const event of [descriptor, agent, profile]) {
    await relayClient.publish(event);
    await requireReadBack(relayClient, event);
  }
}

async function requireReadBack(
  relayClient: RelayClient,
  event: NostrEvent
): Promise<void> {
  const readBack = await relayClient.query([
    { ids: [event.id], kinds: [event.kind], authors: [event.pubkey] },
  ]);
  if (!readBack.some((stored) => stored.id === event.id)) {
    throw new Error(`kind ${String(event.kind)} discovery read-back failed`);
  }
}

async function loadOpenApi(): Promise<unknown> {
  const source = await readFile(
    new URL('../../openapi/escrow-v1.json', import.meta.url),
    'utf8'
  );
  const document = JSON.parse(source) as Record<string, unknown>;
  document.servers = [{ url: config.serviceBaseUrl }];
  document['x-pontmore-timing'] = {
    min_locktime_seconds: config.minLocktimeSeconds,
    release_safety_margin_seconds: config.releaseSafetyMarginSeconds,
    dispute_window_seconds: config.disputeWindowSeconds,
    settlement_after_release_margin: 'unavailable',
  };
  return document;
}

function reportError(error: unknown): void {
  if (isEscrowError(error)) {
    console.error(
      `${error.category}${error.swapId === undefined ? '' : ` coordination=${error.swapId}`}`
    );
    return;
  }
  console.error('operator failure');
}
