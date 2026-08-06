/* R2 over the S3 API, signed with short-lived credentials.
 *
 * The same temporary-credential API r2-grant uses. These credentials remain inside authenticated
 * edge functions that reconcile across tenants, so they are bucket-scoped; the caller-facing
 * r2-grant credentials are separately narrowed to one tenant's object-key prefixes.
 *
 * Deliberately Web Crypto rather than a Node shim — this runs on Deno, and the async HMAC is the
 * only real difference from the copy in scripts/rekey-gated-objects.mjs.
 *
 * In `_shared/` because two functions now sign R2 requests: cdn-reconcile moves objects between
 * tiers, and stream-upload presigns a read so Cloudflare Stream can pull a master out of the gated
 * bucket. SigV4 is unpleasant enough to get right once; a second copy would be a second place for
 * the RFC 3986 bug below to be reintroduced.
 */

const enc = new TextEncoder();

export interface TempCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export type TempCredentialPermission = 'object-read-only' | 'object-read-write';

export async function tempCredentials(
  accountId: string, apiToken: string, parentKey: string, bucket: string,
  permission: TempCredentialPermission = 'object-read-write',
): Promise<TempCreds> {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/temp-access-credentials`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket, parentAccessKeyId: parentKey, permission, ttlSeconds: 3600,
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
  query: Record<string, string> = {},
): Promise<Response> {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const payloadHash = await sha256hex(body ?? new Uint8Array());
  const canonicalUri = `/${bucket}/${key.split('/').map(rfc3986).join('/')}`;
  /* SigV4 wants the query sorted by key and rfc3986-encoded. An empty query yields '', which is
     byte-identical to what every existing caller signed before this parameter was added. */
  const canonicalQuery = Object.keys(query).sort()
    .map(k => `${rfc3986(k)}=${rfc3986(query[k])}`).join('&');

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
    const canonical = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/auto/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(enc.encode(canonical))].join('\n');

    let k = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
    for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
    const signature = [...(await hmac(k, toSign))].map(b => b.toString(16).padStart(2, '0')).join('');

    headers.Authorization =
      `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    try {
      const url = `https://${host}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`;
      const response = await fetch(url, { method, headers, body: body as BodyInit | undefined });
      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        // Consume the body before retrying so the connection can be reused. Retry-After is advisory
        // and bounded: an edge request must not disappear into an unbounded provider backoff.
        await response.arrayBuffer().catch(() => undefined);
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfter = retryAfterHeader == null ? Number.NaN : Number(retryAfterHeader);
        const delay = Number.isFinite(retryAfter)
          ? Math.min(10_000, Math.max(500, retryAfter * 1000))
          : attempt * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return response;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1000));
    }
  }
  throw lastErr;
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    // Ampersand is last so a literal key containing the text "&lt;" is decoded once, not twice.
    .replace(/&amp;/g, '&');
}

export interface ListedR2Object {
  key: string;
  size: number;
  lastModified: string | null;
}

/** Complete ListObjectsV2 inventory, including the metadata needed by a GC review. */
export async function listObjects(
  accountId: string, creds: TempCreds, bucket: string, prefix = '',
): Promise<ListedR2Object[]> {
  const out: ListedR2Object[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = {
      'list-type': '2', prefix, 'max-keys': '1000', ...(token ? { 'continuation-token': token } : {}),
    };
    const res = await s3(accountId, creds, bucket, 'GET', '', undefined, {}, query);
    if (!res.ok) throw new Error(`list ${bucket}/${prefix} → ${res.status}`);
    const xml = await res.text();
    const page: ListedR2Object[] = [];
    for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const item = match[1];
      const key = item.match(/<Key>([\s\S]*?)<\/Key>/)?.[1];
      const size = Number(item.match(/<Size>(\d+)<\/Size>/)?.[1]);
      if (key == null || !Number.isSafeInteger(size) || size < 0) {
        throw new Error(`list ${bucket}/${prefix} returned an unsafe object record`);
      }
      const lastModified = item.match(/<LastModified>([^<]+)<\/LastModified>/)?.[1] ?? null;
      page.push({ key: decodeXml(key), size, lastModified });
    }
    const keyCount = Number(xml.match(/<KeyCount>(\d+)<\/KeyCount>/)?.[1] ?? page.length);
    if (keyCount !== page.length) {
      throw new Error(`list ${bucket}/${prefix} returned KeyCount=${keyCount} but parsed ${page.length}`);
    }
    out.push(...page);
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1]
      : undefined;
    if (/<IsTruncated>true<\/IsTruncated>/.test(xml) && !token) {
      throw new Error(`list ${bucket}/${prefix} was truncated without a continuation token`);
    }
    if (token) token = decodeXml(token);
  } while (token);
  return out;
}

/* A presigned GET: the signature travels in the query string instead of a header, so the URL is
   self-contained and can be handed to something that knows nothing about us.
 *
 * This exists for exactly one caller — Cloudflare Stream pulling a master out of the GATED bucket.
 * Stream cannot fetch through the cdn-gate Worker, which refuses anonymous requests by design, and
 * the alternative is downloading the whole video into an edge function and posting it back up.
 *
 * IT MUST ANSWER A RANGE GET. `POST /stream/copy` needs the object's total size before it starts;
 * it tries HEAD and a range GET, and needs only one of them to answer. That distinction matters
 * here, because R2 binds a presigned URL to the method it was signed for — a GET-presigned URL
 * returns 403 to HEAD (measured on staging, both directions). The range GET carries the total in
 * `Content-Range: bytes 0-9/359046`, which is enough, and Stream was confirmed to accept a
 * GET-only presigned source. A source that answers NEITHER fails with "could not determine the
 * size of the file", which says nothing about the real cause — hence this note.
 *
 * SERVER TO SERVER, NEVER SHOWN TO A USER. This is the one place in the product where an expiring
 * URL is the right answer: it grants read on a gated object to whoever holds it, which is precisely
 * what Part A exists to prevent for anything user-facing.
 */
export async function presignGet(
  accountId: string, creds: TempCreds, bucket: string, key: string, expiresIn: number,
): Promise<string> {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${bucket}/${key.split('/').map(rfc3986).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/auto/s3/aws4_request`;

  /* The session token is signed as a query parameter, not sent as a header. Omitting it produces a
     URL that authenticates and then fails authorization, because temporary credentials mean
     nothing without it. */
  const params: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${creds.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
    'X-Amz-Security-Token': creds.sessionToken,
  };
  const canonicalQuery = Object.keys(params).sort()
    .map(k => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');

  /* UNSIGNED-PAYLOAD, because a presigned GET has no body to hash and the signer cannot know what
     the eventual request will look like. This is the documented literal, not a placeholder. */
  const canonical = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256hex(enc.encode(canonical))].join('\n');

  let k = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), dateStamp);
  for (const part of ['auto', 's3', 'aws4_request']) k = await hmac(k, part);
  const signature = [...(await hmac(k, toSign))].map(b => b.toString(16).padStart(2, '0')).join('');

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/**
 * Every key under `prefix`, following continuation tokens.
 *
 * Needed because per-page document previews have no URL column — one object per page — so the only
 * way to find them is to list. Paginated rather than trusting one response: R2 caps a listing at
 * 1000 keys, and a truncated listing would silently leave page objects behind at their old access
 * level, which is the leak the caller is trying to close.
 */
export async function listKeys(
  accountId: string, creds: TempCreds, bucket: string, prefix: string,
): Promise<string[]> {
  return (await listObjects(accountId, creds, bucket, prefix)).map(object => object.key);
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
