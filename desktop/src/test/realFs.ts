/* A `@tauri-apps/plugin-fs` stand-in backed by the REAL filesystem.
 *
 * The other pipeline tests run against `./vfs`, an in-memory tree rooted at `/src`. That is the
 * right default — it is fast and hermetic — but it makes every path look the same to the code under
 * test, so it cannot notice that a path is an absolute, deeply nested, space-and-emoji-bearing
 * folder somewhere outside the app's own data directory. That is what real client folders are
 * (`~/Library/CloudStorage/Dropbox-…/04 PROJECTS/…`), and it is the shape the 3.2.1 fs-scope
 * regression broke.
 *
 * Backing the same API with `node:fs` against a temp directory keeps the pipeline honest about
 * absolute out-of-appdata paths. See `outOfAppdata.smoke.test.ts` for what that does and does not
 * prove.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export class RealFs {
  /** Absolute, and deliberately nowhere near the app data directory. */
  root = '';

  make(prefix = 'sotto-smoke-'): string {
    this.root = mkdtempSync(join(tmpdir(), prefix));
    return this.root;
  }

  cleanup(): void {
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.root = '';
  }

  /** Create a nested fixture tree, `'a/b/file.pdf': 'contents'`, under `base`. */
  async tree(base: string, entries: Record<string, string>): Promise<void> {
    await fs.mkdir(base, { recursive: true });
    for (const [relative, contents] of Object.entries(entries)) {
      const path = join(base, relative);
      await fs.mkdir(join(path, '..'), { recursive: true });
      await fs.writeFile(path, contents);
    }
  }

  fsApi() {
    return {
      readDir: async (path: string) =>
        (await fs.readdir(path, { withFileTypes: true })).map(e => ({
          name: e.name,
          isDirectory: e.isDirectory(),
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        })),

      exists: async (path: string) => {
        try { await fs.stat(path); return true; } catch { return false; }
      },

      stat: async (path: string) => {
        const s = await fs.stat(path);
        return {
          isFile: s.isFile(), isDirectory: s.isDirectory(), isSymlink: s.isSymbolicLink(),
          size: s.size, mtime: s.mtime, atime: s.atime, birthtime: s.birthtime,
        };
      },

      readFile: async (path: string) => new Uint8Array(await fs.readFile(path)),
      readTextFile: (path: string) => fs.readFile(path, 'utf8'),

      writeTextFile: async (path: string, contents: string) => {
        await fs.writeFile(path, contents, 'utf8');
      },

      mkdir: async (path: string, options?: { recursive?: boolean }) => {
        await fs.mkdir(path, { recursive: options?.recursive ?? false });
      },

      copyFile: async (from: string, to: string) => { await fs.copyFile(from, to); },
      rename: async (from: string, to: string) => { await fs.rename(from, to); },

      remove: async (path: string, options?: { recursive?: boolean }) => {
        await fs.rm(path, { recursive: options?.recursive ?? false, force: false });
      },
    };
  }

  /** Backend for `invokeStub`, so the render fakes write where this filesystem can read them. */
  stubBackend() {
    return {
      put: async (path: string, contents: string) => {
        await fs.mkdir(join(path, '..'), { recursive: true });
        await fs.writeFile(path, contents, 'utf8');
      },
      hasFile: async (path: string) => {
        try { return (await fs.stat(path)).isFile(); } catch { return false; }
      },
      stat: async (path: string) => {
        const s = await fs.stat(path);
        return { size: s.size, mtime: s.mtime };
      },
      sameContent: async (a: string, b: string) => {
        try {
          const [x, y] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
          return x.equals(y);
        } catch { return false; }
      },
    };
  }

  pathApi() {
    const path = join;
    return {
      async join(...parts: string[]) { return path(...parts.filter(Boolean)); },
      async basename(p: string) { return p.split('/').pop() ?? ''; },
      async dirname(p: string) { return p.split('/').slice(0, -1).join('/') || '/'; },
      // Deliberately NOT an ancestor of `root` — the whole point is to run outside it.
      async appDataDir() { return join(tmpdir(), 'sotto-smoke-appdata'); },
    };
  }
}

export const realFs = new RealFs();
