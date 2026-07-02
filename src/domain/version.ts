/* Version parsing — mirrors the Python POC's VERSION_RE logic */

const VERSION_RE = /^(.*?)[-_]?(v(\d+)(?:[.\-](\d+))?(?:[.\-](\d+))?)(\.[^.]+)?$/i;

export interface ParsedVersion {
  base:    string;
  ext:     string;
  version: [number, number, number];
}

export function parseVersion(filename: string): ParsedVersion | null {
  const m = VERSION_RE.exec(filename);
  if (!m) return null;
  return {
    base:    m[1],
    ext:     m[6] ?? '',
    version: [parseInt(m[3] ?? '0'), parseInt(m[4] ?? '0'), parseInt(m[5] ?? '0')],
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
