/* The classification behind every "delete these objects" decision.
 *
 * This module decides what is live, protected, or eligible for deletion, and three surfaces act on
 * its answer: the operator CLI, the Admin edge function, and the desktop card. A wrong `orphan` here
 * is not a bad report — it is bytes deleted from a bucket that the portal is still serving, with no
 * undo. So the cases that matter most are the ones where an object is NOT an orphan for a reason
 * that is easy to miss: a stored URL on a domain nobody configured, an original whose extension is
 * unknown, a page whose row is disconnected rather than deleted.
 */

import { describe, expect, it } from 'vitest';
import {
  assertBlastRadius,
  assertReferenceSafety,
  BLAST_RADIUS_THRESHOLD,
  buildReferenceIndex,
  buildReport,
  classifyObjects,
  parseStoredReference,
  type CdnGcAssetRow,
  type ClassifiedCdnObject,
  type ListedCdnObject,
  type OrphanCdnObject,
} from './cdnGarbageCollection';

const CLIENT = '11111111-2222-3333-4444-555555555555';
const OTHER_CLIENT = '99999999-8888-7777-6666-555555555555';
const STABLE = 'brand-book-2026';
const CHILD = 'c1';

const PUBLIC_DOMAIN = 'https://cdn.example.com';
const GATED_DOMAIN = 'https://files.example.com';
const DOMAINS = { publicDomain: PUBLIC_DOMAIN, gatedDomain: GATED_DOMAIN };

/** An approved, public row — the level that puts objects in the public bucket with no level prefix. */
function row(overrides: Partial<CdnGcAssetRow> = {}): CdnGcAssetRow {
  return {
    id: 'row-1',
    client_id: CLIENT,
    stable_id: STABLE,
    child_id: CHILD,
    perm: 'public',
    status: 'approved',
    preview_page_count: 0,
    ...overrides,
  };
}

/** Rows are cheap to fabricate but `assertReferenceSafety` has a floor; most tests need a crowd. */
function crowd(count: number, overrides: Partial<CdnGcAssetRow> = {}): CdnGcAssetRow[] {
  return Array.from({ length: count }, (_, i) =>
    row({ id: `filler-${i}`, stable_id: `filler-${i}`, ...overrides }));
}

function object(partial: Partial<ListedCdnObject> & { key: string }): ListedCdnObject {
  return { tier: 'public', bucket: 'bucket', size: 100, lastModified: null, ...partial };
}

function only(classified: ClassifiedCdnObject[]): ClassifiedCdnObject {
  expect(classified).toHaveLength(1);
  return classified[0];
}

