/*
 * One-time migration: folder-based stable asset identity.
 * See CLAUDE_CODE_PROMPT_identity-migration.md (repo root) for the full design.
 *
 * Plain Node script (run via tsx) — deliberately NOT a Tauri feature, since it needs
 * no R2/thumbnail/UI code, only filesystem + Supabase REST access. Reads clients.json
 * and settings.json straight from the app's data dir, same as the app does.
 *
 * Usage:
 *   npx tsx scripts/migrate-identity.ts --client="Client Name"
 *
 * Safety: scans and prints a dry-run report, then halts for a typed "yes" before any
 * write (DB backfill, folder rename, or manifest write). Orphan files (no OUT-folder
 * ancestor) and DB-unmatched items are reported but never touched by this pass — they
 * need manual follow-up, since guessing at a rename for them risks touching a folder
 * that isn't actually asset-specific.
 */

import { readFile as fsReadFile, writeFile as fsWriteFile, readdir, rename as fsRename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import { shouldSkipName, isPackageFolder, isOutFolder, isPublishableFile, DEFAULTS } from '../src/domain/naming';
import type { NamingSettings } from '../src/domain/naming';
import { groupAssets } from '../src/domain/assetGrouping';
import { hasStableId, extractStableId, appendStableId, generateStableId } from '../src/domain/stableId';

/* ── Mirrors supabaseService.ts's stripVersionSuffix. Duplicated (not imported)
   because that module also imports @tauri-apps/plugin-fs, which we want to keep
   entirely out of this plain-Node script. Keep in sync by hand if the shortcode
   derivation rule ever changes. ─────────────────────────────────────────────── */
function shortcodeOf(stem: string): string {
  return stem.replace(/\s+[vV]\d+(?:[-._]\d+)*\s*$/, '').trim();
}

/* ── CLI args ────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
function argValue(flag: string): string | null {
  const hit = args.find(a => a.startsWith(`--${flag}=`));
  return hit ? hit.slice(flag.length + 3) : null;
}

const clientName  = argValue('client');
const clientsPath = argValue('clients-json');
if (!clientName) {
  console.error('Usage: npx tsx scripts/migrate-identity.ts --client="Client Name" [--clients-json=/path]');
  process.exit(1);
}

/* ── App data dir (same files the app itself reads/writes) ────────────────────── */

function defaultAppDataDir(): string {
  // Matches tauri.conf.json's identifier: com.disruptcollective.dc-hub
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'com.disruptcollective.dc-hub');
  if (process.platform === 'win32')  return path.join(process.env.APPDATA ?? '', 'com.disruptcollective.dc-hub');
  return path.join(os.homedir(), '.local', 'share', 'com.disruptcollective.dc-hub');
}

interface Client {
  id: string; name: string; sourceFolder: string;
  supabaseUrl: string; supabaseServiceKey: string; identityMigrated: boolean;
}
interface PersistedClients { clients: Client[]; activeClientId: string | null }
type PersistedSettings = Partial<NamingSettings>;

async function loadJson<T>(filePath: string): Promise<T | null> {
  if (!existsSync(filePath)) return null;
  return JSON.parse(await fsReadFile(filePath, 'utf-8')) as T;
}

/* ── Supabase REST (plain fetch — the app proxies through Rust to keep the key off
   the webview's network surface; a Node script has no such surface to protect) ─── */

function sbHeaders(serviceKey: string): Record<string, string> {
  return { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };
}

