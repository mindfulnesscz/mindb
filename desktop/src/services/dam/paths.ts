/* Pure path helpers, and the deterministic canvas node id.
 *
 * `stableId` is the canvas NODE id and must be identical across runs for the same path — if it
 * drifts, every run rewrites the canvas and Obsidian sees the whole board move. Hence a hash, never a
 * counter.
 * 
 * `pathSortKey`/`compareSortKeys` honour the `[NN]` workflow prefixes folders carry, so "02 REVIEW"
 * sorts after "01 WORKING" instead of alphabetically.
 */


export function relativeTo(child: string, parent: string): string {
  const base = parent.endsWith('/') ? parent : parent + '/';
  return child.startsWith(base) ? child.slice(base.length) : child;
}

export function pathParts(rel: string): string[] {
  return rel.split('/').filter(Boolean);
}

export type SortKey = [number, string][];

export function pathSortKey(parts: string[]): SortKey {
  return parts.map(p => {
    const m = p.match(/^\[(\d+)\]/);
    return (m ? [parseInt(m[1], 10), p.toLowerCase()] : [9999, p.toLowerCase()]) as [number, string];
  });
}

export function compareSortKeys(a: SortKey, b: SortKey): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i][0] !== b[i][0]) return a[i][0] - b[i][0];
    if (a[i][1] < b[i][1]) return -1;
    if (a[i][1] > b[i][1]) return 1;
  }
  return a.length - b.length;
}

/* Stable 16-char hex ID for canvas nodes — must be consistent across runs */
export function stableId(s: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const lo = h1 >>> 0;
  const hi = h2 >>> 0;
  return (hi * 0x100000000 + lo).toString(16).padStart(16, '0');
}

export function isPublishable(name: string): boolean {
  return name.includes('.') && !name.startsWith('.') && !name.startsWith('~$');
}

export function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '-');
}

export function toFileUrl(path: string): string {
  return 'file://' + path.split('/').map(encodeURIComponent).join('/');
}
