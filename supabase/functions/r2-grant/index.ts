// r2-grant — Control API storage grants (authentication-plan Phase 3).
//
// Bucket + public domain are environment-level secrets (R2_BUCKET, R2_PUBLIC_DOMAIN).
// Each grant is scoped to one client_id; object keys use prefix `{client_id}/`.
//
// Secrets: CF_API_TOKEN, CF_ACCOUNT_ID, R2_PARENT_ACCESS_KEY_ID,
//           R2_BUCKET, R2_PUBLIC_DOMAIN
import { createClient } from 'npm:@supabase/supabase-js@2';

const GRANT_TTL_SECONDS = 3600;

interface GrantRequest {
  client_id?: string;
  purpose?: 'pipeline' | 'branding';
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'POST only' });

  const authHeader = req.headers.get('Authorization') ?? '';
  const supa = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } },
  );
  const { data: userData, error: userErr } = await supa.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: 'Not authenticated' });

  const body = (await req.json().catch(() => ({}))) as GrantRequest;
  const { client_id, purpose = 'pipeline' } = body;
  if (!client_id) return json(400, { error: 'client_id required' });

  const { data: profile } = await supa
    .from('profiles').select('role').eq('id', userData.user.id).single();

  if (purpose === 'branding') {
    if (!profile || profile.role !== 'admin') {
      return json(403, { error: 'Branding uploads are admin-only' });
    }
  } else {
    if (!profile || !['editor', 'admin'].includes(profile.role)) {
      return json(403, { error: 'Storage grants are for editor/admin roles' });
    }
    if (profile.role !== 'admin') {
      const { data: membership } = await supa
        .from('client_members').select('client_id')
        .eq('user_id', userData.user.id).eq('client_id', client_id).maybeSingle();
      if (!membership) return json(403, { error: 'Not assigned to this client' });
    }
  }

  const bucket       = Deno.env.get('R2_BUCKET');
  const publicDomain = Deno.env.get('R2_PUBLIC_DOMAIN');
  if (!bucket || !publicDomain) {
    return json(503, { error: 'Storage not provisioned — set R2_BUCKET and R2_PUBLIC_DOMAIN function secrets' });
  }

  const cfToken   = Deno.env.get('CF_API_TOKEN');
  const accountId = Deno.env.get('CF_ACCOUNT_ID');
  const parentKey = Deno.env.get('R2_PARENT_ACCESS_KEY_ID');
  if (!cfToken || !accountId || !parentKey) {
    return json(503, { error: 'Storage backend not provisioned — set CF_API_TOKEN / CF_ACCOUNT_ID / R2_PARENT_ACCESS_KEY_ID' });
  }

  const cfRes = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket,
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

  const keyPrefix = purpose === 'branding'
    ? `branding/${client_id}/`
    : `${client_id}/`;

  return json(200, {
    endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    publicDomain,
    keyPrefix,
    accessKeyId:     cfBody.result.accessKeyId,
    secretAccessKey: cfBody.result.secretAccessKey,
    sessionToken:    cfBody.result.sessionToken,
    expiresAt:       Date.now() + GRANT_TTL_SECONDS * 1000,
  });
});
