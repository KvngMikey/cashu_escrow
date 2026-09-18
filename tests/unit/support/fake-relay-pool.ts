/**
 * An in-memory stand-in for `SimplePool`, so the relay seam is exercised
 * without a socket. It stores published events, answers `querySync` by real
 * NIP-01 filter matching, and feeds live subscriptions.
 *
 * `rejectingRelays` makes a relay refuse publishes, which is how the partial
 * and total publish-failure paths are tested.
 */

import { matchFilter } from 'nostr-tools/filter';
import type { Filter } from 'nostr-tools/filter';
import type { SubCloser, SubscribeManyParams } from 'nostr-tools/pool';
import type { NostrEvent } from 'nostr-tools/pure';

import type { RelayPool } from '../../../src/lib/pontmore/relay.ts';

export type FakeRelayPool = RelayPool & {
  /** Events accepted by at least one relay, in publish order. */
  readonly stored: readonly NostrEvent[];
  /** Relay URLs passed to `close()`. */
  readonly closed: readonly string[];
  /** Seed an event as if a relay already had it. */
  seed(event: NostrEvent): void;
};

export function createFakeRelayPool(
  options: { rejectingRelays?: readonly string[] } = {}
): FakeRelayPool {
  const rejecting = new Set(options.rejectingRelays ?? []);
  const stored: NostrEvent[] = [];
  const closed: string[] = [];
  const listeners: { filter: Filter; onevent: (event: NostrEvent) => void }[] =
    [];

  const store = (event: NostrEvent): void => {
    if (!stored.some((existing) => existing.id === event.id))
      stored.push(event);
    for (const listener of listeners) {
      if (matchFilter(listener.filter, event)) listener.onevent(event);
    }
  };

  return {
    stored,
    closed,
    seed: store,

    publish(relays: string[], event: NostrEvent): Promise<string>[] {
      return relays.map((url) => {
        if (rejecting.has(url)) return Promise.reject(new Error('blocked'));
        store(event);
        return Promise.resolve('');
      });
    },

    querySync(_relays: string[], filter: Filter): Promise<NostrEvent[]> {
      return Promise.resolve(
        stored.filter((event) => matchFilter(filter, event))
      );
    },

    subscribe(
      _relays: string[],
      filter: Filter,
      params: SubscribeManyParams
    ): SubCloser {
      const onevent = params.onevent ?? ((): void => undefined);
      for (const event of stored) {
        if (matchFilter(filter, event)) onevent(event);
      }

      const listener = { filter, onevent };
      listeners.push(listener);
      return {
        close(): void {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      };
    },

    close(relays: string[]): void {
      closed.push(...relays);
    },
  };
}
