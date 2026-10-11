import { readFileSync } from 'node:fs';

import { nsecEncode } from 'nostr-tools/nip19';
import type { NostrEvent } from 'nostr-tools/pure';
import { describe, expect, it } from 'vitest';

import { createRelayClient } from '../../../src/lib/pontmore/relay.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { resolveDispute } from '../../../src/operator/resolver.ts';
import { createFakeRelayPool } from '../support/fake-relay-pool.ts';
import { STRANGER } from '../support/keys.ts';

type Vector = {
  descriptor: NostrEvent;
  root: NostrEvent;
  actions: NostrEvent[];
};

describe('dispute resolver', () => {
  it('publishes a linked resolution with the root-bound resolver', async () => {
    const vector = loadVector('dispute-freezes-progress');
    const pool = createFakeRelayPool();
    for (const event of [vector.descriptor, vector.root, ...vector.actions]) {
      pool.seed(event);
    }
    const relay = createRelayClient(['wss://relay.test'], { pool });

    const event = await resolveDispute({
      relay,
      signer: vectorResolver(),
      escrowPubkey: vector.descriptor.pubkey,
      request: {
        coordinationId: vector.root.id,
        effect: 'authorize_refund',
        policy: 'service-policy-1',
        createdAt: 1_800_002_600,
      },
    });

    expect(JSON.parse(event.content)).toEqual({
      version: 2,
      action: 'core/resolve_dispute',
      data: {
        policy: 'service-policy-1',
        effect: 'authorize_refund',
      },
    });
    expect(pool.stored).toContainEqual(event);
  });

  it('rejects an unbound resolver and refuses to choose a fork branch', async () => {
    const disputed = loadVector('dispute-freezes-progress');
    const disputedPool = createFakeRelayPool();
    for (const event of [
      disputed.descriptor,
      disputed.root,
      ...disputed.actions,
    ]) {
      disputedPool.seed(event);
    }
    await expect(
      resolveDispute({
        relay: createRelayClient(['wss://relay.test'], {
          pool: disputedPool,
        }),
        signer: createSigner(STRANGER.nsec, 'resolver'),
        escrowPubkey: disputed.descriptor.pubkey,
        request: {
          coordinationId: disputed.root.id,
          effect: 'resume',
          policy: 'service-policy-1',
          createdAt: 1_800_002_600,
        },
      })
    ).rejects.toMatchObject({ category: 'request_unauthorized' });

    const forked = loadVector('fork-at-secure');
    const forkedPool = createFakeRelayPool();
    for (const event of [forked.descriptor, forked.root, ...forked.actions]) {
      forkedPool.seed(event);
    }
    await expect(
      resolveDispute({
        relay: createRelayClient(['wss://relay.test'], { pool: forkedPool }),
        signer: vectorResolver(),
        escrowPubkey: forked.descriptor.pubkey,
        request: {
          coordinationId: forked.root.id,
          effect: 'resume',
          policy: 'service-policy-1',
          createdAt: 1_800_002_600,
        },
      })
    ).rejects.toMatchObject({ category: 'custody_conflict' });
  });
});

function loadVector(name: string): Vector {
  return JSON.parse(
    readFileSync(
      new URL(`../../../vectors/${name}.json`, import.meta.url),
      'utf8'
    )
  ) as Vector;
}

function vectorResolver() {
  return createSigner(nsecEncode(new Uint8Array(32).fill(0x1e)), 'resolver');
}
