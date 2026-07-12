// r2-grant — the Control API's first endpoint (authentication-plan Phase 3).
//
// The desktop holds NO permanent storage credentials. Per pipeline run it
// POSTs { client_id } here with the user's session JWT; this function:
//   1. authenticates the caller (Supabase JWT),
//   2. authorizes: role editor/admin, and client_members assignment
//      (admins operate on any client),
//   3. reads the client's bucket + public domain from the database
//      (server-authoritative — the desktop cannot mismatch them),
//   4. asks Cloudflare for short-lived scoped credentials for that bucket,
//   5. returns the complete storage grant.
//
// Secrets (set per environment via `supabase secrets set`, never in code):
//   CF_API_TOKEN             Cloudflare API token with R2 edit permission
//   CF_ACCOUNT_ID            Cloudflare account id
//   R2_PARENT_ACCESS_KEY_ID  R2 access key whose scope bounds the temp creds
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRANT_TTL_SECONDS = 3600; // one publish run; the desktop requests per run

interface GrantRequest { client_id?: string }

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  // 1. Authenticate — the caller's JWT rides along on every query below,
  //    so RLS applies exactly as it would to the user directly.
  const authHeader = req.headers.get('Authorization') ?? '';
  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await supa.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'Not authenticated' });

  const { client_id } = (await req.json().catch(() => ({}))) as GrantRequest;
  if (!client_id) return json(400, { error: 'client_id required' });

  // 2. Authorize — desktop roles only, and membership unless admin.
  const { data: profile } = await supa
    .from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || !['editor', 'admin'].includes(profile.role)) {
    return json(403, { error: 'Storage grants are for editor/admin roles' });
  }
  if (profile.role !== 'admin') {
    const { data: membership } = await supa
      .from('client_members').select('client_id')
      .eq('user_id', userData.user.id).eq('client_id', client_id).maybeSingle();
    if (!membership) return json(403, { error: 'Not assigned to this client' });
  }

  // 3. Server-authoritative storage config.
  const { data: client } = await supa
    .from('clients').select('r2_bucket,r2_public_domain').eq('id', client_id).single();
  if (!client?.r2_bucket || !client?.r2_public_domain) {
    return json(400, { error: 'This client has no storage configured (r2_bucket / r2_public_domain)' });
  }

  // 4. Short-lived scoped credentials from Cloudflare.
  const cfToken    = Deno.env.get('CF_API_TOKEN');
  const accountId  = Deno.env.get('CF_ACCOUNT_ID');
  const parentKey  = Deno.env.get('R2_PARENT_ACCESS_KEY_ID');
  if (!cfToken || !accountId || !parentKey) {
    return json(503, { error: 'Storage backend not provisioned — set CF_API_TOKEN / CF_ACCOUNT_ID / R2_PARENT_ACCESS_KEY_ID function secrets' });
  }

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket: client.r2_bucket,
        parentAccessKeyId: parentKey,
        permission: 'object-read-write',
        ttlSeconds: GRANT_TTL_SECONDS,
      }),
    },
  );
  const cfBody = await cfRes.json().catch(() => null);
  if (!cfRes.ok || !cfBody?.result?.accessKeyId) {
    console.error('Cloudflare temp-credentials failed:', cfRes.status, JSON.stringify(cfBody?.errors ?? cfBody));
    return json(502, { error: 'Could not obtain storage credentials' });
  }

  // 5. The grant.
  return json(200, {
    endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
    bucket:          client.r2_bucket,
    publicDomain:    client.r2_public_domain,
    accessKeyId:     cfBody.result.accessKeyId,
    secretAccessKey: cfBody.result.secretAccessKey,
    sessionToken:    cfBody.result.sessionToken,
    expiresAt:       Date.now() + GRANT_TTL_SECONDS * 1000,
  });
});