describe('parseStoredReference', () => {
  it('ignores anything that is not a usable string', () => {
    expect(parseStoredReference(null)).toBeNull();
    expect(parseStoredReference(undefined)).toBeNull();
    expect(parseStoredReference(42)).toBeNull();
    expect(parseStoredReference('')).toBeNull();
    expect(parseStoredReference('   ')).toBeNull();
  });

  it('reads a key off each configured domain', () => {
    expect(parseStoredReference(`${PUBLIC_DOMAIN}/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`, DOMAINS))
      .toEqual({ tier: 'public', key: `${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`, source: 'configured-public-domain' });
    expect(parseStoredReference(`${GATED_DOMAIN}/client/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`, DOMAINS))
      .toEqual({ tier: 'gated', key: `client/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`, source: 'configured-gated-domain' });
  });

  it('honours a path prefix on the configured domain', () => {
    const domains = { publicDomain: 'https://cdn.example.com/assets' };
    expect(parseStoredReference('https://cdn.example.com/assets/a/b.webp', domains))
      .toMatchObject({ tier: 'public', key: 'a/b.webp' });
    // Same origin, outside the configured path: not this domain's object, so it must not be
    // credited to it — the key would be wrong by exactly the prefix.
    expect(parseStoredReference('https://cdn.example.com/elsewhere/b.webp', domains))
      .toMatchObject({ outOfScope: true });
  });

  it('decodes percent-encoding in a stored URL', () => {
    expect(parseStoredReference(`${PUBLIC_DOMAIN}/${CLIENT}/originals/${STABLE}/my%20file.pdf`, DOMAINS))
      .toMatchObject({ key: `${CLIENT}/originals/${STABLE}/my file.pdf` });
  });

  it('infers the tier for a URL on a domain nobody configured', () => {
    // A renamed CDN domain, or a row written before the current configuration. The key shape still
    // says which bucket it belongs to, and guessing wrong here would orphan a live object.
    expect(parseStoredReference(`https://old.example.net/client/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`))
      .toMatchObject({ tier: 'gated', source: 'inferred-old-domain' });
    expect(parseStoredReference(`https://old.example.net/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`))
      .toMatchObject({ tier: 'public', source: 'inferred-old-domain' });
  });

  it('recognises the pre-identity legacy layouts', () => {
    expect(parseStoredReference('https://old.example.net/thumbnails/anything.webp'))
      .toMatchObject({ tier: 'public', source: 'inferred-legacy-old-domain' });
    expect(parseStoredReference('https://old.example.net/internal/pages/anything/001.webp'))
      .toMatchObject({ tier: 'gated', source: 'inferred-legacy-old-domain' });
  });

  it('reports a URL it cannot place rather than guessing a bucket', () => {
    expect(parseStoredReference('https://dropbox.com/s/abc/deck.pdf'))
      .toEqual({ outOfScope: true, value: 'https://dropbox.com/s/abc/deck.pdf' });
  });

  it('errors on a URL it cannot parse at all', () => {
    expect(parseStoredReference('https://')).toMatchObject({ error: expect.stringContaining('cannot parse stored URL') });
    expect(parseStoredReference('https://cdn.example.com/')).toMatchObject({ error: expect.stringContaining('no object key') });
  });

  it('reads a bare stored key, dropping the cache-busting query', () => {
    // `?v=<hash>` is cache-busting, never part of the object key — keeping it would match nothing.
    expect(parseStoredReference(`${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp?v=abc123`))
      .toEqual({ tier: 'public', key: `${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`, source: 'stored-key' });
    expect(parseStoredReference('internal/a/b.webp#frag')).toMatchObject({ tier: 'gated', key: 'internal/a/b.webp' });
  });

  it('takes the tier of a bare key from its first segment', () => {
    for (const level of ['guest', 'client', 'internal']) {
      expect(parseStoredReference(`${level}/x/y.webp`)).toMatchObject({ tier: 'gated' });
    }
    expect(parseStoredReference('public/x/y.webp')).toMatchObject({ tier: 'public' });
    expect(parseStoredReference(`${CLIENT}/x/y.webp`)).toMatchObject({ tier: 'public' });
  });

  it('errors on malformed percent-encoding in a bare key', () => {
    expect(parseStoredReference('%E0%A4%A/thumbnails/x.webp'))
      .toMatchObject({ error: expect.stringContaining('cannot parse stored object key') });
  });
});

