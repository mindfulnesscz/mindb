/* LAYOUT MIGRATION — move a pre-3.2.2 library's loose render artifacts into `thumbnails/`.
 *
 * Before 3.2.2 every artifact sat directly beside its source: `<stem>-thumb.webp`, its
 * `<stem>-thumb.webp.json` cache, and a `<stem>-thumb/` folder of page previews. An OUT folder with
 * three images held nine visible entries for three deliverables. They now live in one `thumbnails/`
 * folder beside the assets they serve — see `@sotto/domain`'s artifactLayout for the rule.
 *
 * This is a MOVE, and both halves of that matter:
 *
 *   NO RE-RENDER. Each manifest travels with the artifact it describes, so the cache still matches
 *   after the move and the next `generate_*` call reports `cached`. A delete-and-regenerate would
 *   cost ~6.4s per Office document across the whole library.
 *
 *   NO CDN TRAFFIC. R2 keys are built from folder identity, never from a local path
 *   (`cdnUpload.ts`), so moving a file locally changes no object key, orphans nothing, and does not
 *   interact with the prune guard.
 *
 * The safety rules, which is why this is not a rename loop:
 *   - only entries `legacyArtifactMove` positively classifies are touched; anything else, including
 *     every real asset, is left exactly where it is;
 *   - only directories that hold scanned ASSETS are visited — the migration never wanders;
 *   - an occupied destination is never overwritten. The already-migrated copy is the current one.
 */

import { mkdir, rename, exists } from '@tauri-apps/plugin-fs';
import {
  legacyArtifactMove, LEGACY_PAGES_MANIFEST, PAGES_MANIFEST, artifactDir,
} from '@sotto/domain';
import type { RunContext, RunStats } from './types';
import { listDir } from './fs';
import { timePhase } from './timing';

/** The asset folders this run actually saw — artifacts only ever belong beside real assets. */
function assetDirsOf(assets: readonly string[]): string[] {
  const dirs = new Set<string>();
  for (const path of assets) {
    const cut = path.lastIndexOf('/');
    if (cut > 0) dirs.add(path.slice(0, cut));
  }
  return [...dirs].sort();
}

export async function runArtifactMigration(ctx: RunContext, stats: RunStats): Promise<void> {
  const { appendLog, settings } = ctx;
  const dirs = assetDirsOf(ctx.collectedAssets ?? []);
  if (!dirs.length) return;
  const phase = timePhase('ARTIFACT MIGRATION');

  let moved = 0;
  let kept = 0;
  let errors = 0;

  for (const dir of dirs) {
    if (ctx.isStopping?.()) return;
    const entries = await listDir(dir);
    const legacy = entries.flatMap(e => {
      const move = legacyArtifactMove(e.name, !!e.isDirectory);
      return move ? [move] : [];
    });
    if (!legacy.length) continue;

    if (settings.dryRun) {
      appendLog('dim', `  [DRY] would move ${legacy.length} render artifact(s) into ${dir}/thumbnails/`);
      moved += legacy.length;
      continue;
    }

    try {
      await mkdir(artifactDir(dir), { recursive: true });
    } catch (e) {
      appendLog('warn', `  ⚠  could not create ${dir}/thumbnails/ — artifacts left in place: ${e}`);
      errors += 1;
      continue;
    }

    for (const move of legacy) {
      const from = `${dir}/${move.from}`;
      const to = `${dir}/${move.to}`;
      try {
        if (await exists(to)) {
          // Already migrated. The copy at the destination is the current one; the leftover is not
          // worth deleting from here — the mirror purges and the CDN GC own that.
          kept += 1;
          continue;
        }
        await rename(from, to);
        moved += 1;
        // The previews manifest travels inside the folder that just moved, still under its old
        // visible name. Hide it in place, or the very next run re-renders the document.
        if (move.kind === 'pages') {
          const legacyManifest = `${to}/${LEGACY_PAGES_MANIFEST}`;
          if (await exists(legacyManifest)) {
            await rename(legacyManifest, `${to}/${PAGES_MANIFEST}`);
          }
        }
      } catch (e) {
        appendLog('warn', `  ⚠  could not move ${move.from} into thumbnails/: ${e}`);
        errors += 1;
      }
    }
  }

  /* An already-migrated library reports nothing, as before — but the sweep still listed every
     asset folder, so the timeline records what that cost even when there is no line to attach it to. */
  if (!moved && !kept && !errors) { phase.done(); return; }

  stats.errors += errors;
  appendLog('info',
    `  ⇄  artifact layout: ${moved} moved into thumbnails/`
    + `${kept ? ` · ${kept} already migrated` : ''}${errors ? ` · ${errors} error(s)` : ''}`
    + ` in ${phase.done()}`);
}
