#!/usr/bin/env node
/**
 * Vercel build entry — pick Vite mode from the Git branch and FORCE the matching
 * committed VITE_* values onto the process env.
 *
 * Why force: Vercel dashboard env vars override Vite mode files. If Preview
 * still has production VITE_SUPABASE_*, staging.hub talks to prod Auth → magic
 * links redirect to hub.disruptcollective.com and the guest form is skipped.
 *
 * main      → .env.production
 * everything else → .env.staging
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(__dirname, '..');

const branch = process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF_NAME || '';
const mode = branch === 'main' ? 'production' : 'staging';
const script = mode === 'production' ? 'build:production' : 'build:staging';
const envFile = resolve(webRoot, `apps/client-hub/.env.${mode}`);

function loadViteEnv(path) {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key.startsWith('VITE_')) out[key] = value;
  }
  return out;
}

const fileEnv = loadViteEnv(envFile);
if (!fileEnv.VITE_SUPABASE_URL || !fileEnv.VITE_SUPABASE_ANON_KEY) {
  console.error(`[vercel-build] missing VITE_* in ${envFile}`);
  process.exit(1);
}

const previous = process.env.VITE_SUPABASE_URL;
if (previous && previous !== fileEnv.VITE_SUPABASE_URL) {
  console.warn(
    `[vercel-build] overriding Vercel VITE_SUPABASE_URL\n` +
      `  was: ${previous}\n` +
      `  now: ${fileEnv.VITE_SUPABASE_URL}`,
  );
}

console.log(
  `[vercel-build] branch=${branch || '(unknown)'} mode=${mode} → ${script}\n` +
    `  VITE_SUPABASE_URL=${fileEnv.VITE_SUPABASE_URL}`,
);

const result = spawnSync(
  'npm',
  ['run', script, '--workspace=apps/client-hub'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd: webRoot,
    env: { ...process.env, ...fileEnv },
  },
);

process.exit(result.status ?? 1);
