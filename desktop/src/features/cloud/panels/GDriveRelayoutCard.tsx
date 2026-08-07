/* "Move delivered files into the current layout" for one Google Drive destination.
 *
 * Changing a destination's export layout in the portal changes where every file belongs. Without
 * this, the next run resolves that the expensive way — upload everything again under its new path
 * and leave the old copies behind, because the cloud export never deletes. Here it is a few seconds
 * of metadata calls and nothing is orphaned.
 *
 * Preview first, always: the button that moves files is not reachable until a read-only scan has
 * produced a plan, and the move re-scans and refuses anything that no longer matches what is on
 * screen. Same shape as the duplicate-folder cleanup beside it, for the same reason.
 *
 * The engine is ../../../services/cloud/gdriveRelayout; this file is the screen and nothing else.
 */

import { useState } from 'react';
import { FolderSymlink } from 'lucide-react';
import {
  scanGDriveRelayout, executeGDriveRelayout, planRelayoutMappings,
  type GDriveRelayoutPlan, type GDriveRelayoutExecution, type RelayoutMapping,
} from '../../../services/cloud/gdriveRelayout';
import { deliveredRemotePaths, renameDeliveredPaths } from '../../../services/pipeline/cloudExport';
import { cloudExportJobs } from '../../../services/pipeline/exportNames';
import { scanAllAssets } from '../../../services/pipeline/scan';
import { reportError } from '../../../services/reportError';
import { resolveExportShape, type CloudDestination, type GDriveDestConfig } from '../../../domain/client';
import { useSettingsStore } from '../../../store/settingsStore';
import { useVocabularyStore } from '../../../store/vocabularyStore';
import { buildVocabMap } from '@sotto/domain';
import { layoutLabel } from '../destLabels';
import css from '../CloudDestinations.module.css';

