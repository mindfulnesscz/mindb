/* DAM / Obsidian Vault builder — port of run_obsidian_notes from app.py.
   Thumbnails copied to 10 ATTACHMENTS. One canvas per note folder. */

import {
  readDir, writeTextFile, readTextFile, copyFile, mkdir, stat, rename, remove,
  type DirEntry,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import type { AppSettings } from '../store/settingsStore';
import type { RunStats } from '../store/pipelineStore';
import type { LogType } from '../store/pipelineStore';
import type { RunContext, CloudUrlEntry } from './pipelineService';
import {
  buildVocabContext, parseFilename, buildNoteName, translateExportName,
  type ParsedFilename, type VocabContext,
} from '../domain/filenameTranslator';

/* ── Canvas constants ───────────────────────────────────────────────────── */

const CANVAS_W       = 480;
const CANVAS_H       = 540;
const CANVAS_GAP     = 40;
const CELL_W         = CANVAS_W + CANVAS_GAP;
const CELL_H         = CANVAS_H + CANVAS_GAP;
const BASE_H_GAP     = 150;
const DEFAULT_COLS   = 3;
const MAX_ROWS_PER_COL = 20; // cap column height — overflow to additional columns
const LABEL_H        = 60;  // cluster label node height
const LABEL_GAP      = 16;  // gap between label bottom and first note top
const NOTE_Y_OFFSET  = LABEL_H + LABEL_GAP; // all notes shifted down by this amount

const GALLERY_THUMB_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff',
  '.pdf', '.pptx', '.pptm', '.ppt',
]);

/* ── Path helpers ───────────────────────────────────────────────────────── */

function relativeTo(child: string, parent: string): string {
  const base = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(base) ? child.slice(base.length) : child;
}

function pathParts(rel: string): string[] {
  return rel.split('/').filter(Boolean);
}

type SortKey = [number, string][];

function pathSortKey(parts: string[]): SortKey {
  return parts.map(p => {
    const m = p.match(/^\[(\d+)\]/);
    return (m ? [parseInt(m[1], 10), p.toLowerCase()] : [9999, p.toLowerCase()]) as [number, string];
  });
}

function compareSortKeys(a: SortKey, b: SortKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    if (a[i][1] < b[i][1]) return -1;
    if (a[i][1] > b[i][1]) return 1;
  }
  return a.length - b.length;
}

/* Stable 16-char hex ID for canvas nodes — must be consistent across runs */
function stableId(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = h1 >>> 0;
  const hi = h2 >>> 0;
  return (hi * 0x100000000 + lo).toString(16).padStart(16, '0');
}

/* ── Filesystem helpers ─────────────────────────────────────────────────── */

async function listDir(path: string): Promise<DirEntry[]> {
  try { return await readDir(path); } catch { return []; }
}

function isPublishable(name: string): boolean {
  return name.includes('.') && !name.startsWith('.') && !name.startsWith('~$');
}

function shouldSkip(name: string, s: AppSettings): boolean {
  if (name.startsWith('~$') || name.includes('[99]')) return true;
  if (s.filterMode === 'whitelist') return !name.includes(s.includeMark);
  return s.excludeMark ? name.includes(s.excludeMark) : false;
}

function isOutFolder(name: string, s: AppSettings): boolean {
  return s.outFolder ? name.toLowerCase() === s.outFolder.toLowerCase() : false;
}

function isPackageFolder(name: string, s: AppSettings): boolean {
  return s.packagePrefix ? name.startsWith(s.packagePrefix) : false;
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-');
}

async function fileExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function isUnchanged(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    return sa.size === sb.size;
  } catch { return false; }
}

/* ── Scope / anchor finding ─────────────────────────────────────────────── */

async function findPackageAnchors(root: string, s: AppSettings): Promise<string[]> {
  const anchors: string[] = [];
  async function walk(dir: string) {
    const name = dir.split('/').pop() ?? '';
    if (shouldSkip(name, s)) return;
    const entries = await listDir(dir);
    if (entries.some(e => e.isDirectory && isPackageFolder(e.name, s))) {
      anchors.push(dir);
    }
    for (const e of entries) {
      if (e.isDirectory && !isPackageFolder(e.name, s) && !shouldSkip(e.name, s)) {
        await walk(await join(dir, e.name));
      }
    }
  }
  await walk(root);
  return anchors.sort((a, b) => a.split('/').length - b.split('/').length);
}

function scopeFor(projDir: string, anchors: string[]): string | null {
  let best: string | null = null;
  for (const anchor of anchors) {
    const prefix = anchor.endsWith('/') ? anchor : anchor + '/';
    if (projDir.startsWith(prefix) || projDir === anchor) {
      if (!best || anchor.split('/').length < best.split('/').length) best = anchor;
    }
  }
  return best;
}

/* ── Thumbnail helpers ──────────────────────────────────────────────────── */

