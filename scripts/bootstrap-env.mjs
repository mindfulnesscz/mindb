#!/usr/bin/env node
/*
 * bootstrap-env — provision a hosted DC Hub environment (a new tier like
 * staging, or a whole new agency instance) to the point a desktop editor can
 * sign in and publish.
 *
 * You DO NOT type secrets or flags on the command line. Instead:
 *
 *   1. cp scripts/environments/example.env.template scripts/environments/staging.env
 *   2. open scripts/environments/staging.env in your editor and fill it in
 *   3. node scripts/bootstrap-env.mjs staging            # dry-run (default: changes nothing)
 *   4. node scripts/bootstrap-env.mjs staging --execute  # do it for real
 *
 * The config file is parsed by this script (never by the shell), so values
 * with spaces, slashes, or > characters are fine. Config files are gitignored.
 *
 * Steps (each idempotent — re-running reconciles, never duplicates):
 *   link + db push · functions deploy · function secrets (Cloudflare) ·
 *   Auth site_url + redirect allow-list (Management API — config as code) ·
 *   invite founding admin + role=admin · optional first client + storage.
 *
 * The platform-account steps it does NOT do (create the Supabase project, the
 * R2 bucket/token/public-domain, Vercel, DNS) are printed as a checklist.
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const KNOWN_PROD_REF = 'knbxyaplaoenrxrpgwcg'; // guard: refuse to hit prod without --i-know-its-prod

function die(msg) { console.error(`\n✗ ${msg}\n`); process.exit(1); }

/* ── inputs ──────────────────────────────────────────────────────────────── */
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const envName = positional[0];
const EXECUTE = flags.has('--execute');

if (!envName) {
  die('Usage: node scripts/bootstrap-env.mjs <env-name> [--execute]\n' +
      '  Reads scripts/environments/<env-name>.env (copy example.env.template first).');
}

const configPath = `scripts/environments/${envName}.env`;
if (!existsSync(configPath)) {
  die(`Config not found: ${configPath}\n` +
      `  Create it:  cp scripts/environments/example.env.template ${configPath}\n` +
      `  then fill it in and re-run.`);
}

function loadEnvFile(path) {
  const out = {};
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}
const cfg = loadEnvFile(configPath);

const required = ['PROJECT_REF', 'SITE_URL', 'ADMIN_EMAIL', 'SUPABASE_ACCESS_TOKEN', 'SUPABASE_DB_PASSWORD', 'SUPABASE_SERVICE_KEY'];
const missing = required.filter(k => !cfg[k]);
if (missing.length) die(`${configPath} is missing: ${missing.join(', ')}`);

const ref = cfg.PROJECT_REF;
if (ref === KNOWN_PROD_REF && !flags.has('--i-know-its-prod')) {
  die(`PROJECT_REF is PRODUCTION (${ref}). If you really mean it, add --i-know-its-prod. ` +
      `For staging, use the staging project ref.`);
}

const supabaseUrl = `https://${ref}.supabase.co`;
const redirectList = [...new Set([
  `${cfg.SITE_URL}/**`,
  'http://localhost:7623/auth-callback',
  'http://localhost:5173/**',
  ...String(cfg.REDIRECT_URLS || '').split(',').map(s => s.trim()).filter(Boolean),
])];

console.log(`\n━━━ bootstrap "${envName}" → ${ref} ━━━`);
console.log(`  site url:      ${cfg.SITE_URL}`);
console.log(`  admin invite:  ${cfg.ADMIN_EMAIL}`);
console.log(`  redirect list: ${redirectList.join('  ')}`);
if (cfg.CLIENT_NAME) console.log(`  first client:  "${cfg.CLIENT_NAME}"  bucket=${cfg.R2_BUCKET || '(none)'}  domain=${cfg.R2_PUBLIC_DOMAIN || '(none)'}`);
console.log(EXECUTE ? '  MODE: EXECUTE (will make changes)\n' : '  MODE: dry-run (no changes — add --execute to run)\n');

