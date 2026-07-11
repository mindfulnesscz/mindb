// Unified version manager — one canonical version for the whole monorepo.
// Root package.json is the single source of truth; every other manifest
// (desktop npm/Tauri/Cargo, web workspace, docs) is written from it.
// See VERSIONING.md for usage.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const write = (file, value) => fs.writeFileSync(path.join(root, file), value)
const readJson = file => JSON.parse(read(file))
const writeJson = (file, value) => write(file, `${JSON.stringify(value, null, 2)}\n`)
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const packageFiles = [
  'package.json',
  'desktop/package.json',
  'web/package.json',
  'web/apps/client-hub/package.json',
  'web/packages/asset-library/package.json',
  'docs/package.json',
]

// npm lockfiles: file → the `packages` entries that carry a version
const lockFiles = {
  'desktop/package-lock.json': [''],
  'web/package-lock.json': ['', 'apps/client-hub', 'packages/asset-library'],
  'docs/package-lock.json': [''],
}

function cargoPackageVersion(source) {
  const block = source.match(/\[\[package\]\][\s\S]*?\nname = "dc-hub-app"\nversion = "([^"]+)"/)
  if (!block) throw new Error('dc-hub-app package not found in Cargo.lock')
  return block[1]
}

function versions() {
  const out = {}
  for (const file of packageFiles) out[file] = readJson(file).version
  for (const [file, entries] of Object.entries(lockFiles)) {
    const lock = readJson(file)
    out[`${file} (root)`] = lock.version
    for (const entry of entries) out[`${file} (${entry || 'package'})`] = lock.packages[entry]?.version
  }
  out['desktop/src-tauri/tauri.conf.json'] = readJson('desktop/src-tauri/tauri.conf.json').version
  out['desktop/src-tauri/Cargo.toml'] = read('desktop/src-tauri/Cargo.toml').match(/^version = "([^"]+)"/m)?.[1]
  out['desktop/src-tauri/Cargo.lock'] = cargoPackageVersion(read('desktop/src-tauri/Cargo.lock'))
  out['CHANGELOG.md'] = read('CHANGELOG.md').match(/^## \[([^\]]+)\]/m)?.[1]
  return out
}

function check() {
  const expected = readJson('package.json').version
  if (!semver.test(expected)) throw new Error(`Invalid canonical version: ${expected}`)
  const mismatches = Object.entries(versions()).filter(([, value]) => value !== expected)
  if (mismatches.length) {
    for (const [file, value] of mismatches) console.error(`${file}: ${value ?? 'missing'} (expected ${expected})`)
    process.exitCode = 1
    return
  }
  console.log(`All version sources match ${expected}`)
}

function nextVersion(current, kind) {
  if (semver.test(kind)) return kind
  const parts = current.split('.').map(Number)
  if (kind === 'major') return `${parts[0] + 1}.0.0`
  if (kind === 'minor') return `${parts[0]}.${parts[1] + 1}.0`
  if (kind === 'patch') return `${parts[0]}.${parts[1]}.${parts[2] + 1}`
  throw new Error('Use check, patch, minor, major, or an explicit X.Y.Z version')
}

function setVersion(kind) {
  const previous = readJson('package.json').version
  const next = nextVersion(previous, kind)

  for (const file of packageFiles) {
    const pkg = readJson(file)
    pkg.version = next
    writeJson(file, pkg)
  }
  for (const [file, entries] of Object.entries(lockFiles)) {
    const lock = readJson(file)
    lock.version = next
    for (const entry of entries) if (lock.packages[entry]) lock.packages[entry].version = next
    writeJson(file, lock)
  }

  const tauri = readJson('desktop/src-tauri/tauri.conf.json')
  tauri.version = next
  writeJson('desktop/src-tauri/tauri.conf.json', tauri)

  write('desktop/src-tauri/Cargo.toml',
    read('desktop/src-tauri/Cargo.toml').replace(/^(version = ")[^"]+("$)/m, `$1${next}$2`))
  write('desktop/src-tauri/Cargo.lock', read('desktop/src-tauri/Cargo.lock').replace(
    /(\[\[package\]\][\s\S]*?\nname = "dc-hub-app"\nversion = ")[^"]+("\n)/,
    `$1${next}$2`,
  ))

  const changelog = read('CHANGELOG.md')
  if (!new RegExp(`^## \\[${next.replaceAll('.', '\\.')}\\]`, 'm').test(changelog)) {
    const date = new Date().toISOString().slice(0, 10)
    write('CHANGELOG.md', changelog.replace(/^(---\n)/m, `$1\n## [${next}] — ${date}\n\n- Describe this release.\n\n`))
  }
  console.log(`Version updated from ${previous} to ${next}`)
  check()
}

const command = process.argv[2] ?? 'check'
if (command === 'check') check()
else setVersion(command)
