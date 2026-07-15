#!/usr/bin/env node
/**
 * Vercel build entry — pick Vite mode from the Git branch so staging never
 * silently bakes in committed .env.production (prod Supabase).
 *
 * main      → production (.env.production)
 * staging + PR previews → staging (.env.staging)
 */
import { spawnSync } from 'node:child_process';

const branch = process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF_NAME || '';
const script = branch === 'main' ? 'build:production' : 'build:staging';

console.log(`[vercel-build] branch=${branch || '(unknown)'} → npm run ${script}`);

const result = spawnSync(
  'npm',
  ['run', script, '--workspace=apps/client-hub'],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

process.exit(result.status ?? 1);
