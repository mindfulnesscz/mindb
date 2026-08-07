/* The rule that stopped a pipeline run spending twenty seconds looking for pages that had not moved.
 *
 * It is an optimisation with a security failure mode, which is why it has its own module and its own
 * tests: sweeping when it was not needed costs round trips, and NOT sweeping when it was needed
 * leaves a document's page readable at a wider access level than the document. Every case that
 * cannot be shown safe must therefore sweep — these pin that asymmetry, not the speed.
 */

import { describe, expect, it } from 'vitest';
import { needsPageSweep, type QueueEntry } from './reconcile-policy.ts';

const entry = (over: Partial<QueueEntry> = {}): QueueEntry =>
  ({ wasLevel: 'client', attempts: 0, lastError: null, ...over });

describe('needsPageSweep', () => {
  it('skips the sweep when the level has not moved since the asset was queued', () => {
    // The seeded-queue case: 20260802090000 queued the entire library on the reasoning that a no-op
    // pass is cheap. This is what makes that true.
    expect(needsPageSweep('client', entry({ wasLevel: 'client' }))).toBe(false);
  });

  it('sweeps when the level moved', () => {
    expect(needsPageSweep('internal', entry({ wasLevel: 'client' }))).toBe(true);
    expect(needsPageSweep('public', entry({ wasLevel: 'guest' }))).toBe(true);
  });

  it('sweeps when an earlier pass on this row failed, even though the level matches', () => {
    /* The case the whole rule turns on. A partial pass moves some pages and DELETES their sources
       while others stay put, so the pages can be split across two levels while `was_level` still
       equals the current one. Skipping here would strand the moved ones at the old level forever. */
    expect(needsPageSweep('client', entry({ attempts: 1 }))).toBe(true);
    expect(needsPageSweep('client', entry({ lastError: 'page: copy failed' }))).toBe(true);
  });

  it('sweeps a brand-new row, whose objects could have been published at any level', () => {
    expect(needsPageSweep('client', entry({ wasLevel: null }))).toBe(true);
  });

  it('sweeps an asset the caller named directly, with no queue row to go on', () => {
    // The portal path: it knows it just changed something, and nothing recorded where the bytes were.
    expect(needsPageSweep('client', undefined)).toBe(true);
  });
});
