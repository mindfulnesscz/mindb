// Server-side branding logo upload — admin-only, writes to R2 under branding/{client_id}/.
// Uses the same Cloudflare temp-credentials flow as r2-grant (no extra upload keys).

import { createClient } from 'npm:@supabase/supabase-js@2';
import { AwsClient } from 'npm:aws4fetch';

const GRANT_TTL_SECONDS = 3600;

interface UploadBody {
  client_id?: string;
  filename?: string;
  content_type?: string;
  data_base64?: string;
}

function json(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function obtainTempCredentials(bucket: string): Promise<{
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
} | null> {
  const cfToken   = Deno.env.get('CF_API_TOKEN');
  const accountId = Deno.env.get('CF_ACCOUNT_ID');
  const parentKey   = Deno.env.get('R2_PARENT_ACCESS_KEY_ID');
  if (!cfToken || !accountId || !parentKey) return null;

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
    return null;
  }

  return {
    endpoint:        `https://${accountId}.r2.cloudflarestorage.com`,
    accessKeyId:     cfBody.result.accessKeyId,
    secretAccessKey: cfBody.result.secretAccessKey,
    sessionToken:    cfBody.result.sessionToken,
  };
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

  const { data: profile } = await supa
    .from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || profile.role !== 'admin') return json(403, { error: 'Admin only' });

  const body = (await req.json().catch(() => ({}))) as UploadBody;
  const { client_id, filename, content_type, data_base64 } = body;
  if (!client_id || !filename || !data_base64) {
    return json(400, { error: 'client_id, filename, and data_base64 required' });
  }

  const bucket       = Deno.env.get('R2_BUCKET');
  const publicDomain = Deno.env.get('R2_PUBLIC_DOMAIN');
  if (!bucket || !publicDomain) {
    return json(503, {
      error: 'Branding upload not provisioned — set R2_BUCKET and R2_PUBLIC_DOMAIN function secrets',
    });
  }

  const creds = await obtainTempCredentials(bucket);
  if (!creds) {
    return json(503, {
      error: 'Storage backend not provisioned — set CF_API_TOKEN, CF_ACCOUNT_ID, and R2_PARENT_ACCESS_KEY_ID',
    });
  }

  const ext = filename.split('.').pop()?.toLowerCase() ?? 'png';
  const objectKey = `branding/${client_id}/logo.${ext}`;
  const bytes = Uint8Array.from(atob(data_base64), c => c.charCodeAt(0));

  const aws = new AwsClient({
    accessKeyId:     creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken:    creds.sessionToken,
    service: 's3',
    region:  'auto',
  });
  const putRes = await aws.fetch(`${creds.endpoint}/${bucket}/${objectKey}`, {
    method: 'PUT',
    headers: { 'Content-Type': content_type ?? `image/${ext}` },
    body: bytes,
  });
  if (!putRes.ok) {
    const err = await putRes.text();
    console.error('R2 branding upload failed:', putRes.status, err);
    return json(502, { error: 'Upload failed' });
  }

  const logoUrl = `${publicDomain.replace(/\/+$/, '')}/${objectKey}`;
  const { error: updErr } = await supa.from('clients').update({ logo_url: logoUrl }).eq('id', client_id);
  if (updErr) return json(500, { error: updErr.message });

  return json(200, { logo_url: logoUrl, object_key: objectKey });
});
