#!/usr/bin/env node
/*
 * bootstrap-env — provision a hosted DC Hub environment (a new tier like
 * staging, or a whole new agency instance) to the point a desktop editor can
 * sign in and publish. This is the *scriptable* half of standing up an
 * environment; the platform-account steps (create the Supabase project, the
 * Cloudflare R2 bucket + token + public domain, the Vercel project + domain,
 * DNS) are a manual checklist printed at the end and documented in
 * docs/operations/deployment.
 *
 * It runs these steps, each idempotent so re-running reconciles rather than
 * duplicates:
 *   1. link the project + push schema (supabase db push)
 *   2. deploy edge functions (supabase functions deploy)
 *   3. set edge-function secrets from an env-file (Cloudflare grant creds)
 *   4. set Auth Site URL + redirect allow-list via the Management API
 *      (config as code — no dashboard clicks, no localhost:3000 drift)
 *   5. invite the founding admin and stamp role=admin (cuts the
 *      chicken-and-egg: they click the email and they're in)
 *   6. optionally create the first client with its storage config + membership
 *
 * Usage:
 *   node scripts/bootstrap-env.mjs \
 *     --ref <supabase-project-ref> \
 *     --site-url https://staging.hub.disruptcollective.com \
 *     --admin you@disruptcollective.com \
 *     [--client "ESS" --bucket dc-hub-staging --domain https://cdn-staging.example.com] \
 *     [--redirect-urls "https://foo/**,https://bar/**"] \
 *     [--dry-run]
 *
 * Required environment (all secret; never commit):
 *   SUPABASE_ACCESS_TOKEN   personal access token — CLI link + Management API
 *   SUPABASE_DB_PASSWORD    the project's database password — for `supabase link`
 *   SUPABASE_SERVICE_KEY    the project's service_role / secret key — admin invite + first client
 * Optional:
 *   SUPABASE_FUNCTION_ENV   path to the CF secrets env-file (default: supabase/functions/.env)
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';

/* ── args ────────────────────────────────────────────────────────────────── */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const DRY = !!args['dry-run'];

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

const ref     = args.ref;
const siteUrl = args['site-url'];
const admin   = args.admin;
if (!ref || !siteUrl || !admin) {
  die('Required: --ref <project-ref> --site-url <https://…> --admin <email>. See the file header for full usage.');
}

const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
const dbPassword  = process.env.SUPABASE_DB_PASSWORD;
const serviceKey  = process.env.SUPABASE_SERVICE_KEY;
if (!accessToken) die('SUPABASE_ACCESS_TOKEN is required in the environment.');
if (!dbPassword)  die('SUPABASE_DB_PASSWORD is required in the environment (for `supabase link`).');
if (!serviceKey)  die('SUPABASE_SERVICE_KEY (service_role/secret key) is required in the environment.');

const supabaseUrl = `https://${ref}.supabase.co`;
const functionEnv = process.env.SUPABASE_FUNCTION_ENV || 'supabase/functions/.env';

// Desktop sign-in and local portal dev always need these; callers can add more.
const redirectSet = new Set([
  `${siteUrl}/**`,
  'http://localhost:7623/auth-callback', // desktop loopback callback
  'http://localhost:5173/**',            // local portal against this backend
  ...String(args['redirect-urls'] || '').split(',').map(s => s.trim()).filter(Boolean),
]);
const redirectList = [...redirectSet];

console.log(`\n━━━ bootstrap-env → ${ref} ━━━`);
console.log(`  site url:      ${siteUrl}`);
console.log(`  admin invite:  ${admin}`);
console.log(`  redirect list: ${redirectList.join('  ')}`);
if (args.client) console.log(`  first client:  "${args.client}"  bucket=${args.bucket || '(none)'}  domain=${args.domain || '(none)'}`);
if (DRY) console.log('  MODE: dry-run (no changes)\n');

/* ── helpers ─────────────────────────────────────────────────────────────── */
function sh(cmd, label) {
  console.log(`\n▸ ${label}`);
  if (DRY) { console.log(`  [dry-run] ${cmd}`); return; }
  execSync(cmd, { stdio: 'inherit', env: { ...process.env, SUPABASE_DB_PASSWORD: dbPassword } });
}

