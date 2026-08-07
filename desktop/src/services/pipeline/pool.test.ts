/* The three properties every caller of asyncPool relies on: the limit holds, one thrower does not
   take the phase down with it, and a stop stops DISPATCH rather than the flight already in the air. */

import { describe, it, expect, vi } from 'vitest';
import { asyncPool } from './pool';

/** A deferred promise, so a test can decide when a worker finishes. */
function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe('asyncPool', () => {
  it('never runs more than the limit at once, and covers every item', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    let live = 0;
    let peak = 0;

    const outcomes = await asyncPool(4, items, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await Promise.resolve();
      live--;
      return n * 2;
    });

    expect(peak).toBe(4);
    expect(outcomes.map(o => (o.status === 'fulfilled' ? o.value : null)))
      .toEqual(items.map(n => n * 2));
  });

  it('refills a slot the moment one frees, rather than waiting for a chunk', async () => {
    // Item 0 is held open. A chunked `Promise.all` barrier would stall items 2 and 3 behind it;
    // a pool must have started them both while it is still pending.
    const held = deferred();
    const started: number[] = [];

    const pending = asyncPool(2, [0, 1, 2, 3], async (n) => {
      started.push(n);
      if (n === 0) await held.promise;
    });

    await new Promise(resolve => setTimeout(resolve, 0)); // drain every pending microtask
    expect(started).toEqual([0, 1, 2, 3]);

    held.resolve();
    await pending;
  });

  it('isolates a thrower: its siblings all still run, and the pool resolves', async () => {
    const outcomes = await asyncPool(2, ['a', 'b', 'c'], async (letter) => {
      if (letter === 'b') throw new Error(`boom ${letter}`);
      return letter.toUpperCase();
    });

    expect(outcomes[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    expect((outcomes[1] as { reason: Error }).reason.message).toBe('boom b');
    expect(outcomes[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  it('stops dispatching on the signal and reports the rest as skipped', async () => {
    const seen: number[] = [];
    let stop = false;

    const outcomes = await asyncPool(1, [0, 1, 2, 3, 4], async (n) => {
      seen.push(n);
      if (n === 1) stop = true;
      return n;
    }, () => stop);

    expect(seen).toEqual([0, 1]);
    expect(outcomes.map(o => o.status))
      .toEqual(['fulfilled', 'fulfilled', 'skipped', 'skipped', 'skipped']);
  });

  it('does nothing for an empty list, and never calls the worker', async () => {
    const worker = vi.fn();
    expect(await asyncPool(8, [], worker)).toEqual([]);
    expect(worker).not.toHaveBeenCalled();
  });

  it('treats a nonsense limit as one worker rather than as none', async () => {
    const outcomes = await asyncPool(0, [1, 2], async (n) => n);
    expect(outcomes.map(o => o.status)).toEqual(['fulfilled', 'fulfilled']);
  });
});
