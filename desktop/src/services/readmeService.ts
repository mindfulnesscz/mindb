import { readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { buildObsidianTags, type VocabTag } from '@sotto/domain';

export const README_FILENAME = 'readme.md';

export interface AssetStatsSnapshot {
  downloads:     number;
  views:         number;
  avgRating:     number;
  ratingCount:   number;
  commentCount:  number;
}

export interface ReadmeInput {
  name:       string;
  stableId:   string;
  status:     string;
  version:    string;
  perm:       string;
  tags:       VocabTag[];
  stats:      AssetStatsSnapshot | null; // null for a brand-new draft asset (Task 6) — no stats yet
}

/**
 * Human/Obsidian-facing mirror of the DB, regenerated in full on every pipeline run.
 * NEVER read by the pipeline for identity — that's .dchub.json's job (see supabaseService.ts).
 * Unlike damService.ts's vault notes, this always fully overwrites; local edits are lost by design.
 *
 * The output is a pure function of `input` — no wall clock. It used to carry a `_Last synced_`
 * timestamp, which made every run's content differ from the file already on disk and so rewrote
 * every readme.md in the client's synced Dropbox tree, every run. `writeReadme` can only skip
 * unchanged files if this stays deterministic; do not reintroduce a clock, a random id, or
 * anything else that varies between two runs over identical data.
 */
export function buildReadme(input: ReadmeInput): string {
  const tags        = buildObsidianTags(input.tags).map(t => `#${t}`).join(' ');
  const statsSection = input.stats
    ? [
        '## Stats',
        `- Views: ${input.stats.views}`,
        `- Downloads: ${input.stats.downloads}`,
        `- Rating: ${input.stats.avgRating.toFixed(1)} (${input.stats.ratingCount} rating${input.stats.ratingCount === 1 ? '' : 's'})`,
        `- Comments: ${input.stats.commentCount}`,
      ].join('\n')
    : '## Stats\n\n_Not yet published — no stats yet._';

  return [
    `# ${input.name}`,
    '',
    `**Status:** ${input.status} · **Version:** ${input.version || '—'} · **Permission:** ${input.perm}`,
    `**Stable ID:** \`${input.stableId}\``,
    '',
    tags,
    '',
    statsSection,
    '',
    '---',
    '_Regenerated automatically on every pipeline run — local edits to this file are overwritten. Identity lives in `.dchub.json`, never here._',
    '',
  ].join('\n');
}

/**
 * Writes readme.md only when its contents would change. Returns true if it wrote.
 *
 * Every package folder gets one of these, and they live in the client's SYNCED Dropbox source
 * tree — so an unconditional write hands Dropbox hundreds of tiny changed files to re-upload after
 * every run, and churns the mtime of the source of truth for nothing. The file on disk is the
 * comparison, not a cache of what we wrote last time: a teammate's edit or deletion must still be
 * healed by the next run.
 */
export async function writeReadme(packageDir: string, input: ReadmeInput): Promise<boolean> {
  const path     = `${packageDir}/${README_FILENAME}`;
  const content  = buildReadme(input);
  // Missing, unreadable or garbled — all mean "write it"; the read is only ever an optimisation.
  const existing = await readTextFile(path).catch(() => null);
  if (existing === content) return false;
  await writeTextFile(path, content);
  return true;
}
