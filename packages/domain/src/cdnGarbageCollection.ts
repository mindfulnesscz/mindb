/* Platform-free CDN garbage-collection policy shared by the CLI and the Admin edge function.
 *
 * This module only classifies data passed to it. It never queries Postgres, lists R2, or deletes
 * anything. Keeping that boundary here ensures every operator surface agrees about what is live,
 * protected, or eligible for deletion.
 */

import {
  effectiveLevel,
  pageTarget,
  parseObjectPath,
  storageTarget,
  tierFor,
  type AccessLevel,
} from './assetStorage.ts';

export type CdnTier = 'public' | 'gated';

export interface CdnGcAssetRow {
  id?: string | null;
  client_id?: string | null;
  stable_id?: string | null;
  child_id?: string | null;
  perm?: string | null;
  status?: string | null;
  thumbnail_url?: string | null;
  download_url?: string | null;
  download_key?: string | null;
  preview_page_count?: number | null;
}

export interface ListedCdnObject {
  tier: CdnTier;
  bucket: string;
  key: string;
  size: number;
  lastModified?: string | null;
}

export interface ReferenceWarning {
  rowId: string | null;
  reason: string;
  column?: string;
  value?: string;
  clientId?: string | null;
  stableId?: string | null;
  childId?: string | null;
}

interface ReferenceGroup {
  exact: Set<string>;
  prefixes: Set<string>;
}

export interface CdnReferenceIndex {
  rowCount: number;
  liveRows: number;
  disconnectedRows: number;
  includedRows: number;
  usableIdentityRows: number;
  live: ReferenceGroup;
  disconnected: ReferenceGroup;
  livePrefixLists: Record<CdnTier, string[]>;
  disconnectedPrefixLists: Record<CdnTier, string[]>;
  liveLocations: Map<string, Set<string>>;
  disconnectedIdentities: Set<string>;
  warnings: ReferenceWarning[];
  dropDisconnected: boolean;
}

interface ClassifiedBase extends ListedCdnObject {
  lastModified: string | null;
}

export interface ReferencedCdnObject extends ClassifiedBase {
  status: 'referenced';
  referenceType: string;
  disconnectedReference: boolean;
}

export interface ProtectedCdnObject extends ClassifiedBase {
  status: 'protected';
  namespace: string;
  clientId: string | null;
}

export interface OrphanCdnObject extends ClassifiedBase {
  status: 'orphan';
  reason: string;
  clientId: string | null;
  level: string;
  namespace?: string | null;
  fromDisconnected?: boolean;
  kind?: string;
  stableId?: string;
  childId?: string;
}

export type ClassifiedCdnObject =
  | ReferencedCdnObject
  | ProtectedCdnObject
  | OrphanCdnObject;

export interface CdnGcTotals {
  totalCount: number;
  totalBytes: number;
  referencedCount: number;
  referencedBytes: number;
  disconnectedReferencedCount: number;
  disconnectedReferencedBytes: number;
  protectedCount: number;
  protectedBytes: number;
  orphanCount: number;
  orphanBytes: number;
}

export interface CdnGcGroup {
  value: string;
  count: number;
  bytes: number;
  sampleKeys: string[];
}

export interface CdnGcBucketReport {
  tier: CdnTier;
  bucket: string;
  totals: CdnGcTotals;
  orphanGroups: {
    byReason: CdnGcGroup[];
    byClient: CdnGcGroup[];
    byLevel: CdnGcGroup[];
  };
  objects: ClassifiedCdnObject[];
}

export interface CdnGcReport {
  schemaVersion: 1;
  environment: string;
  generatedAt: string;
  mode: 'dry-run' | 'execute-preview';
  configuration: {
    projectRef: string;
    publicBucket: string;
    gatedBucket: string;
  };
  options: {
    dropDisconnected: boolean;
    includeProtected: string[];
    minRows: number;
    force: boolean;
  };
  source: {
    assetRows: number;
    liveRows: number;
    disconnectedRows: number;
    includedRows: number;
    usableIdentityRows: number;
    warnings: ReferenceWarning[];
  };
  references: {
    liveExact: number;
    liveOriginalPrefixes: number;
    disconnectedExact: number;
    disconnectedOriginalPrefixes: number;
  };
  writerAudit: readonly WriterAuditEntry[];
  safety: {
    blastRadiusThreshold: number;
    orphanFraction: number;
    blastRadiusExceeded: boolean;
    forced: boolean;
  };
  totals: CdnGcTotals;
  buckets: CdnGcBucketReport[];
}

