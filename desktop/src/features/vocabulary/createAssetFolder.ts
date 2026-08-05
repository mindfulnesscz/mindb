/* Seeding a new asset package — where an asset gets its permanent identity.
 *
 * This is the ONLY sanctioned way to create an asset folder, because it is the only path that mints a
 * `stable_id`. Everything downstream keys off it: CDN object keys, ratings, comments, approvals,
 * version history. A folder made by hand in Finder has no identity and the pipeline refuses to sync
 * it — deliberately, since guessing one would risk claiming another asset's history.
 *
 * The collision check is against every stable_id the client already holds, so a fresh asset can never
 * clash with an existing folder — the same approach the identity migration took.
 *
 * What lands on disk:
 *
 *   <name> __<hash>/
 *     IN/  WRK/  OUT/
 *     OUT/<shortcode>      empty placeholder, deliberately EXTENSIONLESS so the pipeline scanner
 *                          ignores it until a real deliverable replaces it
 *     .dchub.json          the manifest, reserving child_id c1 for that placeholder
 *     readme.md            the human/Obsidian-facing mirror
 *
 * Reserving c1 up front is what makes the first real sync UPDATE this asset rather than create a
 * second row beside it.
 */

import { mkdir, writeTextFile } from '@tauri-apps/plugin-fs';
import { generateStableId, appendStableId, type Slot, type VocabTag } from '@sotto/domain';
import { createDraftAsset, fetchExistingStableIds } from '../../services/supabaseService';
import { writeReadme, README_FILENAME } from '../../services/readmeService';

/**
 * SHA-256 of an empty byte array — a well-known constant, no need to compute it. The placeholder
 * seeded into OUT starts empty, so this is its correct manifest hash until the real file replaces it.
 */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

export interface VersionState { major: string; minor: string; patch: string }

export interface CreateAssetFolderInput {
  /** The generated bracket-coded file stem, e.g. "(PRD)(OVW)(DCK) Sealing v1-0-0". */
  stem:         string;
  /** The short folder name the operator typed — never the tag-derived name, never the stem. */
  folderName:   string;
  targetFolder: string;
  selectedTags: VocabTag[];
  description:  string;
  version:      VersionState;
  clientId:     string;
  config:       { url: string; anonKey: string };
  now?:         () => string;
}

export interface CreatedAssetFolder {
  packageDir: string;
  folder:     string;
  stableId:   string;
}

export async function createAssetFolder(input: CreateAssetFolderInput): Promise<CreatedAssetFolder> {
  const { stem, folderName, targetFolder, selectedTags, description, version, clientId, config } = input;
  const now = input.now ?? (() => new Date().toISOString());

  const byLabel = (slot: Slot) => selectedTags.filter(t => t.slot === slot).map(t => t.label);
  const name    = [...selectedTags.map(t => t.label), description.trim()].filter(Boolean).join(' ');
  // A brand-new asset is pre-release until someone versions it deliberately.
  const versionStr = version.major !== ''
    ? `${version.major || '1'}-${version.minor || '0'}-${version.patch || '0'}`
    : '0-1-0';

  const taken    = await fetchExistingStableIds(clientId, config);
  const stableId = generateStableId(taken);
  // Folder names cannot contain parentheses, so the identifier is the typed name — not the stem.
  const folder     = appendStableId(folderName.trim(), stableId);
  const packageDir = `${targetFolder}/${folder}`;

  await mkdir(packageDir, { recursive: true });
  await mkdir(`${packageDir}/IN`, { recursive: true });
  await mkdir(`${packageDir}/WRK`, { recursive: true });
  await mkdir(`${packageDir}/OUT`, { recursive: true });

  await writeTextFile(`${packageDir}/OUT/${stem}`, '');
  await writeTextFile(
    `${packageDir}/.dchub.json`,
    JSON.stringify({
      stable_id: stableId,
      children: { [stem]: { child_id: 'c1', sha256: EMPTY_SHA256 } },
      updated_at: now(),
    }, null, 2),
  );
  await writeReadme(packageDir, {
    name: name || stem, stableId, status: 'draft', version: versionStr, perm: 'internal',
    tags: selectedTags, stats: null,
  });

  try {
    await createDraftAsset({
      clientId, stableId, name: name || stem,
      entities: byLabel('entity'), angles: byLabel('angle'), formats: byLabel('format'),
      tags: selectedTags.map(t => t.label),
      // No primary-tag concept in this flow; the columns stay nullable for whenever that changes.
      primaryEntityId: null, primaryAngleId: null, primaryFormatId: null,
    }, config);
  } catch (e) {
    // The folder is already on disk, so the operator must be told the DB row is the part that
    // failed — otherwise they retry and end up with two folders for one asset.
    throw new Error(
      `Folder + ${README_FILENAME} were created, but the Supabase draft row failed: ${e instanceof Error ? e.message : e}`,
      { cause: e },
    );
  }

  return { packageDir, folder, stableId };
}
