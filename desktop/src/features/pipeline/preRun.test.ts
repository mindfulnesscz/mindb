/* The pre-run reads — concurrent execution, serial consequences.
 *
 * These four round trips now overlap, which means the ORDER the log reports them in, and what a run
 * falls back to when one fails, are no longer implied by the code's shape. That is what these tests
 * pin: an operator reads a run top-down, and a degraded run has to degrade the same way it did when
 * the reads were awaited one after another.
 *
 * The concurrency itself is asserted directly (all three CDN reads in flight before any resolves),
 * because "parallelised" that quietly serialises again is the whole failure mode of this change.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

const requestR2Grant        = vi.fn();
const fetchAssetStorageState = vi.fn();
const fetchPreviewPageLimit = vi.fn();
const loadVocabulary        = vi.fn();

vi.mock('../../services/supabaseService', () => ({
  requestR2Grant:         (...a: unknown[]) => requestR2Grant(...a),
  fetchAssetStorageState: (...a: unknown[]) => fetchAssetStorageState(...a),
  fetchPreviewPageLimit:  (...a: unknown[]) => fetchPreviewPageLimit(...a),
}));
vi.mock('../../services/vocabService', () => ({
  loadVocabulary: (...a: unknown[]) => loadVocabulary(...a),
}));

const { loadCdnPrerequisites, refreshRunVocabulary } = await import('./preRun');

const SB = { url: 'https://portal.example.com', anonKey: 'anon' };
const ARGS = { sbConfig: SB, clientId: 'client-abc', clientName: 'ESS' };

/** A full grant, both tiers, as the r2-grant function returns one. */
function grant(over: Record<string, unknown> = {}) {
  return {
    endpoint: 'https://r2.example.com',
    bucket: 'sotto', publicDomain: 'https://cdn.example.com',
    keyPrefix: 'client-abc/', clientId: 'client-abc',
    accessKeyId: 'ak', secretAccessKey: 'sk', sessionToken: 'st',
    gatedBucket: 'sotto-gated', gatedDomain: 'https://files.example.com',
    gatedAccessKeyId: 'gak', gatedSecretAccessKey: 'gsk', gatedSessionToken: 'gst',
    expiresAt: Date.parse('2026-08-07T10:00:00Z'),
    ...over,
  };
}

const storageState = (levels: Array<[string, string]> = [], references: Map<string, Set<string>> | null = new Map()) =>
  ({ levels: new Map(levels), references });

beforeEach(() => {
  vi.resetAllMocks();
  requestR2Grant.mockResolvedValue(grant());
  fetchAssetStorageState.mockResolvedValue(storageState([['a1b2c3d4:child', 'public']]));
  fetchPreviewPageLimit.mockResolvedValue(8);
  loadVocabulary.mockResolvedValue({ _schema_version: '4.0.0', _comment: '', tags: [] });
});

describe('loadCdnPrerequisites — the happy path', () => {
  it('dispatches all three reads before any of them resolves', async () => {
    // The point of the change. If a later read waits for an earlier one, only one is in flight here.
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    requestR2Grant.mockImplementation(async () => { await gate; return grant(); });
    fetchAssetStorageState.mockImplementation(async () => { await gate; return storageState(); });
    fetchPreviewPageLimit.mockImplementation(async () => { await gate; return 8; });

    const pending = loadCdnPrerequisites(ARGS);
    await Promise.resolve();

    expect(requestR2Grant).toHaveBeenCalledTimes(1);
    expect(fetchAssetStorageState).toHaveBeenCalledTimes(1);
    expect(fetchPreviewPageLimit).toHaveBeenCalledTimes(1);

    release();
    await pending;
  });

  it('reports the three reads in the order the serial version did', async () => {
    const { r2, assetLevels, cdnKeyReferences, previewPageLimit, lines } =
      await loadCdnPrerequisites(ARGS);

    // Durations and the locale-formatted expiry are the only variable parts of these lines.
    const scrub = (msg: string) => msg
      .replace(/expires [^)]+\)/, 'expires <t>)')
      .replace(/\d+(\.\d+)?m?s/g, '<t>');

    expect(lines.map(l => scrub(l.msg))).toEqual([
      '  Storage grant issued for "ESS" (public sotto · gated sotto-gated, expires <t>) in <t>',
      '  1 known asset level(s) loaded for key routing in <t>',
      '  Page-preview limit for this client: 8 (read in <t>)',
    ]);
    expect(lines.every(l => l.type === 'dim')).toBe(true);

    // Both tiers reach the pipeline, or gated assets would be published on the public domain.
    expect(r2?.bucket).toBe('sotto');
    expect(r2?.gatedBucket).toBe('sotto-gated');
    expect(r2?.gatedSecretKey).toBe('gsk');
    expect(assetLevels?.get('a1b2c3d4:child')).toBe('public');
    expect(cdnKeyReferences).toBeInstanceOf(Map);
    expect(previewPageLimit).toBe(8);
  });

  it('warns and disables pruning when the reference index is incomplete', async () => {
    fetchAssetStorageState.mockResolvedValue(storageState([], null));
    const { cdnKeyReferences, lines } = await loadCdnPrerequisites(ARGS);

    expect(cdnKeyReferences).toBeUndefined();
    expect(lines.some(l => l.type === 'warn'
      && l.msg.includes('stale thumbnail/original pruning disabled for safety'))).toBe(true);
  });

  it('reports no page-limit line when the client has none set', async () => {
    fetchPreviewPageLimit.mockResolvedValue(null);
    const { previewPageLimit, lines } = await loadCdnPrerequisites(ARGS);

    expect(previewPageLimit).toBeUndefined();
    expect(lines.some(l => l.msg.includes('Page-preview limit'))).toBe(false);
  });
});

