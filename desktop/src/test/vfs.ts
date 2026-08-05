/* An in-memory stand-in for the Tauri filesystem, path and core APIs.
 *
 * The pipeline's riskiest operations — package mirror purges, OUT cleanup, disconnected
 * renames — only exist as side effects on disk, so they cannot be characterized by
 * inspecting return values. This module gives them a real filesystem to act on and
 * records every mutation, so a test can assert exactly what was copied, removed and
 * renamed rather than trusting a log line.
 *
 * Deliberate design points:
 * - `mtime` comes from a monotonic counter, not the wall clock. `isUnchanged` compares
 *   mtimes, so a real clock would make the copy/skip decision timing-dependent.
 * - `readDir` throws on a missing directory, as the real plugin does — that is the path
 *   `listDir`'s try/catch is there to swallow, and it should stay exercised.
 * - Every mutation is appended to `ops`, giving tests a precise record of destruction.
 */

export interface VfsEntry {
  content: Uint8Array;
  mtimeMs: number;
}

export type Op =
  | { kind: 'copy'; from: string; to: string }
  | { kind: 'remove'; path: string }
  | { kind: 'rename'; from: string; to: string }
  | { kind: 'mkdir'; path: string }
  | { kind: 'write'; path: string };

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Normalize to a posix absolute path with no trailing slash and no empty segments. */
function norm(p: string): string {
  const cleaned = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
  return cleaned === '' ? '/' : cleaned;
}

function parentOf(p: string): string {
  const n = norm(p);
  const idx = n.lastIndexOf('/');
  return idx <= 0 ? '/' : n.slice(0, idx);
}

class MissingPathError extends Error {
  constructor(op: string, path: string) {
    super(`${op}: no such file or directory (os error 2): ${path}`);
  }
}

export class Vfs {
  private files = new Map<string, VfsEntry>();
  private dirs = new Set<string>(['/']);
  private readFailures = new Set<string>();
  private clock = 1000;
  /** Every mutation, in order. Reset with `reset()`. */
  ops: Op[] = [];

  reset(): void {
    this.files.clear();
    this.dirs = new Set(['/']);
    this.clock = 1000;
    this.ops = [];
    this.readFailures.clear();
  }

  /** Next monotonic timestamp — also usable by tests to age a file deliberately. */
  tick(): number {
    return ++this.clock;
  }

  /** Keep a directory present but make reads fail, matching permission/transient IO errors. */
  failRead(path: string): void {
    this.readFailures.add(norm(path));
  }

  /* ── Building fixtures ──────────────────────────────────────────────────── */

  mkdirp(path: string): void {
    let cur = '';
    for (const seg of norm(path).split('/').filter(Boolean)) {
      cur += `/${seg}`;
      this.dirs.add(cur);
    }
    this.dirs.add(norm(path));
  }

  /** Create (or overwrite) a file, creating parent directories. */
  put(path: string, content = 'x', mtimeMs?: number): void {
    const p = norm(path);
    this.mkdirp(parentOf(p));
    this.files.set(p, { content: enc.encode(content), mtimeMs: mtimeMs ?? this.tick() });
  }

  /**
   * Build a fixture tree. A key ending in `/` is a directory; anything else is a file
   * whose value is its content (defaulting to the file's own name, so every file has a
   * distinct size and content hash).
   */
  tree(root: string, spec: Record<string, string | null>): void {
    this.mkdirp(root);
    for (const [rel, content] of Object.entries(spec)) {
      const abs = `${norm(root)}/${rel.replace(/^\/+/, '')}`;
      if (rel.endsWith('/') || content === null) this.mkdirp(abs);
      else this.put(abs, content === '' ? rel.split('/').pop()! : content);
    }
  }

  /* ── Inspecting the result ──────────────────────────────────────────────── */

  /** All file paths, sorted — the golden output of a run. */
  paths(under?: string): string[] {
    const prefix = under ? `${norm(under)}/` : '';
    return [...this.files.keys()].filter(p => p.startsWith(prefix)).sort();
  }

  /** File paths relative to `under`, sorted. Easier to read in assertions. */
  relPaths(under: string): string[] {
    const prefix = `${norm(under)}/`;
    return this.paths(under).map(p => p.slice(prefix.length)).sort();
  }

  text(path: string): string {
    const e = this.files.get(norm(path));
    if (!e) throw new MissingPathError('text', path);
    return dec.decode(e.content);
  }

  hasFile(path: string): boolean {
    return this.files.has(norm(path));
  }

  hasDir(path: string): boolean {
    return this.dirs.has(norm(path));
  }

  sameContent(left: string, right: string): boolean {
    const a = this.files.get(norm(left))?.content;
    const b = this.files.get(norm(right))?.content;
    if (!a || !b || a.byteLength !== b.byteLength) return false;
    return a.every((byte, i) => byte === b[i]);
  }

  removed(): string[] {
    return this.ops.filter(o => o.kind === 'remove').map(o => (o as { path: string }).path).sort();
  }

  copied(): Array<{ from: string; to: string }> {
    return this.ops.filter(o => o.kind === 'copy').map(o => o as { from: string; to: string });
  }

  renamed(): Array<{ from: string; to: string }> {
    return this.ops.filter(o => o.kind === 'rename').map(o => o as { from: string; to: string });
  }

  /* ── The mocked module surfaces ─────────────────────────────────────────── */

