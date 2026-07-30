/* Settings-shaped adapters over the shared naming rules.
 *
 * @dc-hub/domain takes a NamingSettings; the pipeline carries a full AppSettings. These four
 * adapters are the only place that translation happens, so the domain package stays free of
 * desktop's settings shape.
 * 
 * shouldSkip differs from the domain's shouldSkipName by ONE guard: an empty excludeMark here
 * means "skip nothing", where the domain version would make includes('') true for every name.
 * Both behaviours are pinned by tests — do not change one without the other.
 */

import type { AppSettings } from '../../store/settingsStore';
import {
  isOutFolder as namingIsOutFolder,
  isPackageFolder as namingIsPackageFolder,
} from '@dc-hub/domain';

export function shouldSkip(name: string, s: AppSettings): boolean {
  if (name.startsWith('~$')) return true;
  if (name.includes('[99]')) return true;
  // Guarded: an empty mark would make includes('') true for every name.
  return s.excludeMark ? name.includes(s.excludeMark) : false;
}

/** Prefix packages — skipped during OUT-tree walks / collected for nested export. */
export function isPackageFolder(name: string, s: AppSettings): boolean {
  return namingIsPackageFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
  });
}

export function isOutFolder(name: string, s: AppSettings): boolean {
  return namingIsOutFolder(name, {
    packagePrefix: s.packagePrefix,
    outFolder:     s.outFolder,
    excludeMark:   s.excludeMark,
  });
}

export function isPublishableFile(name: string): boolean {
  return name.includes('.') && !name.startsWith('.') && !name.startsWith('~$');
}

export const THUMB_EXTS = new Set(['.pptx', '.pptm', '.ppt', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff']);
