/* Run timings, kept between runs — the history the 04a–04f series measures itself against.
 *
 * `timing.ts` measures one run and prints it. That is enough to see where a run spends its time
 * and useless for the question that actually matters: *is this slower than it used to be?* The
 * log window is in-memory and dies with the app, so before this the only way to compare two runs
 * was to have both on screen at once.
 *
 * One JSON object per line in the app data directory, appended per run. JSONL rather than a JSON
 * array because a line-per-run file survives a partial write — a truncated last line loses one
 * run, where a truncated array loses the file — and because `jq`, `grep` and a spreadsheet all
 * read it without help.
 *
 * **Comparability is the hard part, not storage.** A run with thumbnails off is not slower than
 * one with thumbnails on, and a dry run is not faster than a real one. `findBaseline` will only
 * match a previous run of the SAME client with the SAME stages enabled and the same dry-run flag;
 * anything else reports no baseline rather than a misleading number. Asset count is deliberately
 * NOT part of the match — it drifts a little every run and would reject almost every comparison —
 * so it is printed in the provenance line instead, for the operator to discount.
 *
 * Best effort throughout: a failure to read or write this file must never fail a run that
 * otherwise succeeded. It is a measurement, not a deliverable.
 */

import { appDataDir, join } from '@tauri-apps/api/path';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import type { AppSettings } from '../../store/settingsStore';
import { runTimelineSummary, type TimelineBaseline } from './timing';

/** Exported so the Diagnostics card can open the same file this writes. */
export const RUN_TIMINGS_FILE = 'run-timings.jsonl';

/**
 * Roughly a year of daily runs. The file is a few hundred bytes per line, so this is ~150KB —
 * small enough to rewrite whole on every run, which is what lets the cap be enforced without a
 * rotation scheme.
 */
const MAX_RUNS = 500;

export interface RunTimingRecord {
  /** ISO 8601, UTC. */
  at:         string;
  clientId:   string | null;
  /** Display name, so the file is readable without joining against the database. */
  client:     string | null;
  appVersion: string;
  /** Enabled stage flags, sorted. Half of the comparability key — see the module note. */
  stages:     string[];
  dryRun:     boolean;
  /** Files the scan found. Not part of the match; printed so an unfair comparison is visible. */
  assets:     number;
  errors:     number;
  /** A stopped run is partial and must never become a baseline. */
  stopped:    boolean;
  totalMs:    number;
  measuredMs: number;
  /** `[label, ms]` pairs — a third of the bytes of `{label, ms}`, over a file that only grows. */
  phases:     [string, number][];
  steps:      [string, number][];
}

/** The stage toggles that change what a run DOES, and therefore how long it should take. */
const STAGE_FLAGS = [
  'doThumbnails', 'doDistribute', 'doPublish', 'doFlatExport', 'doObsidian', 'doCdnOriginals',
] as const satisfies readonly (keyof AppSettings)[];

export function enabledStages(settings: AppSettings): string[] {
  return STAGE_FLAGS.filter(flag => !!settings[flag]).sort();
}

async function timingsPath(): Promise<string> {
  return join(await appDataDir(), RUN_TIMINGS_FILE);
}

/** Oldest first. A malformed line is skipped, never thrown on — one bad write must not blind the rest. */
export async function loadRunTimings(): Promise<RunTimingRecord[]> {
  try {
    const path = await timingsPath();
    if (!await exists(path)) return [];
    return (await readTextFile(path))
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        try {
          const parsed = JSON.parse(line) as RunTimingRecord;
          return typeof parsed?.totalMs === 'number' ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export async function appendRunTiming(record: RunTimingRecord): Promise<void> {
  try {
    const kept = [...await loadRunTimings(), record].slice(-MAX_RUNS);
    await writeTextFile(await timingsPath(), kept.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch {
    // No Tauri (tests, a browser preview), or an unwritable directory. The run itself is unaffected.
  }
}

/**
 * The most recent COMPLETED run of the same client with the same stages and dry-run flag.
 *
 * Stopped runs are excluded on both sides: a run halted halfway through is a partial measurement,
 * and comparing against one would report a large fictional regression on the next full run.
 */
export function findBaseline(
  history: RunTimingRecord[],
  against: Pick<RunTimingRecord, 'clientId' | 'stages' | 'dryRun'>,
): RunTimingRecord | null {
  const key = against.stages.join(',');
  for (let i = history.length - 1; i >= 0; i--) {
    const candidate = history[i];
    if (candidate.stopped) continue;
    if (candidate.clientId !== against.clientId) continue;
    if (candidate.dryRun !== against.dryRun) continue;
    if (candidate.stages.join(',') !== key) continue;
    return candidate;
  }
  return null;
}

/** Local time, minute precision — this is read by a person deciding whether to trust a comparison. */
function describe(record: RunTimingRecord): string {
  const when = new Date(record.at);
  const stamp = Number.isNaN(when.getTime())
    ? record.at
    : `${when.toLocaleDateString()} ${when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return `${stamp} · ${record.assets} asset(s) · ${record.appVersion}`;
}

export function toBaseline(record: RunTimingRecord): TimelineBaseline {
  return {
    totalMs: record.totalMs,
    phases: Object.fromEntries(record.phases),
    describedAs: describe(record),
  };
}

/**
 * Snapshot the finished timeline as a persistable record. Returns null when no run was timed,
 * which is the case in any test that did not call `beginRunTimeline`.
 */
export function buildRunRecord(a: {
  settings:   AppSettings;
  clientId:   string | null;
  clientName: string | null;
  appVersion: string;
  assets:     number;
  errors:     number;
  stopped:    boolean;
  at?:        Date;
}): RunTimingRecord | null {
  const summary = runTimelineSummary(Number.MAX_SAFE_INTEGER);
  if (!summary) return null;
  const round = ({ label, ms }: { label: string; ms: number }): [string, number] =>
    [label, Math.round(ms)];
  return {
    at:         (a.at ?? new Date()).toISOString(),
    clientId:   a.clientId,
    client:     a.clientName,
    appVersion: a.appVersion,
    stages:     enabledStages(a.settings),
    dryRun:     !!a.settings.dryRun,
    assets:     a.assets,
    errors:     a.errors,
    stopped:    a.stopped,
    totalMs:    Math.round(summary.totalMs),
    measuredMs: Math.round(summary.measuredMs),
    phases:     summary.phases.map(round),
    steps:      summary.steps.map(round),
  };
}
