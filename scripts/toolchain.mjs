// Toolchain pinning — one compiler for the whole monorepo, enforced.
//
// WHY THIS EXISTS
// The repo USED TO HAVE three separate npm installs — the root workspace, desktop/ and docs/ —
// so nothing hoisted a shared version and they were free to disagree. They did: root resolved
// TypeScript 5.9.3 while desktop pinned ~5.8.3. The two compilers
// disagreed about real code — four `fetch(..., { body: uint8array })` calls in cloudService.ts
// were errors under 5.9 and silent under 5.8 (TS 5.7 made Uint8Array generic over its buffer, and
// BodyInit rejects possibly-shared memory).
//
// The failure mode is nasty precisely because it is quiet: `npm run check` passed, CI was green,
// and the errors only appeared if you happened to invoke the other compiler. A future routine
// bump of desktop's TypeScript would have surfaced them as a surprise wall of errors, attributed
// to whatever change happened to be in flight at the time.
//
// desktop/ and docs/ are now workspace members and there is ONE lockfile, so a single hoisted
// copy of each tool is installed and accidental drift is largely structural-impossible. This
// script is still the gate, for two reasons: npm will happily install a SECOND nested copy when
// two manifests declare incompatible ranges (exactly how the duplicate React arose), and a
// deliberate bump must be applied everywhere at once rather than one manifest at a time.
//
// So: every manifest pins the SAME EXACT version — no `^`, no `~`, because a range is how two
// installs drift apart while both look correctly configured. This script fails the build if that
// ever stops being true.
//
// Mirrors scripts/version.mjs: root package.json is the source of truth, `check` gates CI, and
// `set` rewrites every manifest at once.
//
//   node scripts/toolchain.mjs check          → exit 1 on any divergence
//   node scripts/toolchain.mjs set typescript 5.9.4   → pin one tool everywhere, then reinstall
//
// After `set`, run: npm install   (one workspace, one lockfile)

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))
const writeJson = (file, value) =>
  fs.writeFileSync(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`)

/** Every manifest that declares the compiler. Root is the source of truth. */
const MANIFESTS = [
  'package.json',
  'desktop/package.json',
  'docs/package.json',
  'packages/asset-library/package.json',
  'packages/auth/package.json',
  'packages/domain/package.json',
  'web/apps/client-hub/package.json',
]

/**
 * Tools that must not drift, and where each applies.
 *
 * The rule these encode: **desktop and web are siblings.** They compile the same shared
 * packages, and (per the Phase 2 direction) will eventually share UI components outright. Two
 * versions of the compiler, the bundler, the test runner, the React runtime or the Node type
 * surface means the two apps are not really building the same code — and the difference shows up
 * as a phantom error or a runtime-only bug rather than an honest install failure.
 *
 * `except` is for third-party constraints that genuinely cannot follow, and each entry must say
 * why. Anything else belongs in the pinned set.
 */
const PINNED = {
  // The language itself. See the header for what its drift cost us.
  typescript: {},

  // Bundler + its React plugin: both apps are Vite + React. Skew here means a config or plugin
  // behaviour that works in one app and not the other.
  'vite': {},
  '@vitejs/plugin-react': {},

  // One test runner, so "the tests pass" means the same thing everywhere. Root ran Vitest 4
  // while desktop ran Vitest 3 — two runners for one repo.
  'vitest': {},

  // The Node type surface. Was 26 / 22 / 20 across three trees, i.e. three different ideas of
  // what the standard library looks like.
  '@types/node': {},

  // The client type that @sotto/auth's SottoClient is built from. If desktop and web disagree,
  // shared data-access signatures silently diverge.
  '@supabase/supabase-js': {},

  // The test stack. One version, so "the tests pass" means the same thing everywhere.
  'jsdom': {},
  '@testing-library/react': {},
  '@testing-library/jest-dom': {},

  // The React runtime and its types. Shared components are the end goal, and two React copies
  // in one tree break hooks and context at runtime — see the plan's React 19 note.
  'react': { except: { 'docs/package.json': 'Next 13 + Nextra 2 pin React 18; unifying needs a Nextra 2→4 migration' } },
  'react-dom': { except: { 'docs/package.json': 'as react' } },
  '@types/react': { except: { 'docs/package.json': 'as react' } },
  '@types/react-dom': { except: { 'docs/package.json': 'as react' } },
}

const EXACT = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

function declared(tool) {
  const out = {}
  for (const file of MANIFESTS) {
    const pkg = readJson(file)
    const spec = pkg.devDependencies?.[tool] ?? pkg.dependencies?.[tool]
    if (spec !== undefined) out[file] = spec
  }
  return out
}

function check() {
  let failed = false

  for (const [tool, { except = {} }] of Object.entries(PINNED)) {
    // Only dependencies/devDependencies are collected. peerDependencies are deliberately left
    // alone and stay ranges: a library must not dictate an exact version to its host.
    const specs = Object.fromEntries(
      Object.entries(declared(tool)).filter(([file]) => !(file in except)),
    )
    if (!Object.keys(specs).length) continue

    const ranged = Object.entries(specs).filter(([, s]) => !EXACT.test(s))
    if (ranged.length) {
      console.error(`✕ ${tool}: must be pinned EXACTLY (no ^ or ~) — a range is how separate installs drift apart:`)
      for (const [file, spec] of ranged) console.error(`    ${file}: ${spec}`)
      failed = true
    }

    const values = new Set(Object.values(specs))
    if (values.size > 1) {
      console.error(`✕ ${tool}: every manifest must agree — found ${[...values].join(', ')}:`)
      for (const [file, spec] of Object.entries(specs)) console.error(`    ${file}: ${spec}`)
      failed = true
    }

    if (!ranged.length && values.size === 1) {
      const skipped = Object.keys(except).length ? `, ${Object.keys(except).length} documented exception(s)` : ''
      console.log(`✓ ${tool.padEnd(22)} ${[...values][0].padEnd(9)} ${Object.keys(specs).length} manifests agree${skipped}`)
    }
  }

  if (failed) {
    console.error('\nFix with: node scripts/toolchain.mjs set <tool> <version>, then npm install.')
    process.exitCode = 1
  }
}

function set(tool, version) {
  if (!(tool in PINNED)) {
    console.error(`✕ "${tool}" is not pinned. Known: ${Object.keys(PINNED).join(', ')}`)
    process.exitCode = 1
    return
  }
  if (!EXACT.test(version)) {
    console.error(`✕ "${version}" is not an exact x.y.z version. Ranges are what this script exists to prevent.`)
    process.exitCode = 1
    return
  }
  const { except = {} } = PINNED[tool]
  let touched = 0
  for (const file of MANIFESTS.filter(f => !(f in except))) {
    const pkg = readJson(file)
    // Update the tool WHERE IT ALREADY LIVES — react is a runtime dependency, and relocating it
    // to devDependencies would change what ships. Only fall back to devDependencies if the
    // manifest does not declare it at all, and only then if it is a dev-only tool.
    const block = pkg.dependencies?.[tool] !== undefined ? 'dependencies'
                : pkg.devDependencies?.[tool] !== undefined ? 'devDependencies'
                : null
    if (!block) continue   // this manifest does not use the tool; adding it would be noise
    const before = pkg[block][tool]
    if (before === version) continue
    pkg[block][tool] = version
    pkg[block] = Object.fromEntries(Object.entries(pkg[block]).sort(([a], [b]) => a.localeCompare(b)))
    writeJson(file, pkg)
    console.log(`  ${file.padEnd(42)} ${String(before).padStart(9)}  →  ${version}  (${block})`)
    touched += 1
  }
  if (!touched) { console.log(`  ${tool} already ${version} everywhere it is declared`); return }
  console.log('\nNow run: npm install')
}

const [command, ...args] = process.argv.slice(2)
if (command === 'check') check()
else if (command === 'set') set(args[0], args[1])
else {
  console.error('usage: node scripts/toolchain.mjs check | set <tool> <x.y.z>')
  process.exitCode = 1
}
