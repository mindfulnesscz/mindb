import { invoke } from '@tauri-apps/api/core';
import { parseFilename, buildVocabContext } from '../domain/filenameTranslator';
import { clientInitials } from '../domain/client';
import type { VocabularyData } from '../domain/vocabulary';
import type { AssetVersions, CloudUrlEntry } from './pipelineService';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface SupabaseConfig {
  url:        string; // https://<project>.supabase.co
  serviceKey: string; // service_role key — bypasses RLS
}

export interface SupabaseExportResult {
  created: number;
  updated: number;
  errors:  number;
}

/* ── Internal fetch helpers ──────────────────────────────────────────────── */

function makeHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey:         serviceKey,
    Authorization:  `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

interface SbRustResponse { status: number; ok: boolean; body: string }

/** Proxy fetch through Rust so the service role key never leaves the native context. */
async function sbFetch(
  url:     string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ ok: boolean; status: number; text(): Promise<string>; json<T>(): Promise<T> }> {
  const r = await invoke<SbRustResponse>('supabase_request', {
    url,
    method:  options.method ?? 'GET',
    headers: options.headers,
    body:    options.body,
  });
  return {
    ok:     r.ok,
    status: r.status,
    text:   async () => r.body,
    json:   async <T>() => JSON.parse(r.body) as T,
  };
}

/**
 * Paginated GET for a single table. `path` is the table name optionally with
 * extra PostgREST filters already appended, e.g. 'assets?status=neq.archived'.
 * client_id, select, limit, offset are always appended.
 */
async function fetchAllForClient<T>(
  base:     string,
  path:     string,
  clientId: string,
  select:   string,
  headers:  Record<string, string>,
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let page = 0;
  const sep = path.includes('?') ? '&' : '?';
  while (true) {
    const url = `${base}/${path}${sep}client_id=eq.${clientId}&select=${select}&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await sbFetch(url, { headers });
    if (!res.ok) throw new Error(await res.text());
    const batch = await res.json() as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    page++;
  }
  return rows;
}

/** Paginated GET for version_history rows belonging to a set of asset UUIDs. */
async function fetchVHForAssets(
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

/* ── Client ID resolution ────────────────────────────────────────────────── */

/**
 * Looks up the Supabase clients.id by name. Creates the row on first run,
 * making the pipeline self-bootstrapping — no manual Supabase setup needed.
 */
export async function resolveClientId(
  clientName: string,
  brandColor:  string,
  config:      SupabaseConfig,
  appendLog:   (type: string, msg: string) => void,
): Promise<string | null> {
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.serviceKey);
  try {
    const res = await sbFetch(
      `${base}/clients?name=eq.${encodeURIComponent(clientName)}&select=id&limit=1`,
      { headers },
    );
    if (!res.ok) throw new Error(await res.text());
    const rows = await res.json() as Array<{ id: string }>;
    if (rows.length) return rows[0].id;

    appendLog('dim', `  Supabase: creating client record for "${clientName}"…`);
    const createRes = await sbFetch(`${base}/clients`, {
      method:  'POST',
      headers: { ...headers, Prefer: 'return=representation' },
      body:    JSON.stringify({
        name:     clientName,
        accent:   brandColor || '#161616',
        initials: clientInitials(clientName),
      }),
    });
    if (!createRes.ok) throw new Error(await createRes.text());
    const created = await createRes.json() as Array<{ id: string }>;
    appendLog('dim', `  Supabase: client created (${created[0].id})`);
    return created[0].id;
  } catch (e) {
    appendLog('error', `  ✕  Supabase: could not resolve client ID: ${e}`);
    return null;
  }
}

/* ── Asset export ────────────────────────────────────────────────────────── */

const BATCH = 500;

function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

