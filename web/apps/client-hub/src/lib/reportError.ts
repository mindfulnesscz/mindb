/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Console only, and that is a DECISION rather than an omission. A browser cannot
 * write a log file, so the portal's only real option is a remote sink — and both
 * candidates cost something that is not a refactoring choice:
 *
 *   Sentry              an account, and you become the processor of every deployed
 *                       agency's error data (paths, asset names, emails) — a
 *                       contractual and GDPR question, not a config flag;
 *   a Supabase table    lives inside the system being monitored, so it cannot report
 *                       the failures that matter most (auth down, backend
 *                       unreachable), and with per-agency projects the errors scatter
 *                       across databases you would need credentials to read.
 *
 * Deferred until there is a second deployment. Desktop meanwhile writes a real
 * rolling log, because a packaged binary has no console to open. Wiring a sink is one
 * call inside this function; nothing else has to change.
 *
 * `no-console` is disabled for this file in eslint.config.js — that override is
 * what makes this the *only* place a raw console.error can live, so a new bare
 * one anywhere else fails CI rather than quietly swallowing a failure.
 *
 * Contexts are prefixed by CONCERN (`feedback.AssetDetail.saveRating`), enforced by
 * a lint rule, so errors can be grouped by what broke rather than by where.
 */
export function reportError(context: string, err: unknown): void {
  console.error(`[${context}] ${toMessage(err)}`, err)
  // A remote sink goes here — see the note above for why there is not one yet.
}

/**
 * Convenience for the common `catch (e) { setError(msg) }` pattern.
 *
 * Handles the three shapes that actually reach us: a real Error, a Supabase
 * `PostgrestError` (a plain object with `message` — `String()` on it would give
 * "[object Object]"), and anything else.
 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
