#!/usr/bin/env node
/* Does every edge function BOOT?
 *
 * WHY THIS EXISTS. Nothing in the toolchain type-checks or runs `supabase/functions/*` — they are
 * Deno modules, and `npm run check` covers the desktop, the web app, the shared packages and the
 * Cloudflare Worker, but not these. A broken import or a syntax error in one of them, or in
 * `_shared/`, is invisible until production.
 *
 * That gap has already cost a production incident: a page-preview sweep added to `cdn-reconcile`
 * called an R2 LIST with credentials scoped `object-read-write`, which does not permit ListBucket.
 * Every asset failed, the move queue stopped draining, and because the same pass sets Cloudflare
 * Stream's `requireSignedURLs`, video playback and animated thumbnails stopped working. No test in
 * the repository could have caught it.
 *
 * WHAT THIS CHECKS, and what it deliberately does not. It asserts each function is served and gets
 * far enough to make a decision — an auth rejection, a validation error, a "not provisioned" 503.
 * All of those prove the module resolved its imports and ran. What it does NOT do is exercise the
 * work: that needs real Cloudflare credentials and a seeded tenant. The logic worth unit-testing has
 * been pulled into `@sotto/domain` instead (see `planPageMoves`), where the ordinary test run covers
 * it. This script covers the half that only a runtime can answer: does it load at all.
 *
 * ONLY TRUSTWORTHY ON A FRESH RUNTIME, and this is the whole operating manual for the script. The
 * local edge runtime compiles a module the first time it is imported and caches it under
 * /var/tmp/sb-compile-edge-runtime; later edits to the file are NOT picked up. So a run against a
 * runtime that already imported the module reports the state it had then, not the state on disk —
 * which means a green result after an edit proves nothing. Measured both ways: a truncated file was
 * still reported broken after being fixed, and an injected syntax error was still reported fine.
 *
 * Hence `--fresh`, which recreates the container first. Use it whenever the answer matters. In CI the
 * container is new, so a plain run is already trustworthy there.
 *
 * Requires a running local stack (`npm run db:start`). Skips with exit 0 when there is none, so it is
 * safe to put in front of a commit hook or a CI job that has no Docker.
 */

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FUNCTIONS_DIR = join(ROOT, 'supabase/functions');

/* Statuses that prove the module booted: it ran far enough to make a decision.
   401 is NOT here. The API gateway rejects a request with no `Authorization` header BEFORE the
   function is invoked, so an unauthenticated probe returns 401 whatever state the code is in — a
   syntax error still answered 401. Every probe therefore carries the anon key, which gets past the
   gateway and lets the function's own auth check answer. */
const BOOTED = new Set([400, 401, 403, 404, 405, 422, 503]);

/* A failure to boot also arrives as 503, the same status these functions use for "storage not
   provisioned" — so status alone cannot tell them apart and the BODY decides. */
const BOOT_FAILURE = /BOOT_ERROR|InvalidWorkerCreation|worker boot error|failed to bootstrap/i;

function localStack() {
  const res = spawnSync('npx', ['supabase', 'status', '-o', 'json'], { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) return null;
  try {
    const json = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    return json.API_URL ? { url: json.API_URL, anonKey: json.ANON_KEY } : null;
  } catch { return null; }
}

async function probe(base, anonKey, name) {
  const url = `${base}/functions/v1/${name}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      // The anon key is what gets past the gateway so the FUNCTION answers rather than Kong.
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: '{}',
    });
  } catch (e) {
    return { name, ok: false, detail: `unreachable: ${e.message}` };
  }
  const body = (await res.text()).slice(0, 300);
  const flat = body.replace(/\s+/g, ' ');

  // Checked BEFORE the status set, because a boot failure is a 503 and so is "not provisioned".
  if (BOOT_FAILURE.test(body)) return { name, ok: false, detail: `${res.status} — DID NOT BOOT: ${flat}` };
  if (BOOTED.has(res.status)) return { name, ok: true, detail: `${res.status} (booted)` };

  /* A 5xx is the interesting case and has to be read, not counted. The edge runtime answers a module
     that fails to load with a boot error; a function that loaded and then threw is a different bug
     and not this script's business — but both are worth failing on, because neither is a decision. */
  return { name, ok: false, detail: `${res.status} — unexpected: ${flat}` };
}

/* A stale runtime makes a green run meaningless, so offer to remove the doubt rather than document
   it and hope. `supabase stop` backs local data up by default; the reset that follows a `start` is
   not triggered here. */
if (process.argv.includes('--fresh')) {
  console.log('smoke-functions: recreating the edge runtime so the result reflects the files on disk…');
  spawnSync('npx', ['supabase', 'stop'], { cwd: ROOT, stdio: 'ignore' });
  const started = spawnSync('npx', ['supabase', 'start'], { cwd: ROOT, stdio: 'ignore' });
  if (started.status !== 0) {
    console.error('smoke-functions: could not restart the local stack.');
    process.exit(1);
  }
}

const stack = localStack();
if (!stack) {
  console.log('smoke-functions: no local Supabase stack — skipped. Start one with `npm run db:start`.');
  process.exit(0);
}

const names = readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('_'))
  .map(d => d.name)
  .sort();

console.log(`smoke-functions: probing ${names.length} function(s) at ${stack.url}\n`);
const results = await Promise.all(names.map(n => probe(stack.url, stack.anonKey, n)));

let failed = 0;
for (const r of results) {
  console.log(`  ${r.ok ? '✓' : '✕'}  ${r.name.padEnd(22)} ${r.detail}`);
  if (!r.ok) failed++;
}

if (failed) {
  console.error(`\n${failed} function(s) did not boot.`);
  console.error('BEFORE believing this, rule out a STALE RUNTIME. The edge runtime caches compiled');
  console.error('modules under /var/tmp/sb-compile-edge-runtime, so a file that was mid-write when it');
  console.error('was first imported stays broken there even after the file on disk is fixed — the error');
  console.error('then names a line that no longer looks like that. A function ADDED since the container');
  console.error('was created answers 404 for the same class of reason. Either way, recreate it:');
  console.error('  node scripts/smoke-functions.mjs --fresh');
  process.exit(1);
}
console.log('\nAll functions boot.');
