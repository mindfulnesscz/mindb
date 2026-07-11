import { writeTextFile } from '@tauri-apps/plugin-fs';
import { buildObsidianTags } from '../domain/vocabulary';
import type { VocabTag } from '../domain/vocabulary';

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
    `_Last synced: ${new Date().toISOString()}_`,
    '',
    '---',
    '_Regenerated automatically on every pipeline run — local edits to this file are overwritten. Identity lives in `.dchub.json`, never here._',
    '',
  ].join('\n');
}

export async function writeReadme(packageDir: string, input: ReadmeInput): Promise<void> {
  await writeTextFile(`${packageDir}/${README_FILENAME}`, buildReadme(input));
}
