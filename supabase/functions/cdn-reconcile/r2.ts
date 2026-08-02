/* R2 over the S3 API, signed with short-lived credentials.
 *
 * The same mechanism r2-grant uses: the Cloudflare API mints a temporary, bucket-scoped key pair
 * from the parent key, so nothing long-lived is held here.
 *
 * Deliberately Web Crypto rather than a Node shim — this runs on Deno, and the async HMAC is the
 * only real difference from the copy in scripts/rekey-gated-objects.mjs.
 */

const enc = new TextEncoder();

export interface TempCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export async function tempCredentials(
  accountId: string, apiToken: string, parentKey: string, bucket: string,
): Promise<TempCreds> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket, parentAccessKeyId: parentKey, permission: 'object-read-write', ttlSeconds: 3600,
      }),
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok || !body?.result?.accessKeyId) {
    throw new Error(`temp credentials for ${bucket}: ${res.status}`);
  }
  return body.result as TempCreds;
}

async function sha256hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: Uint8Array, msg: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}

/* SigV4 canonicalises paths per RFC 3986, whose unreserved set is only A–Z a–z 0–9 - _ . ~ .
   `encodeURIComponent` leaves !'()* alone, and legacy filename-keyed objects are full of
   parentheses — that mismatch cost 17 objects an opaque 403 during the production re-key. */
const rfc3986 = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export async function s3(
  accountId: string, creds: TempCreds, bucket: string, method: string, key: string,
  body?: Uint8Array, extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const payloadHash = await sha256hex(body ?? new Uint8Array());
  const canonicalUri = `/${bucket}/${key.split('/').map(rfc3986).join('/')}`;

  // Signed inside the attempt loop: a signature carries the moment it was made, and R2 refuses one
  // more than a few minutes adrift with RequestTimeTooSkewed — which arrives as a 403 and reads
  // exactly like a credentials fault.
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      'x-amz-security-token': creds.sessionToken,
      ...Object.fromEntries(Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v])),
    };
    const names = Object.keys(headers).sort();
    const canonicalHeaders = names.map(h => `${h}:${String(headers[h]).trim()}\n`).join('');
    const signedHeaders = names.join(';');
    const canonical = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(enc.encode(canonical))].join('\n');

    let k = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
    for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
    const signature = [...(await hmac(k, toSign))].map(b => b.toString(16).padStart(2, '0')).join('');

    headers.Authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      return await fetch(`https://${host}${canonicalUri}`, {
        method, headers, body: body as BodyInit | undefined,
      });
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  throw lastErr;
}

/** Copy one object between buckets, carrying the metadata the pipeline recognises. */
export async function copyObject(
  accountId: string,
  from: { creds: TempCreds; bucket: string; key: string },
  to: { creds: TempCreds; bucket: string; key: string },
): Promise<{ ok: true; sha256: string } | { ok: false; reason: string }> {
  const got = await s3(accountId, from.creds, from.bucket, 'GET', from.key);
  if (got.status === 404) return { ok: false, reason: 'source missing' };
  if (!got.ok) return { ok: false, reason: `GET ${got.status}` };

  const body = new Uint8Array(await got.arrayBuffer());
  const hash = await sha256hex(body);

  /* x-amz-meta-sha256 is how the desktop pipeline recognises an object it has already published;
     without it every moved file looks new and the next run re-uploads the whole library. */
  const put = await s3(accountId, to.creds, to.bucket, 'PUT', to.key, body, {
    'content-type': got.headers.get('content-type') ?? 'application/octet-stream',
    'x-amz-meta-sha256': hash,
    'cache-control': 'private, max-age=31536000, immutable',
  });
  if (!put.ok) return { ok: false, reason: `PUT ${put.status}` };
  return { ok: true, sha256: hash };
}