  /** Matches the subset of `@tauri-apps/plugin-fs` the pipeline uses. */
  fsApi() {
    return {
      readDir: async (path: string) => {
        const p = norm(path);
        if (this.readFailures.has(p)) throw new Error(`readDir: permission denied: ${path}`);
        if (!this.dirs.has(p)) throw new MissingPathError('readDir', path);
        const names = new Set<string>();
        const out: Array<{ name: string; isDirectory: boolean; isFile: boolean; isSymlink: boolean }> = [];
        const prefix = p === '/' ? '/' : `${p}/`;
        for (const d of this.dirs) {
          if (d === p || !d.startsWith(prefix)) continue;
          const name = d.slice(prefix.length).split('/')[0];
          if (name && !names.has(`d:${name}`)) {
            names.add(`d:${name}`);
            out.push({ name, isDirectory: true, isFile: false, isSymlink: false });
          }
        }
        for (const f of this.files.keys()) {
          if (!f.startsWith(prefix)) continue;
          const rest = f.slice(prefix.length);
          if (rest.includes('/')) continue;
          out.push({ name: rest, isDirectory: false, isFile: true, isSymlink: false });
        }
        return out;
      },

      exists: async (path: string) => {
        const p = norm(path);
        return this.files.has(p) || this.dirs.has(p);
      },

      stat: async (path: string) => {
        const p = norm(path);
        const f = this.files.get(p);
        if (f) {
          return {
            isFile: true, isDirectory: false, isSymlink: false,
            size: f.content.byteLength, mtime: new Date(f.mtimeMs),
            atime: new Date(f.mtimeMs), birthtime: new Date(f.mtimeMs),
          };
        }
        if (this.dirs.has(p)) {
          return {
            isFile: false, isDirectory: true, isSymlink: false,
            size: 0, mtime: new Date(1000), atime: new Date(1000), birthtime: new Date(1000),
          };
        }
        throw new MissingPathError('stat', path);
      },

      readFile: async (path: string) => {
        const f = this.files.get(norm(path));
        if (!f) throw new MissingPathError('readFile', path);
        return f.content;
      },

      readTextFile: async (path: string) => {
        const f = this.files.get(norm(path));
        if (!f) throw new MissingPathError('readTextFile', path);
        return dec.decode(f.content);
      },

      writeTextFile: async (path: string, contents: string) => {
        const p = norm(path);
        this.mkdirp(parentOf(p));
        this.files.set(p, { content: enc.encode(contents), mtimeMs: this.tick() });
        this.ops.push({ kind: 'write', path: p });
      },

      mkdir: async (path: string, _opts?: { recursive?: boolean }) => {
        const p = norm(path);
        this.mkdirp(p);
        this.ops.push({ kind: 'mkdir', path: p });
      },

      copyFile: async (from: string, to: string) => {
        const src = this.files.get(norm(from));
        if (!src) throw new MissingPathError('copyFile', from);
        const dest = norm(to);
        this.mkdirp(parentOf(dest));
        // A real copy stamps the destination with "now", which is what makes the next
        // run's isUnchanged() check skip it.
        this.files.set(dest, { content: src.content, mtimeMs: this.tick() });
        this.ops.push({ kind: 'copy', from: norm(from), to: dest });
      },

      rename: async (from: string, to: string) => {
        const src = norm(from);
        const dest = norm(to);
        const f = this.files.get(src);
        if (f) {
          this.files.delete(src);
          this.mkdirp(parentOf(dest));
          this.files.set(dest, f);
        } else if (this.dirs.has(src)) {
          for (const d of [...this.dirs]) {
            if (d === src || d.startsWith(`${src}/`)) {
              this.dirs.delete(d);
              this.dirs.add(dest + d.slice(src.length));
            }
          }
          for (const [fp, entry] of [...this.files]) {
            if (fp.startsWith(`${src}/`)) {
              this.files.delete(fp);
              this.files.set(dest + fp.slice(src.length), entry);
            }
          }
        } else {
          throw new MissingPathError('rename', from);
        }
        this.ops.push({ kind: 'rename', from: src, to: dest });
      },

      remove: async (path: string, _opts?: { recursive?: boolean }) => {
        const p = norm(path);
        if (this.files.delete(p)) {
          this.ops.push({ kind: 'remove', path: p });
          return;
        }
        if (this.dirs.has(p)) {
          for (const d of [...this.dirs]) if (d === p || d.startsWith(`${p}/`)) this.dirs.delete(d);
          for (const f of [...this.files.keys()]) if (f.startsWith(`${p}/`)) this.files.delete(f);
          this.ops.push({ kind: 'remove', path: p });
          return;
        }
        throw new MissingPathError('remove', path);
      },
    };
  }

  /** Matches the subset of `@tauri-apps/api/path` the pipeline uses. */
  pathApi() {
    return {
      async join(...parts: string[]) {
        const joined = parts.filter(p => p !== '' && p !== undefined && p !== null).join('/');
        return norm(joined.startsWith('/') ? joined : `/${joined}`);
      },
      async basename(p: string) {
        return norm(p).split('/').pop() ?? '';
      },
      async dirname(p: string) {
        return parentOf(p);
      },
      async appDataDir() {
        return '/appdata';
      },
    };
  }
}

/** Shared singleton — `vi.mock` factories and the test body must see the same store. */
export const vfs = new Vfs();
