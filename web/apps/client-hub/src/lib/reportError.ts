/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Today it just normalises and logs. Later, route this to a real sink (Sentry,
 * a Supabase `errors` table, etc.) in ONE place instead of chasing 30+ bare
 * `console.error` calls. Behaviour is intentionally unchanged for now.
 */
export function reportError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  // eslint-disable-next-line no-console
  console.error(`[${context}] ${message}`, err)
  // TODO(phase4): forward to telemetry sink here.
}

/** Convenience for the common `catch (e) { setError(msg) }` pattern. */
export function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
