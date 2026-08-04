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

/* LibreOffice release line. Bumping this is a RENDERING change, not just a version bump — see the
   note on the `libreoffice` engine below. */
const LO_VERSION = '26.2.5';

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

  /* LibreOffice converts Office documents to PDF; PDFium then rasterises. It is bundled rather than
     required of the user because rendering fidelity is the whole reason it is here — macOS
     QuickLook was evaluated and dropped the text highlights on a real client deck.
     See docs/pages/desktop/thumbnails.mdx.

     ~284MB download, ~800MB on disk. Deliberately NOT slimmed; see
     docs/pages/ideas/slimming-the-bundled-libreoffice.mdx for why, and what it would take.

     LINUX IS ABSENT ON PURPOSE. Bundling ~800MB inside a .deb fights every packaging convention,
     so Linux declares a package dependency instead (bundle.linux.deb.depends in tauri.conf.json)
     and the OS package manager installs it — still no terminal work for the user.

     Pinned to the 26.2.x line, matching the version whose deck rendering was reviewed and accepted.
     A major-version bump can change layout and font substitution, so treat it as a visual change:
     re-render a corpus of real decks before shipping one. */
  libreoffice: {
    kind: 'tree',
    license: 'MPL-2.0 — redistribution permitted; notices retained, source offer required',
    /** Must exist for the engine to count as installed, and is what Rust resolves. */
    sentinel: {
      darwin: 'LibreOffice.app/Contents/MacOS/soffice',
      win32: 'program/soffice.exe',
    },
    platforms: {
      'darwin-arm64': {
        url: `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/mac/aarch64/LibreOffice_${LO_VERSION}_MacOS_aarch64.dmg`,
        // Verified locally: mounted, extracted with ditto, converted a real .pptx headlessly.
        sha256: 'c99fb4fe574437fc4cb820a4ca15271bca325920861f7139858b36d7f9df78ad',
        archive: 'dmg',
        copy: 'LibreOffice.app',
      },
      'darwin-x64': {
        url: `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/mac/x86_64/LibreOffice_${LO_VERSION}_MacOS_x86-64.dmg`,
        sha256: null, // unpinned — see the warning this triggers
        archive: 'dmg',
        copy: 'LibreOffice.app',
      },
      'win32-x64': {
        url: `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/x86_64/LibreOffice_${LO_VERSION}_Win_x86-64.msi`,
        sha256: null,
        archive: 'msi',
      },
      'win32-arm64': {
        url: `https://download.documentfoundation.org/libreoffice/stable/${LO_VERSION}/win/aarch64/LibreOffice_${LO_VERSION}_Win_aarch64.msi`,
        sha256: null,
        archive: 'msi',
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

/** Run a command to completion, capturing stdout. Throws with stderr on a non-zero exit. */
function run(cmd, args, { capture = false } = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let out = '';
    let err = '';
    if (capture) {
      p.stdout.on('data', d => { out += d; });
      p.stderr.on('data', d => { err += d; });
    }
    p.on('error', fail);
    p.on('exit', code =>
      code === 0 ? ok(out) : fail(new Error(`${cmd} exited ${code}${err ? `: ${err.trim()}` : ''}`)));
  });
}

/** tar is present on macOS, Linux, and Windows 10+ (bsdtar). Avoids a Node tar dependency. */
function untar(archive, into) {
  return run('tar', ['xzf', archive, '-C', into]);
}

/**
 * Extract a directory tree from a macOS .dmg.
 *
 * `ditto` rather than `cp -R`: the LibreOffice bundle contains 25 symlinks and a code signature,
 * and ditto is the only copy that reliably preserves both. Verified locally —
 * `codesign --verify --deep --strict` passes on the extracted copy.
 *
 * Detach runs in a finally block: a leaked mount survives the process and blocks the next run.
 */
async function extractDmg(archive, what, destDir) {
  const out = await run('hdiutil',
    ['attach', '-nobrowse', '-readonly', '-noverify', archive], { capture: true });
  const mount = out.split('\n').map(l => l.match(/(\/Volumes\/.+)$/)?.[1]?.trim()).find(Boolean);
  if (!mount) throw new Error(`could not determine mount point for ${archive}`);
  try {
    await run('ditto', [join(mount, what), join(destDir, what)]);
  } finally {
    await run('hdiutil', ['detach', mount, '-quiet']).catch(() =>
      run('hdiutil', ['detach', mount, '-force', '-quiet']).catch(() => {}));
  }
}

/**
 * Extract a Windows .msi without installing it, via an administrative install.
 *
 * `/a` unpacks the payload to TARGETDIR instead of installing: no registry writes, no
 * system-wide LibreOffice, nothing to uninstall. TARGETDIR must be absolute or msiexec
 * silently writes somewhere unhelpful.
 *
 * NOT YET VERIFIED ON A REAL WINDOWS RUNNER — the layout assertion below is what will catch it if
 * the payload nests differently than expected.
 */
async function extractMsi(archive, destDir) {
  await run('msiexec', ['/a', archive, '/qn', `TARGETDIR=${resolve(destDir)}`]);
}

/** Files that must exist for an engine to count as present, so a half-finished fetch is retried. */
function sentinelsFor(engine, spec) {
  if (engine.kind === 'tree') {
    const rel = engine.sentinel?.[process.platform];
    if (!rel) throw new Error(`no sentinel defined for ${process.platform}`);
    return [rel];
  }
  return spec.files;
}

async function fetchEngine(name, engine, key, { force }) {
  const spec = engine.platforms[key];
  if (!spec) {
    const why = name === 'libreoffice' && process.platform === 'linux'
      ? 'installed via the package dependency declared in tauri.conf.json'
      : 'no build published for this platform';
    console.log(`  ${name}: skipped — ${why}`);
    return { name, skipped: true };
  }

  const outDir = join(NATIVE_DIR, name);
  const stampPath = join(outDir, '.stamp.json');
  const sentinels = sentinelsFor(engine, spec);

  if (!force && await exists(stampPath)) {
    const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
    const present = await Promise.all(sentinels.map(f => exists(join(outDir, f))));
    if (stamp.url === spec.url && present.every(Boolean)) {
      console.log(`  ${name}: up to date (${key})`);
      return { name, cached: true };
    }
  }

  console.log(`  ${name}: fetching ${spec.url}`);
  const tmp = join(NATIVE_DIR, `.tmp-${name}`);
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });

  const archive = join(tmp, `archive.${spec.archive ?? 'tgz'}`);
  await download(spec.url, archive);

  /* Integrity check. An unpinned engine still gets fetched — refusing would block the platforms
     whose digest nobody has recorded yet — but it says so loudly and prints the value to pin, so
     "unverified" is a visible state rather than a silent one. */
  const actual = await sha256File(archive);
  if (spec.sha256 && actual !== spec.sha256) {
    throw new Error(
      `${name}: digest mismatch for ${spec.url}\n  expected ${spec.sha256}\n  actual   ${actual}`);
  }
  if (!spec.sha256) {
    console.log(`    ! UNPINNED download — verify and add to ENGINES.${name}.platforms['${key}']:`);
    console.log(`        sha256: '${actual}',`);
  }

  await mkdir(outDir, { recursive: true });
  const digests = { archive: actual };

  if (engine.kind === 'tree') {
    if (spec.archive === 'dmg') {
      await extractDmg(archive, spec.copy, outDir);
    } else if (spec.archive === 'msi') {
      await extractMsi(archive, outDir);
    } else {
      throw new Error(`${name}: unsupported archive type ${spec.archive}`);
    }
    // Assert the layout rather than trusting it — an upstream repackage should fail here, loudly,
    // not at runtime when a thumbnail silently stops rendering.
    for (const rel of sentinels) {
      if (!await exists(join(outDir, rel))) {
        throw new Error(`${name}: ${rel} missing after extraction — archive layout changed`);
      }
      console.log(`    ✓ ${rel}`);
    }
  } else {
    await untar(archive, tmp);
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
  }

  await writeFile(
    stampPath,
    JSON.stringify({ url: spec.url, platform: key, sentinels, digests }, null, 2) + '\n');
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
