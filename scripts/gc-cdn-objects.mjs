#!/usr/bin/env node
/* Standalone, conservative garbage collection for Sotto's two R2 buckets.
 *
 * Dry-run is the default. The script reads every asset row, constructs the complete live reference
 * set through @sotto/domain, lists both buckets, and writes a reviewable report before it considers
 * deletion. `--execute` still requires confirmation (unless `--yes`) and all destructive work is
 * constrained to orphan keys from the two configured buckets.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import readline from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import {
  effectiveLevel,
  pageTarget,
  parseObjectPath,
  storageTarget,
  tierFor,
} from '../packages/domain/src/assetStorage.ts'
import {
  assertBlastRadius as assertSharedBlastRadius,
  assertReferenceSafety as assertSharedReferenceSafety,
  buildReferenceIndex as buildSharedReferenceIndex,
  buildReport as buildSharedReport,
  classifyObjects as classifySharedObjects,
} from '../packages/domain/src/cdnGarbageCollection.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const BLAST_RADIUS_THRESHOLD = 0.6
export const DEFAULT_MIN_ROWS = 10
export const DELETE_BATCH_SIZE = 500
const MAX_PREVIEW_PAGES = 10_000
const SAMPLE_LIMIT = 5
const KINDS = new Set(['thumbnails', 'originals', 'pages'])

/* Every R2 writer was enumerated before fixing this list:
 *
 * - desktop/src/services/pipeline/cdnUpload.ts writes asset thumbnails/originals/pages;
 * - scripts/rekey-gated-objects.mjs and supabase/functions/_shared/r2.ts only copy those assets;
 * - supabase/functions/r2-branding-upload/index.ts is the sole non-asset writer.
 *
 * A new non-asset writer must add its namespace here before it ships. Operators can deliberately
 * include a protected namespace with `--include-protected <name>`.
 */
export const PROTECTED_NAMESPACES = Object.freeze([
  {
    name: 'branding',
    tier: 'public',
    prefix: 'branding/',
    writer: 'supabase/functions/r2-branding-upload/index.ts',
  },
])

const WRITER_AUDIT = Object.freeze([
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
])

function tagged(tier, key) {
  return `${tier}:${key}`
}

function identityKey(clientId, stableId, childId) {
  return `${clientId}\0${stableId}\0${childId}`
}

function addMapSet(map, key, value) {
  const values = map.get(key) ?? new Set()
  values.add(value)
  map.set(key, values)
}

function addReference(target, tier, key) {
  if (key) target.add(tagged(tier, key))
}

function addPrefix(target, tier, prefix) {
  if (prefix) target.add(tagged(tier, prefix))
}

function routeFor(level) {
  return { tier: tierFor(level), level }
}

function integerPageCount(value, rowId) {
  if (value == null) return 0
  const count = Number(value)
  if (!Number.isInteger(count) || count < 0 || count > MAX_PREVIEW_PAGES) {
    throw new Error(
      `asset ${rowId ?? '(unknown)'} has unsafe preview_page_count=${String(value)} ` +
        `(expected an integer from 0 to ${MAX_PREVIEW_PAGES})`,
    )
  }
  return count
}

function decodePathname(pathname) {
  try {
    return decodeURIComponent(pathname).replace(/^\/+/, '')
  } catch {
    return null
  }
}

function domainKey(url, domain) {
  if (!domain) return null
  try {
    const value = new URL(url)
    const base = new URL(domain)
    const basePath = base.pathname.replace(/\/+$/, '')
    if (value.origin !== base.origin) return null
    if (basePath && value.pathname !== basePath && !value.pathname.startsWith(`${basePath}/`)) {
      return null
    }
    return decodePathname(value.pathname.slice(basePath.length))
  } catch {
    return null
  }
}

