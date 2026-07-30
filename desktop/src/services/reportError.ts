/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Today it just normalises and logs. Later, route this to a real sink (a Tauri
 * log file, Sentry, etc.) in ONE place instead of chasing bare `console.error`
 * calls across services. Behaviour is intentionally unchanged for now.
 *
 * `no-console` is disabled for this file in eslint.config.js — that override is
 * what makes this the *only* place a raw console.error can live, so a new bare
 * one anywhere else fails CI rather than quietly swallowing a failure.
 */
export function reportError(context: string, err: unknown): void {
  console.error(`[${context}] ${toMessage(err)}`, err)
  // TODO(phase4): forward to a Tauri log sink / telemetry here.
}

/**
 * Convenience for the common `catch (e) { ... String(e) }` pattern.
 *
 * Handles a real Error, a plain object carrying a string `message` (Supabase
 * REST errors — `String()` on those yields "[object Object]"), and anything else.
 */
export function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message
  }
  return String(err)
}
