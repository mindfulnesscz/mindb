/* Path arithmetic, in JavaScript, without crossing the bridge.
 *
 * `join`, `dirname` and `basename` from `@tauri-apps/api/path` are IPC CALLS: each one serialises
 * its arguments, hops to Rust and awaits a reply. The scan, publish, collect and DAM walks call
 * them once per directory entry, so a library of a few thousand files paid a few thousand round
 * trips per run to concatenate strings — the most expensive possible way to do the cheapest
 * possible work.
 *
 * These are pure string functions over the SAME inputs and produce the SAME outputs, so every
 * characterization test that compares exact path strings still passes unchanged (that is the
 * check — those suites assert full absolute paths, and they would catch any divergence).
 *
 * WHAT THIS IS SAFE FOR, and what it is not:
 *
 *   - Sotto ships macOS only, and every path the pipeline handles is an absolute POSIX string
 *     that came from a folder picker or from `readDir`. Windows separators are normalised anyway,
 *     because settings files have been seen carrying them.
 *   - `.` and `..` are NOT resolved. Nothing in the pipeline composes them — segments come from
 *     directory listings and from vocabulary translation — and silently collapsing them would be a
 *     way to walk out of a folder that `path_policy` had approved. If you ever need resolution,
 *     that is a job for Rust, which is where the canonicalisation and the scope check live.
 *   - `appDataDir()` and friends STAY on the real API. They ask the OS a question; this file only
 *     answers questions about strings.
 */

/** Posix-normalised: `\` → `/`, duplicate slashes collapsed, no trailing slash. `''` → `/`. */
function normalize(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  return cleaned === '' ? '/' : cleaned;
}

/**
 * Join path segments. Empty segments are dropped, so `joinPath(dir, '')` is `dir`.
 *
 * Deliberately does NOT make the result absolute: a relative first segment stays relative, the
 * same as the platform call it replaces.
 */
export function joinPath(...parts: Array<string | null | undefined>): string {
  const usable = parts.filter((p): p is string => !!p && p !== '');
  if (!usable.length) return '';
  const joined = usable.join('/');
  // A leading `/` is a segment boundary, not a duplicate — `normalize` would otherwise keep it,
  // which is what we want, so this is only about the rest of the string.
  return normalize(joined);
}

/** The containing directory. `/a/b` → `/a`; a top-level entry and `/` itself → `/`. */
export function parentPath(p: string): string {
  const n = normalize(p);
  const idx = n.lastIndexOf('/');
  return idx <= 0 ? '/' : n.slice(0, idx);
}

/** The last segment. `/a/b.png` → `b.png`; trailing slashes are ignored; `/` → `''`. */
export function baseName(p: string): string {
  return normalize(p).split('/').pop() ?? '';
}