/* ── helpers ─────────────────────────────────────────────────────────────── */
function sh(cmd, label) {
  console.log(`\n▸ ${label}`);
  if (!EXECUTE) { console.log(`  [dry-run] ${cmd}`); return; }
  execSync(cmd, { stdio: 'inherit', env: {
    ...process.env,
    SUPABASE_ACCESS_TOKEN: cfg.SUPABASE_ACCESS_TOKEN,
    SUPABASE_DB_PASSWORD:  cfg.SUPABASE_DB_PASSWORD,
  } });
}
async function api(label, url, init) {
  console.log(`\n▸ ${label}`);
  if (!EXECUTE) { console.log(`  [dry-run] ${init.method} ${url}`); return {}; }
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`${label} failed (${res.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}
const mgmt = { Authorization: `Bearer ${cfg.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' };
const svc  = { apikey: cfg.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${cfg.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };

/* ── run ─────────────────────────────────────────────────────────────────── */
try {
  sh(`supabase link --project-ref ${ref}`, 'Link project');
  sh(`supabase db push`, 'Push schema (all migrations)');
  sh(`supabase functions deploy`, 'Deploy edge functions');

  // Function secrets: env-level R2 + Cloudflare grant creds.
  if (cfg.CF_API_TOKEN && cfg.CF_ACCOUNT_ID && cfg.R2_PARENT_ACCESS_KEY_ID && cfg.R2_BUCKET && cfg.R2_PUBLIC_DOMAIN) {
    console.log('\n▸ Set function secrets (R2 + Cloudflare grant)');
    if (!EXECUTE) {
      console.log('  [dry-run] supabase secrets set --env-file <temp>');
    } else {
      const tmp = join(tmpdir(), `dchub-cf-secrets-${ref}.env`);
      writeFileSync(tmp, [
        `R2_BUCKET=${cfg.R2_BUCKET}`,
        `R2_PUBLIC_DOMAIN=${cfg.R2_PUBLIC_DOMAIN.replace(/\/+$/, '')}`,
        `CF_API_TOKEN=${cfg.CF_API_TOKEN}`,
        `CF_ACCOUNT_ID=${cfg.CF_ACCOUNT_ID}`,
        `R2_PARENT_ACCESS_KEY_ID=${cfg.R2_PARENT_ACCESS_KEY_ID}`,
        '',
      ].join('\n'), { mode: 0o600 });
      try {
        execSync(`supabase secrets set --env-file ${tmp}`, { stdio: 'inherit', env: { ...process.env, SUPABASE_ACCESS_TOKEN: cfg.SUPABASE_ACCESS_TOKEN } });
      } finally { unlinkSync(tmp); }
    }
  } else {
    console.log('\n▸ Function secrets — SKIPPED (need R2_BUCKET, R2_PUBLIC_DOMAIN, and CF_* in config; logo upload / r2-grant will 503 until set)');
  }

  await api('Set Auth site URL + redirect allow-list',
    `https://api.supabase.com/v1/projects/${ref}/config/auth`,
    { method: 'PATCH', headers: mgmt, body: JSON.stringify({ site_url: cfg.SITE_URL, uri_allow_list: redirectList.join(',') }) });

  // Founding admin: invite (creates auth.users → handle_new_user makes a
  // 'client' profile), then promote to admin.
  let adminId = null;
  try {
    const invited = await api(`Invite admin ${cfg.ADMIN_EMAIL}`,
      `${supabaseUrl}/auth/v1/invite`,
      { method: 'POST', headers: svc, body: JSON.stringify({ email: cfg.ADMIN_EMAIL }) });
    adminId = invited.id ?? (!EXECUTE ? '<dry-run-admin-id>' : null);
  } catch (e) {
    console.log(`  (invite skipped: ${String(e.message).split('\n')[0]})`);
    const found = await api(`Look up existing user`,
      `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(cfg.ADMIN_EMAIL)}`,
      { method: 'GET', headers: svc });
    adminId = (found.users ?? []).find(u => (u.email || '').toLowerCase() === cfg.ADMIN_EMAIL.toLowerCase())?.id ?? null;
  }
  if (adminId) {
    await api('Promote admin to role=admin',
      `${supabaseUrl}/rest/v1/profiles?id=eq.${adminId}`,
      { method: 'PATCH', headers: { ...svc, Prefer: 'return=minimal' }, body: JSON.stringify({ role: 'admin' }) });
  } else if (EXECUTE) {
    console.log('  ⚠ could not resolve the admin user id — promote manually in the SQL editor.');
  }

  // Optional first client + storage + membership.
  if (cfg.CLIENT_NAME && adminId) {
    const created = await api(`Create client "${cfg.CLIENT_NAME}"`,
      `${supabaseUrl}/rest/v1/clients`,
      { method: 'POST', headers: { ...svc, Prefer: 'return=representation,resolution=merge-duplicates' },
        body: JSON.stringify({
          name: cfg.CLIENT_NAME,
          r2_bucket: cfg.R2_BUCKET || null,
          r2_public_domain: cfg.R2_PUBLIC_DOMAIN ? cfg.R2_PUBLIC_DOMAIN.replace(/\/+$/, '') : null,
          identity_migrated: true,
        }) });
    const clientId = Array.isArray(created) ? created[0]?.id : created?.id;
    if (clientId) {
      await api('Assign admin to the client',
        `${supabaseUrl}/rest/v1/client_members`,
        { method: 'POST', headers: { ...svc, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: adminId, client_id: clientId }) });
    }
  }

  console.log(EXECUTE
    ? `\n✓ Bootstrap complete for "${envName}" (${ref}).\n`
    : `\n✓ Dry-run OK. Re-run with --execute to apply.\n`);
} catch (e) {
  die(String(e.message || e));
}

console.log(`─── Remaining manual steps (platform accounts) ───
  1. Cloudflare R2: bucket "${cfg.R2_BUCKET || '<bucket>'}" with a public domain + CORS GET/HEAD from *.  (You said staging R2 is already set up.)
  2. Vercel: point a project/branch at ${cfg.SITE_URL} with this env's URL + anon key.
  3. Desktop: Settings → Environments → add ${supabaseUrl} + the publishable/anon key; sign in as ${cfg.ADMIN_EMAIL}.
`);
