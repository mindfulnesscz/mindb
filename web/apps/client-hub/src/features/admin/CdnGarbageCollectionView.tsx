import { useState } from 'react'
import type { CdnGcGroup, CdnGcTotals } from '@sotto/domain'
import {
  analyzeCdnGarbage,
  executeCdnGarbage,
  type CdnGcAnalysis,
  type CdnGcExecution,
} from '../../services/cdnGarbageCollection'
import { reportError, toMessage } from '../../lib/reportError'

function bytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value)
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let size = value
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1 }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

function SummaryCard({ label, count, size, danger = false }: {
  label: string
  count: number
  size?: number
  danger?: boolean
}) {
  return (
    <div className={`border rounded-sm p-4 ${danger ? 'border-signal-error bg-signal-error/5' : 'border-border bg-surface'}`}>
      <div className="text-[10px] uppercase tracking-label text-text-muted font-sans">{label}</div>
      <div className="mt-1 font-serif text-2xl text-cosmos-black">{count.toLocaleString()}</div>
      {size != null && <div className="text-[11px] font-mono text-text-muted mt-1">{bytes(size)}</div>}
    </div>
  )
}

function BucketTotals({ totals }: { totals: CdnGcTotals }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px] font-sans">
      <div><span className="text-text-muted">All</span><br />{totals.totalCount} · {bytes(totals.totalBytes)}</div>
      <div><span className="text-text-muted">Referenced</span><br />{totals.referencedCount} · {bytes(totals.referencedBytes)}</div>
      <div><span className="text-text-muted">Protected</span><br />{totals.protectedCount} · {bytes(totals.protectedBytes)}</div>
      <div><span className="text-text-muted">Orphans</span><br />{totals.orphanCount} · {bytes(totals.orphanBytes)}</div>
    </div>
  )
}

