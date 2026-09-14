/**
 * The relay seam. Every read and write against the Nostr network in this
 * operator goes through a `RelayClient` and nothing else.
 *
 * Three properties the callers depend on:
 *
 *   - **Caller-owned lifecycle.** No module singleton and no connection at
 *     construction. Sockets open on the first publish/query/subscribe and
 *     close when the owner calls `close()`.
 *   - **Nothing raw escapes.** The pool is not exposed. A caller cannot reach
 *     past this module to a socket.
 *   - **Inbound events are verified here.** A relay is an untrusted
 *     counterparty; an event that fails id/signature verification is dropped
 *     before any caller sees it.
 *
 * A dead relay never blocks a live one: publish reports per-relay outcomes and
 * fails only when every relay refuses, and query settles per relay.
 */

import { SimplePool } from 'nostr-tools/pool';
import type { SubCloser } from 'nostr-tools/pool';
import type { Filter } from 'nostr-tools/filter';
import type { NostrEvent } from 'nostr-tools/pure';

import { EscrowError } from '../errors.ts';
import { parseUrl } from '../primitives.ts';
import { verifySignedEvent } from './signer.ts';

const DEFAULT_QUERY_TIMEOUT_MS = 5_000;

/**
 * How many recently delivered event ids a subscription remembers. A swap
 * chain is a handful of events, so this only has to outlive the overlap
 * between filters; it is capped because the operator subscribes for weeks.
 */
const SUBSCRIPTION_MEMORY = 10_000;

/** The slice of `SimplePool` this module uses. Tests substitute a fake. */
export type RelayPool = Pick<
  SimplePool,
  'publish' | 'querySync' | 'subscribe' | 'close'
>;

export type RelaySubscription = {
  close(): void;
};

export type PublishOutcome = {
  /** Relays that accepted the event. */
  accepted: readonly string[];
  /** Relays that rejected it or failed to answer. */
  failed: readonly string[];
};

export interface RelayClient {
  readonly relays: readonly string[];
  /** Resolves when every relay has answered. Throws only if all of them fail. */
  publish(event: NostrEvent): Promise<PublishOutcome>;
  /** One-shot read: merged, de-duplicated, verified, oldest first. */
  query(filters: readonly Filter[]): Promise<NostrEvent[]>;
  /** Live read. Stored and new events, verified. Caller closes it. */
  subscribe(
    filters: readonly Filter[],
    onEvent: (event: NostrEvent) => void
  ): RelaySubscription;
  /** Close every connection this client opened. */
  close(): void;
}

export type RelayClientOptions = {
  /** How long a one-shot query waits for a relay. */
  queryTimeoutMs?: number;
  /** Injected pool. Defaults to a fresh `SimplePool` owned by this client. */
  pool?: RelayPool;
};

export function createRelayClient(
  relayUrls: readonly string[],
  options: RelayClientOptions = {}
): RelayClient {
  const relays = normaliseRelays(relayUrls);
  const queryTimeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const pool = options.pool ?? new SimplePool();

  return {
    relays,

    async publish(event) {
      const results = await Promise.allSettled(
        pool.publish([...relays], event)
      );
      const accepted: string[] = [];
      const failed: string[] = [];

      results.forEach((result, index) => {
        // publish() returns one promise per relay, in the order given.
        const url = relays[index] ?? '<unknown>';
        (result.status === 'fulfilled' ? accepted : failed).push(url);
      });

      if (accepted.length === 0) {
        throw new EscrowError(
          'relay_unavailable',
          `kind ${event.kind} event rejected by all ${relays.length} relays`
        );
      }
      return { accepted, failed };
    },

    async query(filters) {
      const batches = await Promise.all(
        filters.map((filter) =>
          pool
            .querySync([...relays], filter, { maxWait: queryTimeoutMs })
            .catch(() => [] as NostrEvent[])
        )
      );

      const byId = new Map<string, NostrEvent>();
      for (const batch of batches) {
        for (const event of batch) {
          if (!byId.has(event.id) && verifySignedEvent(event)) {
            byId.set(event.id, event);
          }
        }
      }

      return [...byId.values()].sort(
        (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1)
      );
    },

    subscribe(filters, onEvent) {
      const delivered = createRecentIds(SUBSCRIPTION_MEMORY);

      const closers: SubCloser[] = filters.map((filter) =>
        pool.subscribe([...relays], filter, {
          onevent: (event) => {
            if (!verifySignedEvent(event)) return;
            if (delivered.add(event.id)) onEvent(event);
          },
        })
      );

      return {
        close() {
          for (const closer of closers) closer.close();
        },
      };
    },

    close() {
      pool.close([...relays]);
    },
  };
}

/** Bounded set of ids: `add` returns false when the id was already present. */
function createRecentIds(limit: number): { add(id: string): boolean } {
  const ids = new Set<string>();
  const order: string[] = [];

  return {
    add(id) {
      if (ids.has(id)) return false;
      ids.add(id);
      order.push(id);
      if (order.length > limit) {
        const oldest = order.shift();
        if (oldest !== undefined) ids.delete(oldest);
      }
      return true;
    },
  };
}

function normaliseRelays(relayUrls: readonly string[]): readonly string[] {
  const relays = [...new Set(relayUrls)];
  if (relays.length === 0) {
    throw new EscrowError('config_invalid', 'no relays configured');
  }

  for (const url of relays) {
    const protocol = parseUrl(url)?.protocol;
    if (protocol !== 'wss:' && protocol !== 'ws:') {
      throw new EscrowError(
        'config_invalid',
        `relay URL is not a ws(s) URL: ${url}`
      );
    }
  }
  return Object.freeze(relays);
}
