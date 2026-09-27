import 'dotenv/config';

import { loadConfig } from '../src/config/index.ts';
import { EscrowError } from '../src/lib/errors.ts';
import {
  buildDescriptorEvent,
  parseDescriptorEvent,
} from '../src/lib/pontmore/descriptor.ts';
import { KIND_ESCROW_DESCRIPTOR } from '../src/lib/pontmore/kinds.ts';
import { createRelayClient } from '../src/lib/pontmore/relay.ts';

const config = loadConfig();
const relay = createRelayClient(config.nostrRelays);

try {
  const event = buildDescriptorEvent({
    signer: config.operatorSigner,
    settings: {
      dTag: config.descriptorDTag,
      schemaUrl: config.schemaUrl,
    },
    ttlSeconds: config.descriptorTtlSeconds,
  });

  await relay.publish(event);
  const readBack = await relay.query([
    {
      ids: [event.id],
      kinds: [KIND_ESCROW_DESCRIPTOR],
      authors: [config.operatorSigner.pubkey],
    },
  ]);
  if (readBack.length !== 1 || parseDescriptorEvent(readBack[0]!) === null) {
    throw new EscrowError(
      'event_invalid',
      'published descriptor failed read-back validation'
    );
  }

  console.log(`published escrow descriptor ${event.id}`);
} finally {
  relay.close();
}
