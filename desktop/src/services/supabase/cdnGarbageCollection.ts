import type { CdnGcReport } from '@sotto/domain';
import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';
import { edgeFunctionError } from './edgeErrors';

export interface CdnGcAnalysis {
  planId: string;
  report: CdnGcReport;
  executable: boolean;
  expectedConfirmation: string;
  requiresProductionConfirmation: boolean;
}

export interface CdnGcExecution {
  planId: string;
  completedAt: string;
  plannedCount: number;
  plannedBytes: number;
  deletedCount: number;
  deletedBytes: number;
  failureCount: number;
  deleted: Array<{
    tier: string;
    bucket: string;
    key: string;
    size: number;
    alreadyMissing: boolean;
  }>;
  failures: Array<{
    tier: string;
    bucket: string;
    key: string;
    size: number;
    status: number;
  }>;
}

interface AnalyzeResponse {
  ok: boolean;
  action: 'analyze';
  analysis?: CdnGcAnalysis;
  error?: string;
}

export interface ExecuteResponse {
  ok: boolean;
  action: 'execute';
  code?: string;
  error?: string;
  analysis?: CdnGcAnalysis;
  execution?: CdnGcExecution;
  verification?: CdnGcAnalysis;
}

async function callCdnGc<T>(config: SupabaseConfig, body: Record<string, unknown>): Promise<T> {
  const res = await sbFetch(`${config.url.replace(/\/+$/, '')}/functions/v1/cdn-gc`, {
    method: 'POST',
    headers: await makeHeaders(config.anonKey),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw edgeFunctionError('cdn-gc', res.status, await res.text());
  return await res.json<T>();
}

export async function analyzeCdnGarbage(config: SupabaseConfig): Promise<CdnGcAnalysis> {
  const result = await callCdnGc<AnalyzeResponse>(config, { action: 'analyze' });
  if (!result.ok || !result.analysis) {
    throw new Error(result.error ?? 'CDN analysis returned no report.');
  }
  return result.analysis;
}

export async function executeCdnGarbage(
  config: SupabaseConfig,
  args: { expectedPlanId: string; confirmation: string; productionConfirmation?: string },
): Promise<ExecuteResponse> {
  return await callCdnGc<ExecuteResponse>(config, {
    action: 'execute',
    expected_plan_id: args.expectedPlanId,
    confirmation: args.confirmation,
    production_confirmation: args.productionConfirmation,
  });
}
