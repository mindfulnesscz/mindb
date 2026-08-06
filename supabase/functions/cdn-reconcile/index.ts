// cdn-reconcile — move an asset's bytes to the key its access level requires.
//
// The access level lives in the R2 object key, which is what lets the cdn-gate Worker authorize a
// request without a database lookup. The cost is that changing `perm` or `status` has to MOVE the
// object. A trigger queues the work (see 20260802090000); this drains the queue.
//
// It replaces a GitHub Actions cron. That worked, but it made a core correctness property depend
// on a CI provider, a checked-out branch, and secrets in a settings page — and it ran the script
// from whatever was on main, so a fix reached production only when someone merged. This runs
// beside the data, with secrets the project already holds.
//
// CALLED BY whoever just changed something: the portal after an edit, the desktop after a run.
// No scheduler, no stored callback token — the caller is already authenticated, and the queue is
// durable so nothing is lost if a call never comes.
//
// Secrets: R2_BUCKET, R2_PUBLIC_DOMAIN, R2_GATED_BUCKET, R2_GATED_DOMAIN, CF_R2_TOKEN,
//          CF_ACCOUNT_ID, R2_PARENT_ACCESS_KEY_ID  — all already set on both projects.
//          CF_STREAM_TOKEN is needed only once videos exist: it reconciles Stream's
//          requireSignedURLs alongside the object key, since a video's level lives in that flag.
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  effectiveLevel, tierFor, assetUrl, stripVersion, planPageMoves, type AccessLevel,
} from '../../../packages/domain/src/assetStorage.ts';
import { tempCredentials, copyObject, s3, type TempCreds } from '../_shared/r2.ts';

/** How many assets one invocation will move. Bounded so a large backlog cannot exceed the
 *  function's wall-clock limit; the queue keeps the rest for the next call. */
const BATCH = 25;

/** Must match parseGatedKey in workers/cdn-gate/src/authz.ts — a key the Worker cannot parse is a
 *  404 on a file the portal is offering, so it is never written. */
