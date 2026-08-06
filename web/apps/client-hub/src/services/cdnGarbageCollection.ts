import type { CdnGcReport } from '@sotto/domain'
import { supabase } from '../lib/supabase'
import { edgeFunctionError } from '../lib/edgeFunction'

export interface CdnGcAnalysis {
  planId: string
  report: CdnGcReport
  executable: boolean
  expectedConfirmation: string
  requiresProductionConfirmation: boolean
}

export interface CdnGcDeletion {
  tier: string
  bucket: string
  key: string
  size: number
  alreadyMissing: boolean
}

export interface CdnGcFailure {
  tier: string
  bucket: string
  key: string
  size: number
  status: number
}

export interface CdnGcExecution {
  planId: string
  completedAt: string
  plannedCount: number
  plannedBytes: number
  deletedCount: number
  deletedBytes: number
  failureCount: number
  deleted: CdnGcDeletion[]
  failures: CdnGcFailure[]
}

interface AnalyzeResponse {
  ok: boolean
  action: 'analyze'
  analysis: CdnGcAnalysis
  error?: string
}

export interface ExecuteResponse {
  ok: boolean
  action: 'execute'
  code?: string
  error?: string
  analysis?: CdnGcAnalysis
  execution?: CdnGcExecution
  verification?: CdnGcAnalysis
}

export class CdnGarbageCollectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CdnGarbageCollectionError'
  }
}

export async function analyzeCdnGarbage(): Promise<CdnGcAnalysis> {
  if (!supabase) throw new CdnGarbageCollectionError('Supabase is not configured.')
  const { data, error } = await supabase.functions.invoke<AnalyzeResponse>('cdn-gc', {
    body: { action: 'analyze' },
  })
  if (error) {
    throw new CdnGarbageCollectionError(await edgeFunctionError(error) ?? error.message)
  }
  if (!data?.ok || !data.analysis) {
    throw new CdnGarbageCollectionError(data?.error ?? 'CDN analysis returned no report.')
  }
  return data.analysis
}

export async function executeCdnGarbage(args: {
  expectedPlanId: string
  confirmation: string
  productionConfirmation?: string
}): Promise<ExecuteResponse> {
  if (!supabase) throw new CdnGarbageCollectionError('Supabase is not configured.')
  const { data, error } = await supabase.functions.invoke<ExecuteResponse>('cdn-gc', {
    body: {
      action: 'execute',
      expected_plan_id: args.expectedPlanId,
      confirmation: args.confirmation,
      production_confirmation: args.productionConfirmation,
    },
  })
  if (error) {
    throw new CdnGarbageCollectionError(await edgeFunctionError(error) ?? error.message)
  }
  if (!data) throw new CdnGarbageCollectionError('CDN execution returned no result.')
  return data
}