function parseAssetForSupabase(assetStem: string, vocab: VocabularyData) {
  const ctx    = buildVocabContext(vocab);
  const parsed = parseFilename(assetStem, ctx);

  const shortcode  = stripVersionSuffix(assetStem);
  const entityTags = parsed.tags.filter(t => t.slot === 'entity');
  const formatTags = parsed.tags.filter(t => t.slot === 'format');
  const angleTags  = parsed.tags.filter(t => t.slot === 'angle');

  const nameParts = [
    ...parsed.tags.map(t => t.label),
    ...parsed.unknownTags.map(u => `[${u}]`),
  ];
  let name = nameParts.join(' ');
  if (parsed.description) name += ` — ${parsed.description}`;

  return {
    shortcode,
    name:       name.trim() || shortcode,
    entities:   entityTags.map(t => t.label),
    formats:    formatTags.map(t => t.label),
    angles:     angleTags.map(t => t.label),
    tags:       parsed.tags.map(t => t.label),
    version:    parsed.version ?? '',
    year_month: parsed.yymm    ?? null,
  };
}

export async function exportAssetsToSupabase(
  packageNames: string[],
  clientId:     string,
  vocab:        VocabularyData,
  config:       SupabaseConfig,
  appendLog:    (type: string, msg: string) => void,
  cdnUrls?:     Map<string, string>,
  cloudUrls?:   Map<string, CloudUrlEntry[]>,
): Promise<SupabaseExportResult> {
  const result: SupabaseExportResult = { created: 0, updated: 0, errors: 0 };
  const base    = `${config.url}/rest/v1`;
  const headers = makeHeaders(config.serviceKey);

  appendLog('section', '━━━ SUPABASE EXPORT ━━━');
  appendLog('dim', `  ${packageNames.length} asset(s) received`);

  // Build deduplicated records by shortcode (last version wins)
  const seen = new Map<string, Record<string, unknown>>();
  for (const pkgName of packageNames) {
    const p = parseAssetForSupabase(pkgName, vocab);
    const rec: Record<string, unknown> = {
      client_id: clientId,
      shortcode:  p.shortcode,
      name:       p.name,
      entities:   p.entities,
      formats:    p.formats,
      angles:     p.angles,
      tags:       p.tags,
      version:    p.version,
      status:     'published',
    };
    if (p.year_month)            rec.year_month    = p.year_month;
    const thumbUrl = cdnUrls?.get(pkgName);
    if (thumbUrl)                rec.thumbnail_url = thumbUrl;
    const cloudEntries = cloudUrls?.get(pkgName);
    if (cloudEntries?.length)    rec.download_urls = cloudEntries;
    seen.set(p.shortcode, rec);
  }
  const allRecords = [...seen.values()];
  if (allRecords.length < packageNames.length) {
    appendLog('dim', `  Deduped to ${allRecords.length} unique shortcode(s)`);
  }

  // Fetch all current (non-archived) assets to diff creates vs updates
  appendLog('dim', '  Fetching existing records…');
  const existingMap = new Map<string, string>(); // shortcode → uuid
  try {
    const rows = await fetchAllForClient<{ id: string; shortcode: string }>(
      base, 'assets?status=neq.archived', clientId, 'id,shortcode', headers,
    );
    for (const r of rows) existingMap.set(r.shortcode.trim(), r.id);
  } catch (e) {
    appendLog('error', `  ✕  Could not fetch existing records: ${e}`);
    result.errors += allRecords.length;
    return result;
  }

  const currentShortcodes = new Set(allRecords.map(r => r.shortcode as string));
  const toCreate  = allRecords.filter(r => !existingMap.has(r.shortcode as string));
  const toUpdate  = allRecords.filter(r =>  existingMap.has(r.shortcode as string));
  const staleIds  = [...existingMap.entries()]
    .filter(([sc]) => !currentShortcodes.has(sc))
    .map(([, id]) => id);

  appendLog('dim', `  ${toCreate.length} to create · ${toUpdate.length} to update · ${staleIds.length} to archive`);

  // Upsert all records (create + update) in a single pass via on_conflict
  const upsertAll = [...toCreate, ...toUpdate];
  for (let i = 0; i < upsertAll.length; i += BATCH) {
    const batch    = upsertAll.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/assets?on_conflict=client_id,shortcode`, {
        method:  'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(batch),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  Upsert batch ${batchNum}: ${await res.text()}`);
        result.errors += batch.length;
      } else {
        const created = batch.filter(r => !existingMap.has(r.shortcode as string)).length;
        result.created += created;
        result.updated += batch.length - created;
        appendLog('success', `  ✓  Batch ${batchNum}: ${created} new · ${batch.length - created} updated`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Upsert batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  // Archive stale records (exist in Supabase but absent from current pipeline run)
  for (let i = 0; i < staleIds.length; i += BATCH) {
    const batch    = staleIds.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/assets?id=in.(${batch.join(',')})`, {
        method:  'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body:    JSON.stringify({ status: 'archived' }),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  Archive batch ${batchNum}: ${await res.text()}`);
        result.errors += batch.length;
      } else {
        appendLog('dim', `  ↷  Archived ${batch.length} stale record(s)`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Archive batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  appendLog('section',
    `━━━ SUPABASE DONE — ${result.created} new · ${result.updated} updated · ${staleIds.length} archived · ${result.errors} errors ━━━`,
  );
  return result;
}

/* ── Version History sync ────────────────────────────────────────────────── */

export async function syncVersionHistory(
  versionMap: Map<string, AssetVersions>,
  clientId:   string,
  vocab:      VocabularyData,
  config:     SupabaseConfig,
  appendLog:  (type: string, msg: string) => void,
): Promise<void> {
  appendLog('section', '━━━ VERSION HISTORY SYNC ━━━');

  const base     = `${config.url}/rest/v1`;
  const headers  = makeHeaders(config.serviceKey);
  const vocabCtx = buildVocabContext(vocab);
  const today    = new Date().toISOString().slice(0, 10);

  // Step 1: Fetch asset id+shortcode for this client
  appendLog('dim', '  Fetching asset IDs…');
  const shortcodeToId = new Map<string, string>(); // shortcode → asset uuid
  try {
    const rows = await fetchAllForClient<{ id: string; shortcode: string }>(
      base, 'assets', clientId, 'id,shortcode', headers,
    );
    for (const r of rows) shortcodeToId.set(r.shortcode.trim(), r.id);
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch asset IDs: ${e}`);
    return;
  }
  appendLog('dim', `  ${shortcodeToId.size} asset(s) found`);

  // Step 2: Fetch existing VH rows for these assets
  const assetIds = [...shortcodeToId.values()];
  const existingVH = new Map<string, Map<string, { id: string; status: string }>>(); // assetId → version → record
  try {
    const rows = await fetchVHForAssets(base, assetIds, headers);
    for (const r of rows) {
      const byVer = existingVH.get(r.asset_id) ?? new Map();
      byVer.set(r.version.trim(), { id: r.id, status: r.status });
      existingVH.set(r.asset_id, byVer);
    }
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch version history: ${e}`);
    return;
  }
  const totalExisting = [...existingVH.values()].reduce((n, m) => n + m.size, 0);
  appendLog('dim', `  ${totalExisting} VH record(s) loaded`);

  const assetIdToShortcode = new Map([...shortcodeToId.entries()].map(([sc, id]) => [id, sc]));

  const toUpsert:     Record<string, unknown>[] = [];
  const toDisconnect: string[]                  = [];
  const toRemove:     string[]                  = [];

  // Step 3: Diff desired state vs existing
  for (const [sc, av] of versionMap) {
    const assetId = shortcodeToId.get(sc);
    if (!assetId) {
      appendLog('dim', `  ⚠  No Supabase asset for "${sc}" — VH skipped`);
      continue;
    }

    const desired = new Map<string, { status: 'Active' | 'History'; file: string }>();
    if (av.current) desired.set(av.current.version, { status: 'Active',   file: av.current.file });
    for (const h of av.history) desired.set(h.version, { status: 'History', file: h.file });

    const existingVersions = existingVH.get(assetId) ?? new Map();

    // Versions to create or update status on
    for (const [version, { status, file }] of desired) {
      const existing = existingVersions.get(version);
      if (!existing || existing.status !== status) {
        const parsed    = parseFilename(sc, vocabCtx);
        const nameParts = [
          ...parsed.tags.map(t => t.label),
          ...parsed.unknownTags.map(u => `[${u}]`),
        ];
        let name = nameParts.join(' ');
        if (parsed.description) name += ` — ${parsed.description}`;
        name = name.trim() || sc;

        toUpsert.push({
          asset_id:      assetId,
          version,
          version_label: version ? `${name} ${version}` : name,
          status,
          file_url:      `file://${file}`,
          date:          today,
        });
      }
    }

    // Versions in DB not in desired → Disconnected
    for (const [version, rec] of existingVersions) {
      if (!desired.has(version) && rec.status !== 'Disconnected') {
        toDisconnect.push(rec.id);
      }
    }
  }

  // Assets entirely gone from source → Removed
  for (const [assetId, byVersion] of existingVH) {
    const sc = assetIdToShortcode.get(assetId);
    if (!sc || !versionMap.has(sc)) {
      for (const [, rec] of byVersion) {
        if (rec.status !== 'Removed') toRemove.push(rec.id);
      }
    }
  }

  appendLog('info', `  ${toUpsert.length} to upsert · ${toDisconnect.length} to disconnect · ${toRemove.length} to remove`);

  // Step 4: Upsert
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    const batch    = toUpsert.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await sbFetch(`${base}/version_history?on_conflict=asset_id,version`, {
        method:  'POST',
        headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=minimal' },
        body:    JSON.stringify(batch),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  VH upsert batch ${batchNum}: ${await res.text()}`);
      } else {
        appendLog('success', `  ✓  VH batch ${batchNum}: ${batch.length} upserted`);
      }
    } catch (e) {
      appendLog('error', `  ✕  VH upsert batch ${batchNum}: ${e}`);
    }
  }

  // Step 5: Status patches (Disconnected, Removed)
  async function patchVHStatus(ids: string[], status: string, label: string) {
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      try {
        const res = await sbFetch(`${base}/version_history?id=in.(${batch.join(',')})`, {
          method:  'PATCH',
          headers: { ...headers, Prefer: 'return=minimal' },
          body:    JSON.stringify({ status }),
        });
        if (!res.ok) {
          appendLog('error', `  ✕  VH ${label}: ${await res.text()}`);
        } else {
          appendLog('dim', `  ↷  Marked ${batch.length} VH record(s) → ${status}`);
        }
      } catch (e) {
        appendLog('error', `  ✕  VH ${label}: ${e}`);
      }
    }
  }

  await patchVHStatus(toDisconnect, 'Disconnected', 'disconnect');
  await patchVHStatus(toRemove,     'Removed',      'remove');

  appendLog('section',
    `━━━ VH DONE — ${toUpsert.length} upserted · ${toDisconnect.length} disconnected · ${toRemove.length} removed ━━━`,
  );
}

/* ── Connection check (used by Settings UI) ──────────────────────────────── */

export async function checkSupabaseConnection(
  url:        string,
  serviceKey: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await sbFetch(
      `${url.trim()}/rest/v1/clients?select=count&limit=0`,
      { headers: makeHeaders(serviceKey.trim()) },
    );
    if (res.ok) return { ok: true, message: 'Connected — service key valid' };
    const body = await res.text();
    return { ok: false, message: `Error ${res.status}: ${body.slice(0, 120)}` };
  } catch (e) {
    return { ok: false, message: String(e) };
  }
}
