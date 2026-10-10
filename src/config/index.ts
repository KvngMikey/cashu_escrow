import { z } from 'zod';

import { EscrowError } from '../lib/errors.ts';
import { HttpUrl, HttpsUrl, MAX_SATS, parseUrl } from '../lib/primitives.ts';
import { createSigner, type EventSigner } from '../lib/pontmore/signer.ts';

const BooleanString = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

const integerString = (minimum: number, maximum = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .transform(Number)
    .pipe(z.number().int().min(minimum).max(maximum));

const RelayList = z
  .string()
  .transform((value) => value.split(',').map((relay) => relay.trim()))
  .pipe(
    z
      .array(
        z.string().refine((value) => {
          const protocol = parseUrl(value)?.protocol;
          return protocol === 'wss:' || protocol === 'ws:';
        }, 'expected a ws(s) relay URL')
      )
      .min(1)
  );

const ServiceBaseUrl = HttpUrl.refine((value) => {
  const url = parseUrl(value);
  return (
    url !== null &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '' &&
    url.username === '' &&
    url.password === ''
  );
}, 'expected a service origin without path, query, credentials, or fragment');

const Environment = z.object({
  NOSTR_RELAYS: RelayList,
  OPERATOR_NSEC: z.string().min(1),
  RESOLVER_NSEC: z.string().min(1),
  MINT_URL: HttpUrl,
  DESCRIPTOR_D_TAG: z.string().regex(/^[!-~]{1,128}$/),
  DESCRIPTOR_TTL_SECONDS: integerString(1),
  SERVICE_BASE_URL: ServiceBaseUrl,
  SERVICE_LISTEN_HOST: z.string().min(1),
  SERVICE_LISTEN_PORT: integerString(1, 65_535),
  SCHEMA_URL: HttpsUrl,

  FEES_ENABLED: BooleanString,
  OPERATOR_FEE_BPS: integerString(0, 10_000),
  OPERATOR_MIN_FEE_SATS: integerString(0, MAX_SATS),
  MIN_COORDINATION_SATS: integerString(1, MAX_SATS),
  REFUND_FEE_MODE: z.enum(['network_only', 'full']),
  RETURN_LN_OVERAGE: BooleanString,
  OPERATOR_LN_ADDRESS: z.string().min(1),
  QUOTE_TTL_SECONDS: integerString(1),
  QUOTE_NETWORK_COST_SATS: integerString(0, MAX_SATS),
  DEFAULT_PAYOUT_TYPE: z.enum(['cashu_p2pk', 'bolt11']),

  RELEASE_SAFETY_MARGIN_SECONDS: integerString(1),
  DISPUTE_WINDOW_SECONDS: integerString(1),
  MIN_LOCKTIME_SECONDS: integerString(1),
  CUSTODY_STORE_PATH: z.string().min(1),
  OPERATOR_STORE_PATH: z.string().min(1),
});

export type AppConfig = {
  nostrRelays: readonly string[];
  operatorSigner: EventSigner;
  resolverSigner: EventSigner;
  mintUrl: string;
  descriptorDTag: string;
  descriptorTtlSeconds: number;
  serviceBaseUrl: string;
  serviceListenHost: string;
  serviceListenPort: number;
  schemaUrl: string;
  feesEnabled: boolean;
  operatorFeeBps: number;
  operatorMinFeeSats: number;
  minCoordinationSats: number;
  refundFeeMode: 'network_only' | 'full';
  returnLnOverage: boolean;
  operatorLnAddress: string;
  quoteTtlSeconds: number;
  quoteNetworkCostSats: number;
  defaultPayoutType: 'cashu_p2pk' | 'bolt11';
  releaseSafetyMarginSeconds: number;
  disputeWindowSeconds: number;
  minLocktimeSeconds: number;
  custodyStorePath: string;
  operatorStorePath: string;
};

/** Parse the process environment once and return only typed application data. */
export function loadConfig(
  environment: Record<string, string | undefined> = process.env
): AppConfig {
  const parsed = Environment.safeParse(environment);
  if (!parsed.success) {
    throw new EscrowError(
      'config_invalid',
      'environment configuration is invalid'
    );
  }

  const env = parsed.data;
  const operatorSigner = createSigner(env.OPERATOR_NSEC, 'operator');
  const resolverSigner = createSigner(env.RESOLVER_NSEC, 'resolver');

  if (operatorSigner.pubkey === resolverSigner.pubkey) {
    throw new EscrowError(
      'config_invalid',
      'operator and resolver keys must differ'
    );
  }
  if (env.OPERATOR_MIN_FEE_SATS > env.MIN_COORDINATION_SATS) {
    throw new EscrowError(
      'config_invalid',
      'operator minimum fee exceeds the minimum coordination amount'
    );
  }

  return Object.freeze({
    nostrRelays: Object.freeze(env.NOSTR_RELAYS),
    operatorSigner,
    resolverSigner,
    mintUrl: env.MINT_URL,
    descriptorDTag: env.DESCRIPTOR_D_TAG,
    descriptorTtlSeconds: env.DESCRIPTOR_TTL_SECONDS,
    serviceBaseUrl: env.SERVICE_BASE_URL,
    serviceListenHost: env.SERVICE_LISTEN_HOST,
    serviceListenPort: env.SERVICE_LISTEN_PORT,
    schemaUrl: env.SCHEMA_URL,
    feesEnabled: env.FEES_ENABLED,
    operatorFeeBps: env.OPERATOR_FEE_BPS,
    operatorMinFeeSats: env.OPERATOR_MIN_FEE_SATS,
    minCoordinationSats: env.MIN_COORDINATION_SATS,
    refundFeeMode: env.REFUND_FEE_MODE,
    returnLnOverage: env.RETURN_LN_OVERAGE,
    operatorLnAddress: env.OPERATOR_LN_ADDRESS,
    quoteTtlSeconds: env.QUOTE_TTL_SECONDS,
    quoteNetworkCostSats: env.QUOTE_NETWORK_COST_SATS,
    defaultPayoutType: env.DEFAULT_PAYOUT_TYPE,
    releaseSafetyMarginSeconds: env.RELEASE_SAFETY_MARGIN_SECONDS,
    disputeWindowSeconds: env.DISPUTE_WINDOW_SECONDS,
    minLocktimeSeconds: env.MIN_LOCKTIME_SECONDS,
    custodyStorePath: env.CUSTODY_STORE_PATH,
    operatorStorePath: env.OPERATOR_STORE_PATH,
  });
}
