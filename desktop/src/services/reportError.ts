/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Today it just normalises and logs. Later, route this to a real sink (a Tauri
 * log file, Sentry, etc.) in ONE place instead of chasing bare `console.error`
 * calls across services. Behaviour is intentionally unchanged for now.
 */
export function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`, err)
  // TODO(phase4): forward to a Tauri log sink / telemetry here.
}

/** Convenience for the common `catch (e) { ... String(e) }` pattern. */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
