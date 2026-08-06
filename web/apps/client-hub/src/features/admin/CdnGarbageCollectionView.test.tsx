// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CdnGcAnalysis, ExecuteResponse } from '../../services/cdnGarbageCollection'

const analyzeMock = vi.fn<() => Promise<CdnGcAnalysis>>()
const executeMock = vi.fn<() => Promise<ExecuteResponse>>()

vi.mock('../../services/cdnGarbageCollection', () => ({
  analyzeCdnGarbage: analyzeMock,
  executeCdnGarbage: executeMock,
}))
vi.mock('../../lib/reportError', () => ({
  reportError: vi.fn(),
  toMessage: (value: unknown) => value instanceof Error ? value.message : String(value),
}))

const analysis: CdnGcAnalysis = {
  planId: 'plan-1234567890',
  executable: true,
  expectedConfirmation: 'DELETE 2 OBJECTS',
  requiresProductionConfirmation: false,
  report: {
    schemaVersion: 1,
    environment: 'staging',
    generatedAt: '2026-08-06T12:00:00.000Z',
    mode: 'dry-run',
    configuration: { projectRef: 'staging-ref', publicBucket: 'public-test', gatedBucket: 'gated-test' },
    options: { dropDisconnected: false, includeProtected: [], minRows: 10, force: false },
    source: { assetRows: 104, liveRows: 100, disconnectedRows: 4, includedRows: 104, usableIdentityRows: 104, warnings: [] },
    references: { liveExact: 235, liveOriginalPrefixes: 0, disconnectedExact: 2, disconnectedOriginalPrefixes: 0 },
    writerAudit: [],
    safety: { blastRadiusThreshold: 0.6, orphanFraction: 0.2, blastRadiusExceeded: false, forced: false },
    totals: {
      totalCount: 10, totalBytes: 1000, referencedCount: 7, referencedBytes: 700,
      disconnectedReferencedCount: 1, disconnectedReferencedBytes: 100,
      protectedCount: 1, protectedBytes: 100, orphanCount: 2, orphanBytes: 200,
    },
    buckets: [{
      tier: 'public', bucket: 'public-test',
      totals: {
        totalCount: 10, totalBytes: 1000, referencedCount: 7, referencedBytes: 700,
        disconnectedReferencedCount: 1, disconnectedReferencedBytes: 100,
        protectedCount: 1, protectedBytes: 100, orphanCount: 2, orphanBytes: 200,
      },
      orphanGroups: {
        byReason: [{ value: 'old-level-copy', count: 2, bytes: 200, sampleKeys: ['client/thumb.webp'] }],
        byClient: [], byLevel: [],
      },
      objects: [],
    }],
  },
}

const { CdnGarbageCollectionView } = await import('./CdnGarbageCollectionView')

describe('CdnGarbageCollectionView', () => {
  beforeEach(() => {
    analyzeMock.mockReset().mockResolvedValue(analysis)
    executeMock.mockReset().mockResolvedValue({
      ok: true,
      action: 'execute',
      execution: {
        planId: analysis.planId,
        completedAt: '2026-08-06T12:10:00.000Z',
        plannedCount: 2,
        plannedBytes: 200,
        deletedCount: 2,
        deletedBytes: 200,
        failureCount: 0,
        deleted: [],
        failures: [],
      },
      verification: { ...analysis, executable: false, expectedConfirmation: 'DELETE 0 OBJECTS', report: {
        ...analysis.report,
        totals: { ...analysis.report.totals, orphanCount: 0, orphanBytes: 0 },
      } },
    })
  })

  it('analyzes, displays the full summary, and requires the exact typed confirmation', async () => {
    render(<CdnGarbageCollectionView isSuperAdmin />)
    fireEvent.click(screen.getByRole('button', { name: 'Analyze' }))

    expect(await screen.findByText('old-level-copy')).toBeInTheDocument()
    expect(screen.getByText('104')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Execute deletion' }))

    const executeButton = screen.getByRole('button', { name: 'Delete confirmed orphans' })
    expect(executeButton).toBeDisabled()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DELETE 2 OBJECTS' } })
    expect(executeButton).toBeEnabled()
    fireEvent.click(executeButton)

    await waitFor(() => expect(executeMock).toHaveBeenCalledWith({
      expectedPlanId: analysis.planId,
      confirmation: 'DELETE 2 OBJECTS',
      productionConfirmation: '',
    }))
    expect(await screen.findByText(/Deleted/)).toBeInTheDocument()
    expect(screen.getByText(/Verification relisted both buckets: 0 orphan objects remain/)).toBeInTheDocument()
  })

  it('does not expose analysis to a non-super-admin', () => {
    render(<CdnGarbageCollectionView isSuperAdmin={false} />)
    expect(screen.queryByRole('button', { name: 'Analyze' })).not.toBeInTheDocument()
    expect(screen.getByText(/visible to super admins only/)).toBeInTheDocument()
  })
})
