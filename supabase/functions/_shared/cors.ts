/* CORS for edge functions the BROWSER calls.
 *
 * Easy to forget and unmistakable when you do: the browser refuses the preflight and the call
 * fails before it reaches the function, so there is nothing in the function's logs to find. It
 * surfaces as `FunctionsFetchError: Failed to send a request to the Edge Function`, which reads
 * like the function is down.
 *
 * Only needed for functions called from the portal. `r2-grant` and `cdn-reconcile` are called by the
 * DESKTOP app, which is not a browser origin and never preflights — which is exactly why the
 * omission in `stream-token` was not obvious by comparison with its neighbours.
 *
 * `stream-upload` was in that desktop-only list until the portal gained a way to delete a video
 * asset, which has to hand the video back to Cloudflare first. A function moving from one list to
 * the other is the case this comment exists to catch.
 *
 * `admin-create-user` and `r2-branding-upload` each carry this same logic inline. They work, so
 * they are left alone here rather than widening an urgent fix; adopt this when either is next
 * touched.
 */

const ALLOWED_ORIGINS = new Set([
  'https://staging.hub.disruptcollective.com',
  'https://hub.disruptcollective.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/** Echo the caller's origin when it is one of ours; otherwise name staging and let the browser refuse. */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  let allow = 'https://staging.hub.disruptcollective.com';
  if (origin) {
    try {
      // Vercel previews are a moving set of hostnames, so they are matched by suffix rather than
      // enumerated — the same rule the two older functions already use.
      const host = new URL(origin).hostname;
      if (ALLOWED_ORIGINS.has(origin) || host.endsWith('.vercel.app')) allow = origin;
    } catch { /* malformed Origin — fall through to the default */ }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

/** 204 for a preflight. Must be returned BEFORE any auth check — a preflight carries no credentials. */
export function preflight(req: Request): Response | null {
  if (req.method !== 'OPTIONS') return null;
  return new Response(null, { status: 204, headers: corsHeaders(req) });
}

export function corsJson(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}
