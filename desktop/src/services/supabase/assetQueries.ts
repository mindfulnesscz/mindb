/* Read queries against public.assets.
 *
 * Reads only. Each takes the caller's SupabaseConfig and goes through sbFetch, so the request is
 * performed by whatever transport that module provides (Rust on desktop today).
 */

import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch, fetchAllForClient } from './rest';
import type { AssetStatsSnapshot } from '../readmeService';

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

/**
 * `${stable_id}:${child_id}` → the asset's effective access level.
 *
 * The upload stages need this BEFORE they write, because the level is part of the object key and
 * decides which bucket the bytes go to. It cannot be derived locally: `perm` is portal-owned once
 * a row exists (see stripPortalOwnedFields), so the database is the only place that knows whether
 * an editor has promoted or locked down this asset since the last run.
 *
 * A key that is absent from the map is a NEW asset, and the caller supplies the create-time
 * default rather than this function guessing — the two defaults would otherwise drift.
 *
 * Best-effort in the same sense as fetchAssetStats: a failure returns an empty map. The caller
 * then treats every asset as new, which sends everything to the create-time default of `client`.
 * That is the safe direction — the failure mode of a network blip is over-restriction, never
 * publishing a client's assets to the public bucket.
 */
export async function fetchAssetLevels(
  clientId: string,
  config:   SupabaseConfig,
): Promise<Map<string, string>> {
  const base    = `${config.url}/rest/v1`;
  const headers = await makeHeaders(config.anonKey);
  const out     = new Map<string, string>();
  try {
    const rows = await fetchAllForClient<{ stable_id: string; child_id: string; effective_level: string }>(
      base, 'assets?status=neq.archived', clientId, 'stable_id,child_id,effective_level', headers,
    );
    for (const r of rows) {
      if (r.stable_id && r.child_id && r.effective_level) {
        out.set(`${r.stable_id}:${r.child_id}`, r.effective_level);
      }
    }
  } catch { /* best-effort — see doc comment above */ }
  return out;
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

