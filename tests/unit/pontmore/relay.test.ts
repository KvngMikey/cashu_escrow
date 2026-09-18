import { describe, expect, it } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';

import { isEscrowError } from '../../../src/lib/errors.ts';
import {
  KIND_COORDINATION_ACTION,
  KIND_COORDINATION_ROOT,
} from '../../../src/lib/pontmore/kinds.ts';
import { createRelayClient } from '../../../src/lib/pontmore/relay.ts';
import { createSigner } from '../../../src/lib/pontmore/signer.ts';
import { createFakeRelayPool } from '../support/fake-relay-pool.ts';
import { OPERATOR } from '../support/keys.ts';

const RELAYS = ['wss://relay.one', 'wss://relay.two'];
const signer = createSigner(OPERATOR.nsec);

function note(swapId: string, createdAt: number): NostrEvent {
  return signer.sign({
    kind: KIND_COORDINATION_ACTION,
    created_at: createdAt,
    tags: [['d', swapId]],
    content: JSON.stringify({ swap_id: swapId, text: 'note' }),
  });
}

describe('relay client construction', () => {
  it('rejects an empty or malformed relay list', () => {
    expect(() => createRelayClient([])).toThrowError(/no relays configured/);
    expect(() => createRelayClient(['https://relay.one'])).toThrowError(
      /ws\(s\)/
    );
    expect(() => createRelayClient(['relay.one'])).toThrowError(/ws\(s\)/);
  });

  it('de-duplicates the configured relays', () => {
    const client = createRelayClient(
      ['wss://relay.one', 'wss://relay.one', 'wss://relay.two'],
      { pool: createFakeRelayPool() }
    );
    expect(client.relays).toEqual(RELAYS);
  });

  it('opens no connection until it is used', () => {
    const pool = createFakeRelayPool();
    createRelayClient(RELAYS, { pool });
    expect(pool.stored).toEqual([]);
  });
});

describe('publish', () => {
  it('reports every relay that accepted the event', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const outcome = await client.publish(note('swap-1', 1_800_000_000));
    expect(outcome).toEqual({ accepted: RELAYS, failed: [] });
    expect(pool.stored).toHaveLength(1);
  });

  it('succeeds while one relay is down, and names it', async () => {
    const pool = createFakeRelayPool({ rejectingRelays: ['wss://relay.two'] });
    const client = createRelayClient(RELAYS, { pool });

    const outcome = await client.publish(note('swap-1', 1_800_000_000));
    expect(outcome).toEqual({
      accepted: ['wss://relay.one'],
      failed: ['wss://relay.two'],
    });
  });

  it('fails loudly when no relay took the event', async () => {
    const pool = createFakeRelayPool({ rejectingRelays: RELAYS });
    const client = createRelayClient(RELAYS, { pool });

    const failure = await client
      .publish(note('swap-1', 1_800_000_000))
      .catch((error: unknown) => error);

    expect(isEscrowError(failure)).toBe(true);
    expect(isEscrowError(failure) && failure.category).toBe(
      'relay_unavailable'
    );
    expect(pool.stored).toEqual([]);
  });
});

describe('query', () => {
  it('merges filters, de-duplicates, and returns the chain oldest first', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const older = note('swap-1', 1_800_000_000);
    const newer = note('swap-1', 1_800_000_100);
    pool.seed(newer);
    pool.seed(older);

    // Two overlapping filters: the same events come back from both.
    const events = await client.query([
      { '#d': ['swap-1'] },
      { kinds: [KIND_COORDINATION_ACTION] },
    ]);

    expect(events.map((event) => event.id)).toEqual([older.id, newer.id]);
  });

  it('drops an event whose signature does not hold', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const honest = note('swap-1', 1_800_000_000);
    pool.seed(honest);
    pool.seed({
      ...honest,
      id: 'a'.repeat(64),
      content: 'rewritten by the relay',
    });

    const events = await client.query([{ kinds: [KIND_COORDINATION_ACTION] }]);
    expect(events.map((event) => event.content)).toEqual([honest.content]);
  });

  it('survives a relay that fails the read', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, {
      pool: {
        ...pool,
        querySync: () => Promise.reject(new Error('socket closed')),
      },
    });

    await expect(
      client.query([{ kinds: [KIND_COORDINATION_ACTION] }])
    ).resolves.toEqual([]);
  });
});

describe('subscribe', () => {
  it('delivers stored and live events, then stops when closed', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const stored = note('swap-1', 1_800_000_000);
    pool.seed(stored);

    const seen: string[] = [];
    const subscription = client.subscribe([{ '#d': ['swap-1'] }], (event) => {
      seen.push(event.id);
    });

    const live = note('swap-1', 1_800_000_100);
    await client.publish(live);
    expect(seen).toEqual([stored.id, live.id]);

    subscription.close();
    await client.publish(note('swap-1', 1_800_000_200));
    expect(seen).toEqual([stored.id, live.id]);
  });

  it('delivers an event once even when two filters match it', async () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const seen: string[] = [];
    client.subscribe(
      [{ '#d': ['swap-1'] }, { kinds: [KIND_COORDINATION_ACTION] }],
      (event) => {
        seen.push(event.id);
      }
    );

    const event = note('swap-1', 1_800_000_000);
    await client.publish(event);
    expect(seen).toEqual([event.id]);
  });

  it('never hands a caller an unverified event', () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    const seen: NostrEvent[] = [];
    client.subscribe(
      [{ kinds: [KIND_COORDINATION_ROOT, KIND_COORDINATION_ACTION] }],
      (event) => {
        seen.push(event);
      }
    );

    const honest = note('swap-1', 1_800_000_000);
    pool.seed({ ...honest, content: 'rewritten in flight' });
    pool.seed(honest);

    expect(seen.map((event) => event.content)).toEqual([honest.content]);
  });
});

describe('close', () => {
  it('closes exactly the relays this client opened', () => {
    const pool = createFakeRelayPool();
    const client = createRelayClient(RELAYS, { pool });

    client.close();
    expect(pool.closed).toEqual(RELAYS);
  });
});
