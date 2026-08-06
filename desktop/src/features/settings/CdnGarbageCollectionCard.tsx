import { useState } from 'react';
import type { CdnGcGroup, CdnGcTotals } from '@sotto/domain';
import { useAuthStore } from '../../store/authStore';
import { useEnvironmentStore } from '../../store/environmentStore';
import {
  analyzeCdnGarbage,
  executeCdnGarbage,
  type CdnGcAnalysis,
  type CdnGcExecution,
} from '../../services/supabase/cdnGarbageCollection';
import { reportError } from '../../services/reportError';
import settingsCss from './SettingsView.module.css';
import css from './CdnGarbageCollectionCard.module.css';

function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size.toFixed(unit === 0 ? 0 : size >= 10 ? 1 : 2)} ${units[unit]}`;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json',
  }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function Metric({ label, count, size, danger = false }: {
  label: string;
  count: number;
  size?: number;
  danger?: boolean;
}) {
  return (
    <div className={`${css.metric} ${danger ? css.metricDanger : ''}`}>
      <div className={css.metricLabel}>{label}</div>
      <div className={css.metricValue}>{count.toLocaleString()}</div>
      {size != null && <div className={css.metricBytes}>{bytes(size)}</div>}
    </div>
  );
}

function GroupTable({ title, groups }: { title: string; groups: CdnGcGroup[] }) {
  if (!groups.length) return null;
  return (
    <div className={css.group}>
      <div className={css.groupTitle}>{title}</div>
      <div className={css.tableWrap}>
        <table className={css.table}>
          <thead><tr><th>Value</th><th className={css.number}>Objects</th><th className={css.number}>Bytes</th><th>Sample keys</th></tr></thead>
          <tbody>
            {groups.map(group => (
              <tr key={group.value}>
                <td>{group.value}</td>
                <td className={css.number}>{group.count}</td>
                <td className={css.number}>{bytes(group.bytes)}</td>
                <td className={css.sample}>{group.sampleKeys.map(key => <div key={key}>{key}</div>)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BucketSummary({ totals }: { totals: CdnGcTotals }) {
  return (
    <span className={css.bucketTotals}>
      {totals.totalCount} objects / {bytes(totals.totalBytes)} ·{' '}
      {totals.referencedCount} referenced · {totals.protectedCount} protected ·{' '}
      {totals.orphanCount} orphan
    </span>
  );
}

export function CdnGarbageCollectionCard() {
  const role = useAuthStore(state => state.profile?.role);
  const { environments, activeEnvId } = useEnvironmentStore();
  const active = environments.find(environment => environment.id === activeEnvId) ?? null;
  const [analysis, setAnalysis] = useState<CdnGcAnalysis | null>(null);
  const [execution, setExecution] = useState<CdnGcExecution | null>(null);
  const [verification, setVerification] = useState<CdnGcAnalysis | null>(null);
  const [working, setWorking] = useState<'analyze' | 'execute' | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [productionConfirmation, setProductionConfirmation] = useState('');

  if (role !== 'super_admin') return null;

  const config = active?.supabaseUrl && active.anonKey
    ? { url: active.supabaseUrl, anonKey: active.anonKey }
    : null;

  async function analyze(): Promise<void> {
    if (!config) { setError('The active environment is not configured.'); return; }
    setWorking('analyze'); setError(''); setNotice(''); setExecution(null); setVerification(null);
    try {
      setAnalysis(await analyzeCdnGarbage(config));
      setConfirming(false); setConfirmation(''); setProductionConfirmation('');
    } catch (cause) {
      setError(message(cause));
      reportError('cdn.CdnGarbageCollectionCard.analyze', cause);
    } finally { setWorking(null); }
  }

  async function execute(): Promise<void> {
    if (!config || !analysis) return;
    setWorking('execute'); setError(''); setNotice('');
    try {
      const result = await executeCdnGarbage(config, {
        expectedPlanId: analysis.planId,
        confirmation,
        productionConfirmation,
      });
      if (result.execution) {
        setExecution(result.execution);
        setVerification(result.verification ?? null);
        if (result.verification) setAnalysis(result.verification);
        setNotice(result.error ?? 'Deletion completed and both buckets were verified.');
      } else if (result.analysis) {
        setAnalysis(result.analysis);
        setNotice(result.error ?? 'The plan changed. Review the fresh analysis before executing.');
      } else {
        setError(result.error ?? 'Execution was refused. Analyze again.');
      }
      setConfirming(false); setConfirmation(''); setProductionConfirmation('');
    } catch (cause) {
      setError(message(cause));
      reportError('cdn.CdnGarbageCollectionCard.execute', cause);
    } finally { setWorking(null); }
  }

  const canConfirm = Boolean(
    analysis && confirmation === analysis.expectedConfirmation &&
    (!analysis.requiresProductionConfirmation || productionConfirmation === 'production'),
  );

  return (
    <div className={`${settingsCss.card} ${analysis ? css.expanded : ''}`}>
      <div className={settingsCss.cardTitle}>CDN garbage collection</div>
      <div className={settingsCss.fields}>
        <p className={css.intro}>
          Compare every asset reference with both R2 buckets. Analysis is read-only; deletion needs a fresh matching plan and typed confirmation.
        </p>
        <div className={css.actions}>
          <button className={css.analyze} disabled={working !== null || !config} onClick={() => void analyze()}>
            {working === 'analyze' ? 'Analyzing…' : analysis ? 'Analyze again' : 'Analyze'}
          </button>
          {analysis && (
            <button
              className={css.download}
              onClick={() => downloadJson(
                `cdn-gc-${analysis.report.environment}-${analysis.report.generatedAt.replace(/[:.]/g, '-')}.json`,
                analysis,
              )}
            >
              Download analysis JSON
            </button>
          )}
          {analysis && (
            <button
              className={css.danger}
              disabled={!analysis.executable || working !== null}
              onClick={() => setConfirming(true)}
            >
              Execute deletion
            </button>
          )}
        </div>

        {working === 'analyze' && <p className={css.status}>Reading all asset rows and listing both buckets…</p>}
        {working === 'execute' && <p className={css.status}>Rebuilding the plan, deleting confirmed orphans, and relisting both buckets…</p>}
        {error && <p className={css.error}>{error}</p>}
        {notice && <p className={css.notice}>{notice}</p>}

        {execution && (
          <div className={css.result}>
            <strong>Execution report:</strong> deleted {execution.deletedCount}/{execution.plannedCount} objects ({bytes(execution.deletedBytes)}).
            {execution.failureCount > 0 && <span className={css.error}> {execution.failureCount} failed.</span>}
            {verification && <div className={css.status}>Verification: {verification.report.totals.orphanCount} orphan objects remain.</div>}
            {execution.failures.map(item => (
              <div className={css.sample} key={`${item.tier}:${item.key}`}>{item.bucket}/{item.key} · HTTP {item.status}</div>
            ))}
            <div className={css.actions}>
              <button
                className={css.download}
                onClick={() => downloadJson(
                  `cdn-gc-execution-${execution.completedAt.replace(/[:.]/g, '-')}.json`,
                  { execution, verification },
                )}
              >
                Download execution JSON
              </button>
            </div>
          </div>
        )}

        {analysis && (
          <>
            <div className={css.meta}>
              {analysis.report.environment} · {new Date(analysis.report.generatedAt).toLocaleString()} · plan {analysis.planId.slice(0, 12)}
            </div>
            <div className={css.summary}>
              <Metric label="Assets" count={analysis.report.source.assetRows} />
              <Metric label="Objects" count={analysis.report.totals.totalCount} size={analysis.report.totals.totalBytes} />
              <Metric label="Referenced" count={analysis.report.totals.referencedCount} size={analysis.report.totals.referencedBytes} />
              <Metric label="Protected" count={analysis.report.totals.protectedCount} size={analysis.report.totals.protectedBytes} />
              <Metric label="Orphans" count={analysis.report.totals.orphanCount} size={analysis.report.totals.orphanBytes} danger={analysis.report.totals.orphanCount > 0} />
            </div>
            <div className={`${css.safety} ${analysis.report.safety.blastRadiusExceeded ? css.blocked : ''}`}>
              <strong>Blast radius: {percent(analysis.report.safety.orphanFraction)}</strong> · limit {percent(analysis.report.safety.blastRadiusThreshold)}
              <div className={css.status}>
                {analysis.report.source.liveRows} live rows · {analysis.report.source.disconnectedRows} disconnected rows retained ·{' '}
                {analysis.report.totals.disconnectedReferencedCount} objects protected only by disconnected rows
              </div>
              {analysis.report.safety.blastRadiusExceeded && <p className={css.error}>Execution is blocked. The desktop cannot override this gate.</p>}
            </div>

            {analysis.report.source.warnings.length > 0 && (
              <details className={css.warning}>
                <summary>Reference warnings ({analysis.report.source.warnings.length})</summary>
                {analysis.report.source.warnings.map((warning, index) => (
                  <div className={css.sample} key={`${warning.rowId}-${index}`}>
                    {warning.rowId ?? 'unknown row'} · {warning.reason} · {warning.value ?? warning.column ?? ''}
                  </div>
                ))}
              </details>
            )}

            {confirming && (
              <div className={css.confirmation}>
                <strong>Confirm permanent deletion of {analysis.report.totals.orphanCount} objects ({bytes(analysis.report.totals.orphanBytes)}).</strong>
                <div className={css.confirmFields}>
                  <label className={css.label}>
                    Type {analysis.expectedConfirmation}
                    <input className={css.input} value={confirmation} onChange={event => setConfirmation(event.target.value)} />
                  </label>
                  {analysis.requiresProductionConfirmation && (
                    <label className={css.label}>
                      Production safeguard: type production
                      <input className={css.input} value={productionConfirmation} onChange={event => setProductionConfirmation(event.target.value)} />
                    </label>
                  )}
                </div>
                <div className={css.actions}>
                  <button className={css.danger} disabled={!canConfirm || working !== null} onClick={() => void execute()}>
                    {working === 'execute' ? 'Executing…' : 'Delete confirmed orphans'}
                  </button>
                  <button className={settingsCss.btnCancel} onClick={() => setConfirming(false)}>Cancel</button>
                </div>
              </div>
            )}

            <div className={css.buckets}>
              {analysis.report.buckets.map(bucket => (
                <div className={css.bucket} key={bucket.tier}>
                  <div className={css.bucketHeader}>
                    <div><div className={css.bucketTitle}>{bucket.tier} bucket</div><div className={css.bucketName}>{bucket.bucket}</div></div>
                    <BucketSummary totals={bucket.totals} />
                  </div>
                  <GroupTable title="Orphans by reason" groups={bucket.orphanGroups.byReason} />
                  <GroupTable title="Orphans by client" groups={bucket.orphanGroups.byClient} />
                  <GroupTable title="Orphans by level" groups={bucket.orphanGroups.byLevel} />
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
