/* Version history sync — the versions/ subtree → public.version_history.
 *
 * The main asset scan deliberately skips versions/; this is the pass that reads it, so a client
 * can see an asset's history without those files competing as current deliverables.
 */

import { type VocabularyData, buildVocabMap, parseFilename } from '@sotto/domain';
import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch, fetchAllForClient, BATCH } from './rest';
import { fetchVHForAssets } from './assetQueries';
import type { AssetVersions } from '../pipeline/types';

/* ── Version History sync ────────────────────────────────────────────────── */

export async function syncVersionHistory(
  versionMap: Map<string, AssetVersions>,
  clientId:   string,
  vocab:      VocabularyData,
  config:     SupabaseConfig,
  appendLog:  (type: string, msg: string) => void,
  options:    { dryRun?: boolean; shouldStop?: () => boolean } = {},
): Promise<void> {
  appendLog('section', '━━━ VERSION HISTORY SYNC ━━━');

  const base     = `${config.url}/rest/v1`;
  const headers  = await makeHeaders(config.anonKey);
  const vocabCtx = buildVocabMap(vocab);
  const today    = new Date().toISOString().slice(0, 10);

  // Step 1: Fetch asset identities for this client. Keyed `${stable_id}:${shortcode}` to
  // match scanVersionMap — the folder hash scopes the display text to one package, so two
  // assets rendering the same name can't collapse onto a single history.
  appendLog('dim', '  Fetching asset IDs…');
  const assetKeyToId = new Map<string, string>();
  try {
    const rows = await fetchAllForClient<{ id: string; shortcode: string; stable_id: string }>(
      base, 'assets', clientId, 'id,shortcode,stable_id', headers,
    );
    for (const r of rows) assetKeyToId.set(`${r.stable_id}:${r.shortcode.trim()}`, r.id);
  } catch (e) {
    appendLog('error', `  ✕  Failed to fetch asset IDs: ${e}`);
    return;
  }
  appendLog('dim', `  ${assetKeyToId.size} asset(s) found`);

  // Step 2: Fetch existing VH rows for these assets
  const assetIds = [...assetKeyToId.values()];
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

  const assetIdToKey = new Map([...assetKeyToId.entries()].map(([key, id]) => [id, key]));

  const toUpsert:     Record<string, unknown>[] = [];
  const toDisconnect: string[]                  = [];
  const toRemove:     string[]                  = [];

  // Step 3: Diff desired state vs existing
  for (const [key, av] of versionMap) {
    const sc      = av.shortcode;
    const assetId = assetKeyToId.get(key);
    if (!assetId) {
      appendLog('dim', `  ⚠  No Supabase asset for "${sc}" (${key}) — VH skipped`);
      continue;
    }

    const desired = new Map<string, 'Active' | 'History'>();
    if (av.current) desired.set(av.current.version, 'Active');
    for (const h of av.history) desired.set(h.version, 'History');

    const existingVersions = existingVH.get(assetId) ?? new Map();

    // Versions to create or update status on
    for (const [version, status] of desired) {
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
    const key = assetIdToKey.get(assetId);
    if (!key || !versionMap.has(key)) {
      for (const [, rec] of byVersion) {
        if (rec.status !== 'Removed') toRemove.push(rec.id);
      }
    }
  }

  appendLog('info', `  ${toUpsert.length} to upsert · ${toDisconnect.length} to disconnect · ${toRemove.length} to remove`);

  if (options.dryRun) {
    appendLog('dim',
      `  [DRY] would upsert ${toUpsert.length}, disconnect ${toDisconnect.length}, ` +
      `and remove ${toRemove.length} version-history record(s)`,
    );
    appendLog('section', '━━━ VH DRY RUN DONE ━━━');
    return;
  }

  // Step 4: Upsert
  for (let i = 0; i < toUpsert.length; i += BATCH) {
    if (options.shouldStop?.()) return;
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
      if (options.shouldStop?.()) return;
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
