/* Read queries against public.assets.
 *
 * Reads only. Each takes the caller's SupabaseConfig and goes through sbFetch, so the request is
 * performed by whatever transport that module provides (Rust on desktop today).
 */

import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch, fetchAllForClient } from './rest';
import type { AssetStatsSnapshot } from '../readmeService';
import { inspectCdnKeyReferences, type CdnReferenceRow } from './cdnReferences';

export async function fetchExistingStableIds(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Set<string>> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  const rows = await fetchAllForClient<{ stable_id: string }>(
    base, 'assets', clientId, 'stable_id', headers,
  );
  return new Set(rows.map(r => r.stable_id));
}

/**
 * Per-asset stats for the readme.md snapshot (Task 5) — reuses the web portal's existing
 * `asset_stats` view (avg rating / rating count / comment count) and aggregates
 * `asset_events` client-side into view/download counts, mirroring
 * web/apps/client-hub/src/services/eventService.ts's own aggregation. Best-effort: a
 * fetch failure just means that run's readme.md ships without stats, never blocks the sync.
 */
export async function fetchAssetStats(
  assetIds: string[],
  config:   SupabaseConfig,
): Promise<Map<string, AssetStatsSnapshot>> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  const result  = new Map<string, AssetStatsSnapshot>();
  if (!assetIds.length) return result;

  for (let i = 0; i < assetIds.length; i += 200) {
    const chunk = assetIds.slice(i, i + 200).join(',');
    try {
      const [statsRes, eventsRes] = await Promise.all([
        sbFetch(`${base}/asset_stats?id=in.(${chunk})&select=id,avg_rating,rating_count,comment_count`, { headers }),
        sbFetch(`${base}/asset_events?asset_id=in.(${chunk})&select=asset_id,event_type`, { headers }),
      ]);
      const statsRows = statsRes.ok
        ? await statsRes.json<Array<{ id: string; avg_rating: number; rating_count: number; comment_count: number }>>()
        : [];
      const eventRows = eventsRes.ok
        ? await eventsRes.json<Array<{ asset_id: string; event_type: string }>>()
        : [];

      const counts = new Map<string, { views: number; downloads: number }>();
      for (const e of eventRows) {
        const c = counts.get(e.asset_id) ?? { views: 0, downloads: 0 };
        if (e.event_type === 'view') c.views++;
        else if (e.event_type === 'download') c.downloads++;
        counts.set(e.asset_id, c);
      }

      for (const row of statsRows) {
        const c = counts.get(row.id) ?? { views: 0, downloads: 0 };
        result.set(row.id, {
          downloads:    c.downloads,
          views:        c.views,
          avgRating:    Number(row.avg_rating) || 0,
          ratingCount:  row.rating_count ?? 0,
          commentCount: row.comment_count ?? 0,
        });
      }
    } catch { /* best-effort — see doc comment above */ }
  }
  return result;
}

interface AssetStorageRow extends CdnReferenceRow {
  effective_level: string;
}

export interface AssetStorageState {
  levels: Map<string, string>;
  references: Map<string, Set<string>> | null;
}

/**
 * Key-routing levels and the live rows that reference each CDN key, from one client-scoped read.
 *
 * The upload stages need this before they write: the level is part of the key, and the reference
 * index prevents deleting a shared key. Neither can be derived locally because portal rows own
 * both values. A level absent from a successful read is a new asset and uses the create-time
 * default; a failed read returns null so routing remains restrictive and pruning stops safely.
 *
 * `null` is deliberately distinct from an empty result. Empty means the client has no rows, while
 * null means references are unknown and destructive orphan pruning must be skipped for this run.
 */
export async function fetchAssetStorageState(
  clientId: string,
  config:   SupabaseConfig,
): Promise<AssetStorageState | null> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  try {
    const rows = await fetchAllForClient<AssetStorageRow>(
      base,
      'assets?status=neq.archived',
      clientId,
      'stable_id,child_id,effective_level,thumbnail_url,download_url,download_key',
      headers,
    );
    const levels = new Map<string, string>();
    for (const r of rows) {
      if (r.stable_id && r.child_id && r.effective_level) {
        levels.set(`${r.stable_id}:${r.child_id}`, r.effective_level);
      }
    }
    const referenceIndex = inspectCdnKeyReferences(rows);
    return {
      levels,
      references: referenceIndex.complete ? referenceIndex.references : null,
    };
  } catch {
    return null;
  }
}

export async function fetchAssetLevels(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Map<string, string>> {
  return (await fetchAssetStorageState(clientId, config))?.levels ?? new Map<string, string>();
}

/**
 * The client's cap on how many document pages get previewed.
 *
 * Portal-owned, like `perm`: an admin sets it in the client admin, so the database is the only place
 * that knows it. Returns null when the read fails or the column is absent, and the caller falls back
 * to `DEFAULT_PREVIEW_PAGE_LIMIT` — a failed read must not silently mean "render every page of every
 * document", which on a large library is minutes of work and hundreds of objects per asset.
 */
export async function fetchPreviewPageLimit(
  clientId: string,
  config:   SupabaseConfig,
): Promise<number | null> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  try {
    const res = await fetch(
      `${base}/clients?id=eq.${encodeURIComponent(clientId)}&select=preview_page_limit`,
      { headers },
    );
    if (!res.ok) return null;
    const rows = await res.json() as Array<{ preview_page_limit?: number | null }>;
    const value = rows[0]?.preview_page_limit;
    return typeof value === 'number' ? value : null;
  } catch {
    return null;
  }
}

/* fetch helpers live in supabase/rest.ts */

/* ── Version history pagination ──────────────────────────────────────────── */

export async function fetchVHForAssets(
  base:     string,
  assetIds: string[],
  headers:  Record<string, string>,
): Promise<Array<{ id: string; asset_id: string; version: string; status: string }>> {
  if (!assetIds.length) return [];
  const PAGE = 1000;
  const rows: Array<{ id: string; asset_id: string; version: string; status: string }> = [];
  for (let ci = 0; ci < assetIds.length; ci += 200) {
    const chunk = assetIds.slice(ci, ci + 200).join(',');
    let page = 0;
    while (true) {
      const res = await sbFetch(
        `${base}/version_history?asset_id=in.(${chunk})&select=id,asset_id,version,status&limit=${PAGE}&offset=${page * PAGE}`,
        { headers },
      );
      if (!res.ok) throw new Error(await res.text());
      const batch = await res.json() as typeof rows;
      rows.push(...batch);
      if (batch.length < PAGE) break;
      page++;
    }
  }
  return rows;
}