async function api(label, url, init) {
  console.log(`\n▸ ${label}`);
  if (DRY) { console.log(`  [dry-run] ${init.method} ${url}`); return {}; }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const mgmtHeaders  = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
const svcHeaders   = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json' };

/* ── run ─────────────────────────────────────────────────────────────────── */
try {
  // 1. link + schema
  sh(`supabase link --project-ref ${ref}`, 'Link project');
  sh(`supabase db push`, 'Push schema (all migrations)');

  // 2. functions
  sh(`supabase functions deploy`, 'Deploy edge functions');

  // 3. function secrets (Cloudflare grant credentials) — skip if no env-file
  if (existsSync(functionEnv)) {
    sh(`supabase secrets set --env-file ${functionEnv}`, `Set function secrets from ${functionEnv}`);
  } else {
    console.log(`\n▸ Function secrets — SKIPPED (${functionEnv} not found; set CF_API_TOKEN / CF_ACCOUNT_ID / R2_PARENT_ACCESS_KEY_ID manually)`);
  }

  // 4. auth config (as code, via Management API)
  await api('Set Auth site URL + redirect allow-list',
    `https://api.supabase.com/v1/projects/${ref}/config/auth`,
    { method: 'PATCH', headers: mgmtHeaders, body: JSON.stringify({
        site_url: siteUrl,
        uri_allow_list: redirectList.join(','),
      }) });

  // 5. founding admin — invite, then promote. inviteUserByEmail creates the
  //    auth.users row (fires handle_new_user → a 'client' profile), so the
  //    profile exists by the time we PATCH it to admin.
  let adminId = null;
  try {
    const invited = await api(`Invite admin ${admin}`,
      `${supabaseUrl}/auth/v1/invite`,
      { method: 'POST', headers: svcHeaders, body: JSON.stringify({ email: admin }) });
    adminId = invited.id ?? (DRY ? '<dry-run-admin-id>' : null);
  } catch (e) {
    // Already invited/exists — look the user up so we can still ensure admin role.
    console.log(`  (invite skipped: ${String(e.message).split('\n')[0]})`);
    const found = await api(`Look up existing user ${admin}`,
      `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(admin)}`,
      { method: 'GET', headers: svcHeaders });
    adminId = (found.users ?? []).find(u => (u.email || '').toLowerCase() === admin.toLowerCase())?.id ?? null;
  }
  if (adminId) {
    await api('Promote admin to role=admin',
      `${supabaseUrl}/rest/v1/profiles?id=eq.${adminId}`,
      { method: 'PATCH', headers: { ...svcHeaders, Prefer: 'return=minimal' }, body: JSON.stringify({ role: 'admin' }) });
  } else if (!DRY) {
    console.log('  ⚠ could not resolve the admin user id — promote manually in the SQL editor.');
  }

  // 6. first client (optional) + storage + admin membership
  if (args.client && adminId) {
    const created = await api(`Create client "${args.client}"`,
      `${supabaseUrl}/rest/v1/clients`,
      { method: 'POST', headers: { ...svcHeaders, Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify({
          name: args.client,
          r2_bucket: args.bucket || null,
          r2_public_domain: args.domain ? String(args.domain).replace(/\/+$/, '') : null,
          identity_migrated: true, // greenfield: stable identity from day one
        }) });
    const clientId = Array.isArray(created) ? created[0]?.id : created?.id;
    if (clientId) {
      await api('Assign admin to the client (client_members)',
        `${supabaseUrl}/rest/v1/client_members`,
        { method: 'POST', headers: { ...svcHeaders, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: adminId, client_id: clientId }) });
    }
  } else if (args.client) {
    console.log('\n▸ First client — SKIPPED (no admin id resolved to own it)');
  }

  console.log(`\n✓ Scriptable bootstrap complete for ${ref}.\n`);
} catch (e) {
  die(String(e.message || e));
}

/* ── manual checklist (always printed) ───────────────────────────────────── */
console.log(`─── Remaining manual steps (platform accounts) ───
  1. Cloudflare R2: create the bucket "${args.bucket || '<bucket>'}", enable a
     public domain (r2.dev or custom), add CORS GET/HEAD from *.
  2. Cloudflare: an R2 API token (account-scoped) → its Token value +
     Access Key ID feed CF_API_TOKEN / R2_PARENT_ACCESS_KEY_ID in ${functionEnv}
     (re-run this script, or 'supabase secrets set', once that file has them).
  3. Vercel: point a project/branch at ${siteUrl} with this env's URL + anon key.
  4. Desktop: add an environment (Settings → Environments) with
     ${supabaseUrl} + the publishable/anon key; sign in as ${admin}.
  5. The admin invite email uses the site URL above — make sure DNS resolves it.
`);
