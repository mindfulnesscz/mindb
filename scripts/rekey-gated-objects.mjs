#!/usr/bin/env node
/* Move an environment's asset objects into the two-tier layout.
 *
 *   public   effective_level = 'public'  -> stays in the PUBLIC bucket, key unchanged
 *   gated    everything else             -> copied to the GATED bucket under {level}/{client_id}/…
 *
 * Where an object belongs is decided by `packages/domain/src/assetStorage.ts`, imported directly
 * rather than restated here — the pipeline uses the same module, so the two cannot drift into
 * writing objects to one place and looking for them in another.
 *
 * THREE PROPERTIES THIS HAS TO HAVE, because it moves other people's files:
 *
 *   idempotent   it compares each row's stored URL against the computed target and skips what
 *                already matches, so a re-run after an interruption resumes rather than repeats.
 *   reversible   copy and repoint FIRST; the source object is left in place. Nothing 404s if the
 *                result is wrong — rollback is repointing the URLs back. `--delete-source` is a
 *                SEPARATE later pass, and it is the only irreversible step.
 *   loud         dry run is the default. `--execute` is required to change anything.
 *
 * A URL that has already been published cannot be un-published. Objects that were public stay
 * fetchable at their old address until --delete-source runs, and anyone who already copied the URL
 * keeps the bytes regardless. Re-keying limits future exposure; it does not undo past exposure.
 *
 *   node scripts/rekey-gated-objects.mjs staging                     # dry run, changes nothing
 *   node scripts/rekey-gated-objects.mjs staging --reclassify-public # preview the perm change too
 *   node scripts/rekey-gated-objects.mjs staging --execute
 *   node scripts/rekey-gated-objects.mjs staging --execute --delete-source   # after verifying
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { effectiveLevel, tierFor, assetUrl, stripVersion } =
  await import(path.join(root, 'packages/domain/src/assetStorage.ts'));

/* ── args ──────────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const envName = args.find(a => !a.startsWith('--'));
const has = f => args.includes(f);
const EXECUTE = has('--execute');
const DELETE_SOURCE = has('--delete-source');
const RECLASSIFY = has('--reclassify-public');

if (!envName) {
  console.error('usage: node scripts/rekey-gated-objects.mjs <env> [--reclassify-public] [--execute] [--delete-source]');
  process.exit(1);
}

/* Config comes from `scripts/environments/<env>.env` when it exists, and otherwise from the
   process environment. Both, in fact — the process wins — so the same script runs from a laptop
   against a gitignored env file and from CI against repository secrets, with no second code path
   to keep correct. The scheduled reconciler (.github/workflows/reconcile-cdn-keys.yml) is the CI
   caller; it has no env file and never will. */
const envFile = path.join(root, 'scripts/environments', `${envName}.env`);
const fromFile = fs.existsSync(envFile)
  ? Object.fromEntries(
      fs.readFileSync(envFile, 'utf8').split('\n')
        .filter(l => l.trim() && !l.startsWith('#') && l.includes('='))
        .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  : {};
const env = { ...fromFile, ...Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && v !== ''),
) };

/* Every value is named explicitly, including the gated pair. An earlier draft derived the gated
   bucket from the public one and got it wrong — `dc-hub-staging` would have produced
   `dc-hub-staging-gated`, while the bucket that exists is `dc-hub-gated-staging`. A clever
   derivation that is wrong writes objects into a bucket nobody is serving. */
const need = ['PROJECT_REF', 'SUPABASE_SERVICE_KEY', 'R2_BUCKET', 'R2_PUBLIC_DOMAIN',
              'R2_GATED_BUCKET', 'R2_GATED_DOMAIN',
              'CF_API_TOKEN', 'CF_ACCOUNT_ID', 'R2_PARENT_ACCESS_KEY_ID'];
const missing = need.filter(k => !env[k]);
if (missing.length) {
  const where = fs.existsSync(envFile) ? path.relative(root, envFile) : 'the environment';
  console.error(`Missing from ${where}: ${missing.join(', ')}`);
  console.error('R2_GATED_BUCKET / R2_GATED_DOMAIN must match workers/cdn-gate/wrangler.jsonc.');
  process.exit(1);
}

const GATED_BUCKET = env.R2_GATED_BUCKET;
const GATED_DOMAIN = env.R2_GATED_DOMAIN;

const REST = `https://${env.PROJECT_REF}.supabase.co/rest/v1`;
const sbHeaders = {
  apikey: env.SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/* ── R2 over the S3 API, signed with short-lived credentials ──────────────────
   Same mechanism the r2-grant edge function uses: the Cloudflare API mints a temporary,
   bucket-scoped key pair from the parent key. Nothing long-lived is written down here. */

async function tempCredentials(bucket) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket, parentAccessKeyId: env.R2_PARENT_ACCESS_KEY_ID,
        permission: 'object-read-write', ttlSeconds: 3600,
      }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result?.accessKeyId) {
    throw new Error(`temp credentials for ${bucket}: ${res.status} ${JSON.stringify(body?.errors ?? body)}`);
  }
  return body.result;
}

