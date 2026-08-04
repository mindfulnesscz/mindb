/* Settings-shaped adapters over the shared naming rules.
 *
 * @sotto/domain takes a NamingSettings; the pipeline carries a full AppSettings. These four
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
} from '@sotto/domain';

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

/* What the Rust render layer can actually decode. Video is deliberately absent — adding it would not
   produce video thumbnails, it would produce one error per video per run. A video's still comes from
   Cloudflare Stream instead, built from `stream_uid` in the portal. */
export const THUMB_EXTS = new Set([
  '.pptx', '.pptm', '.ppt',                                    // presentations
  '.docx', '.docm', '.doc',                                    // text documents
  '.xlsx', '.xlsm', '.xls',                                    // spreadsheets
  '.pdf',
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff',   // rasters
]);

/* Types that get a folder of per-page previews beside the title thumbnail, for the web portal.
   A subset of THUMB_EXTS: rasters are a single page by definition.

   Spreadsheets ARE here, but the Rust side caps them at one page (`render::page_budget`) — a wide
   sheet printed to PDF paginates into dozens of near-empty slices, so the full allowance would
   render useless images. They go through this path rather than the plain thumbnail one so that a
   spreadsheet still gets its manifest and is reported consistently with every other document. */
export const PAGE_PREVIEW_EXTS = new Set([
  '.pptx', '.pptm', '.ppt',
  '.docx', '.docm', '.doc',
  '.xlsx', '.xlsm', '.xls',
  '.pdf',
]);

/* Pages previewed per document when the client row does not say. Mirrors the column default in the
   migration that adds `clients.preview_page_limit`; change both together. */
export const DEFAULT_PREVIEW_PAGE_LIMIT = 50;

/** Lowercased extension including the dot, or '' when there is none. */
export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot).toLowerCase() : '';
}
