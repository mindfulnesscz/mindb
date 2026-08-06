/* The reconcile summary used to be `⟳ CDN reconcile — 0 moved · 2 failed · 1 still queued`, with the
 * per-asset reason only in the Supabase dashboard's function logs — the one place a desktop operator
 * cannot reach while a run is in front of them. These cover the grouping rules that make the
 * replacement readable rather than a wall of repeated text.
 */

import { describe, expect, it } from 'vitest';
import { describeReconcileFailures, type ReconcileFailure } from './cdnReconcile';

const failure = (asset_id: string, reason: string): ReconcileFailure =>
  ({ asset_id, stage: 'stream', reason });

describe('describeReconcileFailures', () => {
  it('names the asset when a reason affects exactly one', () => {
    expect(describeReconcileFailures([failure('asset-1', 'video gone')]))
      .toEqual(['      ↳ asset-1 — stream: video gone']);
  });

  it('groups a shared reason into a count', () => {
    // The motivating case: an unset CF_STREAM_TOKEN fails every video in the batch identically.
    const shared = 'stream token not configured for this environment';
    const lines = describeReconcileFailures([
      failure('a', shared), failure('b', shared), failure('c', shared),
    ]);

    expect(lines).toEqual([`      ↳ 3 assets — stream: ${shared}`]);
  });

  it('keeps distinct stages distinct even for the same asset', () => {
    const lines = describeReconcileFailures([
      { asset_id: 'a', stage: 'page', reason: 'copy failed' },
      { asset_id: 'a', stage: 'database', reason: 'row not repointed' },
    ]);

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('page: copy failed');
    expect(lines[1]).toContain('database: row not repointed');
  });

  it('caps the list and says how much it withheld', () => {
    const many = Array.from({ length: 8 }, (_, i) => failure(`asset-${i}`, `reason ${i}`));
    const lines = describeReconcileFailures(many);

    // Five reasons plus one honest summary line — never a silent truncation.
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe('      ↳ …and 3 more distinct reason(s)');
  });

  it('returns nothing for a clean reconcile', () => {
    expect(describeReconcileFailures([])).toEqual([]);
  });
});
