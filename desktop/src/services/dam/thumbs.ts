/* Thumbnails for the vault's 10 ATTACHMENTS folder.
 *
 * Prefers an existing `-thumb.webp` from the pipeline and only asks Rust to generate one when it is
 * missing, so a vault rebuild costs no image work for assets the pipeline already handled.
 */

import {
  copyFile, mkdir,
} from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { invoke } from '@tauri-apps/api/core';
import {
  listDir, fileExists, isUnchanged,
} from './fs';

export const GALLERY_THUMB_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff',
  '.pdf', '.pptx', '.pptm', '.ppt',
]);

export async function galleryFirstThumbnable(folder: string): Promise<string | null> {
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
export async function ensureThumb(
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
