import 'dotenv/config';

import { loadConfig } from '../src/config/index.ts';
import { EscrowError } from '../src/lib/errors.ts';
import {
  buildAgentDefinitionEvent,
  parseAgentDefinitionEvent,
} from '../src/lib/pontmore/agent.ts';
import { KIND_AGENT_DEFINITION } from '../src/lib/pontmore/kinds.ts';
import { createRelayClient } from '../src/lib/pontmore/relay.ts';
import { PROFILE_ID } from '../src/lib/profiles/swap-v1.ts';

const config = loadConfig();
const relay = createRelayClient(config.nostrRelays);

try {
  const event = buildAgentDefinitionEvent({
    signer: config.operatorSigner,
    capabilities: [PROFILE_ID],
    descriptorDTag: config.descriptorDTag,
    descriptorRelay: config.nostrRelays[0] ?? '',
  });

  await relay.publish(event);
  const readBack = await relay.query([
    {
      ids: [event.id],
      kinds: [KIND_AGENT_DEFINITION],
      authors: [config.operatorSigner.pubkey],
    },
  ]);
  if (
    readBack.length !== 1 ||
    parseAgentDefinitionEvent(readBack[0]!) === null
  ) {
    throw new EscrowError(
      'event_invalid',
      'published agent definition failed read-back validation'
    );
  }

  console.log(`published agent definition ${event.id}`);
} finally {
  relay.close();
}
