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

/** Strip optional `[NN] ` workflow prefix (migration / Vocabulary leave plain OUT). */
export function stripWorkflowPrefix(name: string): string {
  return name.replace(/^\[\d+\]\s*/, '').trim();
}

/**
 * Package folder match. Settings may store just `📦` while disks still use
 * `[00] 📦 Name` — require the configured marker after stripping `[NN] `, not
 * a brittle startsWith on the raw name.
 */
export function isPackageFolder(name: string, s: NamingSettings): boolean {
  const prefix = (s.packagePrefix || '').trim();
  if (!prefix) return false;
  if (name.startsWith(prefix)) return true;
  const strippedName = stripWorkflowPrefix(name);
  const strippedPrefix = stripWorkflowPrefix(prefix);
  if (strippedPrefix && strippedName.startsWith(strippedPrefix)) return true;
  if (strippedName.startsWith(prefix)) return true;
  // Prefix set to `[00] 📦` but folder is `📦 Name`
  if (strippedPrefix && name.startsWith(strippedPrefix)) return true;
  return false;
}

/**
 * OUT folder match — exact, or after stripping `[03] ` so settings `[03] OUT`
 * still match a migrated `OUT` directory (and the reverse).
 */
export function isOutFolder(name: string, s: NamingSettings): boolean {
  const want = stripWorkflowPrefix(s.outFolder || 'OUT').toLowerCase();
  const got  = stripWorkflowPrefix(name).toLowerCase();
  return got === want || got === 'out';
}

export function isPublishableFile(name: string): boolean {
  return name.includes('.') && !name.startsWith('.');
}

export function isThumbFile(stem: string): boolean {
  return stem.includes('-thumb');
}
