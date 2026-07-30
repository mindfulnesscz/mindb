/* Local R2 upload cache, and the public URL shape.
 *
 * A mtime+size fast path so an unchanged file skips hashing AND the network entirely. A stale
 * entry can only cause an unnecessary-but-correct re-upload, never stale content served.
 * 
 * NOTE: the cache is memoised in module state (r2CacheMemo) and there is no reset — tests must use
 * distinct object keys per case rather than expecting isolation.
 */

import { readTextFile, writeTextFile, exists } from '@tauri-apps/plugin-fs';
import { join, appDataDir } from '@tauri-apps/api/path';

export interface R2CacheEntry { mtimeMs: number; size: number; sha256: string }
export type R2Cache = Record<string, R2CacheEntry>;

let r2CacheMemo: R2Cache | null = null;

async function getR2CachePath(): Promise<string> {
  return await join(await appDataDir(), 'r2-upload-cache.json');
}

export async function loadR2Cache(): Promise<R2Cache> {
  if (r2CacheMemo) return r2CacheMemo;
  try {
    const path = await getR2CachePath();
    r2CacheMemo = (await exists(path)) ? JSON.parse(await readTextFile(path)) : {};
  } catch {
    r2CacheMemo = {};
  }
  return r2CacheMemo!;
}

export async function saveR2Cache(cache: R2Cache): Promise<void> {
  try {
    await writeTextFile(await getR2CachePath(), JSON.stringify(cache));
  } catch { /* best-effort — worst case is a slower next run, not incorrect behavior */ }
}

export function r2CacheKey(bucket: string, objectKey: string): string {
  return `${bucket}::${objectKey}`;
}

export function rememberR2Upload(
  cache: R2Cache, bucket: string, objectKey: string, mtimeMs: number, size: number, sha256: string,
): void {
  cache[r2CacheKey(bucket, objectKey)] = { mtimeMs, size, sha256 };
}

export function r2PublicUrl(publicDomain: string, objectKey: string, contentHash?: string): string {
  const base = `${publicDomain.replace(/\/+$/, '')}/${objectKey}`;
  if (!contentHash) return base;
  return `${base}?v=${contentHash.slice(0, 12)}`;
}

