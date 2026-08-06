// stream-upload — put an asset's video master onto Cloudflare Stream.
//
// R2 keeps the master; Stream is a playback format alongside it. This function is the only thing
// that creates Stream videos, which is deliberate: creating one is also the moment its protection
// is decided, and splitting those two steps across callers is how an unprotected gated video
// happens.
//
// INGESTION IS A PULL, NOT A PUSH. Stream fetches the master itself from a presigned R2 URL. The
// alternative — downloading a multi-gigabyte video into an edge function and posting it back out —
// would exceed both the memory and the wall clock of the runtime. It also means the master never
// has to leave Cloudflare's network.
//
// Secrets: CF_STREAM_TOKEN, CF_ACCOUNT_ID, CF_R2_TOKEN, R2_PARENT_ACCESS_KEY_ID,
//          R2_BUCKET, R2_PUBLIC_DOMAIN, R2_GATED_BUCKET, R2_GATED_DOMAIN
import { createClient } from 'npm:@supabase/supabase-js@2';
import { effectiveLevel, tierFor, stripVersion } from '../../../packages/domain/src/assetStorage.ts';
import { isVideoFile } from '../../../packages/domain/src/video.ts';
import { tempCredentials, presignGet } from '../_shared/r2.ts';
import { preflight, corsJson } from '../_shared/cors.ts';
import { callerAuthFailureBody } from '../_shared/caller-auth-policy.ts';

/* Long enough for Stream to pull a large master, short enough that a leaked URL is worthless by the
   time anyone finds it. Cannot exceed the R2 temporary credentials' own hour — a presigned URL dies
   with the key that signed it, and asking for longer produces a URL that silently stops working
   partway through rather than failing up front. */
const INGEST_URL_TTL = 3600;

