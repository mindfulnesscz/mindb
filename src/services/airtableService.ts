import { parseFilename, buildVocabContext } from '../domain/filenameTranslator';
import type { VocabularyData } from '../domain/vocabulary';
import type { AssetVersions, CloudUrlEntry } from './pipelineService';

/* ── Types ───────────────────────────────────────────────────────────────── */

export interface AirtableConfig {
  baseId:   string;
  token:    string;
  table:    string;
  vhTable?: string; // defaults to 'Version History'
}

function sanitizeBaseId(raw: string): string {
  const m = raw.match(/app[a-zA-Z0-9]{14}/);
  return m ? m[0] : raw.trim();
}

export interface AirtableExportResult {
  created: number;
  updated: number;
  errors:  number;
}

/* ── Package name parsing ────────────────────────────────────────────────── */

function stripVersionSuffix(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

function parseAssetForAirtable(assetStem: string, vocab: VocabularyData) {
  const ctx    = buildVocabContext(vocab);
  const parsed = parseFilename(assetStem, ctx);

  // Shortcode = stem without version, used as the upsert merge key
  const shortcode = stripVersionSuffix(assetStem);

  const entityTag = parsed.tags.find(t => t.slot === 'entity');
  const formatTag = parsed.tags.find(t => t.slot === 'format');
  const angleTags = parsed.tags.filter(t => t.slot === 'angle');

  // Human-readable name: all tag labels + unknown tags + description
  const nameParts = [
    ...parsed.tags.map(t => t.label),
    ...parsed.unknownTags.map(u => `[${u}]`),
  ];
  let name = nameParts.join(' ');
  if (parsed.description) name += ` — ${parsed.description}`;

  return {
    shortcode,
    name:    name.trim() || shortcode,
    entity:  entityTag?.label,                     // vocabulary label, e.g. "E-Coating"
    format:  formatTag?.label,                     // vocabulary label, e.g. "Illustration"
    angles:  angleTags.map(t => t.label),          // vocabulary labels, e.g. ["Campaign"]
    tags:    parsed.tags.map(t => t.label),         // decoded labels for readability
    version: parsed.version ?? '',
    yymm:    parsed.yymm ?? null,
  };
}

/* ── Main export function ────────────────────────────────────────────────── */

const BATCH = 10;

export async function exportPackagesToAirtable(
  packageNames: string[],
  clientName:   string,
  vocab:        VocabularyData,
  config:        AirtableConfig,
  appendLog:     (type: string, msg: string) => void,
  cdnUrls?:      Map<string, string>,
  cloudUrls?:    Map<string, CloudUrlEntry[]>,
): Promise<AirtableExportResult> {
  const result: AirtableExportResult = { created: 0, updated: 0, errors: 0 };
  appendLog('section', '━━━ AIRTABLE EXPORT ━━━');

  appendLog('dim', `  ${packageNames.length} asset(s) received. First 3: ${packageNames.slice(0, 3).join(' | ')}`);

  const baseId  = sanitizeBaseId(config.baseId);
  const table   = (config.table || 'Assets').trim();
  const url     = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;
  appendLog('dim', `  → base: ${baseId}  table: ${table}`);
  const headers = {
    Authorization:  `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };

  const seen = new Map<string, { fields: Record<string, unknown> }>();
  let firstLogged = false;
  for (const name of packageNames) {
    const p = parseAssetForAirtable(name, vocab);
    if (!firstLogged) {
      appendLog('dim', `  First parse → shortcode: "${p.shortcode}"  name: "${p.name}"  entity: ${p.entity}  format: ${p.format}`);
      firstLogged = true;
    }
    const fields: Record<string, unknown> = {
      shortcode:       p.shortcode.trim(),
      Name:            p.name.trim(),
      client:          clientName.trim(),
      current_version: p.version.trim(),
    };
    if (p.entity)        fields.entity     = p.entity;
    if (p.format)        fields.format     = p.format;
    if (p.angles.length) fields.angle      = p.angles;
    if (p.tags.length)   fields.tags       = p.tags;
    if (p.yymm)          fields.year_month = p.yymm;
    const thumbUrl   = cdnUrls?.get(name);
    if (thumbUrl)          fields['Thumbnail Link'] = thumbUrl;
    const cloudEntries = cloudUrls?.get(name);
    if (cloudEntries?.length) fields['File URL'] = JSON.stringify(cloudEntries);
    seen.set(p.shortcode, { fields }); // last version wins on duplicate shortcode
  }
  const allRecords = [...seen.values()];
  if (allRecords.length < packageNames.length) {
    appendLog('dim', `  Deduped ${packageNames.length} packages → ${allRecords.length} unique shortcodes`);
  }

  // Step 1: GET existing records to split creates from updates.
  appendLog('dim', '  Checking existing records…');
  const existingMap = new Map<string, string>(); // shortcode → record ID
  let offset: string | undefined;
  try {
    do {
      const params = new URLSearchParams({ pageSize: '100' });
      params.append('fields[]', 'shortcode');
      if (offset) params.set('offset', offset);
      const res  = await fetch(`${url}?${params}`, { headers });
      const data = await res.json() as {
        records: Array<{ id: string; fields: { shortcode?: string } }>;
        offset?: string;
      };
      for (const r of data.records) {
        if (r.fields.shortcode) existingMap.set(r.fields.shortcode.trim(), r.id);
      }
      offset = data.offset;
    } while (offset);
  } catch (e) {
    appendLog('error', `  ✕  Could not fetch existing records: ${e}`);
    result.errors += allRecords.length;
    return result;
  }

  const currentShortcodes = new Set(allRecords.map(r => (r.fields.shortcode as string).trim()));

  const toCreate = allRecords.filter(r => !existingMap.has((r.fields.shortcode as string).trim()));
  const toUpdate = allRecords
    .filter(r => existingMap.has((r.fields.shortcode as string).trim()))
    .map(r => ({ id: existingMap.get((r.fields.shortcode as string).trim())!, fields: { ...r.fields, status: 'Active' } }));

  // Records in Airtable but no longer in the current source → Disconnected
  const toDisconnect = [...existingMap.entries()]
    .filter(([sc]) => !currentShortcodes.has(sc))
    .map(([, id]) => id);

  appendLog('dim', `  ${toCreate.length} to create · ${toUpdate.length} to update · ${toDisconnect.length} to disconnect`);

  // Step 2: POST new records
  const now = new Date().toISOString();
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const batch    = toCreate.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await fetch(url, {
        method:  'POST',
        headers,
        body:    JSON.stringify({
          typecast: true,
          records:  batch.map(r => ({ fields: { ...r.fields, status: 'Active', date_added: now } })),
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        appendLog('error', `  ✕  Create batch ${batchNum}: ${body}`);
        if (body.includes('INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND')) {
          appendLog('error', `      → Check base ID, table name, and that the PAT is granted access to this base.`);
        }
        result.errors += batch.length;
      } else {
        const data = await res.json() as { records: Array<{ id: string }> };
        result.created += data.records.length;
        appendLog('success', `  ✓  Create batch ${batchNum}: ${data.records.length} new`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Create batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  // Step 3: PATCH existing records (typecast auto-creates any missing select options)
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch    = toUpdate.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await fetch(url, {
        method:  'PATCH',
        headers,
        body:    JSON.stringify({ typecast: true, records: batch }),
      });
      if (!res.ok) {
        const body = await res.text();
        appendLog('error', `  ✕  Update batch ${batchNum}: ${body}`);
        result.errors += batch.length;
      } else {
        const data = await res.json() as { records: Array<{ id: string }> };
        result.updated += data.records.length;
        appendLog('success', `  ✓  Update batch ${batchNum}: ${data.records.length} updated`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Update batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  // Step 4: Mark stale records as Disconnected (assets no longer in source)
  for (let i = 0; i < toDisconnect.length; i += BATCH) {
    const batch    = toDisconnect.slice(i, i + BATCH);
    const batchNum = Math.floor(i / BATCH) + 1;
    try {
      const res = await fetch(url, {
        method:  'PATCH',
        headers,
        body:    JSON.stringify({
          typecast: true,
          records:  batch.map(id => ({ id, fields: { status: 'Disconnected' } })),
        }),
      });
      if (!res.ok) {
        appendLog('error', `  ✕  Disconnect batch ${batchNum}: ${await res.text()}`);
        result.errors += batch.length;
      } else {
        appendLog('dim', `  ↷  Disconnected ${batch.length} stale record(s)`);
      }
    } catch (e) {
      appendLog('error', `  ✕  Disconnect batch ${batchNum}: ${e}`);
      result.errors += batch.length;
    }
  }

  appendLog('section',
    `━━━ AIRTABLE DONE — ${result.created} new · ${result.updated} updated · ${toDisconnect.length} disconnected · ${result.errors} errors ━━━`,
  );
  return result;
}

/* ── Version History sync ────────────────────────────────────────────────── */

export async function syncVersionHistory(
  versionMap: Map<string, AssetVersions>,
  _clientName: string,
  vocab:       VocabularyData,
  config:      AirtableConfig,
  appendLog:   (type: string, msg: string) => void,
): Promise<void> {
  appendLog('section', '━━━ VERSION HISTORY SYNC ━━━');

  const baseId  = sanitizeBaseId(config.baseId);
  const headers = {
    Authorization:  `Bearer ${config.token}`,
    'Content-Type': 'application/json',
  };
  const assetsUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(config.table || 'Assets')}`;
  const vhUrl     = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(config.vhTable ?? 'Version History')}`;

  // Step 1: GET all Assets → shortcode → Airtable record ID
  appendLog('dim', '  Fetching Asset record IDs…');
  const assetIdMap = new Map<string, string>(); // shortcode → recordId
  let offset: string | undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    params.append('fields[]', 'shortcode');
    if (offset) params.set('offset', offset);
    try {
      const res  = await fetch(`${assetsUrl}?${params}`, { headers });
      const data = await res.json() as {
        records: Array<{ id: string; fields: { shortcode?: string } }>;
        offset?: string;
      };
      for (const r of data.records) {
        if (r.fields.shortcode) assetIdMap.set(r.fields.shortcode.trim(), r.id);
      }
      offset = data.offset;
    } catch (e) {
      appendLog('error', `  ✕  Failed to fetch Assets: ${e}`);
      return;
    }
  } while (offset);
  appendLog('dim', `  ${assetIdMap.size} asset(s) found in Airtable`);

  // Invert: Airtable record ID → shortcode (for resolving VH linked records)
  const recordToShortcode = new Map<string, string>();
  for (const [sc, rid] of assetIdMap) recordToShortcode.set(rid, sc);

  // Step 2: GET all existing VH records
  appendLog('dim', '  Fetching existing Version History records…');
  // existingVH: shortcode → version → { id, status }
  const existingVH = new Map<string, Map<string, { id: string; status: string }>>();
  offset = undefined;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    ['version', 'status', 'asset'].forEach(f => params.append('fields[]', f));
    if (offset) params.set('offset', offset);
    try {
      const res  = await fetch(`${vhUrl}?${params}`, { headers });
      const data = await res.json() as {
        records: Array<{ id: string; fields: { version?: string; status?: string; asset?: string[] } }>;
        offset?: string;
      };
      for (const r of data.records) {
        const linkedIds = r.fields.asset ?? [];
        if (!linkedIds.length) continue;
        const sc = recordToShortcode.get(linkedIds[0]);
        if (!sc) continue;
        const version = (r.fields.version ?? '').trim();
        const byVersion = existingVH.get(sc) ?? new Map();
        byVersion.set(version, { id: r.id, status: r.fields.status ?? '' });
        existingVH.set(sc, byVersion);
      }
      offset = data.offset;
    } catch (e) {
      appendLog('error', `  ✕  Failed to fetch VH records: ${e}`);
      return;
    }
  } while (offset);
  const totalExisting = [...existingVH.values()].reduce((n, m) => n + m.size, 0);
  appendLog('dim', `  ${totalExisting} VH record(s) loaded`);

  // Step 3: Build desired state from source scan
  const desired = new Map<string, Map<string, { status: 'Active' | 'History'; file: string }>>();
  for (const [sc, av] of versionMap) {
    const versions = new Map<string, { status: 'Active' | 'History'; file: string }>();
    if (av.current) versions.set(av.current.version, { status: 'Active', file: av.current.file });
    for (const h of av.history) versions.set(h.version, { status: 'History', file: h.file });
    desired.set(sc, versions);
  }

  // Step 4: Diff — find updates and creates
  const toCreate: Array<{ shortcode: string; version: string; status: 'Active' | 'History'; file: string }> = [];
  const toUpdate: Array<{ id: string; status: string }> = [];

  // Existing VH records: update status or mark Disconnected/Removed
  for (const [sc, byVersion] of existingVH) {
    const desiredVersions = desired.get(sc);
    for (const [version, rec] of byVersion) {
      if (!desiredVersions) {
        // Asset entirely gone from source → Removed
        if (rec.status !== 'Removed') toUpdate.push({ id: rec.id, status: 'Removed' });
      } else {
        const d = desiredVersions.get(version);
        if (!d) {
          // This specific version gone, asset still exists → Disconnected
          if (rec.status !== 'Disconnected') toUpdate.push({ id: rec.id, status: 'Disconnected' });
        } else if (rec.status !== d.status) {
          toUpdate.push({ id: rec.id, status: d.status });
        }
      }
    }
  }

  // Desired versions missing from existing VH → create
  const vocabCtx = buildVocabContext(vocab);
  for (const [sc, versionEntries] of desired) {
    const existingVersions = existingVH.get(sc) ?? new Map();
    const assetRecordId    = assetIdMap.get(sc);
    if (!assetRecordId) {
      appendLog('dim', `  ⚠  No Airtable Asset record for "${sc}" — VH skipped`);
      continue;
    }
    for (const [version, { status, file }] of versionEntries) {
      if (!existingVersions.has(version)) {
        toCreate.push({ shortcode: sc, version, status, file });
      }
    }
  }

  appendLog('info', `  ${toCreate.length} to create · ${toUpdate.length} to update`);

  // Step 5: Create new VH records (batch POST)
  const today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < toCreate.length; i += BATCH) {
    const batch = toCreate.slice(i, i + BATCH);
    const records = batch.map(item => {
      const parsed = parseFilename(item.shortcode, vocabCtx);
      const nameParts = [
        ...parsed.tags.map(t => t.label),
        ...parsed.unknownTags.map(u => `[${u}]`),
      ];
      let name = nameParts.join(' ');
      if (parsed.description) name += ` — ${parsed.description}`;
      name = name.trim() || item.shortcode;
      const versionLabel = item.version ? `${name} ${item.version}` : name;
      return {
        fields: {
          version_label: versionLabel,
          asset:         [assetIdMap.get(item.shortcode)!],
          version:       item.version,
          status:        item.status,
          file_url:      `file://${item.file}`,
          date:          today,
        },
      };
    });

    try {
      const res = await fetch(vhUrl, {
        method:  'POST',
        headers,
        body:    JSON.stringify({ records }),
      });
      if (!res.ok) {
        const body = await res.text();
        appendLog('error', `  ✕  VH create batch ${Math.floor(i / BATCH) + 1}: ${body}`);
      } else {
        const data = await res.json() as { records: unknown[] };
        appendLog('success', `  ✓  Created ${data.records.length} VH record(s)`);
      }
    } catch (e) {
      appendLog('error', `  ✕  VH create: ${e}`);
    }
  }

  // Step 6: Update statuses (batch PATCH)
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH);
    try {
      const res = await fetch(vhUrl, {
        method:  'PATCH',
        headers,
        body:    JSON.stringify({ records: batch.map(u => ({ id: u.id, fields: { status: u.status } })) }),
      });
      if (!res.ok) {
        const body = await res.text();
        appendLog('error', `  ✕  VH update batch ${Math.floor(i / BATCH) + 1}: ${body}`);
      } else {
        appendLog('success', `  ✓  Updated ${batch.length} VH status(es)`);
      }
    } catch (e) {
      appendLog('error', `  ✕  VH update: ${e}`);
    }
  }

  appendLog('section',
    `━━━ VH DONE — ${toCreate.length} created · ${toUpdate.length} updated ━━━`,
  );
}
