import { supabase } from '../lib/supabase'
import type { Asset, FilterState, Role, AssetStatus, AssetPerm } from '@sotto/asset-library'
import type { AssetRow, AssetStats } from '@sotto/database'
import { releaseStreamVideo } from './streamRelease'
import { reportError } from '../lib/reportError'

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
    previewPageCount: row.preview_page_count ?? null,
    previewPageTotal: row.preview_page_total ?? null,
    downloadUrls: parseDownloadUrls(row.download_urls),
    streamUid: row.stream_uid ?? null,
    streamStatus: row.stream_status ?? null,
    streamDuration: row.stream_duration ?? null,
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
  // Children (parent_id, a gallery's images) and variants (variant_of, format siblings) are
  // both only visible inside the primary's detail view, never as their own top-level card.
  query = query.is('parent_id', null).is('variant_of', null)
  const isStaff = opts.role === 'admin' || opts.role === 'editor' || opts.role === 'super_admin'
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
    .maybeSingle()

  if (error || !data) return null
  const statsMap = await fetchStatsMap([id])
  return toAsset({ ...(data as unknown as AssetRow), stats: statsMap.get(id) ?? null })
}

/**
 * Whether to include rows whose file has left the disk.
 *
 * OFF for everyone but staff, and off by default. A disconnected sub-asset is not a deliverable —
 * it is a loose end — so it must never appear in a browse surface. But it also never appears as a
 * top-level card (see the `parent_id`/`variant_of` filter in fetchAssets), which means excluding it
 * HERE too made it unreachable in the entire portal: not in the grid, not in its parent, and not
 * under the Disconnected status filter, which still applies that same top-level restriction. The
 * rows accumulate silently, keep paying for R2 and Stream storage, and nothing can act on them.
 *
 * So staff opt in, and the detail view shows what it gets in a section of its own rather than
 * mixed into the parent's files — see panels/DisconnectedSubAssetsPanel.tsx.
 *
 * `archived` stays excluded either way: that one is a deliberate editorial state with its own
 * filter, not an unresolved one.
 */
export interface SubAssetOptions {
  includeDisconnected?: boolean
}

export async function fetchChildAssets(
  parentId: string,
  opts: SubAssetOptions = {},
): Promise<Asset[]> {
  if (!supabase) throw new Error('Supabase not configured')
  let query = (supabase as any)
    .from('assets')
    .select('*')
    .eq('parent_id', parentId)
    .neq('status', 'archived')
  if (!opts.includeDisconnected) query = query.neq('status', 'disconnected')
  const { data, error } = await query.order('name')
  if (error) throw new Error(error.message)
  return (data as AssetRow[]).map(row => toAsset({ ...row, stats: null }))
}

/** Folder-based stable identity variants (Task 3) — siblings of a primary asset row. */
export async function fetchVariants(
  primaryId: string,
  opts: SubAssetOptions = {},
): Promise<Asset[]> {
  if (!supabase) throw new Error('Supabase not configured')
  let query = (supabase as any)
    .from('assets')
    .select('*')
    .eq('variant_of', primaryId)
    .neq('status', 'archived')
  if (!opts.includeDisconnected) query = query.neq('status', 'disconnected')
  const { data, error } = await query.order('name')
  if (error) throw new Error(error.message)
  return (data as AssetRow[]).map(row => toAsset({ ...row, stats: null }))
}

export async function updateAssetStatus(
  id: string,
  status: Asset['status'],
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')
   
  const { error } = await (supabase as any).from('assets').update({ status }).eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Set an asset's access level.
 *
 * `variantFamilyOf` extends the change to a whole rendition set: pass the PRIMARY's id and every
 * `variant_of` sibling moves with it, plus the primary itself. That is the default in the portal,
 * because "make this public" almost always means the deliverable rather than the one file the panel
 * happens to be showing — but it is a choice, not a rule, so a print master can still be held back
 * from the web version by unchecking it.
 *
 * Gallery children are NOT handled here and must not be: `perm` on a `parent_id` row is forced to
 * its parent's value by a database trigger (20260731130000), so a gallery is one level by
 * construction. Splitting a gallery's visibility means splitting the gallery into two folders.
 */
export async function updateAssetPerm(
  id: string,
  perm: Asset['perm'],
  variantFamilyOf?: string | null,
): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  if (variantFamilyOf) {
    // One statement, so the family cannot end up half-changed by a failure between two calls.
    const { error } = await (supabase as any)
      .from('assets')
      .update({ perm })
      .or(`id.eq.${variantFamilyOf},variant_of.eq.${variantFamilyOf}`)
    if (error) throw new Error(error.message)
    return
  }

  const { error } = await (supabase as any).from('assets').update({ perm }).eq('id', id)
  if (error) throw new Error(error.message)
}

export async function deleteAsset(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { error } = await (supabase as any).from('assets').delete().eq('id', id)
  if (error) throw new Error(error.message)
}

/**
 * Delete an asset row and whatever media only that row referenced.
 *
 * Today that means its Cloudflare Stream video, which is billed for as long as it is held and is
 * unattributable the moment the row naming it is gone. R2 objects are deliberately NOT touched:
 * they are keyed by stable identity, a sibling version may share the folder, and the pipeline
 * already reports orphaned keys for a separate, explicit sweep.
 *
 * `force` is for the case where Cloudflare cannot be reached. Refusing to delete the row at all
 * would make an outage into a permanently stuck record; proceeding silently would leak a paid video
 * with no trace of what it was. So the caller is told, and chooses.
 */
export async function deleteAssetAndMedia(
  asset: Pick<Asset, 'id' | 'streamUid'>,
  opts: { force?: boolean } = {},
): Promise<void> {
  if (asset.streamUid) {
    try {
      await releaseStreamVideo(asset.id)
    } catch (err) {
      if (!opts.force) throw err
      /* Forced: the operator has accepted the leak. Recorded rather than dropped, because after the
         row is deleted this report is the only thing that will ever name the stranded video — and
         it has to carry the uid, since the row that held it is about to stop existing. */
      reportError('asset.deleteAssetAndMedia.forcedStreamLeak', new Error(
        `Stream video ${asset.streamUid} left behind by the deletion of asset ${asset.id}: `
        + (err instanceof Error ? err.message : String(err)),
      ))
    }
  }
  await deleteAsset(asset.id)
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
    .select('id,name,stream_uid')
    .eq('client_id', clientId)
    .eq('status', 'disconnected')
  if (error) throw new Error(error.message)

  let deleted = 0
  const blocked: string[] = []
  for (const row of (data as Array<{ id: string; name: string; stream_uid: string | null }>) ?? []) {
    try {
      /* `force`, unlike the per-item removal in the detail view: a sweep that stops on the first
         unreachable video would leave the rest of the batch half-done with no way to tell how far
         it got. The leak is reported per row instead. */
      await deleteAssetAndMedia({ id: row.id, streamUid: row.stream_uid }, { force: true })
      deleted++
    } catch {
      blocked.push(row.name)
    }
  }
  return { deleted, blocked }
}
