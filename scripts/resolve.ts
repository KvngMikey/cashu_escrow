import 'dotenv/config';

import { loadConfig } from '../src/config/index.ts';
import { isEscrowError } from '../src/lib/errors.ts';
import { createRelayClient } from '../src/lib/pontmore/relay.ts';
import {
  RESOLUTION_EFFECTS,
  type ResolutionEffect,
} from '../src/lib/pontmore/kinds.ts';
import { ResolutionRequest, resolveDispute } from '../src/operator/resolver.ts';

try {
  await main();
} catch (error) {
  if (isEscrowError(error)) {
    console.error(
      `${error.category}${error.swapId === undefined ? '' : ` coordination=${error.swapId}`}`
    );
  } else if (error instanceof Error && error.message === usage()) {
    console.error(error.message);
  } else {
    console.error('resolver failure');
  }
  process.exitCode = 1;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const config = loadConfig();
  const relay = createRelayClient(config.nostrRelays);
  try {
    const event = await resolveDispute({
      relay,
      signer: config.resolverSigner,
      escrowPubkey: config.operatorSigner.pubkey,
      request: ResolutionRequest.parse({
        coordinationId: options.coordination,
        effect: options.effect,
        policy: options.policy,
        createdAt: Math.floor(Date.now() / 1_000),
      }),
    });
    console.log(`published dispute resolution ${event.id}`);
  } finally {
    relay.close();
  }
}

function parseOptions(args: readonly string[]): {
  coordination: string;
  effect: ResolutionEffect;
  policy: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !['--coordination', '--effect', '--policy'].includes(name) ||
      values.has(name)
    ) {
      throw new Error(usage());
    }
    values.set(name, value);
  }
  const coordination = values.get('--coordination');
  const effect = values.get('--effect');
  const policy = values.get('--policy');
  if (
    coordination === undefined ||
    effect === undefined ||
    policy === undefined ||
    !(RESOLUTION_EFFECTS as readonly string[]).includes(effect)
  ) {
    throw new Error(usage());
  }
  return { coordination, effect: effect as ResolutionEffect, policy };
}

function usage(): string {
  return (
    'usage: npm run resolve -- --coordination <id> ' +
    '--effect resume|authorize_settlement|authorize_refund|cancel --policy <id>'
  );
}
