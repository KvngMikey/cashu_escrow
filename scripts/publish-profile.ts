import 'dotenv/config';

import { loadConfig } from '../src/config/index.ts';
import { EscrowError } from '../src/lib/errors.ts';
import { createRelayClient } from '../src/lib/pontmore/relay.ts';

const config = loadConfig();
const relay = createRelayClient(config.nostrRelays);

try {
  const event = config.operatorSigner.sign({
    kind: 0,
    tags: [],
    content: JSON.stringify({
      name: 'cashu_escrow',
      about: 'Standalone Cashu escrow operator for Pontmore',
    }),
  });

  await relay.publish(event);
  const readBack = await relay.query([
    { ids: [event.id], kinds: [0], authors: [config.operatorSigner.pubkey] },
  ]);
  if (readBack.length !== 1 || readBack[0]?.id !== event.id) {
    throw new EscrowError(
      'event_invalid',
      'published Nostr profile failed read-back validation'
    );
  }

  console.log(`published Nostr profile ${event.id}`);
} finally {
  relay.close();
}
