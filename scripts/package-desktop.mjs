#!/usr/bin/env node
/* Build the desktop app, then place the engines Tauri's bundler cannot carry.
 *
 * WHY THIS EXISTS. `bundle.resources` copies files by dereferencing symlinks. That is fine for a
 * single dynamic library (PDFium stays in `bundle.resources`) and WRONG for an application bundle:
 * LibreOffice.app contains ~25 symlinks and a sealed code signature, and Tauri's copy
 *
 *   - inflated the app from ~800MB to 1.5GB (duplicated symlink targets), and
 *   - broke the signature — `codesign --verify --deep --strict` reported
 *     "a sealed resource is missing or invalid" in LibreOfficePython.framework.
 *
 * Both were measured, not assumed. A dereferenced framework cannot be validly signed, so this is a
 * hard blocker for notarisation rather than a size nitpick.
 *
 * So LibreOffice is placed with `ditto`, which preserves symlinks and signatures, AFTER Tauri has
 * produced the .app and BEFORE anything is signed. The DMG is then regenerated from the completed
 * bundle using Tauri's own `bundle_dmg.sh`, so the disk image keeps the volume icon, window geometry
 * and /Applications drop link that Tauri configures.
 *
 * SIGNING SLOT. Notarisation is off during active development, but the ordering it needs is the
 * ordering here: engines placed, then signed inside-out, then the outer app, then the DMG built from
 * the already-signed bundle, and nothing touched afterwards. When signing is turned on it goes at
 * the marked step — see docs/pages/reference/third-party-engines.mdx.
 */

import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const NATIVE_SRC = join(ROOT, 'desktop/src-tauri/resources/native');
const BUNDLE = join(ROOT, 'desktop/src-tauri/target/release/bundle');

/** Engines Tauri must NOT copy, because they are directory trees with symlinks. */
const PLACED_BY_US = ['libreoffice'];

function run(cmd, args, opts = {}) {
  return new Promise((ok, fail) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('error', fail);
    p.on('exit', code => (code === 0 ? ok() : fail(new Error(`${cmd} ${args.join(' ')} → exit ${code}`))));
  });
}

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

/** The single .app in the macos bundle dir — its name follows productName, so do not hardcode it. */
async function findApp() {
  const dir = join(BUNDLE, 'macos');
  const entries = await readdir(dir).catch(() => []);
  const app = entries.find(e => e.endsWith('.app'));
  if (!app) throw new Error(`no .app found in ${dir}`);
  return join(dir, app);
}

async function main() {
  if (process.platform !== 'darwin') {
    // Windows/Linux placement differs (no .app, and Linux uses a package dependency); those paths
    // are wired up when their release jobs are added, rather than guessed at here.
    console.error('package-desktop currently supports macOS only.');
    process.exit(1);
  }

  console.log('▸ Fetching native engines');
  await run('node', [join(ROOT, 'scripts/fetch-native-deps.mjs')]);

  for (const engine of PLACED_BY_US) {
    if (!await exists(join(NATIVE_SRC, engine))) {
      throw new Error(`${engine} missing from ${NATIVE_SRC} — fetch-native-deps did not provide it`);
    }
  }

  console.log('\n▸ Building app bundle (Tauri carries PDFium; LibreOffice is placed below)');
  await run('npm', ['run', 'tauri', 'build'], { cwd: join(ROOT, 'desktop') });

  const app = await findApp();
  const destRoot = join(app, 'Contents/Resources/resources/native');

  console.log(`\n▸ Placing engines with ditto → ${destRoot}`);
  for (const engine of PLACED_BY_US) {
    const dest = join(destRoot, engine);
    // Remove any stale copy first: ditto merges into an existing tree, which would leave files from
    // a previous LibreOffice version behind and silently change what ships.
    await rm(dest, { recursive: true, force: true });
    await run('ditto', [join(NATIVE_SRC, engine), dest]);
    console.log(`  ✓ ${engine}`);
  }

  /* ── SIGNING GOES HERE ──────────────────────────────────────────────────
     Sign inside-out: every nested Mach-O, then each placed engine's bundle, then the outer .app.
     Must happen after placement and before the DMG is built, and nothing may modify the bundle
     afterwards. Deliberately not enabled yet. */

  console.log('\n▸ Regenerating DMG from the completed bundle');
  const dmgDir = join(BUNDLE, 'dmg');
  const script = join(dmgDir, 'bundle_dmg.sh');
  if (!await exists(script)) {
    // Tauri writes this during its own dmg step; if the layout changes, say so rather than
    // shipping an app-only build that looks complete.
    throw new Error(`${script} not found — cannot rebuild the DMG with the placed engines`);
  }
  /* Clear previous output AND any `rw.*.dmg` staging image. A leftover staging image makes the next
     run attach the stale one and fail confusingly. */
  for (const f of await readdir(dmgDir)) {
    if (f.endsWith('.dmg')) await rm(join(dmgDir, f), { force: true });
  }

  const appName = app.split('/').pop();
  const version = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version;
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x64';
  const dmgName = `DC Hub_${version}_${arch}.dmg`;

  /* The source must be the ABSOLUTE path to the .app: Tauri stages the bundle before calling this
     script, so a bare name resolves for Tauri and not for us. Passing the name alone failed with a
     Finder error (-10006) that reads like flaky AppleScript but is really "the item is not there".
     `--icon` / `--hide-extension` still take the basename, since those name an item INSIDE the
     volume rather than a path on disk. */
  await run('bash', [
    script,
    '--volname', 'DC Hub',
    '--icon', appName, '180', '170',
    '--app-drop-link', '480', '170',
    '--window-size', '660', '400',
    '--hide-extension', appName,
    '--volicon', join(dmgDir, 'icon.icns'),
    dmgName, app,
  ], { cwd: dmgDir });

  console.log('\n▸ Done');
  console.log(`  app: ${app}`);
  console.log(`  dmg: ${join(dmgDir, dmgName)}`);
}

main().catch(err => {
  console.error(`\npackage-desktop failed: ${err.message}`);
  process.exit(1);
});
