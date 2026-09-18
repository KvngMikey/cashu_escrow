import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  REJECTION_REASONS,
  deriveState,
  appendAction,
  validateRoot,
} from '../../src/lib/pontmore/chain.ts';
import { verifySignedEvent } from '../../src/lib/pontmore/signer.ts';
import { swapV1 } from '../../src/lib/profiles/swap-v1.ts';

const VECTOR_DIR = join(import.meta.dirname, '..', '..', 'vectors');

const Event = z.object({
  id: z.string(),
  pubkey: z.string(),
  created_at: z.number(),
  kind: z.number(),
  tags: z.array(z.array(z.string())),
  content: z.string(),
  sig: z.string(),
});

/** The published vector format. A malformed vector is a broken artifact. */
const Vector = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  spec: z.object({
    commit: z.literal('d9a1eb3'),
    pip02_version: z.literal(2),
    profile: z.literal('pontmore/swap@1'),
  }),
  descriptor: Event,
  root: Event,
  actions: z.array(Event),
  expect: z.object({
    root: z.union([
      z.literal('valid'),
      z.object({ rejected: z.enum(REJECTION_REASONS) }),
    ]),
    state: z.string().optional(),
    terminal: z.boolean(),
    disputed: z.boolean(),
    forked: z.union([
      z.object({ branches: z.number().int().min(2) }),
      z.null(),
    ]),
    rejected: z.array(
      z.object({
        action_index: z.number().int().nonnegative(),
        reason: z.enum(REJECTION_REASONS),
      })
    ),
  }),
});

const files = readdirSync(VECTOR_DIR)
  .filter((file) => file.endsWith('.json'))
  .sort();

describe('pontmore/swap@1 conformance vectors', () => {
  it('ships both directions and every escrow economic gate', () => {
    for (const name of [
      'settle-btc-to-fiat',
      'settle-fiat-to-btc',
      'fork-at-secure',
      'fork-at-authorize-settlement',
      'fork-at-settle',
      'fork-at-authorize-refund',
      'fork-at-refund',
    ]) {
      expect(files).toContain(`${name}.json`);
    }
  });

  describe.each(files)('%s', (file) => {
    const vector = Vector.parse(
      JSON.parse(readFileSync(join(VECTOR_DIR, file), 'utf8'))
    );

    it(vector.description, () => {
      expect(file).toBe(`${vector.name}.json`);
      for (const rejection of vector.expect.rejected)
        expect(rejection.action_index).toBeLessThan(vector.actions.length);
      const root = validateRoot({
        root: vector.root,
        descriptor: vector.descriptor,
        profile: swapV1,
      });

      if (vector.expect.root !== 'valid') {
        expect(root.ok).toBe(false);
        expect(root.ok === false && root.reason).toBe(
          vector.expect.root.rejected
        );
        return;
      }

      expect(vector.expect.state).toBeDefined();
      expect(root.ok === false ? root.reason : 'valid').toBe('valid');
      if (!root.ok) return;

      const derived = deriveState({
        root: root.value,
        actions: vector.actions,
        profile: swapV1,
      });

      const reversed = deriveState({
        root: root.value,
        actions: [...vector.actions].reverse(),
        profile: swapV1,
      });
      expect({
        ...reversed,
        rejected: [...reversed.rejected].sort(byId),
      }).toEqual({ ...derived, rejected: [...derived.rejected].sort(byId) });
      if (derived.forked !== null) {
        expect(derived.tip).toBe(derived.forked.predecessor);
        const branch = vector.actions.find((event) =>
          derived.forked?.branches.includes(event.id)
        );
        expect(branch).toBeDefined();
        if (branch !== undefined)
          expect(
            appendAction({
              root: root.value,
              state: derived,
              event: branch,
              profile: swapV1,
            })
          ).toEqual({ ok: false, reason: 'frozen_forked' });
      }
      const appliedIds = derived.applied.map((action) => action.id);
      expect(new Set(appliedIds).size).toBe(appliedIds.length);
      expect(derived.tip).toBe(appliedIds.at(-1) ?? root.value.id);
      const last = vector.actions.find(
        (event) => event.id === appliedIds.at(-1) && verifySignedEvent(event)
      );
      if (last !== undefined && derived.forked === null)
        expect(
          appendAction({
            root: root.value,
            state: derived,
            event: last,
            profile: swapV1,
          })
        ).toEqual({ ok: false, reason: 'duplicate_event' });

      if (vector.expect.state !== undefined) {
        expect(derived.state).toBe(vector.expect.state);
      }
      if (vector.expect.terminal !== undefined) {
        expect(derived.terminal).toBe(vector.expect.terminal);
      }
      if (vector.expect.disputed !== undefined) {
        expect(derived.disputed).toBe(vector.expect.disputed);
      }
      if (vector.expect.forked !== undefined) {
        if (vector.expect.forked === null) {
          expect(derived.forked).toBeNull();
        } else {
          expect(derived.forked?.branches).toHaveLength(
            vector.expect.forked.branches
          );
        }
      }

      const expectedRejections = (vector.expect.rejected ?? []).map(
        (entry) => ({
          id: vector.actions[entry.action_index]?.id,
          reason: entry.reason,
        })
      );
      expect([...derived.rejected].sort(byId)).toEqual(
        [...expectedRejections].sort(byId)
      );
    });
  });
});

function byId(
  a: { id: string | undefined },
  b: { id: string | undefined }
): number {
  return (a.id ?? '').localeCompare(b.id ?? '');
}
