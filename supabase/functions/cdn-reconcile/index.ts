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
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  effectiveLevel, tierFor, assetUrl, stripVersion, type AccessLevel,
} from '../../../packages/domain/src/assetStorage.ts';
import { tempCredentials, copyObject, type TempCreds } from './r2.ts';

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
    .select('id,client_id,stable_id,child_id,perm,status,thumbnail_url,download_url')
    .in('id', queued.map(q => q.asset_id));

  const accountId = env('CF_ACCOUNT_ID');
  const creds: Record<'public' | 'gated', TempCreds> = {
    public: await tempCredentials(accountId, env('CF_R2_TOKEN'), env('R2_PARENT_ACCESS_KEY_ID'), env('R2_BUCKET')),
    gated: await tempCredentials(accountId, env('CF_R2_TOKEN'), env('R2_PARENT_ACCESS_KEY_ID'), env('R2_GATED_BUCKET')),
  };
  const bucketOf = (t: 'public' | 'gated') => (t === 'public' ? env('R2_BUCKET') : env('R2_GATED_BUCKET'));
  const domainOf = (t: 'public' | 'gated') => (t === 'public' ? env('R2_PUBLIC_DOMAIN') : env('R2_GATED_DOMAIN'));

  let moved = 0, skipped = 0, failed = 0;
  const done: string[] = [];

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

    if (Object.keys(patch).length) {
      const { error } = await db.from('assets').update(patch).eq('id', a.id);
      if (error) { failed++; assetFailed = true; }
    }
    // Source objects are left in place, exactly as the re-key script does: until they are removed
    // separately, the whole move is undone by repointing the URLs back.
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
  return json(200, { moved, skipped, failed, remaining: count ?? 0 });
});