async function galleryFirstThumbnable(folder: string): Promise<string | null> {
  const entries = await listDir(folder);
  const candidates = entries
    .filter(e => {
      if (!e.isFile || e.name.startsWith('.') || e.name.includes('-thumb')) return false;
      const ext = '.' + (e.name.split('.').pop() || '').toLowerCase();
      return GALLERY_THUMB_EXTS.has(ext);
    })
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return candidates.length ? join(folder, candidates[0].name) : null;
}

/* Copy pre-existing -thumb.webp, or generate via Rust command if missing.
   Returns the dest filename on success, null otherwise. */
async function ensureThumb(
  srcFile: string,
  destName: string,
  attRoot: string,
  width: number,
  quality: number,
): Promise<string | null> {
  try {
    await mkdir(attRoot, { recursive: true });
    const destPath  = await join(attRoot, destName);
    const srcDir    = srcFile.substring(0, srcFile.lastIndexOf('/'));
    const srcStem   = srcFile.split('/').pop()!.replace(/\.[^.]+$/, '');
    const preExisting = await join(srcDir, srcStem + '-thumb.webp');

    if (await fileExists(preExisting)) {
      if (!await isUnchanged(preExisting, destPath)) await copyFile(preExisting, destPath);
      return destName;
    }
    // Generate directly into ATTACHMENTS
    await invoke<boolean>('generate_thumbnail', { src: srcFile, dest: destPath, width, quality });
    return destName;
  } catch { return null; }
}

/* ── Note content ───────────────────────────────────────────────────────── */

function toFileUrl(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}

function makeNote(
  p: ParsedFilename,
  sourceFile: string,
  sourcePath: string,
  exportName: string | null,
  thumbName: string | null,
  outDirPath: string,
  cloudUrls?: CloudUrlEntry[],
): string {
  const today       = new Date().toISOString().split('T')[0];
  const thumbSection = thumbName ? `![[10 ATTACHMENTS/${thumbName}]]\n\n` : '';

  const obsTags: string[] = [];
  for (const t of p.tags) {
    const tag = t.key.trim();
    if (tag && !obsTags.includes(tag)) obsTags.push(tag);
  }
  obsTags.push('dam');
  if (p.error || p.unknownTags.length) obsTags.push('dam/incomplete');
  const inlineTags = obsTags.map(t => `#${t}`).join(' ');

  const rows: [string, string][] = [];
  rows.push(['Version', p.version || '---']);
  rows.push(['Created', today]);
  if (p.yymm) rows.push(['Year / Month', p.yymm]);
  rows.push(['Source', `\`${sourceFile}\``]);
  rows.push(['Location', `[Open in Finder ↗](${toFileUrl(outDirPath)})`]);
  if (exportName) rows.push(['Export name', `\`${exportName}\``]);
  for (const t of p.tags) {
    rows.push([t.slot.charAt(0).toUpperCase() + t.slot.slice(1),
               `${t.icon || ''} ${t.label}`.trim()]);
  }
  if (p.description) rows.push(['Description', p.description]);
  for (const entry of (cloudUrls ?? [])) {
    rows.push([entry.name, `[↗ open](${entry.url})`]);
  }

  const table = '| Field | Value |\n| --- | --- |\n' +
    rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n');

  let meta = '';
  if (p.version) meta += `<!-- dam:version:"${p.version}" -->\n`;
  if (exportName) meta += `<!-- dam:export_name:"${exportName}" -->\n`;
  meta += `<!-- dam:source_path:"${sourcePath}" -->\n`;
  meta += `<!-- dam:file_path:"${outDirPath}" -->\n`;

  let warning = '';
  if (p.error) {
    warning = `\n> [!warning] Filename has no bracket tags\n` +
      `> **File:** \`${sourceFile}\`  \n` +
      `> Please rename using \`(Entity)(Angle)(Format)\` convention.\n`;
  } else if (p.unknownTags.length) {
    const ts = p.unknownTags.map(t => `[${t}]`).join(', ');
    warning = `\n> [!note] Unknown tags skipped: ${ts}\n` +
      `> These shortcodes are not in the vocabulary. Add them if needed.\n`;
  }

  return `---\n---\n\n${thumbSection}${inlineTags}\n\n${table}\n\n${meta}${warning}\n#### Notes\n\n`;
}

