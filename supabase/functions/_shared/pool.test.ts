/* The edge functions' worker pool.
 *
 * Two properties, and neither is "it is faster": results must come back in INPUT order however they
 * finish — `cdn-reconcile` maps a plan onto its results — and the pool must never exceed its limit,
 * because a cross-bucket copy holds a whole object in the function's memory while it is in flight.
 */

import { describe, expect, it } from 'vitest';
import { mapPool } from './pool.ts';

describe('mapPool', () => {
  it('returns results in input order however they complete', async () => {
    const delays = [30, 0, 20, 10];
    const out = await mapPool(4, delays, async (ms, i) => {
      await new Promise(r => setTimeout(r, ms));
      return `${i}:${ms}`;
    });

    expect(out).toEqual(['0:30', '1:0', '2:20', '3:10']);
  });

  it('never exceeds the limit, and refills a slot the moment one frees', async () => {
    let live = 0;
    let peak = 0;
    const starts: number[] = [];

    await mapPool(2, [0, 1, 2, 3, 4, 5], async (item) => {
      starts.push(item);
      live++;
      peak = Math.max(peak, live);
      await new Promise(r => setTimeout(r, item === 0 ? 20 : 0));
      live--;
    });

    expect(peak).toBe(2);
    // The slow first item must not hold the queue: the fast worker takes 1, 2, 3… while it waits.
    expect(starts.slice(0, 2)).toEqual([0, 1]);
    expect(new Set(starts).size).toBe(6);
  });

  it('handles an empty list and a limit larger than the work', async () => {
    expect(await mapPool(8, [], async () => 1)).toEqual([]);
    expect(await mapPool(99, [1, 2], async (n) => n * 2)).toEqual([2, 4]);
  });

  it('treats a limit below one as one rather than stalling', async () => {
    expect(await mapPool(0, [1, 2, 3], async (n) => n)).toEqual([1, 2, 3]);
  });

  it('propagates a rejection, as the serial loop it replaces did', async () => {
    await expect(mapPool(2, [1, 2, 3], async (n) => {
      if (n === 2) throw new Error('boom');
      return n;
    })).rejects.toThrow('boom');
  });
});