const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/** Minimal SigV4 for R2. Only the three verbs this script needs. */
async function s3(creds, bucket, method, key, body = null, extraHeaders = {}) {
  const host = `${env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? Buffer.alloc(0));
  const canonicalUri = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;

  // Lowercase keys throughout, so the canonical form is a plain sort of this object rather than a
  // case-insensitive lookup back into it. SigV4 fails opaquely (403 SignatureDoesNotMatch) when
  // the signed list and the sent headers disagree by so much as capitalisation.
  const headers = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    'x-amz-security-token': creds.sessionToken,
    ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
  };
  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map(h => `${h}:${String(headers[h]).trim()}\n`).join('');
  const signedHeaders = signedNames.join(';');

  const canonical = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/auto/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonical))].join('\n');
  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const signature = hmac(hmac(hmac(hmac(kDate, 'auto'), 's3'), 'aws4_request'), toSign).toString('hex');

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(`https://${host}${canonicalUri}`, { method, headers, body: body ?? undefined });
}

/* ── the work ─────────────────────────────────────────────────────────────── */

const log = (...a) => console.log(...a);
const plan = { skip: 0, copy: 0, repoint: 0, del: 0, missing: 0, failed: 0 };

async function main() {
  log(`\n  environment   ${envName}  (${env.PROJECT_REF})`);
  log(`  public        ${env.R2_BUCKET}  ${env.R2_PUBLIC_DOMAIN}`);
  log(`  gated         ${GATED_BUCKET}  ${GATED_DOMAIN}`);
  log(`  mode          ${EXECUTE ? 'EXECUTE' : 'DRY RUN — nothing will change'}${DELETE_SOURCE ? ' + DELETE SOURCE' : ''}\n`);

  /* Step 0 — the legacy `public` rows.
     Every asset written before 2026-07-31 carries perm='public' because the pipeline hardcoded it,
     not because anyone decided it should be world-readable. Reclassifying them is what makes the
     re-key meaningful; without it the overwhelming majority of objects stay on the public domain.
     Separate flag, because it changes who can SEE things and not merely where bytes live. */
  if (RECLASSIFY) {
    const legacy = await sbGet('/assets?select=id&perm=eq.public');
    log(`  reclassify    ${legacy.length} row(s) perm public -> client`);
    if (EXECUTE && legacy.length) {
      const res = await fetch(`${REST}/assets?perm=eq.public`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify({ perm: 'client' }),
      });
      if (!res.ok) throw new Error(`reclassify failed: ${res.status} ${await res.text()}`);
      log('                done\n');
    } else log('');
  }

  const assets = await sbGet(
    '/assets?select=id,client_id,stable_id,child_id,perm,status,thumbnail_url,download_url&order=id',
  );

  /* On --execute the reclassification above has already landed, so these rows come back with the
     new perm and the plan below is built from reality. On a DRY RUN it has not, so the same rows
     would still read `public` and the preview would promise 54 reclassifications and then plan
     nine moves — a preview that does not resemble the run it is previewing is worse than none.
     Apply it in memory so the numbers shown are the numbers you would get. */
  if (RECLASSIFY && !EXECUTE) {
    for (const a of assets) if (a.perm === 'public') a.perm = 'client';
  }
  log(`  ${assets.length} asset row(s)\n`);

  const creds = {
    public: await tempCredentials(env.R2_BUCKET),
    gated: await tempCredentials(GATED_BUCKET),
  };
  const bucketFor = tier => (tier === 'public' ? env.R2_BUCKET : GATED_BUCKET);
  const domainFor = tier => (tier === 'public' ? env.R2_PUBLIC_DOMAIN : GATED_DOMAIN);

  for (const a of assets) {
    if (!a.stable_id || !a.child_id || !a.client_id) continue; // no identity, no address
    const level = effectiveLevel(a);
    const patch = {};

    for (const column of ['thumbnail_url', 'download_url']) {
      const current = a[column];
      if (!current) continue;

      const source = { bucket: bucketOf(current), key: keyOf(current) };
      if (!source.key) { plan.failed++; log(`  ?  ${a.id} ${column}: cannot parse ${current}`); continue; }

      /* A migration MOVES bytes between tiers. It does not rename them.
         The obvious implementation — derive the target key from the row's stable_id/child_id, the
         way the pipeline does — is wrong here, and the dry run proved it: rows exist whose stored
         URL disagrees with their identity (a URL ending `/c2.webp` on a row whose child_id is
         `c1`), left over from earlier pipeline versions. Recomputing would have copied one object
         onto another object's key, silently overwriting it.
         So the key tail is preserved exactly and only the level prefix changes. That is
         collision-free by construction, and the pipeline converges keys back to identity on its
         next run, where a wrong key is a re-upload rather than a lost file. */
      const currentTier = source.bucket === env.R2_BUCKET ? 'public' : 'gated';
      const bare = source.key.replace(/^(public|guest|client|internal)\//, '');
      const targetTier = tierFor(level);
      const targetKey = targetTier === 'public' ? bare : `${level}/${bare}`;

      if (currentTier === targetTier && source.key === targetKey) { plan.skip++; continue; }

      const target = { tier: targetTier, key: targetKey };
      log(`  ${EXECUTE ? '→' : '·'}  ${level.padEnd(8)} ${currentTier}:${source.key}`);
      log(`     ${' '.repeat(9)}-> ${target.tier}:${target.key}`);

      if (EXECUTE) {
        const moved = await copyObject(creds, source, { bucket: bucketFor(target.tier), key: target.key });
        if (moved === 'missing') { plan.missing++; continue; }
        if (moved === 'failed') { plan.failed++; continue; }
        plan.copy++;
        // The stamp is re-derived from the bytes actually copied, so the new URL busts caches
        // correctly even if the old URL's stamp was stale.
        patch[column] = assetUrl(domainFor(target.tier), target.key, moved);
      } else {
        plan.copy++;
      }
    }

    if (EXECUTE && Object.keys(patch).length) {
      const res = await fetch(`${REST}/assets?id=eq.${a.id}`, {
        method: 'PATCH', headers: { ...sbHeaders, Prefer: 'return=minimal' }, body: JSON.stringify(patch),
      });
      if (!res.ok) { plan.failed++; log(`  ✕  ${a.id}: DB update failed ${res.status} ${await res.text()}`); continue; }
      plan.repoint++;
    }
  }

  /* Deletion is a SEPARATE pass on purpose. By the time it runs, every row already points at the
     new object, so a source delete cannot break a live URL — and until it runs, the whole move is
     undone by repointing the URLs back. */
  if (DELETE_SOURCE) {
    log('\n  --delete-source: removing originals that have been superseded');
    if (!EXECUTE) log('  (dry run — listing only)');
    const after = await sbGet('/assets?select=id,thumbnail_url,download_url');
    const live = new Set(after.flatMap(r => [r.thumbnail_url, r.download_url].filter(Boolean).map(stripVersion)));
    for (const a of assets) {
      for (const column of ['thumbnail_url', 'download_url']) {
        const old = a[column];
        if (!old || live.has(stripVersion(old))) continue; // still referenced — never delete
        const src = { bucket: bucketOf(old), key: keyOf(old) };
        if (!src.key) continue;
        log(`  ${EXECUTE ? '✕' : '·'}  delete ${src.bucket}:${src.key}`);
        if (EXECUTE) {
          const res = await s3(creds[src.bucket === env.R2_BUCKET ? 'public' : 'gated'], src.bucket, 'DELETE', src.key);
          if (res.ok || res.status === 404) plan.del++; else plan.failed++;
        } else plan.del++;
      }
    }
  }

  log(`\n  ${EXECUTE ? 'done' : 'would'}: ${plan.copy} copied · ${plan.repoint} rows repointed · `
    + `${plan.skip} already correct · ${plan.del} source deleted · ${plan.missing} source missing · ${plan.failed} failed`);
  if (!EXECUTE) log('  Nothing changed. Re-run with --execute.\n');
  if (plan.failed) process.exitCode = 1;
}

