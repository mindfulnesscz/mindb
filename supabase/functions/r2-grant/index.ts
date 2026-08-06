// r2-grant — Control API storage grants (authentication-plan Phase 3).
//
// Bucket + public domain are environment-level secrets (R2_BUCKET, R2_PUBLIC_DOMAIN).
// Each grant is scoped to one client_id. Public keys start `{client_id}/`; gated keys start with
// the effective level and then `{client_id}/`.
//
// Secrets: CF_R2_TOKEN, CF_ACCOUNT_ID, R2_PARENT_ACCESS_KEY_ID,
//           R2_BUCKET, R2_PUBLIC_DOMAIN
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  grantPrefixes,
  temporaryCredentialRequest,
  type GrantPurpose,
} from '../_shared/r2-grant-policy.ts';
import { callerAuthFailureBody } from '../_shared/caller-auth-policy.ts';

const GRANT_TTL_SECONDS = 3600;

interface GrantRequest {
  client_id?: string;
  purpose?: GrantPurpose;
}

// Postgres accepts UUIDs regardless of version/variant (the local seed deliberately uses a
// zero-valued UUID), so validate the shape without rejecting valid database identifiers.
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

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
  if (userErr || !userData.user) return json(401, callerAuthFailureBody(userErr, authHeader));

  const body = (await req.json().catch(() => ({}))) as GrantRequest;
  const { client_id, purpose = 'pipeline' } = body;
  if (!client_id) return json(400, { error: 'client_id required' });
  if (!UUID.test(client_id)) return json(400, { error: 'client_id must be a UUID' });
  if (purpose !== 'pipeline' && purpose !== 'branding') {
    return json(400, { error: 'purpose must be pipeline or branding' });
  }

  const { data: profile } = await supa
    .from('profiles').select('role').eq('id', userData.user.id).single();

  const isAdminOrAbove = !!profile && ['admin', 'super_admin'].includes(profile.role);
  if (purpose === 'branding') {
    if (!isAdminOrAbove) {
      return json(403, { error: 'Branding uploads are admin-only' });
    }
  } else {
    if (!profile || !['editor', 'admin', 'super_admin'].includes(profile.role)) {
      return json(403, { error: 'Storage grants are for editor/admin roles' });
    }
    if (!isAdminOrAbove) {
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

  /* The gated tier. Delivery is two-bucket: `public` objects stay in the bucket above, on the
     public domain; every other level lives in a bucket with no public access at all, reachable
     only through the cdn-gate Worker. The pipeline therefore needs credentials for BOTH, because
     which one an object belongs in is decided per asset, from its effective level.

     Absent is a hard 503 rather than a silent fall back to the public bucket. A desktop that
     quietly published gated content to the public domain because a secret was unset is the exact
     failure this whole tier exists to prevent — and it would look like a successful run. */
  const gatedBucket = Deno.env.get('R2_GATED_BUCKET');
  const gatedDomain = Deno.env.get('R2_GATED_DOMAIN');
  if (purpose === 'pipeline' && (!gatedBucket || !gatedDomain)) {
    return json(503, {
      error: 'Gated storage not provisioned — set R2_GATED_BUCKET and R2_GATED_DOMAIN function '
           + 'secrets. Publishing is refused rather than risk writing gated assets to the public bucket.',
    });
  }

  // CF_R2_TOKEN, with the old CF_API_TOKEN accepted during the rename. See cdn-reconcile.
  const cfToken   = Deno.env.get('CF_R2_TOKEN') ?? Deno.env.get('CF_API_TOKEN');
  const accountId = Deno.env.get('CF_ACCOUNT_ID');
  const parentKey = Deno.env.get('R2_PARENT_ACCESS_KEY_ID');
  if (!cfToken || !accountId || !parentKey) {
    return json(503, { error: 'Storage backend not provisioned — set CF_R2_TOKEN / CF_ACCOUNT_ID / R2_PARENT_ACCESS_KEY_ID' });
  }

  /* Temporary credentials are scoped to ONE bucket, so the two tiers need one grant each. The
     caller receives these credentials, making Cloudflare's prefix restriction the object-layer
     tenant boundary even if the caller ignores the returned keyPrefix. */
  async function tempCredentials(forBucket: string, prefixes: string[]) {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(temporaryCredentialRequest(
          forBucket,
          parentKey,
          prefixes,
          GRANT_TTL_SECONDS,
        )),
      },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.result?.accessKeyId) {
      console.error('Cloudflare temp-credentials failed:', forBucket, res.status, JSON.stringify(body?.errors ?? body));
      return null;
    }
    return body.result as { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  }

  const publicPrefixes = grantPrefixes(client_id, purpose, 'public');
  const publicCreds = await tempCredentials(bucket, publicPrefixes);
  if (!publicCreds) return json(502, { error: 'Could not obtain storage credentials' });

  const gatedCreds = purpose === 'pipeline'
    ? await tempCredentials(gatedBucket!, grantPrefixes(client_id, purpose, 'gated'))
    : null;
  if (purpose === 'pipeline' && !gatedCreds) {
    return json(502, { error: 'Could not obtain gated storage credentials' });
  }

  const keyPrefix = purpose === 'branding'
    ? `branding/${client_id}/`
    : `${client_id}/`;

  return json(200, {
    endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
    bucket,
    publicDomain,
    keyPrefix,
    // The client id, stated rather than left to be parsed back out of keyPrefix. Object keys are
    // built from it directly now, and `branding/{id}/` vs `{id}/` makes that parse a trap.
    clientId:        client_id,
    accessKeyId:     publicCreds.accessKeyId,
    secretAccessKey: publicCreds.secretAccessKey,
    sessionToken:    publicCreds.sessionToken,
    // Absent for a branding grant, which has no gated tier — branding assets are public by nature.
    gatedBucket:     gatedBucket ?? null,
    gatedDomain:     gatedDomain ?? null,
    gatedAccessKeyId:     gatedCreds?.accessKeyId ?? null,
    gatedSecretAccessKey: gatedCreds?.secretAccessKey ?? null,
    gatedSessionToken:    gatedCreds?.sessionToken ?? null,
    expiresAt:       Date.now() + GRANT_TTL_SECONDS * 1000,
  });
});