async function sbGetAll<T>(base: string, table: string, clientId: string, select: string, headers: Record<string, string>, extra = ''): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  let page = 0;
  while (true) {
    const url = `${base}/${table}?client_id=eq.${clientId}${extra}&select=${select}&limit=${PAGE}&offset=${page * PAGE}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const batch = await res.json() as T[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
    page++;
  }
  return rows;
}

async function sbPatch(base: string, headers: Record<string, string>, id: string, body: Record<string, unknown>): Promise<boolean> {
  const res = await fetch(`${base}/assets?id=eq.${id}`, { method: 'PATCH', headers: { ...headers, Prefer: 'return=minimal' }, body: JSON.stringify(body) });
  if (!res.ok) console.error(`  ✕  PATCH ${id} failed: ${await res.text()}`);
  return res.ok;
}

/* ── Filesystem walk — mirrors pipelineService.ts's scanAllAssets exactly, using the
   client's actual configured naming settings, so "current asset files" here matches
   what the live app would compute. ────────────────────────────────────────────── */

async function listDir(dir: string) {
  try { return await readdir(dir, { withFileTypes: true }); } catch { return []; }
}

async function scanAllAssets(root: string, s: NamingSettings): Promise<string[]> {
  const results: string[] = [];

  async function walkForOut(dir: string) {
    const entries = await listDir(dir);
    const hasOut  = entries.some(e => e.isDirectory() && isOutFolder(e.name, s));
    const dirs    = entries.filter(e => e.isDirectory() && !shouldSkipName(e.name, s) && !isPackageFolder(e.name, s));
    await Promise.all(dirs.map(async e => {
      const childPath = path.join(dir, e.name);
      if (isOutFolder(e.name, s)) await collectInOut(childPath);
      else if (!hasOut) await walkForOut(childPath);
    }));
  }

  async function collectInOut(dir: string) {
    const entries = await listDir(dir);
    await Promise.all(entries.map(async e => {
      if (e.name.startsWith('.') || shouldSkipName(e.name, s) || e.name.includes('-thumb')) return;
      if (e.isDirectory() && e.name.toLowerCase() === 'versions') return;
      const childPath = path.join(dir, e.name);
      if (e.isFile() && isPublishableFile(e.name)) results.push(childPath);
      else if (e.isDirectory()) await collectInOut(childPath);
    }));
  }

  await walkForOut(root);
  return results;
}

async function findFileByStem(dir: string, stem: string): Promise<string | null> {
  const entries = await listDir(dir);
  for (const e of entries) {
    if (e.isFile() && e.name.replace(/\.[^.]+$/, '') === stem) return path.join(dir, e.name);
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findFileByStem(path.join(dir, e.name), stem);
      if (found) return found;
    }
  }
  return null;
}

/* ── Matching ────────────────────────────────────────────────────────────────── */

interface MatchedItem {
  key:             string;   // stem (single) or gallery folder name / child stem
  shortcode:       string;   // current DB match key
  dbId:            string;
  packageDir:      string;
  isGalleryParent: boolean;
  // Gallery membership (parent or child) is a distinct relationship (parent_id, grid/carousel
  // UI, e.g. 60 event photos) from same-folder variants (variant_of, chip picker, e.g. format
  // options) — only non-gallery items get variant_of backfilled below. Galleries already have
  // a correct parent_id from legacy pipeline runs; this script never touches it.
  isGallery:       boolean;
}
interface Report {
  matched:         MatchedItem[];
  unmatchedOnDisk: string[]; // shortcodes on disk with no DB row
  unmatchedInDb:   string[]; // DB shortcodes with nothing on disk
  orphans:         string[]; // no OUT ancestor — skipped, never touched
  alreadyHashed:   string[]; // package dirs that already carry a __hash suffix
}

async function main() {
  const dataDir  = defaultAppDataDir();
  const clients  = await loadJson<PersistedClients>(clientsPath ?? path.join(dataDir, 'clients.json'));
  const settings = (await loadJson<PersistedSettings>(path.join(dataDir, 'settings.json'))) ?? {};
  if (!clients) { console.error(`Could not read clients.json under ${dataDir}`); process.exit(1); }

  const client = clients.clients.find(c => c.name.toLowerCase() === clientName!.toLowerCase());
  if (!client) { console.error(`No client named "${clientName}" in ${dataDir}/clients.json`); process.exit(1); }
  if (!client.sourceFolder) { console.error(`Client "${client.name}" has no sourceFolder configured.`); process.exit(1); }
  if (!client.supabaseUrl || !client.supabaseServiceKey) { console.error(`Client "${client.name}" has no Supabase config.`); process.exit(1); }

  const naming: NamingSettings = {
    packagePrefix: settings.packagePrefix ?? DEFAULTS.packagePrefix,
    outFolder:     settings.outFolder     ?? DEFAULTS.outFolder,
    excludeMark:   settings.excludeMark   ?? DEFAULTS.excludeMark,
    includeMark:   settings.includeMark   ?? DEFAULTS.includeMark,
    filterMode:    settings.filterMode    ?? DEFAULTS.filterMode,
  };

  const base    = `${client.supabaseUrl}/rest/v1`;
  const headers = sbHeaders(client.supabaseServiceKey);

  console.log(`\n━━━ Folder-based identity migration — "${client.name}" ━━━`);
  console.log(`  Source: ${client.sourceFolder}`);
  console.log(`  OUT folder marker: "${naming.outFolder}" · package prefix: "${naming.packagePrefix}"\n`);

  // Resolve the Supabase clients.id — do NOT auto-create; that's the live app's job.
  const clientRes = await fetch(`${base}/clients?name=eq.${encodeURIComponent(client.name)}&select=id&limit=1`, { headers });
  if (!clientRes.ok) { console.error(`Could not reach Supabase: ${clientRes.status} ${await clientRes.text()}`); process.exit(1); }
  const clientRows = await clientRes.json() as Array<{ id: string }>;
  if (!clientRows.length) {
    console.error(`No Supabase "clients" row named "${client.name}" — run the app once for this client first (it self-bootstraps that row).`);
    process.exit(1);
  }
  const clientId = clientRows[0].id;

  /* ── Step 1: scan + group ──────────────────────────────────────────────────── */
  console.log('Scanning source folder…');
  const { singles, galleries, packageDirs, orphanKeys } = groupAssets(await scanAllAssets(client.sourceFolder, naming), naming.outFolder);
  console.log(`  ${singles.length} single(s) + ${galleries.length} galler${galleries.length === 1 ? 'y' : 'ies'}\n`);

  /* ── Step 2: match against existing DB rows by current shortcode ─────────────── */
  type ExistingRow = { id: string; shortcode: string; stable_id: string | null };
  let existing: ExistingRow[];
  try {
    existing = await sbGetAll<ExistingRow>(base, 'assets', clientId, 'id,shortcode,stable_id', headers, '&status=neq.archived');
  } catch (e) {
    if (String(e).includes('stable_id') && String(e).includes('does not exist')) {
      console.error(`\n"${client.name}"'s Supabase project doesn't have the stable_id column yet.`);
      console.error('Run web/supabase/migrations/add_stable_identity.sql in its SQL editor first, then re-run this script.\n');
      process.exit(1);
    }
    throw e;
  }
  const existingByShortcode = new Map(existing.map(r => [r.shortcode.trim(), r]));

  const report: Report = { matched: [], unmatchedOnDisk: [], unmatchedInDb: [], orphans: [], alreadyHashed: [] };
  const diskShortcodes = new Set<string>();

  for (const stem of singles) {
    const sc  = shortcodeOf(stem);
    diskShortcodes.add(sc);
    const dir = packageDirs.get(stem);
    const row = existingByShortcode.get(sc);
    if (!row)                  { report.unmatchedOnDisk.push(sc); continue; }
    if (orphanKeys.has(stem))  { report.orphans.push(sc); continue; }
    if (!dir)                  { report.orphans.push(sc); continue; }
    if (hasStableId(path.basename(dir))) { report.alreadyHashed.push(dir); continue; }
    report.matched.push({ key: stem, shortcode: sc, dbId: row.id, packageDir: dir, isGalleryParent: false, isGallery: false });
  }
  for (const g of galleries) {
    const sc  = shortcodeOf(g.name);
    diskShortcodes.add(sc);
    const dir = packageDirs.get(g.name);
    const row = existingByShortcode.get(sc);
    const parentOk = row && !orphanKeys.has(g.name) && dir && !hasStableId(path.basename(dir));
    if (!row)                     report.unmatchedOnDisk.push(sc);
    else if (orphanKeys.has(g.name) || !dir) report.orphans.push(sc);
    else if (hasStableId(path.basename(dir))) report.alreadyHashed.push(dir);
    else report.matched.push({ key: g.name, shortcode: sc, dbId: row.id, packageDir: dir, isGalleryParent: true, isGallery: true });

    for (const child of g.childStems) {
      const childSc = `${sc}|${child}`;
      diskShortcodes.add(childSc);
      const childRow = existingByShortcode.get(childSc);
      if (!childRow) { report.unmatchedOnDisk.push(childSc); continue; }
      if (!parentOk) continue; // parent itself unmatched/orphaned/already-hashed — skip its children too, report via parent
      report.matched.push({ key: child, shortcode: childSc, dbId: childRow.id, packageDir: dir!, isGalleryParent: false, isGallery: true });
    }
  }
  for (const r of existing) if (!diskShortcodes.has(r.shortcode.trim())) report.unmatchedInDb.push(r.shortcode);

  /* ── Step 3: print dry-run report, halt for confirmation ─────────────────────── */
  const distinctDirs = new Set(report.matched.map(m => m.packageDir));
  console.log('━━━ DRY RUN ━━━');
  console.log(`  Matched (will migrate):     ${report.matched.length} row(s) across ${distinctDirs.size} folder(s)`);
  console.log(`  Already hash-suffixed:      ${report.alreadyHashed.length} (skipped, idempotent)`);
  console.log(`  On disk, no DB row:         ${report.unmatchedOnDisk.length} (left untouched)`);
  console.log(`  In DB, nothing on disk:     ${report.unmatchedInDb.length} (left untouched)`);
  console.log(`  Orphans (no OUT ancestor):  ${report.orphans.length} (left untouched — renaming these risks a shared folder)`);
  const preview = (arr: string[]) => arr.slice(0, 10).join(', ') + (arr.length > 10 ? ', …' : '');
  if (report.unmatchedOnDisk.length) console.log(`    unmatched-on-disk: ${preview(report.unmatchedOnDisk)}`);
  if (report.unmatchedInDb.length)   console.log(`    unmatched-in-db:   ${preview(report.unmatchedInDb)}`);
  if (report.orphans.length)         console.log(`    orphans:           ${preview(report.orphans)}`);
  console.log(`\n  Zero R2 calls, zero file moves — this only renames package folders to "<name> __<hash>" and strips [NN] prefixes off their IN/WRK/OUT children.\n`);

  if (!report.matched.length) { console.log('Nothing to migrate. Exiting.'); return; }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question('Type "yes" to back-fill stable_id + rename these folders, anything else to abort: ');
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') { console.log('Aborted — no writes made.'); return; }

  /* ── Step 4: assign stable_id per distinct package dir + child_id per row ────── */
  console.log('\nProceeding — additive only (new columns), reversible by clearing stable_id on affected rows.\n');

  const takenHashes = new Set(existing.map(r => r.stable_id).filter((x): x is string => !!x));
  const stableIdOf  = new Map<string, string>(); // packageDir → newly generated hash
  for (const dir of distinctDirs) stableIdOf.set(dir, generateStableId(takenHashes));

  const byDir = new Map<string, MatchedItem[]>();
  for (const m of report.matched) (byDir.get(m.packageDir) ?? byDir.set(m.packageDir, []).get(m.packageDir)!).push(m);

  // One assignment pass, reused for both the DB backfill and the manifest write below —
  // guarantees they never disagree. child_id numbering covers every item in the folder
  // (galleries and singles share one id-space, per the runtime's manifest logic), but
  // variant_of is only ever assigned among the non-gallery singles in that folder — a
  // gallery's parent_id relationship already exists from legacy runs and is never touched.
  const assignment  = new Map<string, { stableId: string; childId: string }>(); // dbId → assignment
  const variantOfBy = new Map<string, string | null>();                         // dbId → primary dbId (singles only)
  for (const [dir, items] of byDir) {
    const stableId = stableIdOf.get(dir)!;
    const ordered  = [...items].sort((a, b) => {
      if (a.isGalleryParent !== b.isGalleryParent) return a.isGalleryParent ? -1 : 1;
      return a.key.localeCompare(b.key);
    });
    ordered.forEach((item, i) => assignment.set(item.dbId, { stableId, childId: `c${i + 1}` }));

    const singleItems = ordered.filter(i => !i.isGallery);
    if (singleItems.length > 1) {
      const primaryDbId = singleItems[0].dbId;
      for (const item of singleItems) variantOfBy.set(item.dbId, item.dbId === primaryDbId ? null : primaryDbId);
    }
  }

  /* ── Step 5: backfill DB ──────────────────────────────────────────────────────── */
  let patched = 0, failed = 0;
  for (const item of report.matched) {
    const a = assignment.get(item.dbId)!;
    const body: Record<string, unknown> = { stable_id: a.stableId, child_id: a.childId };
    if (variantOfBy.has(item.dbId)) body.variant_of = variantOfBy.get(item.dbId);
    const ok = await sbPatch(base, headers, item.dbId, body);
    if (ok) patched++; else failed++;
  }
  console.log(`  DB backfill: ${patched} row(s) updated, ${failed} failed.\n`);

  /* ── Step 6: rename folders + strip [NN] prefixes + write manifest ───────────── */
  const newDirOf = new Map<string, string>(); // original packageDir → renamed dir
  let renamed = 0;
  for (const [dir, items] of byDir) {
    const stableId  = stableIdOf.get(dir)!;
    const parentDir = path.dirname(dir);
    const baseName  = path.basename(dir).replace(naming.packagePrefix, '').trim() || path.basename(dir);
    const newDir    = path.join(parentDir, appendStableId(baseName, stableId));
    newDirOf.set(dir, newDir);
    try {
      await fsRename(dir, newDir);
      renamed++;

      // Strip [NN] prefixes off immediate children (IN/WRK/OUT workflow subfolders).
      for (const c of await listDir(newDir)) {
        if (!c.isDirectory()) continue;
        const stripped = c.name.replace(/^\[\d+\]\s*/, '');
        if (stripped !== c.name) await fsRename(path.join(newDir, c.name), path.join(newDir, stripped));
      }

      // Manifest — compute sha256 per real file now so the very first live run
      // afterward doesn't need the content-hash fallback for anything already known.
      const outDir  = path.join(newDir, 'OUT');
      const children: Record<string, { child_id: string; sha256: string }> = {};
      for (const item of items) {
        const a = assignment.get(item.dbId)!;
        if (item.isGalleryParent) { children['__gallery_parent__'] = { child_id: a.childId, sha256: '' }; continue; }
        const found  = await findFileByStem(outDir, item.key);
        const sha256 = found ? createHash('sha256').update(await fsReadFile(found)).digest('hex') : '';
        children[found ? path.basename(found) : item.key] = { child_id: a.childId, sha256 };
      }
      await fsWriteFile(
        path.join(newDir, '.dchub.json'),
        JSON.stringify({ stable_id: stableId, children, updated_at: new Date().toISOString() }, null, 2),
      );
    } catch (e) {
      console.error(`  ✕  Rename/manifest failed for "${dir}": ${e}`);
    }
  }
  console.log(`  Renamed ${renamed}/${distinctDirs.size} package folder(s).\n`);

  /* ── Step 7: verify ───────────────────────────────────────────────────────────── */
  console.log('Verifying…');
  let verifyOk = 0, verifyFail = 0;
  for (const [dir, stableId] of stableIdOf) {
    const newDir = newDirOf.get(dir);
    if (newDir && existsSync(newDir) && extractStableId(path.basename(newDir)) === stableId) verifyOk++;
    else { verifyFail++; console.error(`  ✕  Verification failed for: ${newDir ?? dir}`); }
  }
  console.log(`  ${verifyOk}/${distinctDirs.size} folder(s) verified.${verifyFail ? ` ${verifyFail} FAILED — check above.` : ''}\n`);
  console.log(`Done. This client's stable_id rows are backfilled — set client.identityMigrated = true in clients.json`);
  console.log(`(or the Settings UI, once built) to switch the live pipeline over to stable-identity matching for "${client.name}".`);
}

main().catch(e => { console.error(e); process.exit(1); });
