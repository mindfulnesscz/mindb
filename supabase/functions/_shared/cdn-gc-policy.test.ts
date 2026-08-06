import { describe, expect, it } from 'vitest';
import type { CdnGcReport } from '../../../packages/domain/src/cdnGarbageCollection.ts';
import { deletionConfirmation, guardCdnGcExecution } from './cdn-gc-policy.ts';

function report(orphanCount = 2, totalCount = 10): CdnGcReport {
  return {
    schemaVersion: 1,
    environment: 'staging',
    generatedAt: '2026-08-06T12:00:00.000Z',
    mode: 'dry-run',
    configuration: { projectRef: 'staging-ref', publicBucket: 'public', gatedBucket: 'gated' },
    options: { dropDisconnected: false, includeProtected: [], minRows: 10, force: false },
    source: { assetRows: 10, liveRows: 10, disconnectedRows: 0, includedRows: 10, usableIdentityRows: 10, warnings: [] },
    references: { liveExact: 1, liveOriginalPrefixes: 0, disconnectedExact: 0, disconnectedOriginalPrefixes: 0 },
    writerAudit: [],
    safety: { blastRadiusThreshold: 0.6, orphanFraction: totalCount ? orphanCount / totalCount : 0, blastRadiusExceeded: totalCount ? orphanCount / totalCount > 0.6 : false, forced: false },
    totals: {
      totalCount, totalBytes: totalCount, referencedCount: totalCount - orphanCount,
      referencedBytes: totalCount - orphanCount, disconnectedReferencedCount: 0,
      disconnectedReferencedBytes: 0, protectedCount: 0, protectedBytes: 0,
      orphanCount, orphanBytes: orphanCount,
    },
    buckets: [],
  };
}

describe('Admin CDN GC execution guard', () => {
  it('binds confirmation to the fresh orphan count and reviewed plan', () => {
    expect(deletionConfirmation(238)).toBe('DELETE 238 OBJECTS');
    expect(guardCdnGcExecution({
      report: report(), currentPlanId: 'fresh', expectedPlanId: 'fresh',
      confirmation: 'DELETE 2 OBJECTS', isProduction: false,
    })).toEqual({ ok: true });
    expect(guardCdnGcExecution({
      report: report(), currentPlanId: 'fresh', expectedPlanId: 'old',
      confirmation: 'DELETE 2 OBJECTS', isProduction: false,
    })).toMatchObject({ ok: false, code: 'plan_changed' });
  });

  it('cannot override the blast-radius or production confirmation gates', () => {
    expect(guardCdnGcExecution({
      report: report(7, 10), currentPlanId: 'p', expectedPlanId: 'p',
      confirmation: 'DELETE 7 OBJECTS', isProduction: false,
    })).toMatchObject({ ok: false, code: 'blast_radius' });
    expect(guardCdnGcExecution({
      report: report(), currentPlanId: 'p', expectedPlanId: 'p',
      confirmation: 'DELETE 2 OBJECTS', isProduction: true,
    })).toMatchObject({ ok: false, code: 'production_confirmation' });
  });
});
