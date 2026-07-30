/* Version parsing — find trailing vMAJOR[.MINOR[.PATCH]] before the extension. */

export interface ParsedVersion {
  base:    string;
  ext:     string;
  version: [number, number, number];
}

const EXT_RE = /^\.[A-Za-z0-9]{1,8}$/;
const VERSION_AT_END_RE = /[vV](\d+)(?:[.\-](\d+))?(?:[.\-](\d+))?$/;

export function parseVersion(filename: string): ParsedVersion | null {
  let stem = filename;
  let ext = '';
  const dot = filename.lastIndexOf('.');
  if (dot > 0 && EXT_RE.test(filename.slice(dot))) {
    stem = filename.slice(0, dot);
    ext = filename.slice(dot);
  }

  const m = VERSION_AT_END_RE.exec(stem);
  if (!m || m.index === undefined) return null;

  const base = stem.slice(0, m.index).replace(/[\s_-]+$/, '');
  return {
    base,
    ext,
    version: [
      parseInt(m[1] ?? '0', 10),
      parseInt(m[2] ?? '0', 10),
      parseInt(m[3] ?? '0', 10),
    ],
  };
}

export function compareVersions(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/* Given a list of filenames, return only the highest version of each base+ext group */
export function filterHighestVersions(filenames: string[]): string[] {
  const groups = new Map<string, { version: [number, number, number]; name: string }>();
  const unversioned: string[] = [];

  for (const name of filenames) {
    const parsed = parseVersion(name);
    if (!parsed) { unversioned.push(name); continue; }
    const key = `${parsed.base.toLowerCase()}|${parsed.ext.toLowerCase()}`;
    const existing = groups.get(key);
    if (!existing || compareVersions(parsed.version, existing.version) > 0) {
      groups.set(key, { version: parsed.version, name });
    }
  }
  return [...unversioned, ...Array.from(groups.values()).map(v => v.name)];
}
