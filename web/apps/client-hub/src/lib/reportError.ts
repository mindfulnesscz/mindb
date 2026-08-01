/**
 * Single chokepoint for reporting caught errors (Phase 0 seam).
 *
 * Reports go to `public.app_errors` in the project the portal is pointed at — the
 * SAME backend, not a hosted service. A browser cannot write a log file, so without
 * this the portal's errors existed only in a console nobody reads.
 *
 * Sentry was the alternative and was declined for now: another vendor and bill, and
 * once the tool is deployed to another agency, becoming the processor of their error
 * data — a contractual question rather than a configuration one. It wins on two
 * things that are genuinely hard to replicate (un-minifying stacks from uploaded
 * source maps, and telling you an error is NEW), so revisit when either starts to
 * hurt. Adding it later is additive; this function is the only place that changes.
 *
 * `no-console` is disabled for this file in eslint.config.js — that override is
 * what makes this the *only* place a raw console.error can live, so a new bare
 * one anywhere else fails CI rather than quietly swallowing a failure.
 *
 * Contexts are prefixed by CONCERN (`feedback.AssetDetail.saveRating`), enforced by
 * a lint rule, so errors can be grouped by what broke rather than by where.
 */
export function reportError(context: string, err: unknown): void {
  const message = toMessage(err)
  console.error(`[${context}] ${message}`, err)
  void sendToSink(context, message, err instanceof Error ? err.stack : undefined)
}

/** The portal has no run to trace, so its reports carry no trail. Kept for one shared sink shape. */
function recentBreadcrumbs(): string[] { return [] }

/* ── The remote sink ──────────────────────────────────────────────────────────
 * Configured rather than imported. `reportError` is called from stores and services that are
 * themselves imported by the modules holding the Supabase config, so importing that config here would
 * risk a cycle — and the sink has to work before a backend is even chosen. So the app hands it in once
 * it knows, and until then reporting is local only.
 *
 * Never awaited, never throws, and never reports its OWN failure: a sink that recurses when the
 * network is down turns one error into a loop.                                                       */

interface ErrorSink {
  url:         string
  anonKey:     string
  environment: string
  appVersion:  string
  /** The signed-in user, when there is one. RLS refuses a report attributed to anybody else. */
  userId?:     string | null
}

const SOURCE = 'web'

let sink: ErrorSink | null = null

export function configureErrorSink(next: ErrorSink | null): void {
  sink = next
}

async function sendToSink(context: string, message: string, stack: string | undefined): Promise<void> {
  if (!sink) return
  try {
    await fetch(`${sink.url}/rest/v1/app_errors`, {
      method: 'POST',
      headers: {
        apikey: sink.anonKey,
        Authorization: `Bearer ${sink.anonKey}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({
        context,
        message,
        stack: stack ?? null,
        breadcrumbs: recentBreadcrumbs(),
        source: SOURCE,
        app_version: sink.appVersion,
        environment: sink.environment,
        user_id: sink.userId ?? null,
      }),
    })
  } catch {
    // Offline, or the backend is the thing that broke. The console line already went out; a failed
    // report must not become a second error.
  }
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
