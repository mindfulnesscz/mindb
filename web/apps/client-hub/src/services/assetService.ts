import { supabase } from '../lib/supabase'
import type { Asset, FilterState, Role, AssetStatus, AssetPerm } from '@dc-hub/asset-library'
import type { AssetRow, AssetStats } from '../lib/database.types'

type AssetRowWithStats = AssetRow & { stats: AssetStats | AssetStats[] | null }

function extractStats(raw: AssetStats | AssetStats[] | null): AssetStats | null {
  if (!raw) return null
  return Array.isArray(raw) ? (raw[0] ?? null) : raw
}

// Handles text[] (JS array from PostgREST), JSON-encoded strings, and PG array literals {a,b}
function coerceArray(val: unknown): string[] {
  if (!val) return []
  if (Array.isArray(val)) return (val as unknown[]).map(String).filter(Boolean)
  if (typeof val === 'string') {
    if (!val) return []
    if (val.startsWith('[')) {
      try { const p = JSON.parse(val); return Array.isArray(p) ? p.map(String).filter(Boolean) : [] }
      catch { /* fall through */ }
    }
    if (val.startsWith('{') && val.endsWith('}')) {
      return val.slice(1, -1).split(',').map(s => s.replace(/^"|"$/g, '').trim()).filter(Boolean)
    }
    return [val]
  }
  return []
}

function toAsset(row: AssetRowWithStats): Asset {
  const stats = extractStats(row.stats)
  const parsedEntities = coerceArray(row.entities)
  const parsedAngles   = coerceArray(row.angles)
  return {
    id: row.id,
    clientId: row.client_id,
    name: row.name,
    entityType: 'product',              // entity_type column was dropped; kept for type compat
    entity:  parsedEntities[0] ?? '',
    formats: coerceArray(row.formats),
    angle:   parsedAngles[0] ?? '',
    entities: parsedEntities,
    angles:   parsedAngles,
    tagsAll:  coerceArray(row.tags),
    parentId: row.parent_id ?? null,
    childCount: 0,                      // enriched after fetch
    variantOf: row.variant_of ?? null,
    status: row.status as AssetStatus,
    perm: row.perm as AssetPerm,
    version: row.version,
    latest: row.latest,
    avg: Number(stats?.avg_rating ?? 0),
    count: stats?.rating_count ?? 0,
    comments: stats?.comment_count ?? 0,
    approval: 'none',
    thumbnailUrl: row.thumbnail_url ? encodeURI(row.thumbnail_url) : undefined,
    downloadUrl: row.download_url ? encodeURI(row.download_url) : undefined,
    downloadUrls: parseDownloadUrls(row.download_urls),
    stableId: row.stable_id ?? null,
    updatedAt: row.updated_at,
  }
}

