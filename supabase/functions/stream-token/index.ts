// stream-token — signed URLs for the videos a caller is allowed to see.
//
// A gated video is protected by Cloudflare's `requireSignedURLs`, which 401s every delivery URL —
// playback, stills, animated previews — unless a token replaces the uid in the path. This mints
// those tokens.
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

/* Long enough to watch something without the URL dying mid-scrub, short enough that a token
   pasted elsewhere stops working the same afternoon. Renewal is a cheap call, so there is nothing
   to gain from a longer life and a leaked URL to lose. */
const TOKEN_TTL_SECONDS = 3600;

/* Bounded so one request cannot fan out into hundreds of Cloudflare calls. A grid holds far fewer
   videos than assets, and the portal asks only for the ones actually on screen. */
const MAX_PER_REQUEST = 60;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
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
    .from('assets').select('id,stream_uid,perm,status').in('id', ids);
  if (error) return json(500, { error: error.message });

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
    expires_at: Date.now() + TOKEN_TTL_SECONDS * 1000,
  });
});