export const BLAST_RADIUS_THRESHOLD = 0.6;
export const DEFAULT_MIN_ROWS = 10;
const MAX_PREVIEW_PAGES = 10_000;
const SAMPLE_LIMIT = 5;
const KINDS = new Set(['thumbnails', 'originals', 'pages']);

export const PROTECTED_NAMESPACES = Object.freeze([
  {
    name: 'branding',
    tier: 'public' as const,
    prefix: 'branding/',
    writer: 'supabase/functions/r2-branding-upload/index.ts',
  },
]);

interface WriterAuditEntry {
  namespace: string;
  tiedToAssetRows: boolean;
  protectedByDefault?: boolean;
  writers: readonly string[];
}

const WRITER_AUDIT: readonly WriterAuditEntry[] = Object.freeze([
  {
    namespace: 'thumbnails/originals/pages',
    tiedToAssetRows: true,
    writers: [
      'desktop/src/services/pipeline/cdnUpload.ts',
      'scripts/rekey-gated-objects.mjs',
      'supabase/functions/_shared/r2.ts',
    ],
  },
  {
    namespace: 'branding/',
    tiedToAssetRows: false,
    protectedByDefault: true,
    writers: ['supabase/functions/r2-branding-upload/index.ts'],
  },
]);

function tagged(tier: CdnTier, key: string): string {
  return `${tier}:${key}`;
}

function identityKey(clientId: string, stableId: string, childId: string): string {
  return `${clientId}\0${stableId}\0${childId}`;
}

function addMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
  const values = map.get(key) ?? new Set<string>();
  values.add(value);
  map.set(key, values);
}

function addReference(target: Set<string>, tier: CdnTier, key: string | null | undefined): void {
  if (key) target.add(tagged(tier, key));
}

function addPrefix(target: Set<string>, tier: CdnTier, prefix: string): void {
  if (prefix) target.add(tagged(tier, prefix));
}

function integerPageCount(value: number | null | undefined, rowId?: string | null): number {
  if (value == null) return 0;
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0 || count > MAX_PREVIEW_PAGES) {
    throw new Error(
      `asset ${rowId ?? '(unknown)'} has unsafe preview_page_count=${String(value)} ` +
        `(expected an integer from 0 to ${MAX_PREVIEW_PAGES})`,
    );
  }
  return count;
}

