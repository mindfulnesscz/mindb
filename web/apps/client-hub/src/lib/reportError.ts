/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Today it just normalises and logs. Later, route this to a real sink (Sentry,
 * a Supabase `errors` table, etc.) in ONE place instead of chasing bare
 * `console.error` calls. Behaviour is intentionally unchanged for now.
 *
 * `no-console` is disabled for this file in eslint.config.js — that override is
 * what makes this the *only* place a raw console.error can live, so a new bare
 * one anywhere else fails CI rather than quietly swallowing a failure.
 */
export function reportError(context: string, err: unknown): void {
  console.error(`[${context}] ${toMessage(err)}`, err)
  // TODO(phase4): forward to telemetry sink here.
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
