/* Super-admin CDN garbage collection.
 *
 * Analysis is read-only and returns the same shared classification as the CLI. Execution always
 * rebuilds that analysis, binds confirmation to a deterministic plan id, rechecks the database
 * snapshot once more immediately before deletion, and only deletes objects classified as orphan.
 * R2 credentials never leave this function.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  assertReferenceSafety,
  buildReferenceIndex,
  buildReport,
  classifyObjects,
  DEFAULT_MIN_ROWS,
  type CdnGcAssetRow,
  type CdnGcReport,
  type ClassifiedCdnObject,
  type ListedCdnObject,
  type OrphanCdnObject,
} from '../../../packages/domain/src/cdnGarbageCollection.ts';
import { preflight, corsJson as json } from '../_shared/cors.ts';
import { classifyCallerAuthFailure } from '../_shared/caller-auth-policy.ts';
import { listObjects, s3, tempCredentials, type TempCreds } from '../_shared/r2.ts';
import {
  deletionConfirmation,
  guardCdnGcExecution,
  PRODUCTION_PROJECT_REF,
} from '../_shared/cdn-gc-policy.ts';

type Action = 'analyze' | 'execute';
interface RequestBody {
  action?: Action;
  expected_plan_id?: string;
  confirmation?: string;
  production_confirmation?: string;
}

interface RuntimeConfig {
  projectRef: string;
  environment: string;
  isProduction: boolean;
  accountId: string;
  apiToken: string;
  parentKey: string;
  publicBucket: string;
  gatedBucket: string;
  publicDomain: string;
  gatedDomain: string;
}

interface Analysis {
  report: CdnGcReport;
  classified: ClassifiedCdnObject[];
  rowsFingerprint: string;
  planId: string;
}

const PAGE_SIZE = 1000;
const DELETE_CONCURRENCY = 20;

function env(name: string): string {
  return Deno.env.get(name) ?? (name === 'CF_R2_TOKEN' ? Deno.env.get('CF_API_TOKEN') ?? '' : '');
}

function runtimeConfig(): RuntimeConfig {
  const required = [
    'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
    'R2_BUCKET', 'R2_PUBLIC_DOMAIN', 'R2_GATED_BUCKET', 'R2_GATED_DOMAIN',
    'CF_R2_TOKEN', 'CF_ACCOUNT_ID', 'R2_PARENT_ACCESS_KEY_ID',
  ];
  const missing = required.filter(name => !env(name));
  if (missing.length) throw new Error(`Storage not provisioned — missing ${missing.join(', ')}`);
  const projectRef = new URL(env('SUPABASE_URL')).hostname.split('.')[0];
  const isProduction = projectRef === PRODUCTION_PROJECT_REF;
  return {
    projectRef,
    environment: isProduction ? 'production' : 'staging',
    isProduction,
    accountId: env('CF_ACCOUNT_ID'),
    apiToken: env('CF_R2_TOKEN'),
    parentKey: env('R2_PARENT_ACCESS_KEY_ID'),
    publicBucket: env('R2_BUCKET'),
    gatedBucket: env('R2_GATED_BUCKET'),
    publicDomain: env('R2_PUBLIC_DOMAIN'),
    gatedDomain: env('R2_GATED_DOMAIN'),
  };
}

function stableRows(rows: CdnGcAssetRow[]): CdnGcAssetRow[] {
  return [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))).map(row => ({
    id: row.id ?? null,
    client_id: row.client_id ?? null,
    stable_id: row.stable_id ?? null,
    child_id: row.child_id ?? null,
    perm: row.perm ?? null,
    status: row.status ?? null,
    thumbnail_url: row.thumbnail_url ?? null,
    download_url: row.download_url ?? null,
    download_key: row.download_key ?? null,
    preview_page_count: row.preview_page_count ?? null,
  }));
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchAllAssets(db: ReturnType<typeof createClient>): Promise<CdnGcAssetRow[]> {
  const columns = 'id,client_id,stable_id,child_id,perm,status,thumbnail_url,download_url,download_key,preview_page_count';
  const first = await db.from('assets').select(columns, { count: 'exact' }).order('id').range(0, PAGE_SIZE - 1);
  if (first.error) throw new Error(`assets query failed: ${first.error.message}`);
  const expected = first.count;
  if (expected == null) throw new Error('assets query did not return an exact count');
  const rows = [...(first.data ?? [])] as CdnGcAssetRow[];
  for (let from = PAGE_SIZE; from < expected; from += PAGE_SIZE) {
    const page = await db.from('assets').select(columns).order('id').range(from, from + PAGE_SIZE - 1);
    if (page.error) throw new Error(`assets page at ${from} failed: ${page.error.message}`);
    rows.push(...((page.data ?? []) as CdnGcAssetRow[]));
  }
  if (rows.length !== expected) {
    throw new Error(`asset count changed during pagination: expected ${expected}, received ${rows.length}`);
  }
  const ids = new Set(rows.map(row => row.id));
  if (ids.size !== rows.length || ids.has(null) || ids.has(undefined)) {
    throw new Error('assets query returned a missing or duplicate id');
  }
  return rows;
}

async function inventory(
  cfg: RuntimeConfig,
  creds: Record<'public' | 'gated', TempCreds>,
): Promise<ListedCdnObject[]> {
  const [publicObjects, gatedObjects] = await Promise.all([
    listObjects(cfg.accountId, creds.public, cfg.publicBucket),
    listObjects(cfg.accountId, creds.gated, cfg.gatedBucket),
  ]);
  return [
    ...publicObjects.map(object => ({ ...object, tier: 'public' as const, bucket: cfg.publicBucket })),
    ...gatedObjects.map(object => ({ ...object, tier: 'gated' as const, bucket: cfg.gatedBucket })),
  ];
}

async function makeAnalysis(
  db: ReturnType<typeof createClient>,
  cfg: RuntimeConfig,
  permission: 'object-read-only' | 'object-read-write',
): Promise<{ analysis: Analysis; creds: Record<'public' | 'gated', TempCreds> }> {
  const rows = await fetchAllAssets(db);
  const index = buildReferenceIndex(rows, {
    publicDomain: cfg.publicDomain,
    gatedDomain: cfg.gatedDomain,
    dropDisconnected: false,
  });
  assertReferenceSafety(index, { minRows: DEFAULT_MIN_ROWS });
  const [publicCreds, gatedCreds] = await Promise.all([
    tempCredentials(cfg.accountId, cfg.apiToken, cfg.parentKey, cfg.publicBucket, permission),
    tempCredentials(cfg.accountId, cfg.apiToken, cfg.parentKey, cfg.gatedBucket, permission),
  ]);
  const creds = { public: publicCreds, gated: gatedCreds };
  const classified = classifyObjects(await inventory(cfg, creds), index);
  const report = buildReport({
    environment: cfg.environment,
    config: { projectRef: cfg.projectRef, publicBucket: cfg.publicBucket, gatedBucket: cfg.gatedBucket },
    index,
    classified,
    options: { minRows: DEFAULT_MIN_ROWS },
  });
  const rowsFingerprint = await sha256(stableRows(rows));
  const candidates = classified
    .filter((object): object is OrphanCdnObject => object.status === 'orphan')
    .map(({ tier, bucket, key, size, lastModified, reason }) => ({ tier, bucket, key, size, lastModified, reason }))
    .sort((a, b) => `${a.tier}:${a.key}`.localeCompare(`${b.tier}:${b.key}`));
  const planId = await sha256({ schemaVersion: 1, projectRef: cfg.projectRef, rowsFingerprint, candidates });
  return { analysis: { report, classified, rowsFingerprint, planId }, creds };
}

function publicAnalysis(analysis: Analysis, cfg: RuntimeConfig) {
  const { report, planId } = analysis;
  return {
    planId,
    report,
    executable: report.totals.orphanCount > 0 && !report.safety.blastRadiusExceeded,
    expectedConfirmation: deletionConfirmation(report.totals.orphanCount),
    requiresProductionConfirmation: cfg.isProduction,
  };
}

async function deleteCandidates(
  analysis: Analysis,
  cfg: RuntimeConfig,
  creds: Record<'public' | 'gated', TempCreds>,
) {
  const candidates = analysis.classified.filter(
    (object): object is OrphanCdnObject => object.status === 'orphan',
  );
  const deleted: { tier: string; bucket: string; key: string; size: number; alreadyMissing: boolean }[] = [];
  const failures: { tier: string; bucket: string; key: string; size: number; status: number }[] = [];
  for (let offset = 0; offset < candidates.length; offset += DELETE_CONCURRENCY) {
    const batch = candidates.slice(offset, offset + DELETE_CONCURRENCY);
    await Promise.all(batch.map(async object => {
      const expectedBucket = object.tier === 'public' ? cfg.publicBucket : cfg.gatedBucket;
      if (object.bucket !== expectedBucket || !object.key) {
        throw new Error(`refusing deletion outside configured bucket: ${object.bucket}/${object.key}`);
      }
      const res = await s3(cfg.accountId, creds[object.tier], object.bucket, 'DELETE', object.key);
      if (res.ok || res.status === 404) {
        deleted.push({
          tier: object.tier,
          bucket: object.bucket,
          key: object.key,
          size: object.size,
          alreadyMissing: res.status === 404,
        });
      } else {
        await res.arrayBuffer().catch(() => undefined);
        failures.push({ tier: object.tier, bucket: object.bucket, key: object.key, size: object.size, status: res.status });
      }
    }));
  }
  deleted.sort((a, b) => `${a.tier}:${a.key}`.localeCompare(`${b.tier}:${b.key}`));
  failures.sort((a, b) => `${a.tier}:${a.key}`.localeCompare(`${b.tier}:${b.key}`));
  return {
    plannedCount: candidates.length,
    plannedBytes: candidates.reduce((sum, object) => sum + object.size, 0),
    deletedCount: deleted.length,
    deletedBytes: deleted.reduce((sum, object) => sum + object.size, 0),
    failureCount: failures.length,
    deleted,
    failures,
  };
}

Deno.serve(async req => {
  const pre = preflight(req);
  if (pre) return pre;
  if (req.method !== 'POST') return json(req, 405, { error: 'POST only' });

  try {
    const cfg = runtimeConfig();
    if (cfg.publicBucket === cfg.gatedBucket) {
      return json(req, 503, { error: 'Public and gated bucket names must be different.' });
    }
    const authHeader = req.headers.get('Authorization') ?? '';
    const caller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false },
    });
    const { data: userData, error: authError } = await caller.auth.getUser();
    if (authError || !userData.user) {
      /* Logged, unlike the sibling functions: this one is reached by hand, from an admin page, and
         "which of the two 401s was it" is the first question asked when it refuses. */
      const failure = classifyCallerAuthFailure(authError, authHeader);
      console.warn(JSON.stringify({
        event: 'cdn-gc-auth-refused', code: failure.code, authCode: failure.authCode,
      }));
      return json(req, 401, { error: failure.error, code: failure.code });
    }
    const { data: profile, error: profileError } = await caller
      .from('profiles').select('role').eq('id', userData.user.id).single();
    if (profileError || profile?.role !== 'super_admin') {
      return json(req, 403, { error: 'CDN garbage collection is for super admins only.' });
    }

    const body = await req.json().catch(() => ({})) as RequestBody;
    const action = body.action ?? 'analyze';
    if (action !== 'analyze' && action !== 'execute') {
      return json(req, 400, { error: 'action must be analyze or execute' });
    }
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });

    const { analysis, creds } = await makeAnalysis(
      db,
      cfg,
      action === 'execute' ? 'object-read-write' : 'object-read-only',
    );
    if (action === 'analyze') {
      console.log(JSON.stringify({
        event: 'cdn-gc-analysis', actorId: userData.user.id, environment: cfg.environment,
        planId: analysis.planId, objects: analysis.report.totals.totalCount,
        orphanCount: analysis.report.totals.orphanCount, orphanBytes: analysis.report.totals.orphanBytes,
      }));
      return json(req, 200, { ok: true, action, analysis: publicAnalysis(analysis, cfg) });
    }

    const guard = guardCdnGcExecution({
      report: analysis.report,
      currentPlanId: analysis.planId,
      expectedPlanId: body.expected_plan_id,
      confirmation: body.confirmation,
      productionConfirmation: body.production_confirmation,
      isProduction: cfg.isProduction,
    });
    if (!guard.ok) {
      return json(req, 200, {
        ok: false,
        action,
        code: guard.code,
        error: guard.error,
        analysis: publicAnalysis(analysis, cfg),
      });
    }

    // The analysis/listing can take time. Any row mutation since it began invalidates the plan even
    // when the candidate set happens to hash the same, so compare the exact canonical row snapshot.
    const currentRowsFingerprint = await sha256(stableRows(await fetchAllAssets(db)));
    if (currentRowsFingerprint !== analysis.rowsFingerprint) {
      return json(req, 200, {
        ok: false,
        action,
        code: 'assets_changed',
        error: 'Asset rows changed after analysis. Run Analyze again before deleting.',
      });
    }

    const result = await deleteCandidates(analysis, cfg, creds);
    const { analysis: verification } = await makeAnalysis(db, cfg, 'object-read-only');
    console.log(JSON.stringify({
      event: 'cdn-gc-execution', actorId: userData.user.id, environment: cfg.environment,
      planId: analysis.planId, plannedCount: result.plannedCount, deletedCount: result.deletedCount,
      deletedBytes: result.deletedBytes, failureCount: result.failureCount,
      remainingOrphans: verification.report.totals.orphanCount,
    }));
    return json(req, 200, {
      ok: result.failureCount === 0,
      action,
      execution: {
        planId: analysis.planId,
        completedAt: new Date().toISOString(),
        ...result,
      },
      verification: publicAnalysis(verification, cfg),
      ...(result.failureCount ? { error: 'Some R2 deletions failed. Review the result and analyze again.' } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ event: 'cdn-gc-error', error: message }));
    return json(req, message.startsWith('Storage not provisioned') ? 503 : 500, { error: message });
  }
});