Deno.serve(async (req) => {
  /* CORS, because the PORTAL now calls this too — the `release` action below runs when staff delete
     a video asset. Every other caller is the desktop app, which is not a browser origin and never
     preflights, which is why this function went without it until now. A missing preflight fails
     before the function is reached, so there is nothing in the logs to find. */
  const pre = preflight(req);
  if (pre) return pre;

  const json = (status: number, body: Record<string, unknown>) => corsJson(req, status, body);

  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const env = (k: string) => Deno.env.get(k) ?? '';
  const accountId = env('CF_ACCOUNT_ID');
  const streamToken = env('CF_STREAM_TOKEN');
  const cfR2Token = env('CF_R2_TOKEN') || env('CF_API_TOKEN');
  const parentKey = env('R2_PARENT_ACCESS_KEY_ID');

  /* Unprovisioned is a hard 503, matching r2-grant. "Video is not configured" must never arrive as
     "this asset has no video" — one is a setup task and the other looks like normal data. */
  const missing = ['CF_ACCOUNT_ID', 'CF_STREAM_TOKEN', 'R2_PARENT_ACCESS_KEY_ID',
                   'R2_BUCKET', 'R2_PUBLIC_DOMAIN', 'R2_GATED_BUCKET', 'R2_GATED_DOMAIN']
    .filter(k => !env(k));
  if (!cfR2Token) missing.push('CF_R2_TOKEN');
  if (missing.length) {
    return json(503, { error: `Video not provisioned — missing ${missing.join(', ')}` });
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: userData, error: authError } = await asCaller.auth.getUser();
  if (!userData?.user) return json(401, callerAuthFailureBody(authError, authHeader));

  const { data: profile } = await asCaller
    .from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || !['editor', 'admin', 'super_admin'].includes(profile.role)) {
    return json(403, { error: 'Video uploads are for editor/admin roles' });
  }
  const isAdminOrAbove = ['admin', 'super_admin'].includes(profile.role);

  const body = await req.json().catch(() => ({})) as {
    asset_id?: string; replace?: boolean; release?: boolean;
  };
  if (!body.asset_id) return json(400, { error: 'asset_id required' });

  /* Service role for the read: the asset may sit at a level the caller cannot see — an `internal`
     draft is invisible to an editor's own session — and refusing to upload a video because the
     uploader cannot browse to it would be nonsense. Authorization is the explicit check below. */
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });
  const { data: asset } = await db.from('assets')
    .select('id,client_id,name,perm,status,download_url,stream_uid,stream_status,stream_source_hash')
    .eq('id', body.asset_id).maybeSingle();
  if (!asset) return json(404, { error: 'No such asset' });

  if (!isAdminOrAbove) {
    const { data: membership } = await asCaller.from('client_members')
      .select('client_id').eq('user_id', userData.user.id).eq('client_id', asset.client_id).maybeSingle();
    if (!membership) return json(403, { error: 'Not assigned to this client' });
  }

  const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream`;
  const streamHeaders = { Authorization: `Bearer ${streamToken}`, 'Content-Type': 'application/json' };

  /* ── Release ─────────────────────────────────────────────────────────────────
     Give the video back. Stream bills for every minute it holds, and the asset row is the ONLY
     record of which video belonged to which asset, so a row deleted without this leaves a charge
     nobody can attribute or safely clear.

     It lives here rather than in a function of its own because this is already the module trusted
     with CF_STREAM_TOKEN, and that token can delete production's videos from a staging deploy — the
     two environments share one Stream account. One caller, one place to audit.

     The columns are cleared before the caller deletes the row, so a client that dies in between
     leaves an asset with no video rather than a row pointing at a video that no longer exists. */
  if (body.release) {
    if (!asset.stream_uid) return json(200, { released: false, reason: 'no video' });

    const del = await fetch(`${api}/${asset.stream_uid}`, { method: 'DELETE', headers: streamHeaders });
    // 404 is success: the goal is "no video left behind", not "a delete was performed". Retrying a
    // half-finished release must not fail on the part that already worked.
    if (!del.ok && del.status !== 404) {
      const detail = await del.text().catch(() => '');
      console.error('stream release failed', asset.id, asset.stream_uid, del.status, detail);
      return json(502, {
        error: `Cloudflare would not delete the video (HTTP ${del.status}). `
             + 'The asset was left in place — nothing was deleted.',
      });
    }

    const { error: clearErr } = await db.from('assets')
      .update({ stream_uid: null, stream_status: null, stream_source_hash: null })
      .eq('id', asset.id);
    /* The video is already gone, so this is not recoverable by retrying the delete. Reported as a
       failure anyway: the caller's next step is to delete the row, and if that is what actually
       clears the reference then fine — but it must not be told the release succeeded when the
       database still claims a video that no longer exists. */
    if (clearErr) {
      return json(500, { error: `Video deleted but the row still references it: ${clearErr.message}` });
    }
    return json(200, { released: true, stream_uid: asset.stream_uid });
  }

  /* Idempotent by default. The desktop retries a failed run wholesale and the portal has a button;
     without this, the second attempt creates a second video and the unique index rejects the write
     AFTER the upload has been paid for, leaving an orphan nothing points at. */
  if (asset.stream_uid && !body.replace) {
    return json(200, { stream_uid: asset.stream_uid, stream_status: asset.stream_status, reused: true });
  }

  if (!asset.download_url) return json(422, { error: 'Asset has no master file to upload' });

  let key: string;
  try {
    key = decodeURIComponent(new URL(stripVersion(asset.download_url)).pathname.replace(/^\/+/, ''));
  } catch {
    return json(422, { error: `Unparseable download_url: ${asset.download_url}` });
  }

  /* Read the master's content hash out of the URL the pipeline wrote, rather than taking it from
     the caller. The caller would have to derive it the same way, and a caller that got it wrong
     would record a video as current when it is stale — which is invisible until someone notices
     the player and the download button disagree. */
  const sourceHash = new URL(asset.download_url).searchParams.get('v');
  if (!isVideoFile(key)) {
    return json(422, { error: `Not a video: ${key.split('/').pop()}` });
  }

  const level = effectiveLevel(asset);
  const tier = tierFor(level);
  const bucket = tier === 'public' ? env('R2_BUCKET') : env('R2_GATED_BUCKET');

  /* The presigned read is scoped to the bucket the master actually lives in — which follows the
     asset's level, because that is what decides the object key. Reading the tier from the stored
     URL rather than recomputing it would be wrong for a row mid-reconciliation. */
  const creds = await tempCredentials(accountId, cfR2Token, parentKey, bucket);
  const ingestUrl = await presignGet(accountId, creds, bucket, key, INGEST_URL_TTL);

  /* Which database owns this video. Staging and production share one Cloudflare account — Stream
     has no equivalent of the two R2 buckets — so without a marker the two environments' videos are
     indistinguishable, and a cleanup script pointed at "staging" would happily delete production's.
     The project ref is derived, never configured, so it cannot drift from the database it names. */
  const projectRef = new URL(env('SUPABASE_URL')).hostname.split('.')[0];

  const copyRes = await fetch(`${api}/copy`, {
    method: 'POST',
    headers: streamHeaders,
    body: JSON.stringify({
      url: ingestUrl,
      meta: { name: asset.name, asset_id: asset.id, client_id: asset.client_id, project_ref: projectRef },
    }),
  });
  const copyBody = await copyRes.json().catch(() => null);
  if (!copyRes.ok || !copyBody?.result?.uid) {
    const detail = copyBody?.errors?.[0]?.message ?? `HTTP ${copyRes.status}`;
    console.error('stream copy failed', asset.id, copyRes.status, JSON.stringify(copyBody?.errors ?? copyBody));
    /* "could not determine the size of the file" means the source refused HEAD or Range, which is
       a signing or bucket fault on our side, not a bad video. Said plainly so it is not chased as
       a corrupt upload. */
    return json(502, { error: `Stream refused the master: ${detail}` });
  }
  const uid = copyBody.result.uid as string;

  /* ── Protection ──────────────────────────────────────────────────────────────
     requireSignedURLs is IGNORED when passed at creation — measured 2026-08-02, the video comes
     back with it false. It has to be set afterwards, and the response has to be read back, because
     "the API returned 200" is not the same as "the flag is on" and the difference is a gated video
     serving to anyone holding the uid.

     Verified in the same test: with the flag on, playback, stills and animated previews all 401
     unsigned. With it off, all three serve. So this single call is the whole of a video's
     protection, and a failure here is fatal rather than a warning. */
  if (tier !== 'public') {
    const flagRes = await fetch(`${api}/${uid}`, {
      method: 'POST', headers: streamHeaders, body: JSON.stringify({ requireSignedURLs: true }),
    });
    const flagBody = await flagRes.json().catch(() => null);
    if (!flagRes.ok || flagBody?.result?.requireSignedURLs !== true) {
      /* Delete rather than leave it. A `client` video that serves to the world is worse than no
         video at all, and the row is not written yet, so nothing would ever point at it to say
         what it was. Deleting is safe precisely because it was created moments ago by this call. */
      await fetch(`${api}/${uid}`, { method: 'DELETE', headers: streamHeaders });
      console.error('requireSignedURLs did not apply, video deleted', uid, flagRes.status);
      return json(502, {
        error: 'Could not protect the video on Stream, so it was deleted rather than left readable. '
             + `Asset is ${level}; nothing was recorded.`,
      });
    }
  }

  const streamStatus = copyBody.result.status?.state ?? 'queued';
  const { error: writeErr } = await db.from('assets')
    .update({ stream_uid: uid, stream_status: streamStatus, stream_source_hash: sourceHash })
    .eq('id', asset.id);
  if (writeErr) {
    // Same reasoning as above: an unreferenced video is an orphan that still bills and still serves.
    await fetch(`${api}/${uid}`, { method: 'DELETE', headers: streamHeaders });
    return json(500, { error: `Uploaded but could not record it: ${writeErr.message}` });
  }

  /* A replacement supersedes the old video, so the old one goes. Deleted only AFTER the row points
     at the new uid: the other order leaves a window where the asset references a video that no
     longer exists, and a failure mid-way would take out the working video and leave nothing.
     Best-effort — a video that outlives its row costs storage, which is the cheaper failure. */
  let replaced: string | null = null;
  if (asset.stream_uid && asset.stream_uid !== uid) {
    const del = await fetch(`${api}/${asset.stream_uid}`, { method: 'DELETE', headers: streamHeaders });
    if (!del.ok && del.status !== 404) {
      console.error(`superseded video ${asset.stream_uid} not deleted: ${del.status}`);
    }
    replaced = asset.stream_uid;
  }

  return json(200, {
    stream_uid: uid, stream_status: streamStatus, signed: tier !== 'public', replaced,
  });
});
