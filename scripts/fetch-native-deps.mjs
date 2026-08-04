#!/usr/bin/env node
/* Fetch the native engines the desktop app bundles, into desktop/src-tauri/resources/native/.
 *
 * WHY THIS EXISTS. The app used to shell out to Homebrew-installed `cwebp`, `pdftoppm` and
 * `soffice`. That works in `tauri dev` (which inherits the shell PATH) and fails in a packaged
 * build, because an app launched from Finder/Dock/Explorer gets the OS's minimal PATH. The fix is
 * to stop depending on what the user installed and ship the engines ourselves — so every engine
 * lives HERE, is fetched by digest, and is resolved at runtime from the app's resource dir.
 *
 * The binaries are NOT committed (see resources/native/.gitignore) — they are large, per-platform,
 * and reproducible from this script. CI caches them keyed on this file's ENGINES table.
 *
 * SIGNING ORDER MATTERS. Everything fetched here is nested executable code. On macOS it must be
 * signed inside-out BEFORE the outer .app is signed, and the bundle must not be touched afterwards.
 * That is why fetching is a discrete step with a stable output layout rather than something the
 * Rust build does implicitly: the signing step needs to know exactly what landed where.
 *
 * ADDING AN ENGINE (e.g. a 3D model renderer): add an entry to ENGINES. Keep one directory per
 * engine per platform, keep the `files` list exhaustive, and pin `sha256`. Nothing else in the
 * build needs to know the engine exists until Rust asks for it by name via `native::library_path`
 * / `native::tool_path`.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_DIR = join(ROOT, 'desktop/src-tauri/resources/native');

/* PDFium build pinned by release tag. bblanchon/pdfium-binaries publishes SHARED libraries only —
   there is no static archive in these tarballs, which is why PDFium is a bundled dylib/dll/so and
   not linked into the executable. Checked against the chromium/7988 release. */
const PDFIUM_TAG = 'chromium/7988';

/** platform key → { url, sha256, files: [paths inside the archive we keep] } */
const ENGINES = {
  pdfium: {
    /* Rust consumes this through pdfium-render's `bind_to_library`, which expects the
       platform-conventional file name inside a directory we hand it. */
    kind: 'library',
    license: 'BSD-3-Clause (PDFium) / MIT (packaging)',
    platforms: {
      'darwin-arm64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-mac-arm64.tgz`,
        strip: 'lib/',
        files: ['libpdfium.dylib'],
      },
      'darwin-x64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-mac-x64.tgz`,
        strip: 'lib/',
        files: ['libpdfium.dylib'],
      },
      'win32-x64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-win-x64.tgz`,
        strip: 'bin/',
        files: ['pdfium.dll'],
      },
      'win32-arm64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-win-arm64.tgz`,
        strip: 'bin/',
        files: ['pdfium.dll'],
      },
      'linux-x64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-linux-x64.tgz`,
        strip: 'lib/',
        files: ['libpdfium.so'],
      },
      'linux-arm64': {
        url: `https://github.com/bblanchon/pdfium-binaries/releases/download/${PDFIUM_TAG}/pdfium-linux-arm64.tgz`,
        strip: 'lib/',
        files: ['libpdfium.so'],
      },
    },
  },
};

function platformKey() {
  return `${process.platform}-${process.arch}`;
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function sha256File(p) {
  const h = createHash('sha256');
  h.update(await readFile(p));
  return h.digest('hex');
}

/** Download to disk, streaming — these archives are multi-MB and some engines will be far larger. */
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  await mkdir(dirname(dest), { recursive: true });
  await pipeline(res.body, createWriteStream(dest));
}

/** tar is present on macOS, Linux, and Windows 10+ (bsdtar). Avoids a Node tar dependency. */
function untar(archive, into) {
  return new Promise((ok, fail) => {
    const p = spawn('tar', ['xzf', archive, '-C', into], { stdio: 'inherit' });
    p.on('error', fail);
    p.on('exit', code => (code === 0 ? ok() : fail(new Error(`tar exited ${code}`))));
  });
}

async function fetchEngine(name, engine, key, { force }) {
  const spec = engine.platforms[key];
  if (!spec) {
    console.log(`  ${name}: no build for ${key} — skipped`);
    return { name, skipped: true };
  }

  const outDir = join(NATIVE_DIR, name);
  const stampPath = join(outDir, '.stamp.json');
  const wanted = { url: spec.url, files: spec.files };

  if (!force && await exists(stampPath)) {
    const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
    const filesPresent = await Promise.all(spec.files.map(f => exists(join(outDir, f))));
    if (stamp.url === wanted.url && filesPresent.every(Boolean)) {
      console.log(`  ${name}: up to date (${key})`);
      return { name, cached: true };
    }
  }

  console.log(`  ${name}: fetching ${spec.url}`);
  const tmp = join(NATIVE_DIR, `.tmp-${name}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const archive = join(tmp, 'archive.tgz');
  await download(spec.url, archive);
  await untar(archive, tmp);

  await mkdir(outDir, { recursive: true });
  const digests = {};
  for (const file of spec.files) {
    const from = join(tmp, spec.strip ?? '', file);
    if (!await exists(from)) {
      throw new Error(`${name}: expected ${spec.strip ?? ''}${file} in ${spec.url} — archive layout changed`);
    }
    const to = join(outDir, file);
    await writeFile(to, await readFile(from));
    digests[file] = await sha256File(to);
    console.log(`    ✓ ${file}  ${digests[file].slice(0, 12)}`);
  }

  await writeFile(stampPath, JSON.stringify({ ...wanted, platform: key, digests }, null, 2) + '\n');
  await rm(tmp, { recursive: true, force: true });
  return { name, fetched: true };
}

async function main() {
  const force = process.argv.includes('--force');
  const key = platformKey();
  console.log(`Fetching native engines for ${key} → ${NATIVE_DIR}`);
  await mkdir(NATIVE_DIR, { recursive: true });

  for (const [name, engine] of Object.entries(ENGINES)) {
    await fetchEngine(name, engine, key, { force });
  }
  console.log('Done.');
}

main().catch(err => {
  console.error(`\nfetch-native-deps failed: ${err.message}`);
  process.exit(1);
});
