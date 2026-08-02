// stream-token — signed URLs for the videos a caller is allowed to see, and their current state.
//
// A gated video is protected by Cloudflare's `requireSignedURLs`, which 401s every delivery URL —
// playback, stills, animated previews — unless a token replaces the uid in the path. This mints
// those tokens.
//
// IT ALSO SYNCS `stream_status`, which is not scope creep but the fix for a real gap: `stream-upload`
// records the state at the moment of upload (`downloading`, `queued`) and encoding finishes minutes
// later with nothing watching. Both staging videos sat at `downloading` in the database while
// Cloudflare had them `ready`, so the portal correctly showed "video processing" forever.
//
// Here rather than in its own function because this one already has the two things such a function
// would need — the caller's visible asset list, and the Cloudflare credential — and the portal
// already calls it for exactly the videos on screen. A separate endpoint would duplicate both and
// double the round trips.
//
// A webhook from Cloudflare would be the push version and was not chosen: it needs a public
// endpoint and a stored callback secret, which is the arrangement this project deliberately moved
// away from when the CDN reconciler stopped being a GitHub cron.
//
// AUTHORIZATION IS RLS, NOT CODE HERE. The caller's own token queries `public.assets`, so the rows
// that come back are exactly the ones they may see, decided by the policies that already govern
// every other read in the product. A hand-written permission check in this function would be a
// second implementation of the same rule, free to drift from the first — and drift in the
// direction that hands out tokens is a silent data leak.
//
// Secrets: CF_STREAM_TOKEN, CF_ACCOUNT_ID
import { createClient } from 'npm:@supabase/supabase-js@2';
import { effectiveLevel, tierFor } from '../../../packages/domain/src/assetStorage.ts';
import { preflight, corsJson } from '../_shared/cors.ts';

/* Long enough to watch something without the URL dying mid-scrub, short enough that a token
   pasted elsewhere stops working the same afternoon. Renewal is a cheap call, so there is nothing
   to gain from a longer life and a leaked URL to lose. */
const TOKEN_TTL_SECONDS = 3600;

/* Bounded so one request cannot fan out into hundreds of Cloudflare calls. A grid holds far fewer
   videos than assets, and the portal asks only for the ones actually on screen. */
const MAX_PER_REQUEST = 60;

Deno.serve(async (req) => {
  /* Before anything else. A preflight carries no Authorization header, so any auth check placed
     above this would reject it — and the browser would then refuse the real request, which never
     reaches this function at all. */
  const pre = preflight(req);
  if (pre) return pre;

  const json = (status: number, body: Record<string, unknown>) => corsJson(req, status, body);
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const env = (k: string) => Deno.env.get(k) ?? '';
  const accountId = env('CF_ACCOUNT_ID');
  const streamToken = env('CF_STREAM_TOKEN');
  if (!accountId || !streamToken) {
    return json(503, { error: 'Video not provisioned — missing CF_ACCOUNT_ID / CF_STREAM_TOKEN' });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: userData } = await asCaller.auth.getUser();
  if (!userData?.user) return json(401, { error: 'Not authenticated' });

  const body = await req.json().catch(() => ({})) as { asset_ids?: string[] };
  const ids = (body.asset_ids ?? []).slice(0, MAX_PER_REQUEST);
  if (!ids.length) return json(200, { tokens: {}, expires_at: Date.now() });

  /* RLS does the work. An id the caller may not see simply does not come back, and asking for one
     is not an error — the portal batches whatever is on screen and should not have to pre-filter. */
  const { data: assets, error } = await asCaller
    .from('assets').select('id,stream_uid,perm,status,stream_status').in('id', ids);
  if (error) return json(500, { error: error.message });

  /* ── Status sync ─────────────────────────────────────────────────────────────
     Only for videos not already `ready` — a ready video never goes back, so re-checking the whole
     library on every view would be a Cloudflare call per card for no possible change.

     Every tier is refreshed, not just the gated ones that get tokens below: a `public` video's
     encode finishes just as invisibly, and it would otherwise show "processing" forever. */
  const stale = (assets ?? []).filter(a => a.stream_uid && a.stream_status !== 'ready');
  const statuses: Record<string, string> = {};
  if (stale.length) {
    const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false },
    });
    await Promise.all(stale.map(async (a) => {
      const res = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${a.stream_uid}`,
        { headers: { Authorization: `Bearer ${streamToken}` } },
      );
      const b = await res.json().catch(() => null);
      const state = b?.result?.status?.state as string | undefined;
      if (!res.ok || !state || state === a.stream_status) return;
      statuses[a.id] = state;
      /* Service role for the write, deliberately: this is Cloudflare's fact being copied in, not
         anything the caller supplied, and a member has no update rights on assets — correctly.
         Only the one column is touched. */
      await db.from('assets').update({ stream_status: state }).eq('id', a.id);
      // The row the token decision below reads from, so a video that just became ready is
      // reported ready in the same response rather than one poll later.
      a.stream_status = state;
    }));
  }

  const wanted = (assets ?? []).filter(a =>
    /* Public videos carry no `requireSignedURLs`, so a token would be pointless ceremony — and
       minting one per card would triple the Cloudflare calls for the common case. The portal uses
       the bare uid for these; this function simply declines to mint. */
    a.stream_uid && tierFor(effectiveLevel(a)) !== 'public');

  const results = await Promise.all(wanted.map(async (a) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${a.stream_uid}/token`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${streamToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
      },
    );
    const b = await res.json().catch(() => null);
    if (!res.ok || !b?.result?.token) {
      // One video failing must not blank the rest of the grid.
      console.error(`token mint failed for ${a.stream_uid}: ${res.status}`);
      return null;
    }
    return [a.stream_uid as string, b.result.token as string] as const;
  }));

  return json(200, {
    tokens: Object.fromEntries(results.filter(Boolean) as (readonly [string, string])[]),
    /* Only the ones that CHANGED. The portal overlays these on the rows it already fetched, so an
       empty object means "nothing moved" rather than "no videos". */
    statuses,
    expires_at: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
});
