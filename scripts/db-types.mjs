// Database types — generated from the schema, never hand-edited.
//
// WHY THIS EXISTS
// `packages/database/src/database.types.ts` is the single type source for both apps (desktop aliases
// it; the portal's `lib/database.types.ts` is a re-export shim). It was hand-maintained, which means
// it could silently disagree with the schema — and it did: `can_see_asset`, added by the F-4 ratings
// migration, was missing from it. Nothing failed, because a MISSING type is not a type error. Code
// calling that RPC would simply have been untyped.
//
// That is the whole failure mode: schema drift does not break the build, it erodes the guarantee the
// types are there to provide. So generation is a command and agreement is a gate.
//
//   node scripts/db-types.mjs write   → regenerate from the local schema
//   node scripts/db-types.mjs check   → exit 1 if the checked-in file has drifted
//
// `check` needs the local stack. When it is not running it SKIPS rather than fails, so `npm run
// check` still works offline — the enforcing run is CI's, where `.github/workflows/db.yml` starts a
// database from the migrations before calling this. That is the stronger check anyway: it compares
// the committed types against a schema replayed from zero.

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TARGET = path.join(root, 'packages/database/src/database.types.ts')
const REL = 'packages/database/src/database.types.ts'

const mode = process.argv[2]
if (mode !== 'write' && mode !== 'check') {
  console.error('usage: node scripts/db-types.mjs <write|check>')
  process.exit(2)
}

/** Is the local stack reachable? `gen types --local` needs it; offline is a skip, not a failure. */
function stackIsUp() {
  try {
    execFileSync('supabase', ['status'], { cwd: root, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function generate() {
  return execFileSync('supabase', ['gen', 'types', 'typescript', '--local'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // The CLI writes progress ("Connecting to db…") to stderr; only stdout is the file.
    stdio: ['ignore', 'pipe', 'ignore'],
  })
}

if (!stackIsUp()) {
  console.log(`↷ db:types ${mode} skipped — local Supabase is not running (\`supabase start\`).`)
  console.log('  CI enforces this against a schema replayed from the migrations.')
  process.exit(0)
}

const generated = generate()
if (!generated.includes('export type Database')) {
  console.error('✕ db:types — the generator produced no Database type. Is the stack healthy?')
  process.exit(1)
}

const current = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : ''

if (mode === 'write') {
  if (current === generated) {
    console.log(`✓ ${REL} already matches the schema`)
  } else {
    fs.writeFileSync(TARGET, generated)
    console.log(`✓ ${REL} regenerated from the local schema`)
  }
  process.exit(0)
}

if (current === generated) {
  console.log(`✓ ${REL} matches the schema`)
  process.exit(0)
}

// Report WHAT drifted, not just that something did — a 900-line diff is not a message.
const lines = s => new Set(s.split('\n').map(l => l.trim()).filter(Boolean))
const inSchema = lines(generated)
const inFile = lines(current)
const missing = [...inSchema].filter(l => !inFile.has(l))
const stale = [...inFile].filter(l => !inSchema.has(l))

console.error(`✕ ${REL} has drifted from the schema.`)
if (missing.length) {
  console.error(`\n  In the schema but NOT in the checked-in types (${missing.length} line(s)):`)
  for (const l of missing.slice(0, 12)) console.error(`    + ${l}`)
  if (missing.length > 12) console.error(`    … and ${missing.length - 12} more`)
}
if (stale.length) {
  console.error(`\n  In the checked-in types but NOT in the schema (${stale.length} line(s)):`)
  for (const l of stale.slice(0, 12)) console.error(`    - ${l}`)
  if (stale.length > 12) console.error(`    … and ${stale.length - 12} more`)
}
console.error('\n  Fix: npm run db:types   (then commit the result)')
process.exit(1)