/** Parse a stored URL or download_key without re-deriving it from row identity. */
export function parseStoredReference(value, domains = {}) {
  if (typeof value !== 'string' || !value.trim()) return null
  const raw = value.trim()

  if (/^https?:\/\//i.test(raw)) {
    const publicKey = domainKey(raw, domains.publicDomain)
    if (publicKey) return { tier: 'public', key: publicKey, source: 'configured-public-domain' }

    const gatedKey = domainKey(raw, domains.gatedDomain)
    if (gatedKey) return { tier: 'gated', key: gatedKey, source: 'configured-gated-domain' }

    let key
    try {
      key = decodePathname(new URL(raw).pathname)
    } catch {
      return { error: `cannot parse stored URL: ${raw}` }
    }
    if (!key) return { error: `stored URL has no object key: ${raw}` }

    /* Old custom domains are still authoritative when their path has a canonical asset shape.
       Stream URLs and unrelated external URLs do not, and are intentionally out of R2 scope. */
    if (parseObjectPath(`/${key}`)) return { tier: 'gated', key, source: 'inferred-old-domain' }
    if (parseObjectPath(`/public/${key}`)) {
      return { tier: 'public', key, source: 'inferred-old-domain' }
    }
    if (/^(thumbnails|originals|pages)\//.test(key)) {
      return { tier: 'public', key, source: 'inferred-legacy-old-domain' }
    }
    if (/^(public|guest|client|internal)\/(thumbnails|originals|pages)\//.test(key)) {
      return { tier: 'gated', key, source: 'inferred-legacy-old-domain' }
    }
    return { outOfScope: true, value: raw }
  }

  const withoutQuery = raw.split(/[?#]/, 1)[0]
  const key = decodePathname(withoutQuery)
  if (!key) return { error: `cannot parse stored object key: ${raw}` }
  const first = key.split('/', 1)[0]
  return {
    tier: first === 'guest' || first === 'client' || first === 'internal' ? 'gated' : 'public',
    key,
    source: 'stored-key',
  }
}

function parseAssetShape(tier, key) {
  const parsed = tier === 'gated' ? parseObjectPath(`/${key}`) : parseObjectPath(`/public/${key}`)
  if (!parsed) return null

  const parts = parsed.rest.split('/')
  const kind = parts[0]
  if (!KINDS.has(kind)) return null

  if (kind === 'thumbnails') {
    if (parts.length !== 3 || !parts[2].endsWith('.webp')) return null
    const childId = parts[2].slice(0, -'.webp'.length)
    if (!parts[1] || !childId) return null
    return {
      level: parsed.level,
      clientId: parsed.clientId,
      kind,
      stableId: parts[1],
      childId,
    }
  }

  if (kind === 'originals') {
    if (parts.length !== 3 || !parts[1] || !parts[2]) return null
    const dot = parts[2].indexOf('.')
    const childId = dot === -1 ? parts[2] : parts[2].slice(0, dot)
    if (!childId) return null
    return {
      level: parsed.level,
      clientId: parsed.clientId,
      kind,
      stableId: parts[1],
      childId,
    }
  }

  if (parts.length !== 4 || !/^\d{3}\.webp$/.test(parts[3])) return null
  if (!parts[1] || !parts[2]) return null
  return {
    level: parsed.level,
    clientId: parsed.clientId,
    kind,
    stableId: parts[1],
    childId: parts[2],
  }
}

function originalExtension(reference, row) {
  if (!reference?.tier || !reference.key) return null
  const shape = parseAssetShape(reference.tier, reference.key)
  if (
    !shape ||
    shape.kind !== 'originals' ||
    shape.clientId !== row.client_id ||
    shape.stableId !== row.stable_id ||
    shape.childId !== row.child_id
  ) {
    return null
  }
  const leaf = reference.key.slice(reference.key.lastIndexOf('/') + 1)
  const extension = leaf.slice(String(row.child_id).length)
  return extension.startsWith('.') && extension.length > 1 ? extension : null
}

function makeReferenceGroup() {
  return { exact: new Set(), prefixes: new Set() }
}

/** Build the safety-critical reference index for every row in public.assets. */
export function buildReferenceIndex(rows, options = {}) {
  const { dropDisconnected = false, publicDomain = '', gatedDomain = '' } = options
  if (!Array.isArray(rows)) throw new Error('assets query did not return an array')

  const live = makeReferenceGroup()
  const disconnected = makeReferenceGroup()
  const liveLocations = new Map()
  const disconnectedIdentities = new Set()
  const warnings = []
  let liveRows = 0
  let disconnectedRows = 0
  let includedRows = 0
  let usableIdentityRows = 0

  for (const row of rows) {
    const isDisconnected = row.status === 'disconnected'
    if (isDisconnected) disconnectedRows += 1
    else liveRows += 1

    const target = isDisconnected ? disconnected : live
    const include = !isDisconnected || !dropDisconnected
    if (include) includedRows += 1

    const stored = []
    for (const column of ['thumbnail_url', 'download_url', 'download_key']) {
      const parsed = parseStoredReference(row[column], { publicDomain, gatedDomain })
      if (!parsed) continue
      if (parsed.error) throw new Error(`asset ${row.id ?? '(unknown)'} ${column}: ${parsed.error}`)
      if (parsed.outOfScope) {
        warnings.push({
          rowId: row.id ?? null,
          column,
          value: parsed.value,
          reason: 'not-an-r2-key',
        })
        continue
      }
      stored.push(parsed)
      if (include) addReference(target.exact, parsed.tier, parsed.key)
    }

    if (!row.client_id || !row.stable_id || !row.child_id) {
      if (include) {
        warnings.push({
          rowId: row.id ?? null,
          reason: 'missing-identity',
          clientId: row.client_id ?? null,
          stableId: row.stable_id ?? null,
          childId: row.child_id ?? null,
        })
      }
      continue
    }

    const identity = identityKey(row.client_id, row.stable_id, row.child_id)
    if (isDisconnected) disconnectedIdentities.add(identity)
    if (!include) continue
    usableIdentityRows += 1

    const level = effectiveLevel(row)
    const route = routeFor(level)
    if (!isDisconnected) addMapSet(liveLocations, identity, `${route.tier}:${level}`)

    const thumbnail = storageTarget(
      level,
      row.client_id,
      'thumbnails',
      row.stable_id,
      row.child_id,
      '.webp',
    )
    addReference(target.exact, thumbnail.tier, thumbnail.key)

    const extensions = new Set(
      stored.map(reference => originalExtension(reference, row)).filter(Boolean),
    )
    if (extensions.size) {
      for (const extension of extensions) {
        const original = storageTarget(
          level,
          row.client_id,
          'originals',
          row.stable_id,
          row.child_id,
          extension,
        )
        addReference(target.exact, original.tier, original.key)
      }
    } else {
      const extensionless = storageTarget(
        level,
        row.client_id,
        'originals',
        row.stable_id,
        row.child_id,
      )
      addReference(target.exact, extensionless.tier, extensionless.key)
      addPrefix(target.prefixes, extensionless.tier, `${extensionless.key}.`)
    }

    const pageCount = integerPageCount(row.preview_page_count, row.id)
    for (let page = 1; page <= pageCount; page += 1) {
      const targetPage = pageTarget(level, row.client_id, row.stable_id, row.child_id, page)
      addReference(target.exact, targetPage.tier, targetPage.key)
    }
  }

  const toPrefixLists = group => ({
    public: [...group.prefixes]
      .filter(value => value.startsWith('public:'))
      .map(value => value.slice('public:'.length))
      .sort(),
    gated: [...group.prefixes]
      .filter(value => value.startsWith('gated:'))
      .map(value => value.slice('gated:'.length))
      .sort(),
  })

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
  }
}

export function assertReferenceSafety(index, { minRows = DEFAULT_MIN_ROWS } = {}) {
  if (!Number.isInteger(minRows) || minRows < 1) {
    throw new Error('--min-rows must be an integer of at least 1')
  }
  if (index.rowCount === 0) {
    throw new Error('reference safety abort: Supabase returned zero asset rows')
  }
  if (index.rowCount < minRows) {
    throw new Error(
      `reference safety abort: Supabase returned ${index.rowCount} rows, below the sane floor ` +
        `of ${minRows}; verify the environment or pass an intentional --min-rows override`,
    )
  }
  if (index.includedRows === 0) {
    throw new Error('reference safety abort: no rows remain in the reference set')
  }
  if (index.usableIdentityRows === 0) {
    throw new Error(
      'reference safety abort: no included row has a usable client/stable/child identity',
    )
  }
  const expectedIdentityRows = Math.max(1, Math.ceil(index.includedRows * 0.8))
  if (index.usableIdentityRows < expectedIdentityRows) {
    throw new Error(
      `reference safety abort: only ${index.usableIdentityRows}/${index.includedRows} included rows ` +
        'have usable identity (below the 80% sanity floor)',
    )
  }

  const referenceCount =
    index.live.exact.size +
    index.live.prefixes.size +
    index.disconnected.exact.size +
    index.disconnected.prefixes.size
  if (referenceCount === 0) {
    throw new Error('reference safety abort: the computed R2 reference set is empty')
  }
}

function findMatchingPrefix(sortedPrefixes, key) {
  let low = 0
  let high = sortedPrefixes.length - 1
  let candidate = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (sortedPrefixes[mid] <= key) {
      candidate = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return candidate >= 0 && key.startsWith(sortedPrefixes[candidate])
    ? sortedPrefixes[candidate]
    : null
}

function referenceType(index, tier, key) {
  const value = tagged(tier, key)
  if (index.live.exact.has(value)) return 'live-stored-or-derived'
  if (findMatchingPrefix(index.livePrefixLists[tier], key)) return 'live-original-prefix'
  if (index.disconnected.exact.has(value)) return 'disconnected-stored-or-derived'
  if (findMatchingPrefix(index.disconnectedPrefixLists[tier], key)) {
    return 'disconnected-original-prefix'
  }
  return null
}

function protectedNamespace(tier, key, includedProtected) {
  return (
    PROTECTED_NAMESPACES.find(
      namespace =>
        namespace.tier === tier &&
        key.startsWith(namespace.prefix) &&
        !includedProtected.has(namespace.name),
    ) ?? null
  )
}

function legacyNoClient(tier, key) {
  if (/^(thumbnails|originals|pages)\//.test(key)) return true
  return (
    tier === 'gated' && /^(public|guest|client|internal)\/(thumbnails|originals|pages)\//.test(key)
  )
}

function namespaceClient(key) {
  const parts = key.split('/')
  return parts.length > 1 ? parts[1] : null
}

/** Classify a complete, already-listed bucket inventory. */
export function classifyObjects(objects, index, options = {}) {
  const includedProtected = new Set(options.includeProtected ?? [])
  const unknownProtected = [...includedProtected].filter(
    name => !PROTECTED_NAMESPACES.some(namespace => namespace.name === name),
  )
  if (unknownProtected.length) {
    throw new Error(`unknown protected namespace: ${unknownProtected.join(', ')}`)
  }

  return objects.map(object => {
    const base = {
      tier: object.tier,
      bucket: object.bucket,
      key: object.key,
      size: Number(object.size) || 0,
      lastModified: object.lastModified ?? null,
    }
    const refType = referenceType(index, object.tier, object.key)
    if (refType) {
      return {
        ...base,
        status: 'referenced',
        referenceType: refType,
        disconnectedReference: refType.startsWith('disconnected-'),
      }
    }

    const namespace = protectedNamespace(object.tier, object.key, includedProtected)
    if (namespace) {
      return {
        ...base,
        status: 'protected',
        namespace: namespace.name,
        clientId: namespaceClient(object.key),
      }
    }

    if (legacyNoClient(object.tier, object.key)) {
      return {
        ...base,
        status: 'orphan',
        reason: 'legacy-no-client',
        clientId: '(legacy-no-client)',
        level: object.tier === 'public' ? 'public' : object.key.split('/', 1)[0],
      }
    }

    const shape = parseAssetShape(object.tier, object.key)
    if (!shape) {
      const optedInNamespace = PROTECTED_NAMESPACES.find(
        item => item.tier === object.tier && object.key.startsWith(item.prefix),
      )
      return {
        ...base,
        status: 'orphan',
        reason: 'unknown-shape',
        namespace: optedInNamespace?.name ?? null,
        clientId: optedInNamespace ? namespaceClient(object.key) : '(unknown)',
        level: object.tier === 'public' ? 'public' : '(unknown)',
      }
    }

    const identity = identityKey(shape.clientId, shape.stableId, shape.childId)
    const locations = index.liveLocations.get(identity)
    const fromDisconnected = index.disconnectedIdentities.has(identity)
    if (!locations?.size) {
      return {
        ...base,
        ...shape,
        status: 'orphan',
        reason: 'no-matching-row',
        fromDisconnected,
      }
    }

    const location = `${object.tier}:${shape.level}`
    return {
      ...base,
      ...shape,
      status: 'orphan',
      reason: locations.has(location) ? 'unreferenced-current-copy' : 'old-level-copy',
      fromDisconnected,
    }
  })
}

function totalsFor(classified) {
  const total = {
    totalCount: classified.length,
    totalBytes: 0,
    referencedCount: 0,
    referencedBytes: 0,
    disconnectedReferencedCount: 0,
    disconnectedReferencedBytes: 0,
    protectedCount: 0,
    protectedBytes: 0,
    orphanCount: 0,
    orphanBytes: 0,
  }
  for (const object of classified) {
    total.totalBytes += object.size
    if (object.status === 'referenced') {
      total.referencedCount += 1
      total.referencedBytes += object.size
      if (object.disconnectedReference) {
        total.disconnectedReferencedCount += 1
        total.disconnectedReferencedBytes += object.size
      }
    } else if (object.status === 'protected') {
      total.protectedCount += 1
      total.protectedBytes += object.size
    } else {
      total.orphanCount += 1
      total.orphanBytes += object.size
    }
  }
  return total
}

function mergeTotals(totals) {
  return totals.reduce((out, item) => {
    for (const [key, value] of Object.entries(item)) out[key] = (out[key] ?? 0) + value
    return out
  }, {})
}

function groupOrphans(orphans, field) {
  const groups = new Map()
  for (const orphan of orphans) {
    const key = String(orphan[field] ?? '(unknown)')
    const group = groups.get(key) ?? { value: key, count: 0, bytes: 0, sampleKeys: [] }
    group.count += 1
    group.bytes += orphan.size
    if (group.sampleKeys.length < SAMPLE_LIMIT) group.sampleKeys.push(orphan.key)
    groups.set(key, group)
  }
  return [...groups.values()].sort((a, b) => b.bytes - a.bytes || a.value.localeCompare(b.value))
}

export function buildReport({ environment, config, index, classified, options = {}, generatedAt }) {
  const buckets = []
  for (const tier of ['public', 'gated']) {
    const objects = classified.filter(object => object.tier === tier)
    const orphans = objects.filter(object => object.status === 'orphan')
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
    })
  }
  const totals = mergeTotals(buckets.map(bucket => bucket.totals))
  const orphanFraction = totals.totalCount ? totals.orphanCount / totals.totalCount : 0
  return {
    schemaVersion: 1,
    environment,
    generatedAt: generatedAt ?? new Date().toISOString(),
    mode: options.execute ? 'execute-preview' : 'dry-run',
    configuration: {
      projectRef: config.projectRef,
      publicBucket: config.publicBucket,
      gatedBucket: config.gatedBucket,
    },
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
  }
}

export function assertBlastRadius(report, { force = false } = {}) {
  if (report.safety.blastRadiusExceeded && !force) {
    throw new Error(
      `blast-radius abort: ${report.totals.orphanCount}/${report.totals.totalCount} objects ` +
        `(${formatPercent(report.safety.orphanFraction)}) are orphaned, above the ` +
        `${formatPercent(report.safety.blastRadiusThreshold)} gate; inspect the report and pass ` +
        '--force only if that scope is intentional',
    )
  }
}

/** Delete only pre-classified orphan objects; re-running naturally skips keys already removed. */
export async function deleteOrphans(
  classified,
  { deleteBatch, onDeleted, batchSize = DELETE_BATCH_SIZE },
) {
  if (typeof deleteBatch !== 'function') throw new Error('deleteBatch callback is required')
  const orphans = classified.filter(object => object.status === 'orphan')
  if (orphans.some(object => !object.bucket || !object.key)) {
    throw new Error('refusing a deletion plan containing an object without a bucket/key')
  }

  let deleted = 0
  let deletedBytes = 0
  for (const tier of ['public', 'gated']) {
    const tierOrphans = orphans.filter(object => object.tier === tier)
    for (let offset = 0; offset < tierOrphans.length; offset += batchSize) {
      const batch = tierOrphans.slice(offset, offset + batchSize)
      const batchResult = await deleteBatch(batch)
      const confirmedKeys = new Set(
        Array.isArray(batchResult) ? batchResult : batchResult.deletedKeys,
      )
      const requestedKeys = new Set(batch.map(object => object.key))
      const unexpected = [...confirmedKeys].filter(key => !requestedKeys.has(key))
      if (unexpected.length) {
        throw new Error(`delete callback confirmed unexpected keys: ${unexpected.join(', ')}`)
      }
      for (const object of batch) {
        if (!confirmedKeys.has(object.key)) continue
        deleted += 1
        deletedBytes += object.size
        if (onDeleted) await onDeleted(object)
      }
      if (!Array.isArray(batchResult) && batchResult.failures?.length) {
        throw new Error(
          'R2 batch delete partially failed after confirmed deletions were audited: ' +
            batchResult.failures
              .map(item => `${item.key} (${item.code}: ${item.message})`)
              .join(', '),
        )
      }
    }
  }
  return { deleted, deletedBytes, planned: orphans.length }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return String(bytes)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`
}

function humanSummary(report) {
  const lines = [
    `Sotto CDN garbage collection — ${report.environment}`,
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    '',
    `Assets: ${report.source.assetRows} total · ${report.source.liveRows} live · ` +
      `${report.source.disconnectedRows} disconnected`,
    `Objects: ${report.totals.totalCount} (${formatBytes(report.totals.totalBytes)})`,
    `Referenced: ${report.totals.referencedCount} (${formatBytes(report.totals.referencedBytes)})`,
    `  disconnected-row references: ${report.totals.disconnectedReferencedCount} ` +
      `(${formatBytes(report.totals.disconnectedReferencedBytes)})`,
    `Protected namespaces: ${report.totals.protectedCount} (${formatBytes(report.totals.protectedBytes)})`,
    `Orphans: ${report.totals.orphanCount} (${formatBytes(report.totals.orphanBytes)}) · ` +
      `${formatPercent(report.safety.orphanFraction)} of objects`,
    `Blast-radius gate: ${report.safety.blastRadiusExceeded ? 'EXCEEDED' : 'ok'} ` +
      `(limit ${formatPercent(report.safety.blastRadiusThreshold)})`,
  ]

  for (const bucket of report.buckets) {
    lines.push(
      '',
      `${bucket.tier.toUpperCase()} — ${bucket.bucket}`,
      `  total ${bucket.totals.totalCount} / ${formatBytes(bucket.totals.totalBytes)}`,
      `  referenced ${bucket.totals.referencedCount} / ${formatBytes(bucket.totals.referencedBytes)}`,
      `  protected ${bucket.totals.protectedCount} / ${formatBytes(bucket.totals.protectedBytes)}`,
      `  orphan ${bucket.totals.orphanCount} / ${formatBytes(bucket.totals.orphanBytes)}`,
    )
    for (const [label, groups] of [
      ['reason', bucket.orphanGroups.byReason],
      ['client', bucket.orphanGroups.byClient],
      ['level', bucket.orphanGroups.byLevel],
    ]) {
      lines.push(`  by ${label}:`)
      if (!groups.length) lines.push('    (none)')
      for (const group of groups) {
        lines.push(`    ${group.value}: ${group.count} / ${formatBytes(group.bytes)}`)
        for (const key of group.sampleKeys) lines.push(`      - ${key}`)
      }
    }
  }

  if (report.source.warnings.length) {
    lines.push(
      '',
      `Reference warnings: ${report.source.warnings.length} (full detail in JSON report)`,
    )
  }
  lines.push('')
  return `${lines.join('\n')}\n`
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {}
  const values = {}
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const equals = line.indexOf('=')
    if (equals === -1) continue
    const key = line.slice(0, equals).trim()
    let value = line.slice(equals + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values[key] = value
  }
  return values
}

function loadEnvironment(environment) {
  const publicFile = path.join(root, 'scripts/environments', `${environment}.public.env`)
  const secretFile = path.join(root, 'scripts/environments', `${environment}.env`)
  const env = {
    ...readEnvFile(publicFile),
    ...readEnvFile(secretFile),
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => value !== undefined && value !== ''),
    ),
  }
  env.CF_R2_TOKEN ??= env.CF_API_TOKEN

  const required = [
    'PROJECT_REF',
    'SUPABASE_SERVICE_KEY',
    'R2_BUCKET',
    'R2_PUBLIC_DOMAIN',
    'R2_GATED_BUCKET',
    'R2_GATED_DOMAIN',
    'CF_R2_TOKEN',
    'CF_ACCOUNT_ID',
    'R2_PARENT_ACCESS_KEY_ID',
  ]
  const missing = required.filter(key => !env[key] || /^(PASTE_|your-)/i.test(String(env[key])))
  if (missing.length) {
    throw new Error(
      `missing for ${environment}: ${missing.join(', ')}\n` +
        `Expected non-secrets in ${path.relative(root, publicFile)} and secrets in ` +
        `${path.relative(root, secretFile)} or the process environment.`,
    )
  }
  if (env.R2_BUCKET === env.R2_GATED_BUCKET) {
    throw new Error('public and gated bucket names are identical; refusing ambiguous scope')
  }
  return env
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

export function parseArgs(argv) {
  const options = {
    environment: null,
    execute: false,
    yes: false,
    force: false,
    dropDisconnected: false,
    includeProtected: [],
    minRows: DEFAULT_MIN_ROWS,
    help: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--env') options.environment = valueAfter(argv, index++, arg)
    else if (arg === '--execute') options.execute = true
    else if (arg === '--yes') options.yes = true
    else if (arg === '--force') options.force = true
    else if (arg === '--drop-disconnected') options.dropDisconnected = true
    else if (arg === '--include-protected') {
      options.includeProtected.push(
        ...valueAfter(argv, index++, arg)
          .split(',')
          .map(value => value.trim())
          .filter(Boolean),
      )
    } else if (arg === '--min-rows') {
      options.minRows = Number(valueAfter(argv, index++, arg))
    } else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  options.includeProtected = [...new Set(options.includeProtected)]
  if (!options.help && !['dev', 'staging', 'production'].includes(options.environment)) {
    throw new Error('--env is required and must be one of dev, staging, production')
  }
  if (!Number.isInteger(options.minRows) || options.minRows < 1) {
    throw new Error('--min-rows must be an integer of at least 1')
  }
  const knownProtected = new Set(PROTECTED_NAMESPACES.map(namespace => namespace.name))
  const unknown = options.includeProtected.filter(name => !knownProtected.has(name))
  if (unknown.length) throw new Error(`unknown protected namespace: ${unknown.join(', ')}`)
  return options
}

function usage() {
  return `Usage:
  node scripts/gc-cdn-objects.mjs --env <dev|staging|production> [flags]

Dry-run is the default. Flags:
  --execute                    delete candidates after the report and confirmation
  --yes                        skip interactive confirmations (including production)
  --force                      override the >60% blast-radius gate
  --drop-disconnected          stop protecting disconnected-row references
  --include-protected <name>   include a protected namespace (currently: branding)
  --min-rows <count>           intentional asset-row floor override (default: 10)
  --help                       show this help
`
}

async function retryFetch(url, init, attempts = 4) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, init)
      if (response.status !== 429 && response.status < 500) return response
      if (attempt === attempts) return response
      await response.arrayBuffer().catch(() => null)
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(30_000, retryAfter * 1000)
          : Math.min(30_000, 750 * 2 ** (attempt - 1))
      await new Promise(resolve => setTimeout(resolve, delay))
    } catch (error) {
      lastError = error
      if (attempt === attempts) break
      await new Promise(resolve => setTimeout(resolve, 750 * 2 ** (attempt - 1)))
    }
  }
  throw lastError
}

async function fetchAssets(env) {
  const select = [
    'id',
    'client_id',
    'stable_id',
    'child_id',
    'perm',
    'status',
    'thumbnail_url',
    'download_url',
    'download_key',
    'preview_page_count',
  ].join(',')
  const rest = `https://${env.PROJECT_REF}.supabase.co/rest/v1`
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    Prefer: 'count=exact',
  }
  const rows = []
  let exactCount = null
  for (let offset = 0; ; offset += 1000) {
    const response = await retryFetch(
      `${rest}/assets?select=${select}&order=id.asc&limit=1000&offset=${offset}`,
      { headers },
    )
    if (!response.ok) {
      throw new Error(`Supabase assets read failed: ${response.status} ${await response.text()}`)
    }
    const contentRange = response.headers.get('content-range')
    const declared = contentRange?.match(/\/(\d+)$/)?.[1]
    if (declared) exactCount = Number(declared)
    const page = await response.json()
    if (!Array.isArray(page)) throw new Error('Supabase assets read returned a non-array response')
    rows.push(...page)
    if (page.length < 1000) break
  }
  if (exactCount != null && exactCount !== rows.length) {
    throw new Error(
      `Supabase assets changed during pagination (${rows.length} rows read, count says ${exactCount}); rerun`,
    )
  }
  if (new Set(rows.map(row => row.id)).size !== rows.length) {
    throw new Error(
      'Supabase assets pagination returned duplicate row ids; refusing an incomplete snapshot',
    )
  }
  return rows
}

