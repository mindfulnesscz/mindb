/* DAM / Obsidian vault builder — the orchestrator.
 *
 * Turns the source tree into an Obsidian vault: one note per asset (or per gallery), thumbnails in
 * 10 ATTACHMENTS, and one canvas per note folder. `runObsidian` walks the scopes and delegates;
 * everything it delegates to lives in ./dam/*:
 *
 *   paths         pure path helpers + the deterministic canvas node id
 *   fs            filesystem helpers and the settings-shaped naming adapters
 *   scope         which folders are covered, and the vault self-consumption guard
 *   scan          source tree → the OUT folders worth a note (gallery ⇒ one note)
 *   notes         note body construction and IN-PLACE patching (preserves user edits)
 *   thumbs        attachment thumbnails, reusing the pipeline's where possible
 *   canvasLayout  canvas geometry
 *   canvas        writing the canvas, preserving nodes outside the current scope
 */

import { writeTextFile, readTextFile, copyFile, mkdir, rename, remove } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import type { RunStats } from '../store/pipelineStore';
import type { RunContext } from './pipeline/types';
import {
  assetIdentityKey, buildVocabMap, parseFilename, buildNoteName, translateExportName,
} from '@sotto/domain';
import { pathParts, safeName, isPublishable } from './dam/paths';
import { listDir, fileExists, isUnchanged, shouldSkip } from './dam/fs';
import { findPackageAnchors } from './dam/scope';
import { collectOutDirInfos, isGalleryFolder } from './dam/scan';
import { makeNote, patchMeta } from './dam/notes';
import { galleryFirstThumbnable, ensureThumb } from './dam/thumbs';
import { updateDamCanvas } from './dam/canvas';

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

  if (settings.dryRun) {
    appendLog('dim', '  [DRY] would rebuild DAM notes, attachments, and canvases');
    return;
  }

  const vocabMap = buildVocabMap(vocab);
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
    if (ctx.isStopping?.()) return;
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
      if (ctx.isStopping?.()) return;
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
      if (ctx.isStopping?.()) return;
      const stem       = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
      const ext        = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
      const parsed     = parseFilename(stem, vocabMap);
      const title      = buildNoteName(parsed);
      const safe       = safeName(title);
      const icon       = parsed.tags.find(t => t.icon)?.icon || '';
      const noteFileName = `${icon ? icon + ' ' : ''}${safe}.md`;
      const notePath     = await join(noteDir, noteFileName);
      const exportName   = translateExportName(stem, ext, vocabMap);
      const assetPath    = await join(outPath, file.name);
      const identity     = ctx.cdnIdentity?.get(assetPath);
      const assetCloudUrls = identity
        ? ctx.cloudUrls?.get(assetIdentityKey(identity.stableId, identity.childId))
        : undefined;

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
          const { content: patched, changed } = patchMeta(existing, parsed, projRel, thumbName, outPath, assetCloudUrls);
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
          await writeTextFile(notePath, makeNote(parsed, file.name, projRel, exportName, thumbName, outPath, assetCloudUrls));
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