function GroupTable({ title, groups }: { title: string; groups: CdnGcGroup[] }) {
  if (!groups.length) return null
  return (
    <div>
      <h4 className="text-[10px] uppercase tracking-label text-text-muted font-sans mb-2">{title}</h4>
      <div className="border border-border rounded-sm overflow-x-auto">
        <table className="w-full text-[11px] font-sans">
          <thead className="text-text-muted bg-surface-sunken">
            <tr>
              <th className="text-left px-3 py-2 font-normal">Value</th>
              <th className="text-right px-3 py-2 font-normal">Objects</th>
              <th className="text-right px-3 py-2 font-normal">Bytes</th>
              <th className="text-left px-3 py-2 font-normal">Sample keys</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(group => (
              <tr key={group.value} className="border-t border-border align-top">
                <td className="px-3 py-2 font-medium whitespace-nowrap">{group.value}</td>
                <td className="px-3 py-2 text-right">{group.count}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{bytes(group.bytes)}</td>
                <td className="px-3 py-2 font-mono text-[10px] break-all text-text-muted">
                  {group.sampleKeys.map(key => <div key={key}>{key}</div>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AnalysisReport({ analysis }: { analysis: CdnGcAnalysis }) {
  const report = analysis.report
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <SummaryCard label="Assets" count={report.source.assetRows} />
        <SummaryCard label="Objects" count={report.totals.totalCount} size={report.totals.totalBytes} />
        <SummaryCard label="Referenced" count={report.totals.referencedCount} size={report.totals.referencedBytes} />
        <SummaryCard label="Protected" count={report.totals.protectedCount} size={report.totals.protectedBytes} />
        <SummaryCard label="Orphans" count={report.totals.orphanCount} size={report.totals.orphanBytes} danger={report.totals.orphanCount > 0} />
      </div>

      <div className={`border rounded-sm p-4 text-sm font-sans ${report.safety.blastRadiusExceeded ? 'border-signal-error bg-signal-error/5' : 'border-border'}`}>
        <strong>Blast radius: {percent(report.safety.orphanFraction)}</strong>
        <span className="text-text-muted"> · limit {percent(report.safety.blastRadiusThreshold)}</span>
        {report.safety.blastRadiusExceeded && (
          <p className="mt-2 text-signal-error">Execution is blocked. Investigate the reference source; the GUI cannot force this gate.</p>
        )}
        <p className="mt-2 text-[11px] text-text-muted">
          {report.source.liveRows} live rows · {report.source.disconnectedRows} disconnected rows retained ·{' '}
          {report.totals.disconnectedReferencedCount} objects protected only by disconnected rows
        </p>
      </div>

      {report.source.warnings.length > 0 && (
        <details className="border border-border rounded-sm p-4">
          <summary className="cursor-pointer text-sm font-sans font-medium">
            Reference warnings ({report.source.warnings.length})
          </summary>
          <div className="mt-3 space-y-2 text-[10px] font-mono text-text-muted">
            {report.source.warnings.map((warning, index) => (
              <div key={`${warning.rowId}-${index}`}>{warning.rowId ?? 'unknown row'} · {warning.reason} · {warning.value ?? warning.column ?? ''}</div>
            ))}
          </div>
        </details>
      )}

      {report.buckets.map(bucket => (
        <section key={bucket.tier} className="space-y-5 border border-border rounded-sm p-4">
          <div>
            <h3 className="font-serif text-lg text-cosmos-black capitalize">{bucket.tier} bucket</h3>
            <div className="font-mono text-[10px] text-text-muted mt-1">{bucket.bucket}</div>
          </div>
          <BucketTotals totals={bucket.totals} />
          <GroupTable title="Orphans by reason" groups={bucket.orphanGroups.byReason} />
          <GroupTable title="Orphans by client" groups={bucket.orphanGroups.byClient} />
          <GroupTable title="Orphans by level" groups={bucket.orphanGroups.byLevel} />
        </section>
      ))}
    </div>
  )
}

function ExecutionResult({ execution, verification }: {
  execution: CdnGcExecution
  verification: CdnGcAnalysis | null
}) {
  return (
    <section className="border-2 border-cosmos-black rounded-sm p-5 space-y-3">
      <h3 className="font-serif text-xl text-cosmos-black">Execution report</h3>
      <p className="text-sm font-sans">
        Deleted <strong>{execution.deletedCount}/{execution.plannedCount}</strong> objects ({bytes(execution.deletedBytes)}).
        {execution.failureCount > 0 && <span className="text-signal-error"> {execution.failureCount} failed.</span>}
      </p>
      {verification && (
        <p className="text-[11px] font-sans text-text-muted">
          Verification relisted both buckets: {verification.report.totals.orphanCount} orphan objects remain.
        </p>
      )}
      {execution.failures.length > 0 && (
        <div className="text-[10px] font-mono text-signal-error space-y-1">
          {execution.failures.map(item => <div key={`${item.tier}:${item.key}`}>{item.bucket}/{item.key} · HTTP {item.status}</div>)}
        </div>
      )}
      <button
        type="button"
        onClick={() => downloadJson(`cdn-gc-execution-${execution.completedAt.replace(/[:.]/g, '-')}.json`, { execution, verification })}
        className="text-[11px] font-sans underline underline-offset-2"
      >
        Download execution JSON
      </button>
    </section>
  )
}

export function CdnGarbageCollectionView({ isSuperAdmin }: { isSuperAdmin: boolean }) {
  const [analysis, setAnalysis] = useState<CdnGcAnalysis | null>(null)
  const [execution, setExecution] = useState<CdnGcExecution | null>(null)
  const [verification, setVerification] = useState<CdnGcAnalysis | null>(null)
  const [working, setWorking] = useState<'analyze' | 'execute' | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [productionConfirmation, setProductionConfirmation] = useState('')

  if (!isSuperAdmin) {
    return <p className="text-sm font-sans text-text-muted">CDN garbage collection is visible to super admins only.</p>
  }

  async function analyze(): Promise<void> {
    setWorking('analyze'); setError(''); setNotice(''); setExecution(null); setVerification(null)
    try {
      setAnalysis(await analyzeCdnGarbage())
      setConfirming(false); setConfirmation(''); setProductionConfirmation('')
    } catch (cause) {
      setError(toMessage(cause)); reportError('cdn.CdnGarbageCollection.analyze', cause)
    } finally { setWorking(null) }
  }

  async function execute(): Promise<void> {
    if (!analysis) return
    setWorking('execute'); setError(''); setNotice('')
    try {
      const result = await executeCdnGarbage({
        expectedPlanId: analysis.planId,
        confirmation,
        productionConfirmation,
      })
      if (result.execution) {
        setExecution(result.execution)
        setVerification(result.verification ?? null)
        if (result.verification) setAnalysis(result.verification)
        setNotice(result.error ?? 'Deletion completed and both buckets were verified.')
      } else if (result.analysis) {
        setAnalysis(result.analysis)
        setNotice(result.error ?? 'The plan changed. Review the fresh analysis before executing.')
      } else {
        setError(result.error ?? 'Execution was refused. Run Analyze again.')
      }
      setConfirming(false); setConfirmation(''); setProductionConfirmation('')
    } catch (cause) {
      setError(toMessage(cause)); reportError('cdn.CdnGarbageCollection.execute', cause)
    } finally { setWorking(null) }
  }

  const canConfirm = Boolean(
    analysis &&
    confirmation === analysis.expectedConfirmation &&
    (!analysis.requiresProductionConfirmation || productionConfirmation === 'production'),
  )

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-serif text-2xl font-medium text-cosmos-black">CDN garbage collection</h1>
          <p className="text-sm font-sans text-text-muted mt-2 max-w-2xl">
            Analyze compares every asset reference with both R2 buckets. Nothing is deleted until a fresh plan is reviewed and confirmed.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void analyze()}
          disabled={working !== null}
          className="text-sm font-sans font-semibold border-2 border-cosmos-black px-4 py-2 rounded-sm disabled:opacity-50 hover:bg-cosmos-black hover:text-clear-white transition-colors"
          style={{ boxShadow: '4px 4px 0 #161616' }}
        >
          {working === 'analyze' ? 'Analyzing…' : analysis ? 'Analyze again' : 'Analyze'}
        </button>
      </div>

      {error && <p role="alert" className="text-sm font-sans text-signal-error">{error}</p>}
      {notice && <p className="text-sm font-sans border border-border rounded-sm p-3">{notice}</p>}
      {working === 'analyze' && <p className="text-sm font-sans text-text-muted">Reading all asset rows and listing both buckets…</p>}
      {working === 'execute' && <p className="text-sm font-sans text-text-muted">Rebuilding the plan, deleting confirmed orphans, then relisting both buckets…</p>}

      {execution && <ExecutionResult execution={execution} verification={verification} />}

      {analysis && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-y border-border py-3">
            <div className="text-[10px] font-mono text-text-muted">
              {analysis.report.environment} · generated {new Date(analysis.report.generatedAt).toLocaleString()} · plan {analysis.planId.slice(0, 12)}
            </div>
            <div className="flex items-center gap-4">
              <button
                type="button"
                onClick={() => downloadJson(`cdn-gc-${analysis.report.environment}-${analysis.report.generatedAt.replace(/[:.]/g, '-')}.json`, analysis)}
                className="text-[11px] font-sans underline underline-offset-2"
              >
                Download analysis JSON
              </button>
              <button
                type="button"
                disabled={!analysis.executable || working !== null}
                onClick={() => setConfirming(true)}
                className="text-sm font-sans font-semibold px-4 py-2 rounded-sm bg-signal-error text-clear-white disabled:opacity-40"
              >
                Execute deletion
              </button>
            </div>
          </div>

          {confirming && (
            <section className="border-2 border-signal-error rounded-sm p-5 space-y-4 bg-signal-error/5">
              <div>
                <h3 className="font-serif text-xl text-cosmos-black">Confirm permanent deletion</h3>
                <p className="text-sm font-sans text-text-muted mt-1">
                  This will delete {analysis.report.totals.orphanCount} objects ({bytes(analysis.report.totals.orphanBytes)}). The server will reject the action if this plan changes.
                </p>
              </div>
              <label className="block text-xs font-sans font-medium">
                Type <span className="font-mono">{analysis.expectedConfirmation}</span>
                <input
                  value={confirmation}
                  onChange={event => setConfirmation(event.target.value)}
                  className="mt-1 block w-full max-w-md border border-border rounded-sm px-3 py-2 font-mono text-sm bg-bg"
                  autoComplete="off"
                />
              </label>
              {analysis.requiresProductionConfirmation && (
                <label className="block text-xs font-sans font-medium">
                  Production safeguard: type <span className="font-mono">production</span>
                  <input
                    value={productionConfirmation}
                    onChange={event => setProductionConfirmation(event.target.value)}
                    className="mt-1 block w-full max-w-md border border-border rounded-sm px-3 py-2 font-mono text-sm bg-bg"
                    autoComplete="off"
                  />
                </label>
              )}
              <div className="flex gap-3">
                <button
                  type="button"
                  disabled={!canConfirm || working !== null}
                  onClick={() => void execute()}
                  className="text-sm font-sans font-semibold px-4 py-2 rounded-sm bg-signal-error text-clear-white disabled:opacity-40"
                >
                  {working === 'execute' ? 'Executing…' : 'Delete confirmed orphans'}
                </button>
                <button type="button" onClick={() => setConfirming(false)} className="text-sm font-sans px-4 py-2">Cancel</button>
              </div>
            </section>
          )}

          <AnalysisReport analysis={analysis} />
        </>
      )}

      {!analysis && working === null && (
        <div className="border border-dashed border-border rounded-sm p-10 text-center text-sm font-sans text-text-muted">
          Run Analyze to build a read-only inventory and deletion plan.
        </div>
      )}
    </div>
  )
}
