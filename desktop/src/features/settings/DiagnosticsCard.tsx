/* Reaching the diagnostic files without knowing where an app data directory lives.
 *
 * These are the only diagnostics once this is a packaged binary — there is no console to open — and they
 * sit in ~/Library/Application Support/<bundle id>/, a path most people cannot navigate to and macOS
 * hides from Finder by default. A log nobody can reach is not a log.
 *
 * Two actions rather than one, because they answer different questions: Open reads it, Reveal is what
 * you use to attach it to a bug report. Both are no-ops until the file exists, so each row says whether
 * it does and how big it is rather than opening an empty window.
 */

import { useEffect, useState } from 'react';
import { openPath, revealItemInDir } from '@tauri-apps/plugin-opener';
import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, stat } from '@tauri-apps/plugin-fs';
import { reportError, LOG_FILE } from '../../services/reportError';
import { RUN_TIMINGS_FILE } from '../../services/pipeline/runTimings';
import css from './SettingsView.module.css';

interface DiagFile {
  file:    string;
  hint:    string;
  /** What to say when it does not exist yet — the absence is normal in both cases. */
  empty:   string;
  measure: (size: number) => string;
}

const FILES: DiagFile[] = [
  {
    file: LOG_FILE,
    hint: 'Errors are written here with the pipeline step they happened in. Send this file when '
      + 'reporting a problem — it is the only record once the app is installed.',
    empty: 'No errors recorded yet.',
    measure: size => `${(size / 1024).toFixed(1)} KB recorded.`,
  },
  {
    file: RUN_TIMINGS_FILE,
    hint: 'One line per pipeline run: how long each phase took, which stages were on, and how many '
      + 'assets. The run log compares each run against the last comparable one; this is the whole '
      + 'history behind that, for spotting drift over weeks.',
    empty: 'No runs recorded yet.',
    measure: size => `${(size / 1024).toFixed(1)} KB recorded.`,
  },
];

export function DiagnosticsCard() {
  const [rows, setRows] = useState<{ path: string; size: number | null }[]>(
    FILES.map(() => ({ path: '', size: null })),
  );

  useEffect(() => {
    void (async () => {
      try {
        const dir = await appDataDir();
        setRows(await Promise.all(FILES.map(async ({ file }) => {
          const path = await join(dir, file);
          return { path, size: await exists(path) ? (await stat(path)).size : null };
        })));
      } catch (e) {
        reportError('os.DiagnosticsCard.locateLog', e);
      }
    })();
  }, []);

  return (
    <div className={css.card}>
      <div className={css.cardTitle}>Diagnostics</div>
      <div className={css.fields}>
        {FILES.map((meta, i) => {
          const { path, size } = rows[i];
          const empty = size === null;
          return (
            <div key={meta.file}>
              <p className={css.fieldHint}>{meta.hint}</p>
              <p className={`${css.fieldHint} ${css.pathLine}`}>{path || '…'}</p>
              <p className={css.fieldHint}>{empty ? meta.empty : meta.measure(size)}</p>
              <div className={css.diagActions}>
                <button
                  className={css.btnCancel}
                  disabled={empty}
                  onClick={() => openPath(path).catch(e => reportError('os.DiagnosticsCard.openLog', e))}
                >
                  Open {meta.file}
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
          );
        })}
      </div>
    </div>
  );
}