describe('loadCdnPrerequisites — degradation', () => {
  it('disables the CDN stages when the grant fails, and keeps nothing else it read', async () => {
    // The two database reads have already finished by now. They are still discarded: a failed grant
    // used to mean they never ran, and previewPageLimit decides how many pages get rendered LOCALLY.
    requestR2Grant.mockRejectedValue(new Error('r2-grant is not deployed'));
    const result = await loadCdnPrerequisites(ARGS);

    expect(result.r2).toBeUndefined();
    expect(result.assetLevels).toBeUndefined();
    expect(result.previewPageLimit).toBeUndefined();
    expect(result.lines).toEqual([
      { type: 'error', msg: '  ✕  CDN steps disabled — Error: r2-grant is not deployed' },
    ]);
  });

  it('refuses a grant with no gated tier rather than publishing to the public bucket', async () => {
    requestR2Grant.mockResolvedValue(grant({ gatedBucket: null }));
    const result = await loadCdnPrerequisites(ARGS);

    expect(result.r2).toBeUndefined();
    expect(result.lines[0].msg).toContain('storage grant has no gated tier');
    expect(result.lines[0].msg).toContain('Refusing to publish to the public bucket');
  });

  it('keeps the grant but stops at a throwing storage-state read', async () => {
    // Same shape as falling out of the old try block: the grant survives, everything behind the
    // failure is left undefined, and only one failure line is printed.
    fetchAssetStorageState.mockRejectedValue(new Error('no session'));
    const result = await loadCdnPrerequisites(ARGS);

    expect(result.r2?.bucket).toBe('sotto');
    expect(result.assetLevels).toBeUndefined();
    expect(result.previewPageLimit).toBeUndefined();
    expect(result.lines.filter(l => l.type === 'error')).toEqual([
      { type: 'error', msg: '  ✕  CDN steps disabled — Error: no session' },
    ]);
    expect(result.lines.some(l => l.msg.includes('Page-preview limit'))).toBe(false);
  });

  it('keeps the levels it did read when the page-limit read throws', async () => {
    fetchPreviewPageLimit.mockRejectedValue(new Error('no session'));
    const result = await loadCdnPrerequisites(ARGS);

    expect(result.assetLevels?.size).toBe(1);
    expect(result.previewPageLimit).toBeUndefined();
    expect(result.lines.at(-1)).toEqual(
      { type: 'error', msg: '  ✕  CDN steps disabled — Error: no session' },
    );
  });

  it('treats an unreadable storage state as a restrictive default, not as a failure', async () => {
    // fetchAssetStorageState reports a failed read as null. Levels fall back to empty (create-time
    // default) and pruning stops — the pipeline must not guess that a stale key is unshared.
    fetchAssetStorageState.mockResolvedValue(null);
    const result = await loadCdnPrerequisites(ARGS);

    expect(result.assetLevels?.size).toBe(0);
    expect(result.cdnKeyReferences).toBeUndefined();
    expect(result.lines.some(l => l.type === 'error')).toBe(false);
  });
});

describe('refreshRunVocabulary', () => {
  it('returns the portal copy and reports it as fresh', async () => {
    const fresh = { _schema_version: '4.0.0', _comment: 'portal', tags: [] };
    loadVocabulary.mockResolvedValue(fresh);

    const result = await refreshRunVocabulary('client-abc', { persistCache: true });

    expect(result.data).toBe(fresh);
    expect(result.fresh).toBe(true);
    expect(loadVocabulary).toHaveBeenCalledWith('client-abc', {
      forceFromDb: true, persistCache: true, requireDb: true,
    });
    expect(result.lines[0].msg).toContain('Vocabulary refreshed from portal in');
  });

  it('does not persist the cache on a dry run', async () => {
    await refreshRunVocabulary('client-abc', { persistCache: false });
    expect(loadVocabulary).toHaveBeenCalledWith('client-abc',
      expect.objectContaining({ persistCache: false }));
  });

  it('falls back to the cached labels on failure, and says so', async () => {
    // Never fatal: the run is still useful with slightly stale labels. `data: null` is the signal
    // to keep whatever the caller already had.
    loadVocabulary.mockRejectedValue(new Error('offline'));

    const result = await refreshRunVocabulary('client-abc', { persistCache: true });

    expect(result.data).toBeNull();
    expect(result.fresh).toBe(false);
    expect(result.lines[0].type).toBe('warn');
    expect(result.lines[0].msg).toContain('Vocabulary refresh skipped — using cached labels (Error: offline)');
  });
});
