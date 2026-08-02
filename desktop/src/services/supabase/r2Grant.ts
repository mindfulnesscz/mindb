import type { SupabaseConfig } from './rest';
import { makeHeaders, sbFetch } from './rest';
import { edgeFunctionError } from './edgeErrors';

export interface R2Grant {
  endpoint:        string;
  bucket:          string;
  publicDomain:    string;
  keyPrefix:       string;
  clientId:        string;
  accessKeyId:     string;
  secretAccessKey: string;
  sessionToken:    string;
  /* The gated tier: a bucket with no public access, reachable only through the cdn-gate Worker.
     Null only for a branding grant, which has no gated tier. For a pipeline grant the function
     refuses with 503 rather than returning null, because a desktop that quietly published gated
     assets to the public bucket would look like a successful run. */
  gatedBucket:          string | null;
  gatedDomain:          string | null;
  gatedAccessKeyId:     string | null;
  gatedSecretAccessKey: string | null;
  gatedSessionToken:    string | null;
  expiresAt:       number;
}

export async function requestR2Grant(config: SupabaseConfig, clientId: string): Promise<R2Grant> {
  const res = await sbFetch(`${config.url}/functions/v1/r2-grant`, {
    method:  'POST',
    headers: await makeHeaders(config.anonKey),
    body:    JSON.stringify({ client_id: clientId }),
  });
  // Naming WHY it failed matters — a gateway error otherwise reads like a storage-provisioning
  // problem, and a not-yet-deployed function reads like a dead runtime. See ./edgeErrors.
  if (!res.ok) throw edgeFunctionError('r2-grant', res.status, await res.text());
  return await res.json<R2Grant>();
}
