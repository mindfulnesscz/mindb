/* Where a source file lands on a cloud DESTINATION — the naming half of the export.
 *
 * Split out of cloudExport so the re-layout mover (services/cloud/gdriveRelayout.ts) can ask the
 * same question the uploader asks, rather than reimplementing it. The mover's whole correctness
 * rests on computing a file's OLD remote path and its NEW one with identical rules; a second copy
 * of these would plan moves from paths nothing was ever written to.
 *
 * `deliveryLayout.ts` answers the same question for a LOCAL destination and for the `source`
 * layout's tree; this module is the remote-name layer over it — vocabulary translation, the layout
 * choice, and Drive's split of a path into folder + file name.
 */

import { buildVocabMap, translateExportName, stripWorkflowPrefix, isArtifactPath } from '@sotto/domain';
import type { AppSettings } from '../../store/settingsStore';
import type { DestExportLayout } from '../../domain/client';
import { deliveredRelDir } from './deliveryLayout';
import { keepOnlyHighestVersions } from './packages';

export type CloudFileJob = {
  srcPath: string;
  stem: string;
  ext: string;
  fileName: string;
  /** `folders`: the path below the OUT folder — a gallery, or nothing. */
  relativeDir: string;
  /** `source`: the full delivered tree, identical to what a local destination receives. */
  sourceDir: string;
  /** When set, used as the full remote relative path (package mode). */
  nestedOverride: string | null;
}

export interface RemoteNames {
  /** Path relative to the destination's remote root — the upload cache's key, and what the log shows. */
  nestedName:       string;
  /** Drive addresses folders, not paths: the absolute-ish folder path to resolve or create. */
  gdriveFolderPath: string;
  gdriveFileName:   string;
}

/** The containing folder a job is delivered into, chosen by the destination's layout. Both trees
 *  are computed once per file when the jobs are built; this only picks between them. */
export function jobDirFor(job: CloudFileJob, layout: DestExportLayout): string {
  if (layout === 'flat')   return '';
  if (layout === 'source') return job.sourceDir;
  return job.relativeDir;
}

/** Where one job lands remotely. Shared so the Drive folder pre-resolve targets exactly the folders
 *  the upload loop will ask for — two copies of these rules would pre-warm the wrong tree. */
export function remoteNamesFor(
  job: CloudFileJob,
  vocabMap: ReturnType<typeof buildVocabMap>,
  layout: DestExportLayout,
  remotePath: string,
): RemoteNames {
  const { stem, ext, nestedOverride } = job;
  const dir = jobDirFor(job, layout);
  const translated = nestedOverride
    ? nestedOverride.split('/').pop()!
    : translateExportName(stem, ext, vocabMap);
  const nestedName = nestedOverride
    ?? (dir ? `${dir}/${translated}` : translated);
  const base = remotePath.replace(/\/$/, '');
  const sub = nestedOverride
    ? nestedName.split('/').slice(0, -1).join('/')
    : dir;
  const gdriveFolderPath = nestedOverride || sub
    ? [base, sub].filter(Boolean).join('/')
    : remotePath;
  return {
    nestedName,
    gdriveFolderPath,
    gdriveFileName: nestedOverride ? nestedName.split('/').pop()! : translated,
  };
}

export function relativeUnderOut(
  srcPath: string,
  outFolderName: string,
): { dir: string; fileName: string } {
  const parts = srcPath.replace(/\\/g, '/').split('/');
  let outIdx = -1;
  for (let i = parts.length - 1; i >= 0; i--) {
    const want = stripWorkflowPrefix(outFolderName || 'OUT').toLowerCase();
    const got  = stripWorkflowPrefix(parts[i]).toLowerCase();
    if (got === want || got === 'out') { outIdx = i; break; }
  }
  const fileName = parts[parts.length - 1] ?? '';
  if (outIdx < 0) return { dir: '', fileName };
  const relative = parts.slice(outIdx + 1);
  if (relative.length <= 1) return { dir: '', fileName };
  return { dir: relative.slice(0, -1).join('/'), fileName };
}

/**
 * One job per collected OUT asset, carrying BOTH folder trees.
 *
 * Derived once per run and per re-layout scan: the run may hold destinations on different layouts,
 * and re-deriving per destination would be the same work N times. `sourceDir` falls back to the
 * OUT-relative tree when there is no source folder to be relative to — there is nothing to guess
 * from, and inventing a folder is worse than delivering to the root.
 */
export function buildCloudFileJobs(srcPaths: string[], settings: AppSettings): CloudFileJob[] {
  const outFolder = settings.outFolder || 'OUT';
  return srcPaths.map(srcPath => {
    const fileName = srcPath.split('/').pop()!;
    const dotIdx   = fileName.lastIndexOf('.');
    const ext      = dotIdx > 0 ? fileName.slice(dotIdx) : '';
    const stem     = dotIdx > 0 ? fileName.slice(0, dotIdx) : fileName;
    const { dir: relativeDir } = relativeUnderOut(srcPath, outFolder);
    const sourceDir = settings.sourceFolder
      ? deliveredRelDir(settings.sourceFolder, srcPath, settings)
      : relativeDir;
    return {
      srcPath, stem, ext, fileName, relativeDir, sourceDir,
      nestedOverride: null as string | null,
    };
  });
}

/** THE EXPORT BOUNDARY, as a filter over jobs: a destination receives assets, never a thumbnail,
 *  a previews folder or a render cache. Applied against the path about to be uploaded. */
export function assetJobsOnly(jobs: CloudFileJob[]): { kept: CloudFileJob[]; dropped: number } {
  const kept = jobs.filter(job =>
    !isArtifactPath(job.nestedOverride ?? `${job.relativeDir}/${job.fileName}`));
  return { kept, dropped: jobs.length - kept.length };
}

/**
 * The OUT jobs a cloud export would send for a library — highest version only, artifacts held back.
 *
 * The re-layout mover has to reason about the exact set of files the export delivers: a job it does
 * not know about is a remote file it would leave behind at the old path, and a job the export would
 * never send is a move planned against nothing. So both call this rather than each assembling the
 * list from the same three steps in the same order and hoping.
 */
export function cloudExportJobs(
  srcPaths: string[],
  settings: AppSettings,
): { jobs: CloudFileJob[]; droppedVersions: string[]; droppedArtifacts: number } {
  const { kept: current, dropped: droppedVersions } = keepOnlyHighestVersions(srcPaths);
  const { kept: jobs, dropped: droppedArtifacts } = assetJobsOnly(buildCloudFileJobs(current, settings));
  return { jobs, droppedVersions, droppedArtifacts };
}
