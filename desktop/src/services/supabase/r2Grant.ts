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
    let msg = body;
    try { msg = (JSON.parse(body) as { error?: string }).error ?? body; } catch { /* raw */ }
    throw new Error(`Storage grant refused (${res.status}): ${msg}`);
  }
  return await res.json<R2Grant>();
}
