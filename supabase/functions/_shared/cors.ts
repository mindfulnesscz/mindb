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
 * ── The origin list is CONFIGURATION, not code ────────────────────────────────
 * `ALLOWED_ORIGINS`, comma-separated, exactly as `workers/cdn-gate/wrangler.jsonc` already does it
 * for the CDN Worker. It was a hardcoded array of disruptcollective.com hostnames, which made the
 * portal's own domain a compile-time fact — so a local gate on a different port, a rebranded
 * deployment, or handing this tool to another agency each meant editing three source files and
 * redeploying, for something that is deployment configuration in every other part of the system.
 *
 * The built-in list stays as the FALLBACK, so an environment whose secret has not been set behaves
 * exactly as before rather than locking the portal out of its own backend. That matters more than
 * purity here: the failure mode of an empty allow-list is every browser call failing at once, with
 * nothing server-side to see.
 */

/* Read once. Deno.env.get is cheap but this is called on every request, and a value that changed
   mid-instance would make two requests to the same worker disagree. */
const CONFIGURED = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map(o => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);

/* The pre-configuration list. Kept verbatim so an unset ALLOWED_ORIGINS is a no-op rather than an
   outage — see the header. Localhost is in here because the portal's dev server is a first-class
   caller: gated delivery and video are both testable locally against a `wrangler dev` gate. */
const FALLBACK = [
  'https://staging.hub.disruptcollective.com',
  'https://hub.disruptcollective.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

const ORIGINS = CONFIGURED.length > 0 ? CONFIGURED : FALLBACK;
const ALLOWED_ORIGINS = new Set(ORIGINS);

/**
 * Echo the caller's origin when it is one of ours; otherwise name the first configured origin and
 * let the browser refuse.
 *
 * The default used to be a literal staging URL. It is now whatever heads the list, so a deployment
 * that has never heard of disruptcollective.com does not name it in a rejection header.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  let allow = ORIGINS[0];
  if (origin) {
    try {
      // Vercel previews are a moving set of hostnames, so they are matched by suffix rather than
      // enumerated — a platform fact rather than a per-deployment choice, hence still in code.
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