function decodePathname(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

function domainKey(url: string, domain: string | undefined): string | null {
  if (!domain) return null;
  try {
    const value = new URL(url);
    const base = new URL(domain);
    const basePath = base.pathname.replace(/\/+$/, '');
    if (value.origin !== base.origin) return null;
    if (basePath && value.pathname !== basePath && !value.pathname.startsWith(`${basePath}/`)) {
      return null;
    }
    return decodePathname(value.pathname.slice(basePath.length));
  } catch {
    return null;
  }
}

export type StoredReference =
  | { tier: CdnTier; key: string; source: string }
  | { error: string }
  | { outOfScope: true; value: string };

/** Parse a stored URL or download_key without re-deriving it from row identity. */
export function parseStoredReference(
  value: unknown,
  domains: { publicDomain?: string; gatedDomain?: string } = {},
): StoredReference | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const raw = value.trim();

  if (/^https?:\/\//i.test(raw)) {
    const publicKey = domainKey(raw, domains.publicDomain);
    if (publicKey) return { tier: 'public', key: publicKey, source: 'configured-public-domain' };

    const gatedKey = domainKey(raw, domains.gatedDomain);
    if (gatedKey) return { tier: 'gated', key: gatedKey, source: 'configured-gated-domain' };

    let key: string | null;
    try {
      key = decodePathname(new URL(raw).pathname);
    } catch {
      return { error: `cannot parse stored URL: ${raw}` };
    }
    if (!key) return { error: `stored URL has no object key: ${raw}` };

    if (parseObjectPath(`/${key}`)) return { tier: 'gated', key, source: 'inferred-old-domain' };
    if (parseObjectPath(`/public/${key}`)) {
      return { tier: 'public', key, source: 'inferred-old-domain' };
    }
    if (/^(thumbnails|originals|pages)\//.test(key)) {
      return { tier: 'public', key, source: 'inferred-legacy-old-domain' };
    }
    if (/^(public|guest|client|internal)\/(thumbnails|originals|pages)\//.test(key)) {
      return { tier: 'gated', key, source: 'inferred-legacy-old-domain' };
    }
    return { outOfScope: true, value: raw };
  }

  const withoutQuery = raw.split(/[?#]/, 1)[0];
  const key = decodePathname(withoutQuery);
  if (!key) return { error: `cannot parse stored object key: ${raw}` };
  const first = key.split('/', 1)[0];
  return {
    tier: first === 'guest' || first === 'client' || first === 'internal' ? 'gated' : 'public',
    key,
    source: 'stored-key',
  };
}

interface AssetShape {
  level: AccessLevel;
  clientId: string;
  kind: string;
  stableId: string;
  childId: string;
}

function parseAssetShape(tier: CdnTier, key: string): AssetShape | null {
  const parsed = tier === 'gated' ? parseObjectPath(`/${key}`) : parseObjectPath(`/public/${key}`);
  if (!parsed) return null;

  const parts = parsed.rest.split('/');
  const kind = parts[0];
  if (!KINDS.has(kind)) return null;

  if (kind === 'thumbnails') {
    if (parts.length !== 3 || !parts[2].endsWith('.webp')) return null;
    const childId = parts[2].slice(0, -'.webp'.length);
    if (!parts[1] || !childId) return null;
    return { level: parsed.level, clientId: parsed.clientId, kind, stableId: parts[1], childId };
  }

  if (kind === 'originals') {
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null;
    const dot = parts[2].indexOf('.');
    const childId = dot === -1 ? parts[2] : parts[2].slice(0, dot);
    if (!childId) return null;
    return { level: parsed.level, clientId: parsed.clientId, kind, stableId: parts[1], childId };
  }

  if (parts.length !== 4 || !/^\d{3}\.webp$/.test(parts[3])) return null;
  if (!parts[1] || !parts[2]) return null;
  return {
    level: parsed.level,
    clientId: parsed.clientId,
    kind,
    stableId: parts[1],
    childId: parts[2],
  };
}

function originalExtension(
  reference: Extract<StoredReference, { tier: CdnTier }> | null,
  row: CdnGcAssetRow,
): string | null {
  if (!reference) return null;
  const shape = parseAssetShape(reference.tier, reference.key);
  if (
    !shape ||
    shape.kind !== 'originals' ||
    shape.clientId !== row.client_id ||
    shape.stableId !== row.stable_id ||
    shape.childId !== row.child_id
  ) return null;
  const leaf = reference.key.slice(reference.key.lastIndexOf('/') + 1);
  const extension = leaf.slice(String(row.child_id).length);
  return extension.startsWith('.') && extension.length > 1 ? extension : null;
}

function makeReferenceGroup(): ReferenceGroup {
  return { exact: new Set<string>(), prefixes: new Set<string>() };
}

/** Build the safety-critical reference index for every row in public.assets. */
export function buildReferenceIndex(
  rows: CdnGcAssetRow[],
  options: { dropDisconnected?: boolean; publicDomain?: string; gatedDomain?: string } = {},
): CdnReferenceIndex {
  const { dropDisconnected = false, publicDomain = '', gatedDomain = '' } = options;
  if (!Array.isArray(rows)) throw new Error('assets query did not return an array');

  const live = makeReferenceGroup();
  const disconnected = makeReferenceGroup();
  const liveLocations = new Map<string, Set<string>>();
  const disconnectedIdentities = new Set<string>();
  const warnings: ReferenceWarning[] = [];
  let liveRows = 0;
  let disconnectedRows = 0;
  let includedRows = 0;
  let usableIdentityRows = 0;

  for (const row of rows) {
    const isDisconnected = row.status === 'disconnected';
    if (isDisconnected) disconnectedRows += 1;
    else liveRows += 1;

    const target = isDisconnected ? disconnected : live;
    const include = !isDisconnected || !dropDisconnected;
    if (include) includedRows += 1;

    const stored: Extract<StoredReference, { tier: CdnTier }>[] = [];
    for (const column of ['thumbnail_url', 'download_url', 'download_key'] as const) {
      const parsed = parseStoredReference(row[column], { publicDomain, gatedDomain });
      if (!parsed) continue;
      if ('error' in parsed) throw new Error(`asset ${row.id ?? '(unknown)'} ${column}: ${parsed.error}`);
      if ('outOfScope' in parsed) {
        warnings.push({ rowId: row.id ?? null, column, value: parsed.value, reason: 'not-an-r2-key' });
        continue;
      }
      stored.push(parsed);
      if (include) addReference(target.exact, parsed.tier, parsed.key);
    }

    if (!row.client_id || !row.stable_id || !row.child_id) {
      if (include) {
        warnings.push({
          rowId: row.id ?? null,
          reason: 'missing-identity',
          clientId: row.client_id ?? null,
          stableId: row.stable_id ?? null,
          childId: row.child_id ?? null,
        });
      }
      continue;
    }

    const identity = identityKey(row.client_id, row.stable_id, row.child_id);
    if (isDisconnected) disconnectedIdentities.add(identity);
    if (!include) continue;
    usableIdentityRows += 1;

    const level = effectiveLevel({ perm: row.perm, status: row.status });
    const route = { tier: tierFor(level), level };
    if (!isDisconnected) addMapSet(liveLocations, identity, `${route.tier}:${level}`);

    const thumbnail = storageTarget(level, row.client_id, 'thumbnails', row.stable_id, row.child_id, '.webp');
    addReference(target.exact, thumbnail.tier, thumbnail.key);

    const extensions = new Set(
      stored.map(reference => originalExtension(reference, row)).filter((v): v is string => Boolean(v)),
    );
    if (extensions.size) {
      for (const extension of extensions) {
        const original = storageTarget(level, row.client_id, 'originals', row.stable_id, row.child_id, extension);
        addReference(target.exact, original.tier, original.key);
      }
    } else {
      const extensionless = storageTarget(level, row.client_id, 'originals', row.stable_id, row.child_id);
      addReference(target.exact, extensionless.tier, extensionless.key);
      addPrefix(target.prefixes, extensionless.tier, `${extensionless.key}.`);
    }

    const pageCount = integerPageCount(row.preview_page_count, row.id);
    for (let page = 1; page <= pageCount; page += 1) {
      const targetPage = pageTarget(level, row.client_id, row.stable_id, row.child_id, page);
      addReference(target.exact, targetPage.tier, targetPage.key);
    }
  }

  const toPrefixLists = (group: ReferenceGroup): Record<CdnTier, string[]> => ({
    public: [...group.prefixes].filter(value => value.startsWith('public:')).map(value => value.slice(7)).sort(),
    gated: [...group.prefixes].filter(value => value.startsWith('gated:')).map(value => value.slice(6)).sort(),
  });

  return {
    rowCount: rows.length,
    liveRows,
    disconnectedRows,
    includedRows,
    usableIdentityRows,
    live,
    disconnected,
    livePrefixLists: toPrefixLists(live),
    disconnectedPrefixLists: toPrefixLists(disconnected),
    liveLocations,
    disconnectedIdentities,
    warnings,
    dropDisconnected,
  };
}

export function assertReferenceSafety(
  index: CdnReferenceIndex,
  { minRows = DEFAULT_MIN_ROWS }: { minRows?: number } = {},
): void {
  if (!Number.isInteger(minRows) || minRows < 1) throw new Error('--min-rows must be an integer of at least 1');
  if (index.rowCount === 0) throw new Error('reference safety abort: Supabase returned zero asset rows');
  if (index.rowCount < minRows) {
    throw new Error(
      `reference safety abort: Supabase returned ${index.rowCount} rows, below the sane floor ` +
        `of ${minRows}; verify the environment or pass an intentional --min-rows override`,
    );
  }
  if (index.includedRows === 0) throw new Error('reference safety abort: no rows remain in the reference set');
  if (index.usableIdentityRows === 0) {
    throw new Error('reference safety abort: no included row has a usable client/stable/child identity');
  }
  const expectedIdentityRows = Math.max(1, Math.ceil(index.includedRows * 0.8));
  if (index.usableIdentityRows < expectedIdentityRows) {
    throw new Error(
      `reference safety abort: only ${index.usableIdentityRows}/${index.includedRows} included rows ` +
        'have usable identity (below the 80% sanity floor)',
    );
  }
  const referenceCount =
    index.live.exact.size + index.live.prefixes.size +
    index.disconnected.exact.size + index.disconnected.prefixes.size;
  if (referenceCount === 0) throw new Error('reference safety abort: the computed R2 reference set is empty');
}

function findMatchingPrefix(sortedPrefixes: string[], key: string): string | null {
  let low = 0;
  let high = sortedPrefixes.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (sortedPrefixes[mid] <= key) {
      candidate = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return candidate >= 0 && key.startsWith(sortedPrefixes[candidate]) ? sortedPrefixes[candidate] : null;
}

function referenceType(index: CdnReferenceIndex, tier: CdnTier, key: string): string | null {
  const value = tagged(tier, key);
  if (index.live.exact.has(value)) return 'live-stored-or-derived';
  if (findMatchingPrefix(index.livePrefixLists[tier], key)) return 'live-original-prefix';
  if (index.disconnected.exact.has(value)) return 'disconnected-stored-or-derived';
  if (findMatchingPrefix(index.disconnectedPrefixLists[tier], key)) return 'disconnected-original-prefix';
  return null;
}

function protectedNamespace(tier: CdnTier, key: string, included: Set<string>) {
  return PROTECTED_NAMESPACES.find(
    namespace => namespace.tier === tier && key.startsWith(namespace.prefix) && !included.has(namespace.name),
  ) ?? null;
}

function legacyNoClient(tier: CdnTier, key: string): boolean {
  if (/^(thumbnails|originals|pages)\//.test(key)) return true;
  return tier === 'gated' && /^(public|guest|client|internal)\/(thumbnails|originals|pages)\//.test(key);
}

function namespaceClient(key: string): string | null {
  const parts = key.split('/');
  return parts.length > 1 ? parts[1] : null;
}

/** Classify a complete, already-listed bucket inventory. */
export function classifyObjects(
  objects: ListedCdnObject[],
  index: CdnReferenceIndex,
  options: { includeProtected?: string[] } = {},
): ClassifiedCdnObject[] {
  const includedProtected = new Set(options.includeProtected ?? []);
  const unknownProtected = [...includedProtected].filter(
    name => !PROTECTED_NAMESPACES.some(namespace => namespace.name === name),
  );
  if (unknownProtected.length) throw new Error(`unknown protected namespace: ${unknownProtected.join(', ')}`);

  return objects.map(object => {
    const base: ClassifiedBase = {
      tier: object.tier,
      bucket: object.bucket,
      key: object.key,
      size: Number(object.size) || 0,
      lastModified: object.lastModified ?? null,
    };
    const refType = referenceType(index, object.tier, object.key);
    if (refType) {
      return { ...base, status: 'referenced', referenceType: refType, disconnectedReference: refType.startsWith('disconnected-') };
    }

    const namespace = protectedNamespace(object.tier, object.key, includedProtected);
    if (namespace) {
      return { ...base, status: 'protected', namespace: namespace.name, clientId: namespaceClient(object.key) };
    }

    if (legacyNoClient(object.tier, object.key)) {
      return {
        ...base,
        status: 'orphan',
        reason: 'legacy-no-client',
        clientId: '(legacy-no-client)',
        level: object.tier === 'public' ? 'public' : object.key.split('/', 1)[0],
      };
    }

    const shape = parseAssetShape(object.tier, object.key);
    if (!shape) {
      const optedIn = PROTECTED_NAMESPACES.find(
        item => item.tier === object.tier && object.key.startsWith(item.prefix),
      );
      return {
        ...base,
        status: 'orphan',
        reason: 'unknown-shape',
        namespace: optedIn?.name ?? null,
        clientId: optedIn ? namespaceClient(object.key) : '(unknown)',
        level: object.tier === 'public' ? 'public' : '(unknown)',
      };
    }

    const identity = identityKey(shape.clientId, shape.stableId, shape.childId);
    const locations = index.liveLocations.get(identity);
    const fromDisconnected = index.disconnectedIdentities.has(identity);
    if (!locations?.size) {
      return { ...base, ...shape, status: 'orphan', reason: 'no-matching-row', fromDisconnected };
    }
    const location = `${object.tier}:${shape.level}`;
    return {
      ...base,
      ...shape,
      status: 'orphan',
      reason: locations.has(location) ? 'unreferenced-current-copy' : 'old-level-copy',
      fromDisconnected,
    };
  });
}

function emptyTotals(): CdnGcTotals {
  return {
    totalCount: 0,
    totalBytes: 0,
    referencedCount: 0,
    referencedBytes: 0,
    disconnectedReferencedCount: 0,
    disconnectedReferencedBytes: 0,
    protectedCount: 0,
    protectedBytes: 0,
    orphanCount: 0,
    orphanBytes: 0,
  };
}

function totalsFor(classified: ClassifiedCdnObject[]): CdnGcTotals {
  const total = emptyTotals();
  total.totalCount = classified.length;
  for (const object of classified) {
    total.totalBytes += object.size;
    if (object.status === 'referenced') {
      total.referencedCount += 1;
      total.referencedBytes += object.size;
      if (object.disconnectedReference) {
        total.disconnectedReferencedCount += 1;
        total.disconnectedReferencedBytes += object.size;
      }
    } else if (object.status === 'protected') {
      total.protectedCount += 1;
      total.protectedBytes += object.size;
    } else {
      total.orphanCount += 1;
      total.orphanBytes += object.size;
    }
  }
  return total;
}

function mergeTotals(totals: CdnGcTotals[]): CdnGcTotals {
  const out = emptyTotals();
  for (const item of totals) {
    for (const key of Object.keys(out) as (keyof CdnGcTotals)[]) out[key] += item[key];
  }
  return out;
}

function groupOrphans(orphans: OrphanCdnObject[], field: 'reason' | 'clientId' | 'level'): CdnGcGroup[] {
  const groups = new Map<string, CdnGcGroup>();
  for (const orphan of orphans) {
    const key = String(orphan[field] ?? '(unknown)');
    const group = groups.get(key) ?? { value: key, count: 0, bytes: 0, sampleKeys: [] };
    group.count += 1;
    group.bytes += orphan.size;
    if (group.sampleKeys.length < SAMPLE_LIMIT) group.sampleKeys.push(orphan.key);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.value.localeCompare(b.value));
}

export function buildReport(args: {
  environment: string;
  config: { projectRef: string; publicBucket: string; gatedBucket: string };
  index: CdnReferenceIndex;
  classified: ClassifiedCdnObject[];
  options?: { execute?: boolean; dropDisconnected?: boolean; includeProtected?: string[]; minRows?: number; force?: boolean };
  generatedAt?: string;
}): CdnGcReport {
  const { environment, config, index, classified, options = {}, generatedAt } = args;
  const buckets: CdnGcBucketReport[] = [];
  for (const tier of ['public', 'gated'] as const) {
    const objects = classified.filter(object => object.tier === tier);
    const orphans = objects.filter((object): object is OrphanCdnObject => object.status === 'orphan');
    buckets.push({
      tier,
      bucket: tier === 'public' ? config.publicBucket : config.gatedBucket,
      totals: totalsFor(objects),
      orphanGroups: {
        byReason: groupOrphans(orphans, 'reason'),
        byClient: groupOrphans(orphans, 'clientId'),
        byLevel: groupOrphans(orphans, 'level'),
      },
      objects,
    });
  }
  const totals = mergeTotals(buckets.map(bucket => bucket.totals));
  const orphanFraction = totals.totalCount ? totals.orphanCount / totals.totalCount : 0;
  return {
    schemaVersion: 1,
    environment,
    generatedAt: generatedAt ?? new Date().toISOString(),
    mode: options.execute ? 'execute-preview' : 'dry-run',
    configuration: { projectRef: config.projectRef, publicBucket: config.publicBucket, gatedBucket: config.gatedBucket },
    options: {
      dropDisconnected: Boolean(options.dropDisconnected),
      includeProtected: [...(options.includeProtected ?? [])].sort(),
      minRows: options.minRows ?? DEFAULT_MIN_ROWS,
      force: Boolean(options.force),
    },
    source: {
      assetRows: index.rowCount,
      liveRows: index.liveRows,
      disconnectedRows: index.disconnectedRows,
      includedRows: index.includedRows,
      usableIdentityRows: index.usableIdentityRows,
      warnings: index.warnings,
    },
    references: {
      liveExact: index.live.exact.size,
      liveOriginalPrefixes: index.live.prefixes.size,
      disconnectedExact: index.disconnected.exact.size,
      disconnectedOriginalPrefixes: index.disconnected.prefixes.size,
    },
    writerAudit: WRITER_AUDIT,
    safety: {
      blastRadiusThreshold: BLAST_RADIUS_THRESHOLD,
      orphanFraction,
      blastRadiusExceeded: orphanFraction > BLAST_RADIUS_THRESHOLD,
      forced: Boolean(options.force),
    },
    totals,
    buckets,
  };
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function assertBlastRadius(report: CdnGcReport, { force = false }: { force?: boolean } = {}): void {
  if (report.safety.blastRadiusExceeded && !force) {
    throw new Error(
      `blast-radius abort: ${report.totals.orphanCount}/${report.totals.totalCount} objects ` +
        `(${formatPercent(report.safety.orphanFraction)}) are orphaned, above the ` +
        `${formatPercent(report.safety.blastRadiusThreshold)} gate; inspect the report and pass ` +
        '--force only if that scope is intentional',
    );
  }
}
