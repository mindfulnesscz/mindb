/* Reaching the error log without knowing where an app data directory lives.
 *
 * The log is the only diagnostic once this is a packaged binary — there is no console to open — and it
 * sits in ~/Library/Application Support/<bundle id>/, a path most people cannot navigate to and macOS
 * hides from Finder by default. A log nobody can reach is not a log.
 *
 * Two actions rather than one, because they answer different questions: Open reads it, Reveal is what
 * you use to attach it to a bug report. Both are no-ops until something has actually failed, so the
 * card says whether the file exists and how big it is rather than opening an empty window.
 */

import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { reportError, LOG_FILE } from '../../services/reportError';
import css from './SettingsView.module.css';

export function DiagnosticsCard() {
  const [path, setPath] = useState('');
  const [size, setSize] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const p = await join(await appDataDir(), LOG_FILE);
        setPath(p);
        setSize(await exists(p) ? (await stat(p)).size : null);
      } catch (e) {
        reportError('os.DiagnosticsCard.locateLog', e);
      }
    })();
  }, []);

  const empty = size === null;

  return (
    <div className={css.card}>
      <div className={css.cardTitle}>Diagnostics</div>
      <div className={css.fields}>
        <p className={css.fieldHint}>
          Errors are written here with the pipeline step they happened in. Send this file when
          reporting a problem — it is the only record once the app is installed.
        </p>
        <p className={`${css.fieldHint} ${css.pathLine}`}>{path || '…'}</p>
        <p className={css.fieldHint}>
          {empty
            ? 'No errors recorded yet.'
            : `${(size / 1024).toFixed(1)} KB recorded.`}
        </p>
        <div className={css.diagActions}>
          <button
            className={css.btnCancel}
            disabled={empty}
            onClick={() => openPath(path).catch(e => reportError('os.DiagnosticsCard.openLog', e))}
          >
            Open log
          </button>
          <button
            className={css.btnCancel}
            disabled={empty}
            onClick={() => revealItemInDir(path).catch(e => reportError('os.DiagnosticsCard.revealLog', e))}
          >
            Reveal in Finder
          </button>
        </div>
      </div>
    </div>
  );
}
