/* The last few runs, readable without opening the file.
 *
 * `run-timings.jsonl` already answers "where does my run go, and is that new?" — but only to
 * someone willing to read JSONL and do the division. Open/Reveal stay for the whole history and for
 * attaching to a bug report; this is the part an operator actually looks at, which is the last run
 * and whether it moved.
 *
 * Each phase's share of the run is drawn as the row's own background rather than as a bar in a
 * column of its own: at this width a real bar column would cost more space than the numbers it
 * illustrates, and the fill reads at a glance from across the desk.
 *
 * Read-only, and loaded once when Settings opens — there is no run in progress while this is on
 * screen, so nothing here can go stale under the operator.
 */

import { useEffect, useState } from 'react';
import { loadRunTimings } from '../../services/pipeline/runTimings';
import { buildRunRows, type RunRow } from '../../services/pipeline/runTimingsView';
import { reportError } from '../../services/reportError';
import css from './SettingsView.module.css';

const SHOWN = 10;

function RunEntry({ row, defaultOpen }: { row: RunRow; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={css.runEntry}>
      <button className={css.runHead} onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className={css.runCaret} aria-hidden="true">{open ? '▾' : '▸'}</span>
        <span className={css.runWhen}>{row.when}</span>
        <span className={css.runTotal}>{row.total}</span>
        {row.comparison && <span className={css.runDelta}>{row.comparison.delta}</span>}
      </button>

      <p className={`${css.fieldHint} ${css.runContext}`}>
        {row.context}
        {row.stopped   && <span className={css.runFlagWarn}> · stopped</span>}
        {row.errors > 0 && <span className={css.runFlagError}> · {row.errors} error{row.errors === 1 ? '' : 's'}</span>}
      </p>

      {open && (
        <div className={css.runDetail}>
          {row.phases.map(phase => (
            <div key={phase.label} className={css.phaseRow}>
              {/* The fill is the measurement, so it is inline: a share is a number, not a theme. */}
              <span className={css.phaseFill} style={{ width: `${phase.share}%` }} aria-hidden="true" />
              <span className={css.phaseLabel}>{phase.label}</span>
              <span className={css.phaseMs}>{phase.duration}</span>
              <span className={css.phaseShare}>{phase.share}%</span>
              {phase.delta && <span className={css.phaseDelta}>{phase.delta}</span>}
            </div>
          ))}

          {row.steps.length > 0 && (
            <p className={`${css.fieldHint} ${css.runSteps}`}>
              Steps inside a phase — {row.steps.map(s => `${s.label} ${s.duration}`).join(' · ')}
            </p>
          )}
          <p className={`${css.fieldHint} ${css.runSteps}`}>
            {row.unaccounted
              ? `${row.unaccounted} of the run is not covered by any timed phase.`
              : 'Every part of the run is covered by a timed phase.'}
            {row.comparison
              ? ` Compared against ${row.comparison.against}.`
              : ' No comparable earlier run — deltas need the same client, stages and dry-run flag.'}
          </p>
        </div>
      )}
    </div>
  );
}

export function RunTimingsTable() {
  const [rows, setRows] = useState<RunRow[] | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows(buildRunRows(await loadRunTimings(), SHOWN));
      } catch (e) {
        // Timings are a measurement, never a deliverable — a failure here shows as "no runs".
        reportError('os.RunTimingsTable.load', e);
        setRows([]);
      }
    })();
  }, []);

  if (!rows?.length) return null;

  return (
    <div className={css.runList}>
      {rows.map((row, i) => <RunEntry key={row.key} row={row} defaultOpen={i === 0} />)}
    </div>
  );
}