describe('buildReferenceIndex', () => {
  it('refuses anything that is not an array of rows', () => {
    // A failed query that resolved to null must never read as "no assets reference anything".
    expect(() => buildReferenceIndex(null as unknown as CdnGcAssetRow[])).toThrow(/did not return an array/);
  });

  it('derives the thumbnail and page keys a row implies', () => {
    const index = buildReferenceIndex([row({ preview_page_count: 2 })]);
    expect(index.live.exact).toContain(`public:${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`);
    expect(index.live.exact).toContain(`public:${CLIENT}/pages/${STABLE}/${CHILD}/001.webp`);
    expect(index.live.exact).toContain(`public:${CLIENT}/pages/${STABLE}/${CHILD}/002.webp`);
    expect(index.live.exact).not.toContain(`public:${CLIENT}/pages/${STABLE}/${CHILD}/003.webp`);
    expect(index.usableIdentityRows).toBe(1);
  });

  it('protects an original of unknown extension with a prefix, not a guess', () => {
    // Nothing records the original's extension when no stored URL carries one. A prefix keeps
    // `<childId>.<anything>` alive; guessing one extension would orphan every other.
    const index = buildReferenceIndex([row()]);
    expect(index.livePrefixLists.public).toContain(`${CLIENT}/originals/${STABLE}/${CHILD}.`);
    expect(index.live.exact).toContain(`public:${CLIENT}/originals/${STABLE}/${CHILD}`);
  });

  it('uses the real extension when a stored URL reveals one', () => {
    const index = buildReferenceIndex(
      [row({ download_url: `${PUBLIC_DOMAIN}/${CLIENT}/originals/${STABLE}/${CHILD}.pdf` })],
      DOMAINS,
    );
    expect(index.live.exact).toContain(`public:${CLIENT}/originals/${STABLE}/${CHILD}.pdf`);
    expect(index.livePrefixLists.public).toHaveLength(0);
  });

  it('ignores an extension from another asset’s original', () => {
    // The stored URL must belong to THIS row's identity, or its extension says nothing about it.
    const index = buildReferenceIndex(
      [row({ download_url: `${PUBLIC_DOMAIN}/${OTHER_CLIENT}/originals/${STABLE}/${CHILD}.pdf` })],
      DOMAINS,
    );
    expect(index.livePrefixLists.public).toContain(`${CLIENT}/originals/${STABLE}/${CHILD}.`);
  });

  it('separates disconnected rows from live ones but still keeps their references', () => {
    const index = buildReferenceIndex([row(), row({ id: 'row-2', status: 'disconnected' })]);
    expect(index.liveRows).toBe(1);
    expect(index.disconnectedRows).toBe(1);
    expect(index.includedRows).toBe(2);
    expect(index.disconnected.exact.size).toBeGreaterThan(0);
    expect(index.disconnectedIdentities.size).toBe(1);
  });

  it('drops disconnected rows from the reference set only when asked', () => {
    const index = buildReferenceIndex(
      [row(), row({ id: 'row-2', stable_id: 'gone', status: 'disconnected' })],
      { dropDisconnected: true },
    );
    expect(index.includedRows).toBe(1);
    expect(index.disconnected.exact.size).toBe(0);
    // Identity is still recorded, so a later object can be labelled as coming from a disconnected row.
    expect(index.disconnectedIdentities.size).toBe(1);
  });

  it('warns instead of throwing when a row has no usable identity', () => {
    const index = buildReferenceIndex([row({ child_id: null })]);
    expect(index.usableIdentityRows).toBe(0);
    expect(index.warnings).toEqual([
      expect.objectContaining({ rowId: 'row-1', reason: 'missing-identity', childId: null }),
    ]);
  });

  it('warns about a stored value that is not an R2 object at all', () => {
    const index = buildReferenceIndex([row({ download_url: 'https://dropbox.com/s/abc/deck.pdf' })], DOMAINS);
    expect(index.warnings).toEqual([
      expect.objectContaining({ reason: 'not-an-r2-key', column: 'download_url' }),
    ]);
  });

  it('aborts on a stored URL it cannot parse', () => {
    // Silently skipping it would drop a live reference and turn its object into an orphan.
    expect(() => buildReferenceIndex([row({ thumbnail_url: 'https://' })], DOMAINS))
      .toThrow(/row-1 thumbnail_url/);
  });

  it.each([
    ['a fraction', 1.5],
    ['a negative count', -1],
    ['an implausible count', 10_001],
  ])('aborts on %s of preview pages', (_label, value) => {
    // The count drives a loop that writes references; a bad value either under-protects or hangs.
    expect(() => buildReferenceIndex([row({ preview_page_count: value })]))
      .toThrow(/unsafe preview_page_count/);
  });

  it('treats a null page count as zero pages', () => {
    expect(() => buildReferenceIndex([row({ preview_page_count: null })])).not.toThrow();
  });
});

describe('assertReferenceSafety', () => {
  const index = (rows: CdnGcAssetRow[]) => buildReferenceIndex(rows);

  it('accepts a healthy index', () => {
    expect(() => assertReferenceSafety(index(crowd(10)))).not.toThrow();
  });

  it('rejects a nonsense floor', () => {
    expect(() => assertReferenceSafety(index(crowd(10)), { minRows: 0 })).toThrow(/at least 1/);
    expect(() => assertReferenceSafety(index(crowd(10)), { minRows: 1.5 })).toThrow(/at least 1/);
  });

  it('aborts on zero rows — an empty query would orphan the entire bucket', () => {
    expect(() => assertReferenceSafety(index([]))).toThrow(/zero asset rows/);
  });

  it('aborts below the sane row floor', () => {
    expect(() => assertReferenceSafety(index(crowd(3)))).toThrow(/below the sane floor/);
    expect(() => assertReferenceSafety(index(crowd(3)), { minRows: 3 })).not.toThrow();
  });

  it('aborts when every row was dropped from the reference set', () => {
    const dropped = buildReferenceIndex(crowd(10, { status: 'disconnected' }), { dropDisconnected: true });
    expect(() => assertReferenceSafety(dropped)).toThrow(/no rows remain/);
  });

  it('aborts when no included row has a usable identity', () => {
    expect(() => assertReferenceSafety(index(crowd(10, { child_id: null })))).toThrow(/usable client\/stable\/child/);
  });

  it('aborts when identity is present but sparse', () => {
    // 80% floor: a partially-populated query is the shape of a schema change, not a real library.
    const rows = [...crowd(5), ...crowd(5, { child_id: null }).map((r, i) => ({ ...r, id: `bad-${i}` }))];
    expect(() => assertReferenceSafety(buildReferenceIndex(rows))).toThrow(/80% sanity floor/);
  });

  it('aborts when the computed reference set is empty', () => {
    const empty = { ...buildReferenceIndex(crowd(10)), live: { exact: new Set<string>(), prefixes: new Set<string>() },
      disconnected: { exact: new Set<string>(), prefixes: new Set<string>() } };
    expect(() => assertReferenceSafety(empty)).toThrow(/reference set is empty/);
  });
});