const sha256hex = value => crypto.createHash('sha256').update(value).digest('hex')
const hmac = (key, value) => crypto.createHmac('sha256', key).update(value).digest()
const rfc3986 = value =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )

function parentR2Credentials(env) {
  /* For API-created R2 tokens, Cloudflare defines the S3 secret access key as SHA-256(token value).
     This uses the parent credential because this standalone tool needs ListObjectsV2 across the
     bucket. It is never logged, written to a report, or passed to another process. */
  return {
    accessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
    secretAccessKey: sha256hex(env.CF_R2_TOKEN),
  }
}

async function s3Request(env, credentials, method, bucket, key = '', options = {}) {
  const body = options.body == null ? null : Buffer.from(options.body)
  const query = options.query ?? {}
  const host = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`
  const canonicalUri = `/${rfc3986(bucket)}/${key.split('/').map(rfc3986).join('/')}`
  const canonicalQuery = Object.keys(query)
    .sort()
    .map(name => `${rfc3986(name)}=${rfc3986(String(query[name]))}`)
    .join('&')

  let lastError
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
    const dateStamp = amzDate.slice(0, 8)
    const payloadHash = sha256hex(body ?? Buffer.alloc(0))
    const headers = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
      ),
    }
    if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
    const signedNames = Object.keys(headers).sort()
    const canonicalHeaders = signedNames
      .map(name => `${name}:${String(headers[name]).trim().replace(/\s+/g, ' ')}\n`)
      .join('')
    const signedHeaders = signedNames.join(';')
    const canonical = [
      method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${dateStamp}/auto/s3/aws4_request`
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonical))].join(
      '\n',
    )
    const dateKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp)
    const signature = hmac(
      hmac(hmac(hmac(dateKey, 'auto'), 's3'), 'aws4_request'),
      toSign,
    ).toString('hex')
    headers.Authorization =
      `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`

    try {
      const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`
      const response = await fetch(url, { method, headers, body: body ?? undefined })
      if (response.status !== 429 && response.status < 500) return response
      if (attempt === 6) return response
      await response.arrayBuffer().catch(() => null)
      const retryAfter = Number(response.headers.get('retry-after'))
      const delay =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(30_000, retryAfter * 1000)
          : Math.min(30_000, 750 * 2 ** (attempt - 1))
      console.warn(`  R2 ${response.status}; retrying ${bucket} in ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    } catch (error) {
      lastError = error
      if (attempt === 6) break
      const delay = Math.min(30_000, 750 * 2 ** (attempt - 1))
      console.warn(`  R2 network error; retrying ${bucket} in ${delay}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw lastError
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function xmlValue(xml, name) {
  return xml.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1] ?? null
}

async function listBucket(env, credentials, tier, bucket, onPage) {
  const objects = []
  let token
  let pageNumber = 0
  do {
    const query = {
      'list-type': '2',
      'max-keys': '1000',
      ...(token ? { 'continuation-token': token } : {}),
    }
    const response = await s3Request(env, credentials, 'GET', bucket, '', { query })
    if (!response.ok) {
      throw new Error(`R2 LIST ${bucket} failed: ${response.status} ${await response.text()}`)
    }
    const xml = await response.text()
    const pageStart = objects.length
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = xmlValue(match[1], 'Key')
      const size = Number(xmlValue(match[1], 'Size'))
      if (key == null || !Number.isFinite(size) || size < 0) {
        throw new Error(`R2 LIST ${bucket} returned an object without a valid key/size`)
      }
      objects.push({
        tier,
        bucket,
        key: decodeXml(key),
        size,
        lastModified: xmlValue(match[1], 'LastModified'),
      })
    }
    const rawKeyCount = xmlValue(xml, 'KeyCount')
    const declaredKeyCount = rawKeyCount == null ? null : Number(rawKeyCount)
    const parsedKeyCount = objects.length - pageStart
    if (
      declaredKeyCount != null &&
      Number.isFinite(declaredKeyCount) &&
      declaredKeyCount !== parsedKeyCount
    ) {
      throw new Error(
        `R2 LIST ${bucket} declared ${declaredKeyCount} keys but ${parsedKeyCount} were parsed`,
      )
    }
    pageNumber += 1
    if (onPage) onPage({ tier, bucket, pageNumber, objectCount: objects.length })
    const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
    const next = xmlValue(xml, 'NextContinuationToken')
    if (truncated && !next) {
      throw new Error(`R2 LIST ${bucket} was truncated without a continuation token`)
    }
    token = truncated ? decodeXml(next) : undefined
  } while (token)
  return objects
}

function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

async function deleteR2Batch(env, credentials, bucket, batch) {
  const body = Buffer.from(
    `<Delete>${batch.map(object => `<Object><Key>${escapeXml(object.key)}</Key></Object>`).join('')}` +
      '<Quiet>false</Quiet></Delete>',
  )
  const response = await s3Request(env, credentials, 'POST', bucket, '', {
    query: { delete: '' },
    body,
    headers: {
      'content-md5': crypto.createHash('md5').update(body).digest('base64'),
      'content-type': 'application/xml',
    },
  })
  const xml = await response.text()
  if (!response.ok) throw new Error(`R2 batch delete ${bucket} failed: ${response.status} ${xml}`)

  const failures = [...xml.matchAll(/<Error>([\s\S]*?)<\/Error>/g)].map(match => ({
    key: decodeXml(xmlValue(match[1], 'Key') ?? '(unknown)'),
    code: xmlValue(match[1], 'Code') ?? 'Unknown',
    message: xmlValue(match[1], 'Message') ?? '',
  }))
  const deletedKeys = [...xml.matchAll(/<Deleted>([\s\S]*?)<\/Deleted>/g)]
    .map(match => xmlValue(match[1], 'Key'))
    .filter(key => key != null)
    .map(decodeXml)
  /* R2 normally returns one <Deleted> per key when Quiet=false. If it returns an empty successful
     body, the request itself is still the confirmation. A partially populated response is not. */
  if (!deletedKeys.length && !failures.length) {
    return { deletedKeys: batch.map(item => item.key), failures }
  }
  const accountedFor = new Set([...deletedKeys, ...failures.map(item => item.key)])
  for (const object of batch) {
    if (!accountedFor.has(object.key)) {
      failures.push({
        key: object.key,
        code: 'Unconfirmed',
        message: 'key missing from DeleteObjects response',
      })
    }
  }
  return { deletedKeys, failures }
}

function safeTimestamp(iso) {
  return iso.replace(/[:.]/g, '-')
}

async function atomicWrite(file, data) {
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, data)
  await rename(temporary, file)
}

async function writeReports(report) {
  const directory = path.join(root, 'reports/cdn-gc')
  await mkdir(directory, { recursive: true })
  const base = `${safeTimestamp(report.generatedAt)}-${report.environment}-${report.mode}`
  const jsonPath = path.join(directory, `${base}.json`)
  const summaryPath = path.join(directory, `${base}.txt`)
  await atomicWrite(jsonPath, `${JSON.stringify(report, null, 2)}\n`)
  await atomicWrite(summaryPath, humanSummary(report))
  return { jsonPath, summaryPath, directory, base }
}

function relative(file) {
  return path.relative(root, file)
}

function fingerprintRows(rows) {
  const stable = [...rows]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map(row => [
      row.id,
      row.client_id,
      row.stable_id,
      row.child_id,
      row.perm,
      row.status,
      row.thumbnail_url,
      row.download_url,
      row.download_key,
      row.preview_page_count,
    ])
  return sha256hex(JSON.stringify(stable))
}

async function confirmExecution(report, options) {
  if (options.yes) {
    console.log('  --yes supplied: interactive confirmations bypassed')
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('--execute needs an interactive terminal or an explicit --yes')
  }
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const expected = `DELETE ${report.totals.orphanCount} OBJECTS`
    const first = await prompt.question(
      `\nType "${expected}" to reclaim ${formatBytes(report.totals.orphanBytes)}: `,
    )
    if (first !== expected) throw new Error('confirmation did not match; nothing deleted')
    if (options.environment === 'production') {
      const second = await prompt.question('Production confirmation — type "production": ')
      if (second !== 'production')
        throw new Error('production confirmation did not match; nothing deleted')
    }
  } finally {
    prompt.close()
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const env = loadEnvironment(options.environment)
  const config = {
    projectRef: env.PROJECT_REF,
    publicBucket: env.R2_BUCKET,
    gatedBucket: env.R2_GATED_BUCKET,
  }
  console.log(`\nSotto CDN garbage collection — ${options.environment}`)
  console.log(`  mode: ${options.execute ? 'EXECUTE (preview and confirmation first)' : 'DRY RUN'}`)
  console.log(`  public: ${config.publicBucket}`)
  console.log(`  gated:  ${config.gatedBucket}`)
  console.log('  reading all asset rows…')

  const rows = await fetchAssets(env)
  const initialFingerprint = fingerprintRows(rows)
  const index = buildSharedReferenceIndex(rows, {
    dropDisconnected: options.dropDisconnected,
    publicDomain: env.R2_PUBLIC_DOMAIN,
    gatedDomain: env.R2_GATED_DOMAIN,
  })
  assertSharedReferenceSafety(index, { minRows: options.minRows })
  console.log(
    `  references: ${index.live.exact.size + index.live.prefixes.size} live · ` +
      `${index.disconnected.exact.size + index.disconnected.prefixes.size} disconnected`,
  )

  const credentials = parentR2Credentials(env)
  console.log('  listing both R2 buckets…')
  const inventories = await Promise.all([
    listBucket(env, credentials, 'public', config.publicBucket, page => {
      console.log(`  public LIST page ${page.pageNumber}: ${page.objectCount} objects`)
    }),
    listBucket(env, credentials, 'gated', config.gatedBucket, page => {
      console.log(`  gated LIST page ${page.pageNumber}: ${page.objectCount} objects`)
    }),
  ])
  const classified = classifySharedObjects(inventories.flat(), index, {
    includeProtected: options.includeProtected,
  })
  const report = buildSharedReport({
    environment: options.environment,
    config,
    index,
    classified,
    options,
  })
  const paths = await writeReports(report)
  console.log(`\n${humanSummary(report)}`)
  console.log(`  JSON report:    ${relative(paths.jsonPath)}`)
  console.log(`  Human summary:  ${relative(paths.summaryPath)}`)

  try {
    assertSharedBlastRadius(report, { force: options.force })
  } catch (error) {
    console.error(`\n  ${error.message}`)
    console.error('  The report was written; no objects were deleted.\n')
    throw error
  }

  if (!options.execute) {
    console.log('\n  Dry run complete. Nothing changed. Review the report, then add --execute.\n')
    return
  }

  await confirmExecution(report, options)

  /* A level/status/URL change while a large bucket was being listed can turn a candidate live.
     Re-read immediately before deletion and require the exact reviewed row snapshot. */
  console.log('  rechecking asset rows before deletion…')
  const currentRows = await fetchAssets(env)
  if (fingerprintRows(currentRows) !== initialFingerprint) {
    throw new Error(
      'asset rows changed after the preview; refusing deletion — rerun for a fresh report',
    )
  }

  const auditPath = path.join(paths.directory, `${paths.base}.audit.jsonl`)
  await appendFile(
    auditPath,
    `${JSON.stringify({
      event: 'start',
      startedAt: new Date().toISOString(),
      environment: options.environment,
      report: relative(paths.jsonPath),
      plannedCount: report.totals.orphanCount,
      plannedBytes: report.totals.orphanBytes,
    })}\n`,
  )
  console.log(`  audit manifest: ${relative(auditPath)}`)

  const result = await deleteOrphans(classified, {
    deleteBatch: async batch => {
      const bucket = batch[0]?.bucket
      if (!bucket || ![config.publicBucket, config.gatedBucket].includes(bucket)) {
        throw new Error(`refusing deletion outside configured buckets: ${String(bucket)}`)
      }
      if (batch.some(object => object.bucket !== bucket || object.status !== 'orphan')) {
        throw new Error('refusing a mixed or non-orphan deletion batch')
      }
      const keys = await deleteR2Batch(env, credentials, bucket, batch)
      console.log(`  deleted batch: ${bucket} · ${keys.length} objects`)
      return keys
    },
    onDeleted: object =>
      appendFile(
        auditPath,
        `${JSON.stringify({
          event: 'deleted',
          deletedAt: new Date().toISOString(),
          bucket: object.bucket,
          tier: object.tier,
          key: object.key,
          size: object.size,
          reason: object.reason,
        })}\n`,
      ),
  })
  await appendFile(
    auditPath,
    `${JSON.stringify({ event: 'complete', completedAt: new Date().toISOString(), ...result })}\n`,
  )
  console.log(
    `\n  Complete: deleted ${result.deleted}/${result.planned} objects ` +
      `(${formatBytes(result.deletedBytes)}).\n`,
  )
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirect) {
  main().catch(error => {
    console.error(`\nFAILED: ${error.message}\n`)
    process.exitCode = 1
  })
}