/** Entity → angle → format labels for pills, deduped (same label in two dimensions once). */
export function assetFacetLabels(asset: Asset): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const push = (labels: string[]) => {
    for (const raw of labels) {
      const label = raw.trim()
      if (!label || seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
  }
  push(asset.entities?.length ? asset.entities : [asset.entity].filter(Boolean))
  push(asset.angles?.length ? asset.angles : [asset.angle].filter(Boolean))
  push(asset.formats ?? [])
  return out
}

function parseDownloadUrls(raw: unknown): Asset['downloadUrls'] {
  if (!Array.isArray(raw)) return []
  return raw
    .map(item => {
      if (!item || typeof item !== 'object') return null
      const o = item as Record<string, unknown>
      const url = typeof o.url === 'string' ? o.url : ''
      if (!url) return null
      return {
        destId: typeof o.destId === 'string' ? o.destId : undefined,
        provider: String(o.provider ?? ''),
        name: String(o.name ?? o.provider ?? 'Cloud'),
        url,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
}

export interface FetchAssetsOptions {
  filters?: Partial<FilterState>
  role?: Role
  clientId?: string
}

async function fetchStatsMap(ids: string[]): Promise<Map<string, AssetStats>> {
  if (!supabase || ids.length === 0) return new Map()
  const { data } = await supabase
    .from('asset_stats' as never)
    .select('id, avg_rating, rating_count, comment_count')
    .in('id', ids)
  const map = new Map<string, AssetStats>()
  for (const row of (data as unknown as AssetStats[] ?? [])) {
    map.set(row.id, row)
  }
  return map
}

export async function fetchAssets(opts: FetchAssetsOptions = {}): Promise<{ assets: Asset[]; allAssets: Asset[] }> {
  if (!supabase) throw new Error('Supabase not configured')

  const { filters = {}, clientId } = opts

  let query = supabase
    .from('assets')
    .select('*')
    .order('updated_at', { ascending: false })

  if (clientId)               query = query.eq('client_id', clientId)
  // Children (legacy parent_id) and variants (folder-based stable identity, Task 3) are
  // both only visible inside the primary's detail view, never as their own top-level card.
  query = query.is('parent_id', null).is('variant_of', null)
  const isStaff = opts.role === 'admin' || opts.role === 'editor'
  if (filters.status?.length) {
    // Explicit status selection — show exactly what was requested
    query = query.in('status', filters.status)
  } else {
    // Default: hide archived always; hide disconnected for non-staff
    query = query.neq('status', 'archived')
    if (!isStaff) query = query.neq('status', 'disconnected')
  }
  if (filters.perms?.length)  query = query.in('perm', filters.perms)
  if (filters.latestOnly)     query = query.eq('latest', true)
  if (filters.search?.trim()) {
    for (const word of filters.search.trim().split(/\s+/).filter(Boolean)) {
      query = query.ilike('name', `%${word}%`)
    }
  }

  const { data, error } = await query
  if (error) throw new Error(error.message)

  const rows = (data as unknown as AssetRow[] ?? [])
  const statsMap = await fetchStatsMap(rows.map(r => r.id))

  let allAssets = rows.map(row => toAsset({ ...row, stats: statsMap.get(row.id) ?? null }))

  // Enrich with child + variant counts (one extra query each, grouped in JS)
  if (allAssets.length > 0) {
    const parentIds = allAssets.map(a => a.id)
    const [{ data: childRows }, { data: variantRows }] = await Promise.all([
      (supabase as any).from('assets').select('parent_id').in('parent_id', parentIds)
        .neq('status', 'archived').neq('status', 'disconnected'),
      (supabase as any).from('assets').select('variant_of').in('variant_of', parentIds)
        .neq('status', 'archived').neq('status', 'disconnected'),
    ])
    const childCounts = new Map<string, number>()
    for (const c of (childRows ?? [])) {
      childCounts.set(c.parent_id, (childCounts.get(c.parent_id) ?? 0) + 1)
    }
    for (const v of (variantRows ?? [])) {
      childCounts.set(v.variant_of, (childCounts.get(v.variant_of) ?? 0) + 1)
    }
    allAssets = allAssets.map(a => ({ ...a, childCount: childCounts.get(a.id) ?? 0 }))
  }

  // Client-side array filters — avoids `&&` operator errors when columns are text not text[]
  let assets = allAssets
  if (filters.entities?.length) {
    // Match against the full entities array (falls back to the singular field for rows that
    // never got one), not just entity[0] — a tag rolled up from a variant may not be first.
    assets = assets.filter(a => filters.entities!.some(e => (a.entities?.length ? a.entities : [a.entity]).includes(e)))
  }
  if (filters.angles?.length) {
    assets = assets.filter(a => filters.angles!.some(g => (a.angles?.length ? a.angles : [a.angle]).includes(g)))
  }
  if (filters.formats?.length) {
    assets = assets.filter(a => filters.formats!.some(f => a.formats.includes(f)))
  }

  return { assets, allAssets }
}

export async function fetchAsset(id: string): Promise<Asset | null> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase
    .from('assets')
    .select('*')
    .eq('id', id)
    .single()

  if (error) return null
  const statsMap = await fetchStatsMap([id])
  return toAsset({ ...(data as unknown as AssetRow), stats: statsMap.get(id) ?? null })
}

export async function fetchChildAssets(parentId: string): Promise<Asset[]> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await (supabase as any)
    .from('assets')
    .select('*')
    .eq('parent_id', parentId)
    .neq('status', 'archived')
    .neq('status', 'disconnected')
    .order('name')
  if (error) throw new Error(error.message)
  return (data as AssetRow[]).map(row => toAsset({ ...row, stats: null }))
}

/** Folder-based stable identity variants (Task 3) — siblings of a primary asset row. */
export async function fetchVariants(primaryId: string): Promise<Asset[]> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await (supabase as any)
    .from('assets')
    .select('*')
    .eq('variant_of', primaryId)
    .neq('status', 'archived')
    .neq('status', 'disconnected')
    .order('name')
  if (error) throw new Error(error.message)
  return (data as AssetRow[]).map(row => toAsset({ ...row, stats: null }))
}

export async function updateAssetStatus(
  id: string,
  status: Asset['status'],
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('assets').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function updateAssetPerm(
  id: string,
  perm: Asset['perm'],
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('assets').update({ perm }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteAsset(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase as any).from('assets').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/** Deletes every `disconnected` asset for a client, one row at a time — `variant_of` has no
 * ON DELETE CASCADE/SET NULL, so a single batched DELETE would fail entirely if any disconnected
 * row is still referenced by a live variant; deleting per-row lets the rest still go through. */
export async function deleteDisconnectedAssets(
  clientId: string,
): Promise<{ deleted: number; blocked: string[] }> {
  if (!supabase) throw new Error('Supabase not configured')
  const { data, error } = await (supabase as any)
    .from('assets')
    .select('id,name')
    .eq('client_id', clientId)
    .eq('status', 'disconnected')
  if (error) throw new Error(error.message)

  let deleted = 0
  const blocked: string[] = []
  for (const row of (data as Array<{ id: string; name: string }>) ?? []) {
    const { error: delError } = await (supabase as any).from('assets').delete().eq('id', row.id)
    if (delError) blocked.push(row.name)
    else deleted++
  }
  return { deleted, blocked }
}