describe('classifyObjects', () => {
  const index = buildReferenceIndex([row({ preview_page_count: 1 })], DOMAINS);

  it('rejects an unknown protected namespace rather than silently protecting nothing', () => {
    expect(() => classifyObjects([], index, { includeProtected: ['branding', 'nope'] }))
      .toThrow(/unknown protected namespace: nope/);
  });

  it.each([
    ['thumbnail', `${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp`],
    ['page', `${CLIENT}/pages/${STABLE}/${CHILD}/001.webp`],
  ])('keeps a referenced %s', (_label, key) => {
    expect(only(classifyObjects([object({ key })], index)))
      .toMatchObject({ status: 'referenced', referenceType: 'live-stored-or-derived', disconnectedReference: false });
  });

  it('keeps an original matched only by its prefix', () => {
    expect(only(classifyObjects([object({ key: `${CLIENT}/originals/${STABLE}/${CHILD}.pdf` })], index)))
      .toMatchObject({ status: 'referenced', referenceType: 'live-original-prefix' });
  });

  it('finds the right prefix among many', () => {
    // Binary search over a sorted prefix list: the neighbours on both sides must not match.
    const many = buildReferenceIndex(
      ['aaa', 'mmm', 'zzz'].map((s, i) => row({ id: `r${i}`, stable_id: s })),
      DOMAINS,
    );
    expect(only(classifyObjects([object({ key: `${CLIENT}/originals/mmm/${CHILD}.psd` })], many)))
      .toMatchObject({ status: 'referenced' });
    expect(only(classifyObjects([object({ key: `${CLIENT}/originals/nnn/${CHILD}.psd` })], many)))
      .toMatchObject({ status: 'orphan' });
  });

  it('keeps an object referenced only by a disconnected row, and says so', () => {
    // Disconnected is a soft delete: the row can come back, and its bytes must still be there.
    const disconnectedIndex = buildReferenceIndex([row({ status: 'disconnected' })], DOMAINS);
    const classified = only(classifyObjects(
      [object({ tier: 'gated', key: `internal/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp` })],
      disconnectedIndex,
    ));
    expect(classified).toMatchObject({ status: 'referenced', disconnectedReference: true });
  });

  it('protects branding, which no asset row will ever reference', () => {
    const classified = only(classifyObjects([object({ key: `branding/${CLIENT}/logo.png` })], index));
    expect(classified).toMatchObject({ status: 'protected', namespace: 'branding', clientId: CLIENT });
  });

  it('lets an operator opt branding back in deliberately', () => {
    const classified = only(classifyObjects(
      [object({ key: `branding/${CLIENT}/logo.png` })], index, { includeProtected: ['branding'] },
    ));
    expect(classified).toMatchObject({ status: 'orphan', reason: 'unknown-shape', namespace: 'branding', clientId: CLIENT });
  });

  it('does not protect branding in the gated bucket — the namespace is public-tier only', () => {
    expect(only(classifyObjects([object({ tier: 'gated', key: 'branding/x/logo.png' })], index)))
      .toMatchObject({ status: 'orphan' });
  });

  it.each([
    ['public', 'public' as const, 'thumbnails/legacy.webp', 'public'],
    ['gated', 'gated' as const, 'internal/pages/legacy/001.webp', 'internal'],
  ])('flags a pre-identity %s object as legacy', (_label, tier, key, level) => {
    expect(only(classifyObjects([object({ tier, key })], index)))
      .toMatchObject({ status: 'orphan', reason: 'legacy-no-client', clientId: '(legacy-no-client)', level });
  });

  it('flags an object of no recognisable shape', () => {
    expect(only(classifyObjects([object({ key: 'stray-upload.txt' })], index)))
      .toMatchObject({ status: 'orphan', reason: 'unknown-shape', clientId: '(unknown)', level: 'public' });
    expect(only(classifyObjects([object({ tier: 'gated', key: 'client/not-a-uuid/thumbnails/a/b.webp' })], index)))
      .toMatchObject({ status: 'orphan', reason: 'unknown-shape', level: '(unknown)' });
  });

  it.each([
    ['a thumbnail with too many segments', `${CLIENT}/thumbnails/${STABLE}/extra/${CHILD}.webp`],
    ['a thumbnail that is not webp', `${CLIENT}/thumbnails/${STABLE}/${CHILD}.png`],
    ['a page numbered without padding', `${CLIENT}/pages/${STABLE}/${CHILD}/1.webp`],
    ['an original with no leaf', `${CLIENT}/originals/${STABLE}/`],
  ])('does not read %s as an asset object', (_label, key) => {
    expect(only(classifyObjects([object({ key })], index))).toMatchObject({ reason: 'unknown-shape' });
  });

  it('flags a well-formed object whose row is gone', () => {
    expect(only(classifyObjects([object({ key: `${CLIENT}/thumbnails/vanished/${CHILD}.webp` })], index)))
      .toMatchObject({ status: 'orphan', reason: 'no-matching-row', fromDisconnected: false, stableId: 'vanished' });
  });

  it('marks an orphan whose identity belongs to a disconnected row', () => {
    const both = buildReferenceIndex(
      [row(), row({ id: 'row-2', stable_id: 'soft-deleted', status: 'disconnected' })],
      { ...DOMAINS, dropDisconnected: true },
    );
    expect(only(classifyObjects([object({ key: `${CLIENT}/thumbnails/soft-deleted/${CHILD}.webp` })], both)))
      .toMatchObject({ status: 'orphan', fromDisconnected: true });
  });

  it('separates a copy left at an old level from an unreferenced current-level copy', () => {
    // The row is public; a gated copy of the same identity is residue from a level change, and a
    // public copy that no reference names is something else — the reasons drive different follow-ups.
    const gatedResidue = only(classifyObjects(
      [object({ tier: 'gated', key: `internal/${CLIENT}/thumbnails/${STABLE}/${CHILD}.webp` })], index,
    ));
    expect(gatedResidue).toMatchObject({ status: 'orphan', reason: 'old-level-copy' });

    const currentLevel = only(classifyObjects(
      [object({ key: `${CLIENT}/pages/${STABLE}/${CHILD}/009.webp` })], index,
    ));
    expect(currentLevel).toMatchObject({ status: 'orphan', reason: 'unreferenced-current-copy' });
  });

  it('coerces a missing or unusable size to zero rather than poisoning every total', () => {
    const classified = classifyObjects(
      [object({ key: 'stray.txt', size: Number.NaN }), object({ key: 'stray2.txt', size: undefined as unknown as number })],
      index,
    );
    expect(classified.map(c => c.size)).toEqual([0, 0]);
  });
});

