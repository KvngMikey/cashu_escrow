import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { generateSecretKey } from 'nostr-tools/pure';
import { nsecEncode } from 'nostr-tools/nip19';

import { createRelayClient } from '../src/lib/pontmore/relay.ts';
import { createSigner } from '../src/lib/pontmore/signer.ts';

const vitest = new URL('../node_modules/.bin/vitest', import.meta.url).pathname;

await probeRelay();
await run([
  'run',
  '--project',
  'unit',
  'tests/unit/operator/coordinator.test.ts',
  'tests/unit/service/nip98.test.ts',
  'tests/unit/service/server.test.ts',
]);
await run([
  'run',
  '--project',
  'integration',
  'tests/integration/custody.test.ts',
]);

console.log('smoke scenarios passed');

async function probeRelay(): Promise<void> {
  const relay = createRelayClient([
    process.env.TEST_RELAY_URL ?? 'ws://127.0.0.1:17000',
  ]);
  try {
    const signer = createSigner(nsecEncode(generateSecretKey()), 'operator');
    const event = signer.sign({
      kind: 1,
      tags: [['t', 'cashu-escrow-smoke']],
      content: `cashu_escrow smoke ${randomUUID()}`,
    });
    await relay.publish(event);
    const stored = await relay.query([{ ids: [event.id] }]);
    if (!stored.some((candidate) => candidate.id === event.id)) {
      throw new Error('local relay publish read-back failed');
    }
  } finally {
    relay.close();
  }
}

function run(args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(vitest, args, {
      cwd: new URL('..', import.meta.url),
      env: process.env,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `smoke suite failed (${signal === null ? `exit ${String(code)}` : signal})`
        )
      );
    });
  });
}