const CONFIRM_WORD = 'move';
const PREVIEW_ROWS = 12;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function GDriveRelayoutCard({ dest }: { dest: CloudDestination }) {
  const settings = useSettingsStore(s => s.settings);
  const vocab    = useVocabularyStore(s => s.data);

  const [mappings, setMappings]   = useState<RelayoutMapping[]>([]);
  const [inPlace, setInPlace]     = useState(0);
  const [unknown, setUnknown]     = useState(0);
  const [plan, setPlan]           = useState<GDriveRelayoutPlan | null>(null);
  const [execution, setExecution] = useState<GDriveRelayoutExecution | null>(null);
  const [working, setWorking]     = useState<'scan' | 'move' | null>(null);
  const [progress, setProgress]   = useState('');
  const [error, setError]         = useState('');
  const [notice, setNotice]       = useState('');
  const [confirming, setConfirming]     = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const cfg    = dest.config as GDriveDestConfig;
  const token  = cfg.token;
  const layout = resolveExportShape(dest).exportLayout;
  const target = {
    accessToken:   token?.accessToken ?? '',
    remotePath:    cfg.remotePath,
    sharedDriveId: cfg.sharedDriveId ?? '',
    destId:        dest.id,
  };

  function reset() {
    setConfirming(false); setConfirmation(''); setProgress('');
  }

  /** Both halves of "where is it, where should it be", from the library and this machine's records. */
  async function currentMappings(): Promise<{ mappings: RelayoutMapping[]; inPlace: number; unknown: number }> {
    setProgress('Reading the source library…');
    const scanned = await scanAllAssets(settings.sourceFolder, settings);
    const { jobs } = cloudExportJobs(scanned, settings);
    const delivered = await deliveredRemotePaths(dest.id);
    const result = planRelayoutMappings(
      jobs,
      buildVocabMap(vocab ?? { _schema_version: '2.1.0', _comment: '', tags: [] }),
      layout,
      delivered,
    );
    return { mappings: result.mappings, inPlace: result.inPlace, unknown: result.unknown.length };
  }

  async function scan(): Promise<void> {
    setWorking('scan'); setError(''); setNotice(''); setExecution(null); reset();
    try {
      const found = await currentMappings();
      setMappings(found.mappings);
      setInPlace(found.inPlace);
      setUnknown(found.unknown);
      if (!found.mappings.length) {
        setPlan(null);
        setNotice(found.inPlace
          ? `Nothing to move — all ${found.inPlace} delivered file(s) are already where “${layoutLabel(dest)}” puts them.`
          : 'No delivery records for this destination on this machine — the next run will upload normally.');
        return;
      }
      const result = await scanGDriveRelayout(target, found.mappings, found.inPlace, setProgress);
      setPlan(result);
      if (!result.totals.moves) setNotice('Nothing to move — no recorded file is where the plan expected it.');
    } catch (cause) {
      setPlan(null);
      setError(message(cause));
      reportError('config.GDriveRelayoutCard.scan', cause);
    } finally { setWorking(null); setProgress(''); }
  }

  async function move(): Promise<void> {
    if (!plan) return;
    setWorking('move'); setError(''); setNotice('');
    try {
      const result = await executeGDriveRelayout(target, mappings, inPlace, plan.planId, setProgress);
      setPlan(result.plan);
      if (result.executed) {
        setExecution(result.executed);
        /* The cache is keyed by remote path, so every applied move invalidates a record. Re-keying
           is what keeps the next run warm — without it the export rediscovers each file over the
           network and pays a full cold pass to conclude nothing changed. */
        const rekeyed = await renameDeliveredPaths(dest.id, result.executed.applied);
        setNotice(
          `Moved ${result.executed.moved} file(s)` +
          `${result.executed.trashed ? `, trashed ${result.executed.trashed} emptied folder(s)` : ''}` +
          `${result.executed.failed ? `, ${result.executed.failed} failed` : ''}` +
          ` · ${rekeyed} delivery record(s) re-keyed. Share links are unchanged — Drive keeps each file’s id.`);
      } else {
        setNotice(result.refused);
      }
      reset();
    } catch (cause) {
      setError(message(cause));
      reportError('config.GDriveRelayoutCard.move', cause);
    } finally { setWorking(null); setProgress(''); }
  }

  const busy = working !== null;
  const ready = !!token?.accessToken && !!settings.sourceFolder;

  return (
    <div className={css.formSection}>
      <div className={css.sectionLabel}>Export layout migration</div>
      <div className={css.authBox}>
        <p className={css.deviceHint}>
          This destination’s layout is <strong>{layoutLabel(dest)}</strong>. If files were delivered
          under a different one, they are still where that layout put them — the export would upload
          them again at the new paths and leave the old copies behind. This <strong>moves</strong> them
          instead: no bytes are re-sent, each file keeps its Drive id, and every share link pointing
          at it stays valid. Emptied folders are <strong>trashed</strong>, not deleted, and nothing
          moves until you confirm a preview.
        </p>

        <div className={css.authBtns}>
          <button className={css.outlineBtn} disabled={busy || !ready} onClick={() => void scan()}>
            <FolderSymlink size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {working === 'scan' ? 'Scanning…' : plan ? 'Scan again' : 'Preview the moves'}
          </button>
          {plan && (
            <button
              className={css.outlineBtn}
              disabled={busy}
              onClick={() => downloadJson(`gdrive-relayout-${plan.planId.slice(0, 12)}.json`, { plan, execution })}
            >
              Download report
            </button>
          )}
          {plan && plan.totals.moves > 0 && !confirming && (
            <button
              className={`${css.outlineBtn} ${css.outlineBtnDanger}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
              style={{ marginLeft: 'auto' }}
            >
              Move files…
            </button>
          )}
        </div>

        {!token?.accessToken && <p className={css.deviceHint}>Connect the destination first.</p>}
        {!settings.sourceFolder && <p className={css.deviceHint}>Set this client’s source folder first.</p>}
        {progress && <p className={css.deviceHint}>{progress}</p>}
        {error && <p className={css.authError}>{error}</p>}
        {notice && <p className={css.deviceHint}>{notice}</p>}

        {plan && (
          <div className={css.dedupeReport}>
            <div className={css.dedupeMeta}>
              {plan.rootPath} · {plan.scannedFolders} folder(s) scanned · plan {plan.planId.slice(0, 12)}
            </div>

            {plan.warnings.map(warning => (
              <p className={css.authError} key={warning}>{warning}</p>
            ))}

            <div className={css.dedupeTotals}>
              <span><strong>{plan.totals.moves}</strong> file(s) to move</span>
              <span><strong>{plan.totals.prune}</strong> emptied folder(s) to trash</span>
              <span><strong>{plan.totals.inPlace}</strong> already in place</span>
              <span><strong>{plan.totals.skipped}</strong> skipped</span>
              {unknown > 0 && <span><strong>{unknown}</strong> not delivered from here</span>}
            </div>

            <div className={css.dedupeTableWrap}>
              <table className={css.dedupeTable}>
                <thead><tr><th>From</th><th>To</th></tr></thead>
                <tbody>
                  {plan.actions.slice(0, PREVIEW_ROWS).map(action => (
                    <tr key={action.fileId}>
                      <td className={css.dedupeMono}>{action.from}</td>
                      <td className={css.dedupeMono}>{action.to}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {plan.actions.length > PREVIEW_ROWS && (
              <p className={css.deviceHint}>
                …and {plan.actions.length - PREVIEW_ROWS} more — the full list is in the report.
              </p>
            )}

            {plan.skipped.length > 0 && (
              <details className={css.dedupeDetails}>
                <summary>{plan.skipped.length} skipped</summary>
                {plan.skipped.map(item => (
                  <div className={css.dedupeMono} key={item.path}>{item.path} — {item.reason}</div>
                ))}
              </details>
            )}

            {confirming && (
              <div className={css.dedupeConfirm}>
                <strong>
                  Move {plan.totals.moves} file(s) in {dest.name || 'this destination'} into the
                  “{layoutLabel(dest)}” layout? Emptied folders go to Drive’s trash.
                </strong>
                <label className={css.fieldLabel}>
                  Type {CONFIRM_WORD} to confirm
                  <input
                    className={css.input}
                    value={confirmation}
                    onChange={event => setConfirmation(event.target.value)}
                  />
                </label>
                <div className={css.authBtns}>
                  <button
                    className={`${css.outlineBtn} ${css.outlineBtnDanger}`}
                    disabled={busy || confirmation.trim().toLowerCase() !== CONFIRM_WORD}
                    onClick={() => void move()}
                  >
                    {working === 'move' ? 'Moving…' : 'Move files'}
                  </button>
                  <button className={css.outlineBtn} onClick={() => { setConfirming(false); setConfirmation(''); }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {execution && (
              <details className={css.dedupeDetails}>
                <summary>
                  Audit log — {execution.moved} moved · {execution.trashed} trashed ·{' '}
                  {execution.skipped} skipped · {execution.failed} failed
                </summary>
                {execution.audit.map((entry, index) => (
                  <div className={css.dedupeMono} key={`${entry.at}-${index}`}>
                    {entry.outcome} · {entry.action.kind} ·{' '}
                    {entry.action.kind === 'move' ? `${entry.action.from} → ${entry.action.to}` : entry.action.path}
                    {entry.reason ? ` · ${entry.reason}` : ''}
                  </div>
                ))}
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
