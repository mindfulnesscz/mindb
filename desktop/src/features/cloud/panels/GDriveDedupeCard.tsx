/* "Clean up duplicate folders" for one Google Drive destination.
 *
 * Preview first, always: the button that moves files is not reachable until a read-only scan has
 * produced a plan, and the merge re-scans and refuses anything that no longer matches what is on
 * screen. Same shape as Settings → CDN garbage collection, for the same reason — it rearranges files
 * a client already has.
 *
 * The engine is ../../../services/cloud/gdriveDedupe; this file is the screen and nothing else.
 */

import { useState } from 'react';
import { FolderTree } from 'lucide-react';
import {
  scanGDriveDuplicates, executeGDriveDedupe,
  type GDriveDedupePlan, type GDriveDedupeExecution,
} from '../../../services/cloud/gdriveDedupe';
import { reportError } from '../../../services/reportError';
import type { GDriveDestConfig } from '../../../domain/client';
import css from '../CloudDestinations.module.css';

const CONFIRM_WORD = 'merge';

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

export function GDriveDedupeCard({ cfg, destName }: { cfg: GDriveDestConfig; destName: string }) {
  const [plan, setPlan]           = useState<GDriveDedupePlan | null>(null);
  const [execution, setExecution] = useState<GDriveDedupeExecution | null>(null);
  const [working, setWorking]     = useState<'scan' | 'merge' | null>(null);
  const [progress, setProgress]   = useState('');
  const [error, setError]         = useState('');
  const [notice, setNotice]       = useState('');
  const [confirming, setConfirming] = useState(false);
  const [confirmation, setConfirmation] = useState('');

  const token = cfg.token;
  const target = {
    accessToken:   token?.accessToken ?? '',
    remotePath:    cfg.remotePath,
    sharedDriveId: cfg.sharedDriveId ?? '',
  };

  function reset() {
    setConfirming(false); setConfirmation(''); setProgress('');
  }

  async function scan(): Promise<void> {
    setWorking('scan'); setError(''); setNotice(''); setExecution(null); reset();
    try {
      const result = await scanGDriveDuplicates(target, setProgress);
      setPlan(result);
      if (!result.totals.duplicateSets) setNotice('No duplicate folders — this destination is clean.');
    } catch (cause) {
      setPlan(null);
      setError(message(cause));
      reportError('config.GDriveDedupeCard.scan', cause);
    } finally { setWorking(null); setProgress(''); }
  }

  async function merge(): Promise<void> {
    if (!plan) return;
    setWorking('merge'); setError(''); setNotice('');
    try {
      const result = await executeGDriveDedupe(target, plan.planId, setProgress);
      setPlan(result.plan);
      if (result.executed) {
        setExecution(result.executed);
        setNotice(
          `Merged: ${result.executed.applied} action(s) applied` +
          `${result.executed.skipped ? `, ${result.executed.skipped} left in place` : ''}` +
          `${result.executed.failed ? `, ${result.executed.failed} failed` : ''}.`);
      } else {
        setNotice(result.refused);
      }
      reset();
    } catch (cause) {
      setError(message(cause));
      reportError('config.GDriveDedupeCard.merge', cause);
    } finally { setWorking(null); setProgress(''); }
  }

  const busy = working !== null;
  const differing = plan?.collisions.filter(item => item.resolution === 'kept-both') ?? [];

  return (
    <div className={css.formSection}>
      <div className={css.sectionLabel}>Maintenance</div>
      <div className={css.authBox}>
        <p className={css.deviceHint}>
          Drive allows several folders with the same name in one parent, and older versions of the
          export created them. This merges each set into the <strong>oldest</strong> folder — the one
          exports now use — and moves nothing until you confirm a preview. Removed folders are
          <strong> trashed</strong>, not deleted.
        </p>

        <div className={css.authBtns}>
          <button className={css.outlineBtn} disabled={busy || !token?.accessToken} onClick={() => void scan()}>
            <FolderTree size={13} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            {working === 'scan' ? 'Scanning…' : plan ? 'Scan again' : 'Preview duplicate folders'}
          </button>
          {plan && (
            <button
              className={css.outlineBtn}
              disabled={busy}
              onClick={() => downloadJson(`gdrive-dedupe-${plan.planId.slice(0, 12)}.json`, { plan, execution })}
            >
              Download report
            </button>
          )}
          {plan && plan.totals.duplicateSets > 0 && !confirming && (
            <button
              className={`${css.outlineBtn} ${css.outlineBtnDanger}`}
              disabled={busy}
              onClick={() => setConfirming(true)}
              style={{ marginLeft: 'auto' }}
            >
              Merge duplicates…
            </button>
          )}
        </div>

        {!token?.accessToken && <p className={css.deviceHint}>Connect the destination first.</p>}
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

            {plan.totals.duplicateSets > 0 && (
              <>
                <div className={css.dedupeTotals}>
                  <span><strong>{plan.totals.duplicateSets}</strong> duplicate set(s)</span>
                  <span><strong>{plan.totals.duplicateFolders}</strong> extra folder(s)</span>
                  <span><strong>{plan.totals.filesMoved}</strong> file(s) to move</span>
                  <span><strong>{plan.totals.filesTrashed}</strong> identical copy/copies to trash</span>
                  <span><strong>{plan.totals.foldersTrashed}</strong> folder(s) to trash</span>
                  <span><strong>{plan.totals.collisions}</strong> name collision(s)</span>
                </div>

                <div className={css.dedupeTableWrap}>
                  <table className={css.dedupeTable}>
                    <thead>
                      <tr><th>Folder</th><th>Copies</th><th>Keeping</th><th>Files moved</th><th>Trashed</th></tr>
                    </thead>
                    <tbody>
                      {plan.sets.map(set => (
                        <tr key={set.path + set.canonicalId}>
                          <td>{set.path}</td>
                          <td>{set.duplicates.length + 1}</td>
                          <td className={css.dedupeMono}>
                            {set.canonicalId}
                            {set.canonicalCreatedTime && ` · ${set.canonicalCreatedTime.slice(0, 10)}`}
                          </td>
                          <td>{set.filesMoved}</td>
                          <td>{set.filesTrashed + set.foldersTrashed}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {differing.length > 0 && (
                  <details className={css.dedupeDetails}>
                    <summary>{differing.length} file(s) share a name but not their contents — both kept</summary>
                    {differing.map(item => (
                      <div className={css.dedupeMono} key={item.otherId}>{item.path}/{item.name}</div>
                    ))}
                  </details>
                )}
              </>
            )}

            {confirming && (
              <div className={css.dedupeConfirm}>
                <strong>
                  Merge {plan.totals.duplicateFolders} duplicate folder(s) in {destName}? Files move into the
                  oldest copy; emptied folders go to Drive’s trash.
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
                    onClick={() => void merge()}
                  >
                    {working === 'merge' ? 'Merging…' : 'Merge duplicates'}
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
                  Audit log — {execution.applied} applied · {execution.skipped} skipped · {execution.failed} failed
                </summary>
                {execution.audit.map((entry, index) => (
                  <div className={css.dedupeMono} key={`${entry.at}-${index}`}>
                    {entry.outcome} · {entry.action.kind} · {entry.action.path}
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