describe('buildReport', () => {
  const index = buildReferenceIndex(crowd(10), DOMAINS);
  const classified = classifyObjects([
    object({ key: `${CLIENT}/thumbnails/filler-0/${CHILD}.webp`, size: 10 }),
    object({ key: `branding/${CLIENT}/logo.png`, size: 20 }),
    object({ key: 'stray-a.txt', size: 30 }),
    object({ tier: 'gated', key: `internal/${CLIENT}/thumbnails/filler-0/${CHILD}.webp`, size: 40 }),
  ], index);

  const report = buildReport({
    environment: 'staging',
    config: { projectRef: 'ref', publicBucket: 'pub', gatedBucket: 'gated' },
    index,
    classified,
    generatedAt: '2026-08-06T00:00:00.000Z',
  });

  it('totals each bucket and the pair', () => {
    expect(report.buckets.map(b => b.tier)).toEqual(['public', 'gated']);
    expect(report.buckets[0].totals).toMatchObject({ totalCount: 3, referencedCount: 1, protectedCount: 1, orphanCount: 1 });
    expect(report.buckets[1].totals).toMatchObject({ totalCount: 1, orphanCount: 1, orphanBytes: 40 });
    expect(report.totals).toMatchObject({ totalCount: 4, totalBytes: 100, orphanCount: 2, orphanBytes: 70 });
  });

  it('reports a dry run unless execution was requested', () => {
    expect(report.mode).toBe('dry-run');
    const executing = buildReport({
      environment: 'staging',
      config: { projectRef: 'ref', publicBucket: 'pub', gatedBucket: 'gated' },
      index,
      classified,
      options: { execute: true },
    });
    expect(executing.mode).toBe('execute-preview');
  });

  it('carries the row provenance an operator needs to trust the plan', () => {
    expect(report.source).toMatchObject({ assetRows: 10, liveRows: 10, disconnectedRows: 0, usableIdentityRows: 10 });
    expect(report.references.liveExact).toBeGreaterThan(0);
    expect(report.writerAudit.some(entry => entry.namespace === 'branding/')).toBe(true);
  });

  it('normalises the options it echoes back', () => {
    const echoed = buildReport({
      environment: 'dev', config: { projectRef: 'r', publicBucket: 'p', gatedBucket: 'g' }, index, classified,
      options: { includeProtected: ['branding'], force: true },
    });
    expect(echoed.options).toEqual({ dropDisconnected: false, includeProtected: ['branding'], minRows: 10, force: true });
    expect(echoed.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('groups orphans by reason, client and level, largest first', () => {
    const groups = report.buckets[0].orphanGroups;
    expect(groups.byReason[0]).toMatchObject({ value: 'unknown-shape', count: 1, bytes: 30 });
    expect(groups.byClient[0].value).toBe('(unknown)');
    expect(groups.byLevel[0].value).toBe('public');
  });

  it('caps the sample keys shown per group', () => {
    // A group is a summary; ten thousand keys in a report nobody can read is not a safeguard.
    const many = classifyObjects(
      Array.from({ length: 8 }, (_, i) => object({ key: `stray-${i}.txt`, size: 1 })), index,
    );
    const grouped = buildReport({ environment: 'e', config: { projectRef: 'r', publicBucket: 'p', gatedBucket: 'g' },
      index, classified: many });
    expect(grouped.buckets[0].orphanGroups.byReason[0].count).toBe(8);
    expect(grouped.buckets[0].orphanGroups.byReason[0].sampleKeys).toHaveLength(5);
  });

  it('computes a zero blast radius for an empty bucket pair rather than dividing by zero', () => {
    const empty = buildReport({ environment: 'e', config: { projectRef: 'r', publicBucket: 'p', gatedBucket: 'g' },
      index, classified: [] });
    expect(empty.safety).toMatchObject({ orphanFraction: 0, blastRadiusExceeded: false });
  });
});

describe('assertBlastRadius', () => {
  const index = buildReferenceIndex(crowd(10), DOMAINS);
  const reportWith = (orphans: number, referenced: number) => buildReport({
    environment: 'e',
    config: { projectRef: 'r', publicBucket: 'p', gatedBucket: 'g' },
    index,
    classified: classifyObjects([
      ...Array.from({ length: orphans }, (_, i) => object({ key: `stray-${i}.txt` })),
      ...Array.from({ length: referenced }, (_, i) => object({ key: `${CLIENT}/thumbnails/filler-${i}/${CHILD}.webp` })),
    ], index),
  });

  it('passes when most objects are still referenced', () => {
    const report = reportWith(1, 9);
    expect(report.safety.blastRadiusExceeded).toBe(false);
    expect(() => assertBlastRadius(report)).not.toThrow();
  });

  it('aborts when a majority of the bucket pair would be deleted', () => {
    // The shape of a broken reference query, not a real cleanup. Refusing is the whole point.
    const report = reportWith(9, 1);
    expect(report.safety.orphanFraction).toBeGreaterThan(BLAST_RADIUS_THRESHOLD);
    expect(() => assertBlastRadius(report)).toThrow(/blast-radius abort: 9\/10 objects \(90.0%\)/);
  });

  it('can be overridden deliberately, and records that it was', () => {
    const report = reportWith(9, 1);
    expect(() => assertBlastRadius(report, { force: true })).not.toThrow();
  });
});

describe('orphan candidates', () => {
  it('are exactly the objects an executor may delete', () => {
    // The executor filters on `status === 'orphan'`; anything mislabelled here is deleted bytes.
    const index = buildReferenceIndex(crowd(10), DOMAINS);
    const classified = classifyObjects([
      object({ key: `${CLIENT}/thumbnails/filler-1/${CHILD}.webp` }),
      object({ key: `branding/${CLIENT}/logo.png` }),
      object({ key: 'stray.txt' }),
    ], index);
    const candidates = classified.filter((c): c is OrphanCdnObject => c.status === 'orphan');
    expect(candidates.map(c => c.key)).toEqual(['stray.txt']);
  });
});
