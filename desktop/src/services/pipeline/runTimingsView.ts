/* The persisted run history, shaped for a person to read.
 *
 * `run-timings.jsonl` is one JSON object per run, and `[label, ms]` pairs in completion order are
 * exactly the wrong shape for the question an operator brings to it: *what is my run spending its
 * time on, and is that new?* Answering it from the raw file means sorting fourteen pairs by hand
 * and dividing each one by the total. This module does that, once, in pure functions — no
 * filesystem, no React — so the numbers can be tested without a window and the card that draws
 * them stays a drawing.
 *
 * The comparison rule is NOT reimplemented here: `findBaseline` in `runTimings.ts` owns what makes
 * two runs comparable (same client, same stages, same dry-run flag, neither stopped), and a second
 * copy of that rule would drift from the one the run log prints and quietly disagree with it.
 */

import { formatDuration } from './timing';
import { findBaseline, type RunTimingRecord } from './runTimings';

export interface PhaseRow {
  label: string;
  ms: number;
  /** Formatted `ms` — `640ms`, `12.4s`, `3m 12s`. */
  duration: string;
  /** Share of the run's wall clock, 0–100, rounded. Drives the bar width. */
  share: number;
  /** Signed change against the baseline, `—` when it barely moved, `new` when the baseline had no
   *  such phase, and `null` when there is no baseline to compare against at all. */
  delta: string | null;
}

export interface RunRow {
  /** Stable key for React — the ISO timestamp plus index, since two runs could share a second. */
  key:     string;
  /** Local date and time, minute precision. */
  when:    string;
  total:   string;
  totalMs: number;
  /** `29 assets · 3.2.2 · Mucha Family`. */
  context: string;
  assets:  number;
  errors:  number;
  stopped: boolean;
  dryRun:  boolean;
  /** Untimed work: `totalMs - measuredMs`, formatted, or null when it is negligible. */
  unaccounted: string | null;
  /** Every phase, slowest first. */
  phases: PhaseRow[];
  /** Sub-steps in completion order — nested inside a phase, so never ranked or shared. */
  steps:  { label: string; duration: string }[];
  /** Total change vs the baseline, and what the baseline was. Null when nothing is comparable. */
  comparison: { delta: string; against: string } | null;
}

/**
 * A signed delta, or `—` when nothing moved. The 100ms floor matches `timing.ts`'s log block on
 * purpose: below it the number is scheduler noise, and the two surfaces reporting one run must not
 * disagree about whether a phase changed.
 */
function formatDelta(deltaMs: number): string {
  if (Math.abs(deltaMs) < 100) return '—';
  return `${deltaMs > 0 ? '+' : '-'}${formatDuration(Math.abs(deltaMs))}`;
}

function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

/** The one-line provenance an unfair comparison is recognised by. */
function contextOf(record: RunTimingRecord): string {
  return [
    `${record.assets} asset${record.assets === 1 ? '' : 's'}`,
    record.appVersion,
    record.client,
    record.dryRun ? 'dry run' : null,
  ].filter(Boolean).join(' · ');
}

function toRow(record: RunTimingRecord, baseline: RunTimingRecord | null, index: number): RunRow {
  const before = baseline ? new Map(baseline.phases) : null;
  const untimed = record.totalMs - record.measuredMs;
  return {
    key:     `${record.at}#${index}`,
    when:    formatWhen(record.at),
    total:   formatDuration(record.totalMs),
    totalMs: record.totalMs,
    context: contextOf(record),
    assets:  record.assets,
    errors:  record.errors,
    stopped: record.stopped,
    dryRun:  record.dryRun,
    // Under 100ms of untimed work is measurement overhead, not a gap worth pointing at.
    unaccounted: untimed >= 100 ? formatDuration(untimed) : null,
    phases: [...record.phases]
      .sort((a, b) => b[1] - a[1])
      .map(([label, ms]) => ({
        label,
        ms,
        duration: formatDuration(ms),
        share: record.totalMs > 0 ? Math.round((ms / record.totalMs) * 100) : 0,
        // A phase the baseline never had is new, not infinitely slower.
        delta: !before ? null
          : before.has(label) ? formatDelta(ms - before.get(label)!)
          : 'new',
      })),
    steps: record.steps.map(([label, ms]) => ({ label, duration: formatDuration(ms) })),
    comparison: baseline
      ? { delta: formatDelta(record.totalMs - baseline.totalMs), against: formatWhen(baseline.at) }
      : null,
  };
}

/**
 * The most recent `limit` runs, newest first, each compared against the newest comparable run
 * BEFORE it — which is the same run the log compared it against when it happened, so the deltas
 * shown here and the ones printed that day are the same numbers.
 */
export function buildRunRows(history: RunTimingRecord[], limit = 10): RunRow[] {
  const rows: RunRow[] = [];
  for (let i = history.length - 1; i >= 0 && rows.length < limit; i--) {
    rows.push(toRow(history[i], findBaseline(history.slice(0, i), history[i]), i));
  }
  return rows;
}
