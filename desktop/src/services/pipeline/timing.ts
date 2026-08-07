/* Run timing — the only thing in the pipeline that knows how long anything took.
 *
 * Nothing in the run log carried a duration before this, which is why run speed regressed across
 * several audits without anyone being able to say where. Every phase now reports its own time on
 * the banner it already prints, and the run closes with a RUN TOTAL block naming the slowest few.
 *
 * **The timeline is module state, deliberately.** A run's phases are spread across `runPipeline`,
 * the stage modules, and the post-run portal sync in `useRunPipeline` — and the widest of those,
 * `exportAssetsToSupabase`, already takes fourteen positional arguments. Threading a collector
 * through all of it would be a larger and riskier change than the measurement it exists to add,
 * for a value that is genuinely global: there is exactly one run at a time (the Run button is
 * gated on `runStatus`). `beginRunTimeline()` resets it, so tests are hermetic.
 *
 * Measuring is free when no run is active: `timePhase`/`timeStep` still return a working timer,
 * they just record nothing. A stage exercised by a unit test needs no setup.
 */

/** Monotonic where available. `Date.now()` only as a fallback for a host without `performance`. */
function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/**
 * `640ms` · `12.4s` · `3m 12s`.
 *
 * Sub-second work is reported whole — a tenth of a millisecond is noise at this scale — and past a
 * minute the tenths stop carrying information, so they are dropped for `m s`. The 59.95s guard is
 * what stops a run rounding to the nonsense `60.0s` instead of `1m 0s`.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 59.95) return `${seconds.toFixed(1)}s`;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

export interface Timer {
  /** Milliseconds since the timer started. */
  elapsed(): number;
  /** `elapsed()`, formatted. */
  format(): string;
}

export function startTimer(): Timer {
  const started = now();
  const elapsed = () => now() - started;
  return { elapsed, format: () => formatDuration(elapsed()) };
}

export interface PhaseTimer {
  /**
   * Formatted elapsed time, and the point the phase enters the timeline. The first call settles
   * the measurement: later calls return that same number rather than a growing one, so a banner
   * printed on two different exit paths can neither double-count nor disagree with itself.
   */
  done(): string;
}

interface PhaseRecord { label: string; ms: number; ranked: boolean }

let timeline: { started: number; phases: PhaseRecord[] } | null = null;

/** Start a run's timeline. Discards any previous one — a run is never concurrent with another. */
export function beginRunTimeline(): void {
  timeline = { started: now(), phases: [] };
}

/** Drop the timeline. Not required for correctness; keeps a finished run out of the next one. */
export function endRunTimeline(): void {
  timeline = null;
}

function track(label: string, ranked: boolean): PhaseTimer {
  const timer = startTimer();
  let settled: number | null = null;
  return {
    done() {
      if (settled === null) {
        settled = timer.elapsed();
        timeline?.phases.push({ label, ms: settled, ranked });
      }
      return formatDuration(settled);
    },
  };
}

/** A top-level phase: timed, and eligible for the RUN TOTAL ranking. */
export function timePhase(label: string): PhaseTimer {
  return track(label, true);
}

/**
 * A step INSIDE a phase — the Supabase export's writes, one cloud destination of several.
 * Timed and logged where it happens, but kept out of the ranking: a parent and its own child
 * would otherwise take two of the five slots to say one thing.
 */
export function timeStep(label: string): PhaseTimer {
  return track(label, false);
}

export interface LabelledDuration { label: string; ms: number }

export interface RunTimelineSummary {
  /** Wall clock from `beginRunTimeline()` — not the sum of phases; see `measuredMs`. */
  totalMs: number;
  /** Summed top-level phases. Below `totalMs` by whatever the run does that nothing times. */
  measuredMs: number;
  /** Ranked phases, slowest first, capped at `topN`. */
  slowest: LabelledDuration[];
  /** EVERY ranked phase, in the order it completed. What the run record persists. */
  phases: LabelledDuration[];
  /** Every sub-step, in completion order. Persisted too — they are where 04b–04f will land. */
  steps: LabelledDuration[];
}

export function runTimelineSummary(topN = 5): RunTimelineSummary | null {
  if (!timeline) return null;
  const ranked = timeline.phases.filter(p => p.ranked);
  const bare = ({ label, ms }: PhaseRecord): LabelledDuration => ({ label, ms });
  return {
    totalMs: now() - timeline.started,
    measuredMs: ranked.reduce((sum, p) => sum + p.ms, 0),
    slowest: [...ranked].sort((a, b) => b.ms - a.ms).slice(0, topN).map(bare),
    phases: ranked.map(bare),
    steps: timeline.phases.filter(p => !p.ranked).map(bare),
  };
}

/**
 * A previous run to measure this one against. Deliberately plain numbers rather than the persisted
 * record type — this module stays free of the filesystem, and of any opinion about what makes two
 * runs comparable. `runTimings.ts` decides that and hands the answer in.
 */
export interface TimelineBaseline {
  totalMs: number;
  /** Phase label → milliseconds, from the run being compared against. */
  phases: Record<string, number>;
  /** One line of provenance, so an unfair comparison can be recognised as one. */
  describedAs: string;
}

/**
 * A signed delta, or `—` when nothing moved. Sub-100ms differences are reported as unchanged:
 * below that the number is scheduler noise, and a column of `+11ms`/`-7ms` reads as signal.
 */
function formatDelta(deltaMs: number): string {
  if (Math.abs(deltaMs) < 100) return '—';
  return `${deltaMs > 0 ? '+' : '-'}${formatDuration(Math.abs(deltaMs))}`;
}

/**
 * The closing block. Wall clock first, because that is the number the operator felt, then the
 * phases worth attacking. The measured-of-total line is the honest part: a large gap between them
 * is untimed work, and finding it is the whole point of this instrumentation.
 *
 * With a baseline, every line also carries its change since the comparable previous run — which is
 * what makes a regression visible the moment it happens rather than at the next audit.
 */
export function logRunTimeline(
  appendLog: (type: 'section' | 'dim', msg: string) => void,
  options: { baseline?: TimelineBaseline | null; topN?: number } = {},
): void {
  const { baseline = null, topN = 5 } = options;
  const summary = runTimelineSummary(topN);
  if (!summary) return;

  const headline = baseline
    ? `  (${formatDelta(summary.totalMs - baseline.totalMs)} vs previous run)`
    : '';
  appendLog('section', `━━━ RUN TOTAL — ${formatDuration(summary.totalMs)} ━━━${headline}`);
  if (!summary.slowest.length) return;

  const width = Math.max(...summary.slowest.map(p => p.label.length));
  summary.slowest.forEach((phase, i) => {
    const share = summary.totalMs > 0 ? Math.round((phase.ms / summary.totalMs) * 100) : 0;
    // A phase absent from the baseline is new, not infinitely slower — say so rather than
    // reporting its whole duration as a regression.
    const before = baseline?.phases[phase.label];
    const delta = !baseline ? ''
      : before === undefined ? '     new'
      : `  ${formatDelta(phase.ms - before).padStart(7)}`;
    appendLog('dim',
      `  ${i + 1}. ${phase.label.padEnd(width)}  ${formatDuration(phase.ms).padStart(7)}  (${String(share).padStart(2)}%)${delta}`);
  });
  appendLog('dim', `  measured ${formatDuration(summary.measuredMs)} of ${formatDuration(summary.totalMs)}`);
  if (baseline) appendLog('dim', `  vs ${baseline.describedAs}`);
}
