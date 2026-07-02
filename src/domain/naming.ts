/* File/folder naming convention helpers */

/* Default folder convention markers (can be overridden by settings) */
export const DEFAULTS = {
  packagePrefix:  '[00] 📦',
  outFolder:      '[03] OUT',
  excludeMark:    '⦰',
  includeMark:    '🏁',
  filterMode:     'blacklist' as FilterMode,
};

export type FilterMode = 'blacklist' | 'whitelist';

export interface NamingSettings {
  packagePrefix: string;
  outFolder:     string;
  excludeMark:   string;
  includeMark:   string;
  filterMode:    FilterMode;
}

export function shouldSkipName(name: string, s: NamingSettings): boolean {
  if (name.startsWith('~$')) return true;
  if (name.includes('[99]')) return true;
  if (s.filterMode === 'whitelist') return !name.includes(s.includeMark);
  return name.includes(s.excludeMark);
}

export function isPackageFolder(name: string, s: NamingSettings): boolean {
  return name.startsWith(s.packagePrefix);
}

export function isOutFolder(name: string, s: NamingSettings): boolean {
  return name.toLowerCase() === s.outFolder.toLowerCase();
}

export function isPublishableFile(name: string): boolean {
  return name.includes('.') && !name.startsWith('.');
}

export function isThumbFile(stem: string): boolean {
  return stem.includes('-thumb');
}