function patchMeta(
  content: string,
  p: ParsedFilename,
  sourcePath: string,
  thumbName: string | null,
  outDirPath: string,
  cloudUrls?: CloudUrlEntry[],
): { content: string; changed: boolean } {
  let changed = false;

  function setComment(text: string, key: string, value: string): [string, boolean] {
    const re = new RegExp(`<!--\\s*dam:${key}:"([^"]*)"\\s*-->`);
    const m  = text.match(re);
    if (m) {
      if (m[1] === value) return [text, false];
      return [text.replace(re, `<!-- dam:${key}:"${value}" -->`), true];
    }
    return [text + `<!-- dam:${key}:"${value}" -->\n`, true];
  }

  let c: boolean;
  if (p.version) { [content, c] = setComment(content, 'version', p.version); changed = changed || c; }
  [content, c] = setComment(content, 'source_path', sourcePath); changed = changed || c;
  [content, c] = setComment(content, 'file_path', outDirPath);   changed = changed || c;

  if (thumbName) {
    const thumbLine = `![[10 ATTACHMENTS/${thumbName}]]`;
    if (content.includes('![[10 ATTACHMENTS/')) {
      const next = content.replace(/!\[\[10 ATTACHMENTS\/[^\]]+\]\]/, thumbLine);
      if (next !== content) { content = next; changed = true; }
    } else {
      const next = content.replace(/(---\n\n)(\s*#)/, `$1${thumbLine}\n\n$2`);
      if (next !== content) { content = next; changed = true; }
    }
  }

  // Patch cloud URL rows in the table
  if (cloudUrls?.length) {
    const tableStart = content.indexOf('| Field | Value |');
    if (tableStart !== -1) {
      let tableEnd = content.indexOf('\n\n', tableStart);
      if (tableEnd === -1) tableEnd = content.length;
      else tableEnd += 1; // include first \n of \n\n so slice boundary is clean

      let block = content.slice(tableStart, tableEnd);
      for (const entry of cloudUrls) {
        const newRow = `| ${entry.name} | [↗ open](${entry.url}) |`;
        const escaped = entry.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const rowRe   = new RegExp(`\\| ${escaped} \\| [^\\n]+ \\|`);
        if (rowRe.test(block)) {
          const updated = block.replace(rowRe, newRow);
          if (updated !== block) { block = updated; changed = true; }
        } else {
          const trimmed = block.trimEnd();
          block = trimmed + `\n${newRow}` + block.slice(trimmed.length);
          changed = true;
        }
      }
      if (changed) {
        content = content.slice(0, tableStart) + block + content.slice(tableEnd);
      }
    }
  }

  // Remove legacy <!-- dam:links_start -->...<!-- dam:links_end --> section
  const legacyLinksRe = /\n*<!-- dam:links_start -->[\s\S]*?<!-- dam:links_end -->\n*/;
  if (legacyLinksRe.test(content)) {
    content = content.replace(legacyLinksRe, '\n\n');
    changed = true;
  }

  return { content, changed };
}

/* ── Gallery folder detection ───────────────────────────────────────────── */

const IMAGE_EXTS = new Set(['.jpg','.jpeg','.png','.webp','.gif','.tif','.tiff','.bmp']);

async function isGalleryFolder(path: string, vocab: VocabContext): Promise<boolean> {
  try {
    const parsed = parseFilename(path.split('/').pop()!, vocab);
    if (parsed.error) return false;
    const entries = await readDir(path);
    return entries.some(e => {
      if (!e.isFile || e.name.startsWith('.')) return false;
      const ext = '.' + (e.name.split('.').pop() || '').toLowerCase();
      return IMAGE_EXTS.has(ext);
    });
  } catch { return false; }
}

/* ── OUT dir collection with scope context ──────────────────────────────── */

interface OutDirInfo {
  outPath:    string;
  isOrphan:   boolean;
  noteBase:   string;
  projRel:    string;
  clusterKey: string[];
  sortKey:    string[];
}

async function collectOutDirInfos(
  source: string,
  damRoot: string,
  anchors: string[],
  s: AppSettings,
): Promise<OutDirInfo[]> {
  const results: OutDirInfo[] = [];

  async function walk(dir: string) {
    const name = dir.split('/').pop() ?? '';
    if (shouldSkip(name, s) || isPackageFolder(name, s)) return;
    const entries = await listDir(dir);
    const outEntry = entries.find(e => e.isDirectory && isOutFolder(e.name, s));
    if (outEntry) {
      const outPath  = await join(dir, outEntry.name);
      const scope    = scopeFor(dir, anchors);
      const noteBase = scope ? await join(damRoot, scope.split('/').pop()!) : damRoot;
      const projRel  = scope ? relativeTo(dir, scope) : relativeTo(dir, source);
      const parts    = pathParts(projRel);
      const n        = parts.length;
      results.push({
        outPath, isOrphan: false, noteBase, projRel,
        clusterKey: parts.slice(0, Math.min(Math.max(n - 1, 0), 2)),
        sortKey:    parts,
      });
      return; // don't descend into siblings
    }
    const hasFiles = entries.some(e =>
      e.isFile && isPublishable(e.name) && !e.name.includes('-thumb') && !shouldSkip(e.name, s)
    );
    if (hasFiles) {
      const scope    = scopeFor(dir, anchors);
      const noteBase = scope ? await join(damRoot, scope.split('/').pop()!) : damRoot;
      const projRel  = scope ? relativeTo(dir, scope) : relativeTo(dir, source);
      const parts    = pathParts(projRel);
      const n        = parts.length;
      results.push({
        outPath: dir, isOrphan: true, noteBase, projRel,
        clusterKey: parts.slice(0, Math.min(Math.max(n - 1, 0), 2)),
        sortKey:    parts,
      });
    }
    for (const e of entries) {
      if (e.isDirectory && !shouldSkip(e.name, s) && !isPackageFolder(e.name, s)) {
        await walk(await join(dir, e.name));
      }
    }
  }

  for (const e of await listDir(source)) {
    if (e.isDirectory && !shouldSkip(e.name, s)) {
      await walk(await join(source, e.name));
    }
  }
  return results;
}

/* ── Canvas generation ──────────────────────────────────────────────────── */

async function updateDamCanvas(
  noteFolder: string,
  canvasDir: string,
  vault: string,
  noteSourceMap: Map<string, [string[], string[]]>,
  appendLog: (t: LogType, m: string) => void,
): Promise<string | null> {
  // Recursively collect all .md notes under noteFolder (scope root)
  const allNotes: Array<{ absPath: string; name: string }> = [];
  async function collectNotes(dir: string) {
    const es = await listDir(dir);
    for (const e of es) {
      const childPath = await join(dir, e.name);
      if (e.isDirectory && !e.name.startsWith('.')) {
        await collectNotes(childPath);
      } else if (e.isFile && e.name.endsWith('.md') && !e.name.startsWith('🚫') && !e.name.startsWith('_X ')) {
        allNotes.push({ absPath: childPath, name: e.name });
      }
    }
  }
  await collectNotes(noteFolder);
  if (!allNotes.length) return null;

  // Canvas files live flat in canvasDir (DAM root), one per scope — not nested with notes.
  const fn = noteFolder.split('/').pop()!;
  const label = fn.replace(/^\[\d+\]\s*/, '') || fn;
  await mkdir(canvasDir, { recursive: true }).catch(() => {});
  const topEntries = await listDir(canvasDir);
  const existing = topEntries.find(
    e => e.isFile && e.name.endsWith('.canvas') && e.name.startsWith(`_X ${label}`),
  );
  let cols = DEFAULT_COLS;
  let canvasPath: string;
  if (existing) {
    const m = existing.name.match(/-c(\d+)/);
    if (m) cols = parseInt(m[1], 10);
    canvasPath = await join(canvasDir, existing.name);
  } else {
    canvasPath = await join(canvasDir, `_X ${label} -c3.canvas`);
  }

  const noteFolderRel = relativeTo(noteFolder, vault);

  // Resolve (clusterKey, sortKey) for each note using its absolute path
  async function getSrc(absPath: string): Promise<[string[], string[]]> {
    if (noteSourceMap.has(absPath)) return noteSourceMap.get(absPath)!;
    try {
      const text = await readTextFile(absPath);
      const m    = text.match(/<!--\s*dam:source_path:"([^"]*)"\s*-->/);
      if (m && m[1]) { const p = pathParts(m[1]); return [p, p]; }
    } catch { /* ignore */ }
    return [[], []];
  }

  const notesWithSrc: Array<{ absPath: string; name: string; ck: string[]; sk: string[] }> = [];
  for (const { absPath, name } of allNotes) {
    const [ck, sk] = await getSrc(absPath);
    notesWithSrc.push({ absPath, name, ck, sk });
  }

  notesWithSrc.sort((a, b) => {
    const r1 = compareSortKeys(pathSortKey(a.ck), pathSortKey(b.ck));
    if (r1 !== 0) return r1;
    const r2 = compareSortKeys(pathSortKey(a.sk), pathSortKey(b.sk));
    if (r2 !== 0) return r2;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });

  // Group into clusters
  const clusters: Array<{ key: string[]; notes: Array<{ absPath: string; name: string; sk: string[] }> }> = [];
  for (const n of notesWithSrc) {
    const last = clusters[clusters.length - 1];
    if (last && JSON.stringify(last.key) === JSON.stringify(n.ck)) {
      last.notes.push({ absPath: n.absPath, name: n.name, sk: n.sk });
    } else {
      clusters.push({ key: n.ck, notes: [{ absPath: n.absPath, name: n.name, sk: n.sk }] });
    }
  }

  clusters.sort((a, b) => {
    if (!a.key.length && b.key.length) return -1;
    if (a.key.length && !b.key.length) return 1;
    return compareSortKeys(pathSortKey(a.key), pathSortKey(b.key));
  });

  // Preserve non-note nodes from existing canvas (keep anything not under this scope)
  let preservedNodes: object[] = [];
  let edges: object[] = [];
  if (await fileExists(canvasPath)) {
    try {
      const data = JSON.parse(await readTextFile(canvasPath)) as {
        nodes?: Array<{ type: string; file?: string; [k: string]: unknown }>;
        edges?: object[];
      };
      edges = data.edges ?? [];
      for (const node of (data.nodes ?? [])) {
        if (node.type === 'file') {
          const f = node.file as string;
          if (!f.startsWith(noteFolderRel + '/') && f !== noteFolderRel) preservedNodes.push(node);
        } else if (node.type === 'text' && (node.color as string) === '#000000') {
          // auto-generated cluster labels — drop and regenerate
        } else {
          preservedNodes.push(node);
        }
      }
    } catch { /* start fresh */ }
  }

  // Layout — canvas file references are vault-relative paths of each note
  const noteNodes: object[] = [];
  let xCursor = 0;
  let prevKey: string[] | null = null;
  let prevClusterCols = cols;

  for (const cluster of clusters) {
    if (prevKey !== null) {
      let common = 0;
      const minLen = Math.min(prevKey.length, cluster.key.length);
      for (let i = 0; i < minLen; i++) { if (prevKey[i] === cluster.key[i]) common++; else break; }
      const maxDepth = Math.max(prevKey.length, cluster.key.length, 1);
      xCursor += prevClusterCols * CELL_W + BASE_H_GAP * (maxDepth - common);
    }

    // Group by sk within cluster
    const skMap = new Map<string, Array<{ absPath: string; name: string }>>();
    for (const { absPath, name, sk } of cluster.notes) {
      const k = JSON.stringify(sk);
      if (!skMap.has(k)) skMap.set(k, []);
      skMap.get(k)!.push({ absPath, name });
    }
    const sortedSks = [...skMap.keys()].sort((a, b) =>
      compareSortKeys(pathSortKey(JSON.parse(a)), pathSortKey(JSON.parse(b)))
    );
    const hasMulti = sortedSks.some(sk => skMap.get(sk)!.length >= 2);

    if (!hasMulti) {
      /* Simple cluster: fill top-down first, wrap to next column after MAX_ROWS_PER_COL rows */
      const cNotes = cluster.notes;
      const numCols = Math.max(1, Math.ceil(cNotes.length / MAX_ROWS_PER_COL));
      prevClusterCols = numCols;

      // Cluster label spanning all columns
      const labelText = '# ' + (cluster.key.length
        ? cluster.key[cluster.key.length - 1].replace(/^\[\d+\]\s*/, '')
        : '(root)');
      const labelId = stableId(`label:${JSON.stringify(cluster.key)}`);
      noteNodes.push({
        id: labelId, type: 'text', text: labelText,
        x: xCursor, y: 0,
        width: numCols * CELL_W - CANVAS_GAP, height: LABEL_H,
        color: '#000000',
      });

      cNotes.forEach(({ absPath }, i) => {
        const file = relativeTo(absPath, vault);
        noteNodes.push({
          id: stableId(file), type: 'file', file,
          x: xCursor + Math.floor(i / MAX_ROWS_PER_COL) * CELL_W,
          y: NOTE_Y_OFFSET + (i % MAX_ROWS_PER_COL) * CELL_H,
          width: CANVAS_W, height: CANVAS_H,
        });
      });
    } else {
      /* Mixed layout: each multi-asset sort_key group gets ceil(count/MAX_ROWS) dedicated
         columns so no column grows taller than MAX_ROWS_PER_COL notes. */
      const colAssign = new Map<string, number>(); // sk → base column index
      let colCounter = 0, singlesCol: number | null = null;
      for (const sk of sortedSks) {
        const count = skMap.get(sk)!.length;
        if (count >= 2) {
          colAssign.set(sk, colCounter);
          colCounter += Math.max(1, Math.ceil(count / MAX_ROWS_PER_COL));
        } else {
          if (singlesCol === null) singlesCol = colCounter++;
          colAssign.set(sk, singlesCol);
        }
      }
      prevClusterCols = colCounter;

      // Cluster label spanning all columns
      const labelText = '# ' + (cluster.key.length
        ? cluster.key[cluster.key.length - 1].replace(/^\[\d+\]\s*/, '')
        : '(root)');
      const labelId = stableId(`label:${JSON.stringify(cluster.key)}`);
      noteNodes.push({
        id: labelId, type: 'text', text: labelText,
        x: xCursor, y: 0,
        width: colCounter * CELL_W - CANVAS_GAP, height: LABEL_H,
        color: '#000000',
      });

      const skPos    = new Map<string, number>(); // position within each multi-item sk group
      let singlesPos = 0;                         // shared counter for all single-item sk groups
      for (const { absPath, sk } of cluster.notes) {
        const skKey   = JSON.stringify(sk);
        const baseCol = colAssign.get(skKey) ?? 0;
        const isMulti = (skMap.get(skKey)?.length ?? 0) >= 2;
        let inGroupIdx: number;
        if (isMulti) {
          inGroupIdx = skPos.get(skKey) ?? 0;
          skPos.set(skKey, inGroupIdx + 1);
        } else {
          inGroupIdx = singlesPos++;
        }
        const file = relativeTo(absPath, vault);
        noteNodes.push({
          id: stableId(file), type: 'file', file,
          x: xCursor + (baseCol + Math.floor(inGroupIdx / MAX_ROWS_PER_COL)) * CELL_W,
          y: NOTE_Y_OFFSET + (inGroupIdx % MAX_ROWS_PER_COL) * CELL_H,
          width: CANVAS_W, height: CANVAS_H,
        });
      }
    }

    prevKey = cluster.key;
  }

  try {
    await writeTextFile(canvasPath, JSON.stringify({ nodes: [...preservedNodes, ...noteNodes], edges }, null, 2));
    appendLog('success', `  🗺  canvas: ${relativeTo(canvasPath, vault)}`);
    return canvasPath;
  } catch (e) {
    appendLog('error', `  ✗  Canvas write failed: ${e}`);
    return null;
  }
}

