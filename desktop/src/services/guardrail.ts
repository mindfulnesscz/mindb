/* Blast-radius guardrail for the destructive stages of a run.
 *
 * THE INVARIANT
 * A run must not destroy more than it touched. Every bulk-destructive stage here is driven by a
 * DIFF — "these rows/objects were not in what I just synced, so they are stale" — and a diff is only
 * as trustworthy as the set it diffs against. When that set is wrong, the diff is not slightly wrong;
 * it is inverted, and the stage happily destroys everything.
 *
 * That is not hypothetical:
 *
 *   F-9  an integration test synced a seven-asset fixture against a client that owned seventeen real
 *        assets. Stage 4 disconnected all seventeen. Working exactly as designed, on the wrong input.
 *   F-5  a failed read of existing rows would have made "no row for this key" mean "absent" rather
 *        than "unknown", disconnecting every asset. That one is now gated on `readFailed` — this is
 *        the same class of failure, caught by shape instead of by cause.
 *
 * So the ratio is the signal. A healthy run destroys a little and writes a lot; a run that destroys
 * far more than it wrote is either operating on the wrong tenant, or was handed a partial view of the
 * source. Neither is worth guessing about, and both are cheap to survive: the destructive stage is
 * SKIPPED and reported, the run's useful work stands, and the operator re-runs deliberately.
 *
 * Deliberately NOT a confirmation dialog: the pipeline runs headless inside services, and a modal
 * from three layers down is how a "just click OK" habit forms. The operator opts in ahead of time,
 * per run, via the "Allow large deletions" run option.
 *
 * The floor matters as much as the ratio. Small numbers are noisy — a package losing its last two
 * files legitimately disconnects two rows while writing none — so anything at or below the floor is
 * always allowed. This is a tripwire for catastrophes, not a code review of every run.
 */

/** Below this many doomed items, the ratio is not meaningful and the stage always proceeds. */
export const DESTRUCTION_FLOOR = 10;

/** Above the floor, a stage may destroy at most this multiple of what the run actually wrote. */
export const DESTRUCTION_RATIO = 1;

export interface DestructionAssessment {
  /** True when the stage must not run. */
  blocked: boolean;
  /** One line for the activity log, always present — a skipped stage must say so loudly. */
  message: string;
}

export interface DestructionRequest {
  /** What is being destroyed, for the log: 'row(s)', 'CDN object(s)'. */
  unit: string;
  /** How many items this stage is about to destroy. */
  doomed: number;
  /**
   * How many items the run wrote — created plus updated. This is the evidence that the run saw a
   * real source tree. Zero writes plus many deletions is the exact shape of a wrong-input run.
   */
  written: number;
  /** The operator's per-run opt-in. */
  allowLarge?: boolean;
}

export function assessDestruction({
  unit, doomed, written, allowLarge = false,
}: DestructionRequest): DestructionAssessment {
  if (doomed <= 0) return { blocked: false, message: '' };

  const limit = Math.max(DESTRUCTION_FLOOR, Math.floor(written * DESTRUCTION_RATIO));
  if (doomed <= limit) {
    return { blocked: false, message: `  ⦾  ${doomed} ${unit} to remove (run wrote ${written})` };
  }

  if (allowLarge) {
    return {
      blocked: false,
      message: `  ⚠  ${doomed} ${unit} to remove against only ${written} written — allowed by the "Allow large deletions" run option.`,
    };
  }

  return {
    blocked: true,
    message:
      `  ✕  REFUSING to remove ${doomed} ${unit}: the run wrote only ${written}. ` +
      'That ratio usually means the source folder was empty, partly readable, or the wrong client is ' +
      'active — not that this much is really stale. Nothing was removed. Check the source, then ' +
      're-run with "Allow large deletions" if it is genuinely correct.',
  };
}
