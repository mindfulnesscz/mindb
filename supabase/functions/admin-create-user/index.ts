// Admin-only user provisioning — create auth user with or without invite email,
// then apply role + client access via update_user_access.

import { createClient } from 'npm:@supabase/supabase-js@2';

const ALLOWED_ORIGINS = new Set([
  'https://staging.hub.disruptcollective.com',
  'https://hub.disruptcollective.com',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

interface CreateUserBody {
  email?: string;
  name?: string;
  role?: string;
  client_id?: string;
  member_client_ids?: string[];
  send_invitation?: boolean;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? '';
  let allow = 'https://staging.hub.disruptcollective.com';
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (ALLOWED_ORIGINS.has(origin) || host.endsWith('.vercel.app')) allow = origin;
    } catch { /* ignore */ }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

function json(req: Request, status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(req) },
  });
}

function serviceHeaders(serviceKey: string): Record<string, string> {
  return {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    'Content-Type': 'application/json',
  };
}

async function findUserIdByEmail(
  supabaseUrl: string,
  serviceKey: string,
  email: string,
): Promise<string | null> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?filter=${encodeURIComponent(email)}`,
    { headers: serviceHeaders(serviceKey) },
  );
  if (!res.ok) return null;
  const body = await res.json().catch(() => ({})) as { users?: { id: string; email?: string }[] };
  const match = (body.users ?? []).find(
    u => (u.email ?? '').toLowerCase() === email.toLowerCase(),
  );
  return match?.id ?? null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== 'POST') return json(req, 405, { error: 'POST only' });

  const authHeader = req.headers.get('Authorization') ?? '';
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false },
  });
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(req, 401, { error: 'Not authenticated' });

  const { data: profile } = await userClient
    .from('profiles').select('role').eq('id', userData.user.id).single();
  if (!profile || profile.role !== 'admin') return json(req, 403, { error: 'Admin only' });

  const body = (await req.json().catch(() => ({}))) as CreateUserBody;
  const email = (body.email ?? '').trim().toLowerCase();
  const name = (body.name ?? '').trim();
  const role = (body.role ?? 'public').trim();
  const sendInvitation = Boolean(body.send_invitation);
  const clientId = body.client_id ?? null;
  const memberClientIds = body.member_client_ids ?? [];

  if (!email || !email.includes('@')) {
    return json(req, 400, { error: 'Valid email required' });
  }
  if (!['public', 'member', 'editor', 'admin'].includes(role)) {
    return json(req, 400, { error: 'Invalid role' });
  }
  if (role === 'member' && !clientId) {
    return json(req, 400, { error: 'Member role requires a client' });
  }
  if (role === 'editor' && !clientId && memberClientIds.length === 0) {
    return json(req, 400, { error: 'Editor role requires at least one client' });
  }

  const existingId = await findUserIdByEmail(supabaseUrl, serviceKey, email);
  if (existingId) {
    return json(req, 409, { error: 'A user with this email already exists' });
  }

  const meta = name ? { name } : {};
  let userId: string | null = null;

  if (sendInvitation) {
    const res = await fetch(`${supabaseUrl}/auth/v1/invite`, {
      method: 'POST',
      headers: serviceHeaders(serviceKey),
      body: JSON.stringify({ email, data: meta }),
    });
    const invited = await res.json().catch(() => ({})) as { id?: string; msg?: string; message?: string };
    if (!res.ok) {
      return json(req, res.status === 422 ? 409 : 502, {
        error: invited.msg ?? invited.message ?? 'Invite failed',
      });
    }
    userId = invited.id ?? null;
  } else {
    const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: serviceHeaders(serviceKey),
      body: JSON.stringify({
        email,
        email_confirm: true,
        user_metadata: meta,
      }),
    });
    const created = await res.json().catch(() => ({})) as { id?: string; msg?: string; message?: string };
    if (!res.ok) {
      return json(req, res.status === 422 ? 409 : 502, {
        error: created.msg ?? created.message ?? 'Create user failed',
      });
    }
    userId = created.id ?? null;
  }

  if (!userId) {
    userId = await findUserIdByEmail(supabaseUrl, serviceKey, email);
  }
  if (!userId) {
    return json(req, 500, { error: 'User created but id could not be resolved' });
  }

  const { error: accessErr } = await userClient.rpc('update_user_access', {
    p_user_id: userId,
    p_role: role,
    p_client_id: role === 'member' ? clientId : undefined,
    p_member_client_ids: role === 'editor' && memberClientIds.length ? memberClientIds : undefined,
  });
  if (accessErr) {
    return json(req, 500, { error: accessErr.message });
  }

  return json(req, 200, {
    id: userId,
    email,
    role,
    invited: sendInvitation,
  });
});