/* ── Main Obsidian builder ──────────────────────────────────────────────── */

export async function runObsidian(ctx: RunContext, stats: RunStats): Promise<void> {
  const { settings, vocab, appendLog, addIssue, setProgress } = ctx;

  if (!settings.vaultFolder) {
    appendLog('error', '  Vault folder not set — skipping Obsidian build.');
    return;
  }
  if (!settings.sourceFolder) {
    appendLog('error', '  Source folder not set — skipping Obsidian build.');
    return;
  }

  appendLog('section', '━━━ DAM / OBSIDIAN ━━━');
  appendLog('dim', `  → ${settings.vaultFolder}`);

  const vocabMap = buildVocabContext(vocab);
  const damFolder = await join(settings.vaultFolder, '05 DAM');
  const damRoot   = await join(damFolder, '01 EXPORTS');
  const canvasDir = damFolder; // flat _X canvases at DAM root for easy access
  const attRoot   = await join(settings.vaultFolder, '10 ATTACHMENTS');
  const width     = parseInt(String(settings.thumbWidth),  10) || 320;
  const quality   = parseInt(String(settings.thumbQuality), 10) || 70;

  appendLog('dim', `  DAM root: ${damRoot}`);
  appendLog('dim', `  Canvases: ${canvasDir}`);

  const anchors = await findPackageAnchors(settings.sourceFolder, settings);
  appendLog('dim', `  Anchors (${anchors.length}): ${anchors.map(a => a.split('/').pop()).join(', ') || 'none'}`);

  const outDirs = await collectOutDirInfos(settings.sourceFolder, damRoot, anchors, settings);

  if (!outDirs.length) {
    appendLog('dim', `  No "${settings.outFolder}" folders found — check source folder and out-folder name in Settings.`);
    appendLog('section', '━━━ OBSIDIAN DONE — 0 notes ━━━');
    return;
  }

  appendLog('info', `  Found ${outDirs.length} output folder(s)`);
  const total = outDirs.length;

  const noteSourceMap = new Map<string, [string[], string[]]>();
  const liveNotePaths = new Set<string>();
  const noteBases     = new Set<string>(); // one canvas per scope anchor

  for (let idx = 0; idx < outDirs.length; idx++) {
    const { outPath, isOrphan, noteBase, projRel, clusterKey, sortKey } = outDirs[idx];
    noteBases.add(noteBase);
    appendLog('info', `  📁 ${projRel || '(root)'} → ${noteBase.split('/').pop()}`);

    const entries = await listDir(outPath);

    // Identify gallery subdirs
    const galleryNames = new Set<string>();
    for (const e of entries) {
      if (e.isDirectory && !e.name.startsWith('.') && !shouldSkip(e.name, settings)) {
        if (await isGalleryFolder(await join(outPath, e.name), vocabMap)) galleryNames.add(e.name);
      }
    }

    const relParts = pathParts(projRel);
    const noteDir  = relParts.length
      ? await join(noteBase, ...relParts)
      : noteBase;
    await mkdir(noteDir, { recursive: true }).catch(() => {});

    // ── Gallery notes ─────────────────────────────────────────────────────
    for (const gName of galleryNames) {
      const gPath      = await join(outPath, gName);
      const gParsed    = parseFilename(gName, vocabMap);
      const title      = buildNoteName(gParsed);
      const safe       = safeName(title);
      const icon       = gParsed.tags.find(t => t.icon)?.icon || '';
      const noteFileName = `${icon ? icon + ' ' : ''}${safe}.md`;
      const notePath     = await join(noteDir, noteFileName);
      const exportName   = translateExportName(gName, '', vocabMap);

      liveNotePaths.add(notePath);
      noteSourceMap.set(notePath, [clusterKey, sortKey]);

      // Gallery thumb: first thumbnable file in the gallery folder
      let thumbName: string | null = null;
      const firstThumb = await galleryFirstThumbnable(gPath);
      if (firstThumb) {
        thumbName = await ensureThumb(firstThumb, `${safe}-thumb.webp`, attRoot, width, quality);
      }

      if (await fileExists(notePath)) {
        try {
          const existing = await readTextFile(notePath);
          const { content: patched, changed } = patchMeta(existing, gParsed, projRel, thumbName, gPath);
          if (changed) {
            await writeTextFile(notePath, patched);
            appendLog('success', `    ↑  updated: ${noteFileName}`);
            stats.notes += 1;
          } else {
            appendLog('dim', `    ↷  unchanged: ${noteFileName}`);
          }
        } catch (e) {
          appendLog('error', `    ✕  patch failed: ${noteFileName} — ${e}`);
          stats.errors += 1;
        }
      } else {
        try {
          await writeTextFile(notePath, makeNote(gParsed, gName, projRel, exportName || null, thumbName, gPath));
          appendLog('success', `    ✓  gallery note: ${noteFileName}`);
          stats.notes += 1;
        } catch (e) {
          appendLog('error', `    ✕  note write failed: ${noteFileName} — ${e}`);
          addIssue({ category: 'error', file: noteFileName, reason: String(e) });
          stats.errors += 1;
        }
      }
    }

    // ── Asset files ───────────────────────────────────────────────────────
    const assetFiles = entries.filter(
      e => e.isFile && isPublishable(e.name) && !e.name.includes('-thumb')
        && !e.name.startsWith('.') && !shouldSkip(e.name, settings)
    );

    // WIP placeholder for empty non-orphan OUT folders
    if (!assetFiles.length && !galleryNames.size && !isOrphan) {
      const parentName  = projRel.split('/').pop() || '';
      const cleanName   = parentName.replace(/^\[\d+\]\s*/, '') || parentName;
      const wipFileName = `⏳ ${safeName(cleanName)}.md`;
      const wipPath     = await join(noteDir, wipFileName);
      liveNotePaths.add(wipPath);
      noteSourceMap.set(wipPath, [clusterKey, sortKey]);
      if (!await fileExists(wipPath)) {
        const today   = new Date().toISOString().split('T')[0];
        const content = `---\n---\n\n#dam #dam/wip\n\n| Field | Value |\n| --- | --- |\n| Created | ${today} |\n| Status | Work in progress |\n<!-- dam:source_path:"${projRel}" -->\n\n#### Notes\n\n`;
        await writeTextFile(wipPath, content).catch(() => {});
        appendLog('dim', `    ⏳ WIP: ${wipFileName}`);
      }
    }

    for (const file of assetFiles) {
      const stem       = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
      const ext        = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
      const parsed     = parseFilename(stem, vocabMap);
      const title      = buildNoteName(parsed);
      const safe       = safeName(title);
      const icon       = parsed.tags.find(t => t.icon)?.icon || '';
      const noteFileName = `${icon ? icon + ' ' : ''}${safe}.md`;
      const notePath     = await join(noteDir, noteFileName);
      const exportName   = translateExportName(stem, ext, vocabMap);
      const stemCloudUrls = ctx.cloudUrls?.get(stem);

      liveNotePaths.add(notePath);
      noteSourceMap.set(notePath, [clusterKey, sortKey]);

      // Copy pre-existing -thumb.webp → ATTACHMENTS
      let thumbName: string | null = null;
      const preExistingThumb = await join(outPath, `${stem}-thumb.webp`);
      if (await fileExists(preExistingThumb)) {
        const thumbDestName = `${safe}-thumb.webp`;
        const thumbDest     = await join(attRoot, thumbDestName);
        try {
          await mkdir(attRoot, { recursive: true });
          if (!await isUnchanged(preExistingThumb, thumbDest)) await copyFile(preExistingThumb, thumbDest);
          thumbName = thumbDestName;
        } catch { /* skip */ }
      }

      if (await fileExists(notePath)) {
        try {
          const existing = await readTextFile(notePath);
          const { content: patched, changed } = patchMeta(existing, parsed, projRel, thumbName, outPath, stemCloudUrls);
          if (changed) {
            await writeTextFile(notePath, patched);
            appendLog('success', `    ↑  updated: ${noteFileName}`);
            stats.notes += 1;
          } else {
            appendLog('dim', `    ↷  unchanged: ${noteFileName}`);
          }
        } catch (e) {
          appendLog('error', `    ✕  patch failed: ${noteFileName} — ${e}`);
          stats.errors += 1;
        }
      } else {
        try {
          await writeTextFile(notePath, makeNote(parsed, file.name, projRel, exportName, thumbName, outPath, stemCloudUrls));
          appendLog('success', `    ✓  note: ${noteFileName}`);
          stats.notes += 1;
        } catch (e) {
          appendLog('error', `    ✕  note write failed: ${noteFileName} — ${e}`);
          addIssue({ category: 'error', file: noteFileName, reason: String(e) });
          stats.errors += 1;
        }
      }
    }

    setProgress(Math.round(((idx + 1) / total) * 100));
  }

  // ── Shared trash helpers ──────────────────────────────────────────────
  const trashDir = await join(settings.vaultFolder, '05 DAM', '🗑 Trash');
  let trashCreated = false;
  let disconnectedCount = 0;

  async function ensureTrash() {
    if (!trashCreated) { await mkdir(trashDir, { recursive: true }); trashCreated = true; }
  }

  async function trashItem(absPath: string, reason: string) {
    const name = absPath.split('/').pop()!;
    await ensureTrash();
    const destPath = await join(trashDir, `🚫 ${name}`);
    await rename(absPath, destPath);
    const rel = absPath.replace(damRoot, '').replace(/^\//, '');
    appendLog('disconnected', `  🚫 DISCONNECTED: ${rel}`);
    addIssue({ category: 'disconnected', file: rel, reason });
    disconnectedCount += 1;
    stats.disconnected += 1;
  }

  // ── Pass 1: orphaned notes → trash (BEFORE canvas generation) ─────────
  // Must run first so collectNotes in updateDamCanvas only sees current notes.
  if (await fileExists(damRoot)) {
    async function walkOrphanNotes(dir: string) {
      for (const e of await listDir(dir)) {
        const childPath = await join(dir, e.name);
        if (e.isDirectory) {
          await walkOrphanNotes(childPath);
        } else if (e.isFile && e.name.endsWith('.md') && !e.name.startsWith('🚫')) {
          if (!liveNotePaths.has(childPath)) {
            try {
              const content = await readTextFile(childPath);
              if (!content.toLowerCase().includes('#disconnected')) {
                await writeTextFile(childPath, content.trimEnd() + '\n#disconnected\n');
              }
            } catch { /* ignore */ }
            try { await trashItem(childPath, 'Source removed — moved to Trash'); } catch (err) {
              appendLog('error', `  ✗  Could not move disconnected note: ${err}`);
            }
          }
        }
      }
    }
    await walkOrphanNotes(damRoot);
  }

  // ── Canvas — one per scope, written flat into 05 DAM/ ─────────────────
  appendLog('dim', `  Canvas bases (${noteBases.size}): ${[...noteBases].map(f => f.split('/').pop()).join(', ') || 'none'}`);
  const liveCanvasPaths = new Set<string>();
  for (const folder of [...noteBases].sort()) {
    try {
      const cp = await updateDamCanvas(folder, canvasDir, settings.vaultFolder, noteSourceMap, appendLog);
      if (cp) {
        liveCanvasPaths.add(cp);
      } else {
        appendLog('dim', `  ⚠  No notes for canvas: ${folder.split('/').pop()} (${folder})`);
      }
    } catch (e) {
      appendLog('error', `  ✗  Canvas failed for ${folder.split('/').pop()}: ${e}`);
    }
  }

  // ── Pass 2: orphaned canvases + empty folders (AFTER canvas generation) ─
  // Scan DAM root for live/orphan flat canvases, and EXPORTS tree for leftovers
  // from the old nested placement so they get moved to Trash.
  if (await fileExists(damRoot) || await fileExists(canvasDir)) {
    async function walkOrphanCanvases(dir: string, recurse: boolean) {
      for (const e of await listDir(dir)) {
        if (e.name.startsWith('🗑')) continue; // never touch Trash
        const childPath = await join(dir, e.name);
        if (e.isDirectory) {
          if (recurse) await walkOrphanCanvases(childPath, true);
        } else if (e.isFile && e.name.endsWith('.canvas') && e.name.startsWith('_X ') && !e.name.startsWith('🚫')) {
          if (!liveCanvasPaths.has(childPath)) {
            try { await trashItem(childPath, 'Scope removed — moved to Trash'); } catch (err) {
              appendLog('error', `  ✗  Could not move disconnected canvas: ${err}`);
            }
          }
        }
      }
    }

    async function pruneEmptyDirs(dir: string): Promise<boolean> {
      const entries = await listDir(dir);
      let hasContent = false;
      for (const e of entries) {
        if (e.isDirectory) {
          const childPath = await join(dir, e.name);
          const childEmpty = await pruneEmptyDirs(childPath);
          if (!childEmpty) hasContent = true;
        } else {
          hasContent = true;
        }
      }
      if (!hasContent && dir !== damRoot) {
        try {
          await remove(dir, { recursive: false });
          const rel = dir.replace(damRoot, '').replace(/^\//, '');
          appendLog('dim', `  🗑  removed empty folder: ${rel}`);
        } catch { /* might not be empty due to hidden files */ }
        return true;
      }
      return false;
    }

    await walkOrphanCanvases(canvasDir, false);
    if (await fileExists(damRoot)) {
      await walkOrphanCanvases(damRoot, true);
      await pruneEmptyDirs(damRoot);
    }
  }

  if (disconnectedCount > 0) {
    appendLog('info', `  🗑  ${disconnectedCount} item(s) moved to 05 DAM/🗑 Trash`);
  }

  appendLog('section',
    `━━━ OBSIDIAN DONE — ${stats.notes} notes · ${stats.disconnected} disconnected · ${stats.errors} errors ━━━`
  );
}