const GATED_KEY_SHAPE =
  /^(public|guest|client|internal)\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/.+/i;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  /* CF_R2_TOKEN was CF_API_TOKEN. Two Cloudflare tokens named almost identically — one minting R2
     credentials, one deploying the Worker — is how the wrong one ends up pasted, and the failure is
     an authorization error that looks like a bad token rather than the wrong scope. The old name is
     still read so the rename cannot break an environment mid-flight. */
  const env = (k: string) => Deno.env.get(k) ?? (k === 'CF_R2_TOKEN' ? Deno.env.get('CF_API_TOKEN') ?? '' : '');
  const need = ['R2_BUCKET', 'R2_PUBLIC_DOMAIN', 'R2_GATED_BUCKET', 'R2_GATED_DOMAIN',
                'CF_R2_TOKEN', 'CF_ACCOUNT_ID', 'R2_PARENT_ACCESS_KEY_ID'];
  const missing = need.filter(k => !env(k));
  if (missing.length) {
    // Explicit 503 rather than a partial move, matching r2-grant: "not provisioned" must never
    // read as "nothing to do".
    return json(503, { error: `Storage not provisioned — missing ${missing.join(', ')}` });
  }

  /* The caller's own token authorizes this, which is why no callback secret is stored anywhere.
     Staff only: reconciling touches every client's objects. */
  const authHeader = req.headers.get('Authorization') ?? '';
  const asCaller = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    global: { headers: { Authorization: authHeader } }, auth: { persistSession: false },
  });
  const { data: userData } = await asCaller.auth.getUser();
  if (!userData?.user) return json(401, { error: 'Not authenticated' });
  const { data: profile } = await asCaller
    .from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || !['editor', 'admin', 'super_admin'].includes(profile.role)) {
    return json(403, { error: 'Reconciling is for editor/admin roles' });
  }

  // The work itself runs as the service role: the queue spans clients, and an asset may have been
  // moved out of the caller's own visibility by the very change being reconciled.
  const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { persistSession: false },
  });

  /* Either reconcile the assets the caller names — the portal knows exactly what it just changed,
     so it need not wait behind an unrelated backlog — or take the oldest slice of the queue. */
  const body = await req.json().catch(() => ({})) as { asset_ids?: string[] };
  const queued: { asset_id: string }[] = body.asset_ids?.length
    ? body.asset_ids.slice(0, BATCH).map(id => ({ asset_id: id }))
    : ((await db.from('cdn_move_queue')
        .select('asset_id').order('queued_at', { ascending: true }).limit(BATCH)).data ?? []);
  if (!queued.length) return json(200, { moved: 0, skipped: 0, failed: 0, remaining: 0 });

  const { data: assets } = await db.from('assets')
    .select('id,client_id,stable_id,child_id,perm,status,thumbnail_url,download_url,stream_uid,preview_page_count')
    .in('id', queued.map(q => q.asset_id));

  const accountId = env('CF_ACCOUNT_ID');
  const creds: Record<'public' | 'gated', TempCreds> = {
    public: await tempCredentials(accountId, env('CF_R2_TOKEN'), env('R2_PARENT_ACCESS_KEY_ID'), env('R2_BUCKET')),
    gated: await tempCredentials(accountId, env('CF_R2_TOKEN'), env('R2_PARENT_ACCESS_KEY_ID'), env('R2_GATED_BUCKET')),
  };
  const bucketOf = (t: 'public' | 'gated') => (t === 'public' ? env('R2_BUCKET') : env('R2_GATED_BUCKET'));
  const domainOf = (t: 'public' | 'gated') => (t === 'public' ? env('R2_PUBLIC_DOMAIN') : env('R2_GATED_DOMAIN'));

  let moved = 0, skipped = 0, failed = 0, reflagged = 0;
  const done: string[] = [];

  /* ── Video protection follows the level too ───────────────────────────────────
     A gated video is protected by Stream's `requireSignedURLs`, set per video through Cloudflare's
     API. So the access level is baked into the delivery object here exactly as it is baked into an
     R2 object key, and a `public` -> `client` demotion has to propagate or the video keeps serving
     to anyone holding the uid. Cheaper than the R2 case — one call, no bytes move — and this queue
     already knows precisely which assets changed level.

     Returns false on any failure so the asset stays queued and is retried. Never silently true:
     "we could not tell whether that video is protected" must not be recorded as reconciled. */
  const streamToken = env('CF_STREAM_TOKEN');
  async function reconcileStreamFlag(uid: string, wantSigned: boolean): Promise<boolean> {
    /* Absent token with a video to protect is a failure, not a skip. Making it a hard 503 for the
       whole function instead would stop image re-keying working on any project that has not set
       the secret yet, which is a bigger outage for a smaller problem. */
    if (!streamToken) {
      console.error(`CF_STREAM_TOKEN not set — cannot verify protection of stream video ${uid}`);
      return false;
    }
    const api = `https://api.cloudflare.com/client/v4/accounts/${accountId}/stream/${uid}`;
    const headers = { Authorization: `Bearer ${streamToken}`, 'Content-Type': 'application/json' };

    const current = await fetch(api, { headers });
    if (current.status === 404) {
      // The row points at a video that no longer exists. Not this function's job to repair, but it
      // must not be reported as protected.
      console.error(`stream video ${uid} is gone; row still references it`);
      return false;
    }
    const currentBody = await current.json().catch(() => null);
    if (!current.ok) { console.error(`stream GET ${uid}: ${current.status}`); return false; }
    if (currentBody?.result?.requireSignedURLs === wantSigned) return true;

    const set = await fetch(api, {
      method: 'POST', headers, body: JSON.stringify({ requireSignedURLs: wantSigned }),
    });
    const setBody = await set.json().catch(() => null);
    // Read the flag back rather than trusting the status. A 200 that did not apply the change is
    // exactly the behaviour the creation API has, and it is what makes this whole check necessary.
    if (!set.ok || setBody?.result?.requireSignedURLs !== wantSigned) {
      console.error(`could not set requireSignedURLs=${wantSigned} on ${uid}: ${set.status}`);
      return false;
    }
    reflagged++;
    return true;
  }

  for (const a of assets ?? []) {
    const level = effectiveLevel(a) as AccessLevel;
    const patch: Record<string, string> = {};
    let assetFailed = false;

    for (const column of ['thumbnail_url', 'download_url'] as const) {
      const current = (a as Record<string, string | null>)[column];
      if (!current) continue;

      let key: string;
      try { key = decodeURIComponent(new URL(stripVersion(current)).pathname.replace(/^\/+/, '')); }
      catch { continue; }

      const currentTier = current.startsWith(env('R2_PUBLIC_DOMAIN')) ? 'public' : 'gated';
      /* The key TAIL is preserved and only the level prefix changes. Recomputing it from
         stable_id/child_id looks tidier and is wrong: rows exist whose stored URL disagrees with
         their identity, and recomputing would copy one object onto another object's key. The
         client id is inserted when a legacy key lacks one, because the Worker reads the tenant out
         of that segment. */
      const bare = key.replace(/^(public|guest|client|internal)\//, '');
      const withClient = bare.startsWith(`${a.client_id}/`) ? bare : `${a.client_id}/${bare}`;
      const targetTier = tierFor(level);
      const targetKey = targetTier === 'public' ? bare : `${level}/${withClient}`;

      if (currentTier === targetTier && key === targetKey) { skipped++; continue; }
      if (targetTier === 'gated' && !GATED_KEY_SHAPE.test(targetKey)) {
        failed++; assetFailed = true;
        console.error(`unservable key refused: ${targetKey}`);
        continue;
      }

      const result = await copyObject(
        accountId,
        { creds: creds[currentTier], bucket: bucketOf(currentTier), key },
        { creds: creds[targetTier], bucket: bucketOf(targetTier), key: targetKey },
      );
      if (!result.ok) {
        failed++; assetFailed = true;
        console.error(`${a.id} ${column}: ${result.reason}`);
        continue;
      }
      patch[column] = assetUrl(domainOf(targetTier), targetKey, result.sha256);
      moved++;
    }

    /* Video protection first: it is one cheap API call and it is the security-critical half. Putting
       it after the page work meant a page failure could keep the asset queued forever while its
       video kept serving at the wrong protection — see the note below. */
    if (a.stream_uid && !(await reconcileStreamFlag(a.stream_uid, tierFor(level) !== 'public'))) {
      failed++; assetFailed = true;
    }

    /* ── Per-page document previews ────────────────────────────────────────
       Page objects appear in no URL column — a document publishes one object per rendered page and
       the portal derives each address from the thumbnail — so the column loop above cannot see them.
       Without this, narrowing a deck from `client` to `internal` moves its thumbnail and leaves its
       pages readable under the old `client/` prefix.

       ADDRESSED FROM `preview_page_count`, NOT BY LISTING. An earlier version listed each level
       prefix with a temporary grant that returned 403 for ListObjects. Every asset was marked failed
       and nothing was ever dequeued — so `cdn_move_queue` stopped draining and videos queued behind
       the jam never had `requireSignedURLs` reconciled. Cloudflare's current object-read-write
       temporary credentials do include ListObjects, but per-asset listings are still slower and
       broader than using the row's bounded page count.

       RESIDUE, deliberately accepted: if the page COUNT also shrank (an edited document, or a lowered
       client limit) the objects past the new count at an old level are not addressable from the row,
       and are left for the desktop pipeline's own sweep, which lists all four levels with credentials
       that permit it. That sweep runs on every pipeline run; this one closes the common case — a level
       change with a stable page count — immediately.

       SOURCE IS DELETED HERE, unlike the column path above. A superseded thumbnail is safe to leave
       because its column was repointed, so nothing references the old object. A page has no column to
       repoint: the old object stays at a WIDER level, reachable by anyone holding a cookie for it.
       Orphaned is not unreachable. */
    for (const mv of planPageMoves(level, a.client_id, a.stable_id, a.child_id,
                                   a.preview_page_count ?? 0)) {
      if (mv.targetTier === 'gated' && !GATED_KEY_SHAPE.test(mv.targetKey)) {
        failed++; assetFailed = true;
        console.error(`unservable page key refused: ${mv.targetKey}`);
        continue;
      }

      const result = await copyObject(
        accountId,
        { creds: creds[mv.fromTier], bucket: bucketOf(mv.fromTier), key: mv.sourceKey },
        { creds: creds[mv.targetTier], bucket: bucketOf(mv.targetTier), key: mv.targetKey },
      );
      /* A page that is not at this level is the NORMAL case — only one of the four levels holds it,
         so three misses per page are expected. Counting those as failures is what jammed the queue. */
      if (!result.ok) {
        if (result.reason !== 'source missing') {
          failed++; assetFailed = true;
          console.error(`${a.id} page ${mv.sourceKey}: ${result.reason}`);
        }
        continue;
      }
      moved++;

      const del = await s3(accountId, creds[mv.fromTier], bucketOf(mv.fromTier), 'DELETE', mv.sourceKey);
      if (!del.ok && del.status !== 404) {
        // The copy succeeded so the portal is already correct; the stale WIDER copy surviving is the
        // security problem, so it is worth reporting and retrying.
        failed++; assetFailed = true;
        console.error(`${a.id} page ${mv.sourceKey}: delete of superseded object failed ${del.status}`);
      }
    }

    if (Object.keys(patch).length) {
      const { error } = await db.from('assets').update(patch).eq('id', a.id);
      if (error) { failed++; assetFailed = true; }
    }
    // Thumbnail/original sources stay in place so the move remains reversible by repointing the
    // URLs. The next desktop upload touching this identity now sweeps both namespaces across all
    // four levels (with a live-row shared-key guard), as it already does for pages. Residue for an
    // identity never touched again still needs a separate bucket-wide GC with parent LIST access;
    // the client-scoped temporary R2 grant intentionally cannot perform that global diff.
    if (!assetFailed) done.push(a.id);
  }

  if (done.length) await db.from('cdn_move_queue').delete().in('asset_id', done);
  // A failed asset stays queued, with the reason, so the next call retries it rather than losing it.
  const stuck = (assets ?? []).map(a => a.id).filter(id => !done.includes(id));
  if (stuck.length) {
    await db.from('cdn_move_queue')
      .update({ attempts: 1, last_error: 'see function logs' }).in('asset_id', stuck);
  }

  const { count } = await db.from('cdn_move_queue').select('*', { count: 'exact', head: true });
  return json(200, { moved, skipped, failed, reflagged, remaining: count ?? 0 });
});
