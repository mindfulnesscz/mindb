/* Where a source file lands in a DELIVERED tree — one set of rules, two stages.
 *
 * The local publish walks the source tree and builds each target path as it descends; the cloud
 * export has only a flat list of absolute source paths and has to derive the same answer. Those
 * were two independent implementations of "what the client sees", and they disagreed: publish
 * mirrored the whole source tree, cloud export kept only the part BELOW the OUT folder, so a
 * deliverable with no gallery landed at the destination root and its package folder was lost.
 * Both meanings are legitimate — that is why `exportLayout` now names them apart (`source` vs
 * `folders`) — but there must be exactly ONE definition of each.
 *
 * The rules encoded here are the publish walk's, read off `runPublish`:
 *   - a segment ABOVE the OUT folder keeps its name with the `__<8hex>` identity suffix stripped,
 *     because identity is internal and never shown to a client;
 *   - the OUT segment itself DISAPPEARS — it is the machinery, not a folder anyone receives;
 *   - a segment BELOW OUT (a gallery) is passed through verbatim, exactly as `publishDir` does.
 *
 * Pure string work over paths that already came from a folder picker or `readDir`, so it does not
 * touch the filesystem and cannot be told about one that is not in the path.
 */

import type { AppSettings } from '../../store/settingsStore';
import { stripStableId } from '@sotto/domain';
import { isOutFolder } from './naming';

/** Path segments of `absPath` relative to `sourceRoot`, untouched. Empty when it is the root. */
export function sourceRelativeSegments(sourceRoot: string, absPath: string): string[] {
  const root = sourceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const abs  = absPath.replace(/\\/g, '/').replace(/\/+$/, '');
  let rel: string;
  if (abs === root) {
    rel = '';
  } else if (abs.startsWith(root + '/')) {
    rel = abs.slice(root.length + 1);
  } else {
    // Fallback: find root as a path prefix (handles mild join/realpath drift).
    const idx = abs.toLowerCase().indexOf(root.toLowerCase() + '/');
    rel = idx >= 0 ? abs.slice(idx + root.length + 1) : (abs.split('/').pop() ?? '');
  }
  return rel.split('/').filter(Boolean);
}

/** Relative path from source root → target, stripping stable-id suffixes on ancestors. */
export function nestedPublishRel(sourceRoot: string, absPath: string): string {
  return sourceRelativeSegments(sourceRoot, absPath)
    .map(seg => stripStableId(seg))
    .join('/');
}

/**
 * The folder one source FILE is delivered into, relative to the destination root, for the
 * `source` layout — the same folder `runPublish` copies it to under a local destination.
 *
 * `''` means the destination root: a file directly inside a source-root OUT folder has no
 * containing folder to preserve.
 */
export function deliveredRelDir(
  sourceRoot: string,
  absFilePath: string,
  settings: AppSettings,
): string {
  const segments = sourceRelativeSegments(sourceRoot, absFilePath).slice(0, -1); // drop the file
  const outIdx = segments.findIndex(seg => isOutFolder(seg, settings));
  if (outIdx < 0) {
    // No OUT segment: the caller is holding a path the scan could not have produced. Stripping
    // identity from every segment is the closest safe answer — it never invents a folder.
    return segments.map(seg => stripStableId(seg)).join('/');
  }
  return [
    ...segments.slice(0, outIdx).map(seg => stripStableId(seg)),
    ...segments.slice(outIdx + 1),
  ].join('/');
}