async function copyObject(creds, source, target) {
  const from = source.bucket === env.R2_BUCKET ? creds.public : creds.gated;
  const to = target.bucket === env.R2_BUCKET ? creds.public : creds.gated;

  const got = await s3(from, source.bucket, 'GET', source.key);
  if (got.status === 404) { log(`     source missing, skipping`); return 'missing'; }
  if (!got.ok) { log(`     GET failed ${got.status}`); return 'failed'; }
  const body = Buffer.from(await got.arrayBuffer());
  const contentType = got.headers.get('content-type') ?? 'application/octet-stream';

  const put = await s3(to, target.bucket, 'PUT', target.key, body, {
    'content-type': contentType,
    // Gated bytes are only ever served through the Worker, which sets its own Cache-Control;
    // this is what a direct read would see, and `private` is the honest value for them.
    'cache-control': target.bucket === env.R2_BUCKET
      ? 'public, max-age=31536000, immutable'
      : 'private, max-age=31536000, immutable',
  });
  if (!put.ok) { log(`     PUT failed ${put.status} ${await put.text()}`); return 'failed'; }
  return sha256hex(body);
}

async function sbGet(query) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const res = await fetch(`${REST}${query}${query.includes('?') ? '&' : '?'}limit=1000&offset=${offset}`,
      { headers: sbHeaders });
    if (!res.ok) throw new Error(`${query}: ${res.status} ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    if (page.length < 1000) return out;
  }
}

/** Which bucket a stored URL points at. Public domain -> public bucket; anything else is gated. */
function bucketOf(url) {
  return url.startsWith(env.R2_PUBLIC_DOMAIN) ? env.R2_BUCKET : GATED_BUCKET;
}
function keyOf(url) {
  try { return decodeURIComponent(new URL(stripVersion(url)).pathname.replace(/^\/+/, '')) || null; }
  catch { return null; }
}

main().catch(e => { console.error('\n  FAILED:', e.message, '\n'); process.exit(1); });
