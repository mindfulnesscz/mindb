import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';

export interface R2Grant {
  endpoint:        string;
  bucket:          string;
  publicDomain:    string;
  keyPrefix:       string;
  accessKeyId:     string;
  secretAccessKey: string;
  sessionToken:    string;
  expiresAt:       number;
}

export async function requestR2Grant(config: SupabaseConfig, clientId: string): Promise<R2Grant> {
  const res = await sbFetch(`${config.url}/functions/v1/r2-grant`, {
    method:  'POST',
    headers: makeHeaders(config.anonKey),
    body:    JSON.stringify({ client_id: clientId }),
  });
  if (!res.ok) {
    const body = await res.text();
    // The function reports its own refusals in `error`; the API gateway reports
    // upstream trouble in `message` (e.g. "name resolution failed" when the edge
    // runtime container isn't up). Naming the difference matters — a gateway error
    // reads like a storage-provisioning problem otherwise.
    let msg = body, gateway = false;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      if (parsed.error) msg = parsed.error;
      else if (parsed.message) { msg = parsed.message; gateway = true; }
    } catch { /* raw body */ }
    if (gateway || res.status === 502 || res.status === 504) {
      throw new Error(
        `Storage grant unreachable (${res.status}): ${msg} — the r2-grant function did not respond. `
        + `Locally, check the edge runtime is running (\`docker start supabase_edge_runtime_<project>\`).`,
      );
    }
    throw new Error(`Storage grant refused (${res.status}): ${msg}`);
  }
  return await res.json<R2Grant>();
}
