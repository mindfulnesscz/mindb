/* cdn-gate — the byte-level access boundary in front of the gated R2 bucket.
 *
 * Two tiers of delivery, and only one of them involves this Worker:
 *
 *   PUBLIC   dc-hub-bucket, served directly at cdn.disruptcollective.com. Never routed here, so
 *            the public tier stays at exactly today's speed.
 *   GATED    dc-hub-gated, which has NO public access at all. Its only door is this Worker, at
 *            files.disruptcollective.com. Two buckets rather than one bucket with a route
 *            exclusion, so that a broken route or a missing binding 404s instead of publishing
 *            the whole library: the failure mode is closed.
 *
 * Two routes:
 *
 *   POST/DELETE /auth   Sign in / sign out. Resolves the caller's level against Supabase and sets
 *                       the signed cookie. Runs once per session, so it may do I/O.
 *   GET/HEAD /<key>     The hot path. Authorizes from the cookie and the key alone — no database
 *                       call, no KV read, nothing awaited but the R2 body. See ./authz.
 *
 * Performance rules this file exists to honour, each with a real failure mode:
 *   · never `Vary: Cookie` — the bytes are identical for everyone allowed to see them, so ONE
 *     cache entry serves all of them; varying by cookie fragments per-user and silently kills
 *     the hit rate
 *   · never cache an authorization outcome — a cached 403 would later be served to someone who
 *     IS authorized
 *   · stream the body, never buffer — the largest asset in the library is 380 MB
 *   · Smart Placement stays off — it moves a Worker toward its origin, which helps DB-bound
 *     Workers; with no database call this one belongs at the edge nearest the user
 */

import {
  parseGatedKey, authorize, levelForProfile, isStaffRole, parseRangeHeader, resolveContentRange,
} from './authz';
import { COOKIE_NAME, clearCookieHeader, mint, readCookie, setCookieHeader, verify } from './token';

export interface Env {
  /** The gated bucket. Deliberately the ONLY way in — this bucket has no public domain. */
  GATED: R2Bucket;
  /** HS256 secret for the CDN cookie. Shared with nothing else. */
  CDN_COOKIE_SECRET: string;
  /** Supabase project the /auth route validates sessions against. */
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  /** Cookie scope — the registrable domain shared by portal and CDN, e.g. `.disruptcollective.com`. */
  COOKIE_DOMAIN: string;
  /** Comma-separated exact origins allowed to send credentialed requests. `*` is INVALID with
   *  credentials, and gets silently rejected by the browser, so this list is not optional. */
  ALLOWED_ORIGINS: string;
  /** Cookie lifetime. Short enough to matter, long enough that a grid never 403s mid-scroll. */
  TOKEN_TTL_SECONDS?: string;
  /** Bump to retire every cached entry — see the cache key below. Responses are stored
   *  `immutable` for a year, so a deploy that changes response headers needs this. */
  CACHE_EPOCH?: string;
}

const DEFAULT_TTL_SECONDS = 1800; // 30 min
/** A year, paired with the pipeline's `?v=<content-hash>` — which is what makes it safe. */
const IMMUTABLE = 'private, max-age=31536000, immutable';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return preflight(req, env);
    if (url.pathname === '/auth') return handleAuth(req, env);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return refuse(405, 'Method not allowed', req, env);
    }
    return handleObject(req, env, ctx, url);
  },
} satisfies ExportedHandler<Env>;

/* ── /auth — the only route allowed to touch the network ──────────────────── */

/**
 * Exchange a Supabase session for a CDN cookie.
 *
 * Modelled on the r2-grant edge function: same auth chain, and the same explicit 503 when the
 * environment is not provisioned, so "not configured yet" never reads as "you are not allowed".
 *
 * The caller's own access token does the authorizing — this Worker holds no service key, so the
 * worst it can do with a forged request is fail. The token is validated by Supabase
 * (`/auth/v1/user`) rather than by verifying a signature locally, which keeps this working whether
 * the project signs with the legacy shared secret or an asymmetric key.
 *
 * The minted token is NEVER returned in the body — only as Set-Cookie. That is what stops it
 * finding its way into a query string later and fragmenting the cache per user.
 */
async function handleAuth(req: Request, env: Env): Promise<Response> {
  if (req.method === 'DELETE') {
    return json(200, { signed_out: true }, req, env, clearCookieHeader(env.COOKIE_DOMAIN));
  }
  if (req.method !== 'POST') return refuse(405, 'POST or DELETE only', req, env);

  if (!env.CDN_COOKIE_SECRET || !env.COOKIE_DOMAIN) {
    return json(503, { error: 'CDN gate not provisioned — set CDN_COOKIE_SECRET and COOKIE_DOMAIN' }, req, env);
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json(503, { error: 'CDN gate not provisioned — set SUPABASE_URL and SUPABASE_ANON_KEY' }, req, env);
  }

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return json(401, { error: 'Not authenticated' }, req, env);
  }
  const supaHeaders = { Authorization: authHeader, apikey: env.SUPABASE_ANON_KEY };

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, { headers: supaHeaders });
  if (!userRes.ok) return json(401, { error: 'Not authenticated' }, req, env);
  const user = (await userRes.json()) as { id?: string };
  if (!user.id) return json(401, { error: 'Not authenticated' }, req, env);

  // RLS ("profiles: own row") is what scopes this, but the id filter is still explicit: a staff
  // caller can read every profile, and an unfiltered select would hand us an arbitrary one.
  const profRes = await fetch(
    `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${user.id}&select=role,client_id`,
    { headers: supaHeaders },
  );
  if (!profRes.ok) return json(502, { error: 'Could not resolve profile' }, req, env);
  const rows = (await profRes.json()) as Array<{ role: string; client_id: string | null }>;
  const profile = rows[0];
  if (!profile) return json(403, { error: 'No profile for this account' }, req, env);

  const ttl = Number(env.TOKEN_TTL_SECONDS ?? DEFAULT_TTL_SECONDS) || DEFAULT_TTL_SECONDS;
  const lvl = levelForProfile(profile.role, profile.client_id);
  const { token, exp } = await mint(
    { sub: user.id, lvl, cid: profile.client_id, st: isStaffRole(profile.role), ttlSeconds: ttl },
    env.CDN_COOKIE_SECRET,
  );

  // The body carries what the portal needs to schedule its next refresh, and nothing more.
  return json(
    200, { level: lvl, client_id: profile.client_id, expires_at: exp * 1000 },
    req, env, setCookieHeader(token, env.COOKIE_DOMAIN, ttl),
  );
}

/* ── the hot path ─────────────────────────────────────────────────────────── */

async function handleObject(req: Request, env: Env, ctx: ExecutionContext, url: URL): Promise<Response> {
  const target = parseGatedKey(url.pathname);
  // A path whose level cannot be determined is not a public one. 404, not 403: there is nothing
  // here to admit the existence of.
  if (!target) return refuse(404, 'Not found', req, env);
  if (!env.GATED) return json(503, { error: 'CDN gate not provisioned — bind the gated R2 bucket' }, req, env);

  const claims = await verify(readCookie(req.headers.get('Cookie'), COOKIE_NAME), env.CDN_COOKIE_SECRET);
  if (!authorize(target, claims)) return refuse(403, 'Forbidden', req, env);

  const range = req.headers.get('Range');
  const ifNoneMatch = req.headers.get('If-None-Match');

  /* The cache key KEEPS the query string, and that is load-bearing rather than incidental.
     The pipeline writes one object per logical asset under a version-stable key, so a version
     bump OVERWRITES the same key and relies on its `?v=<content-hash>` stamp to bust caches
     (see r2Cache.ts and the note in runCdnUpload). Stripping the query would make this cache
     content-blind: with `max-age=31536000, immutable` it would then serve the superseded bytes
     for up to a year. Since every portal URL for a given version carries the SAME stamp, keeping
     it costs no fragmentation — it just makes the entry content-addressed.

     CACHE_EPOCH covers the other kind of staleness: a change to the RESPONSE SHAPE rather than
     the bytes. Immutable year-long entries survive a deploy, so a Worker that starts emitting
     different headers keeps serving the old ones. Bumping the epoch retires every entry without
     needing a dashboard purge or a cache-purge API token. Bump it when response headers change.

     No cookie in the key and no Vary: authorization already happened above, and the bytes are
     identical for everyone it let through, so ONE entry serves all of them. */
  const epoch = env.CACHE_EPOCH ?? '1';
  const cacheKey = new Request(`${url.origin}/_c${epoch}${url.pathname}${url.search}`, { method: 'GET' });
  const cache = caches.default;

  // Ranged requests skip the cache entirely: a 206 is a partial representation, and storing one
  // under the full object's key would serve a truncated body to the next reader.
  if (!range && req.method === 'GET') {
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (ifNoneMatch && hit.headers.get('ETag') === ifNoneMatch) {
        return notModified(hit, req, env);
      }
      return deliver(hit, req, env, 'hit');
    }
  }

  if (req.method === 'HEAD') {
    const head = await env.GATED.head(target.key);
    if (!head) return refuse(404, 'Not found', req, env);
    const headers = baseHeaders(req, env);
    head.writeHttpMetadata(headers);
    headers.set('ETag', head.httpEtag);
    headers.set('Content-Length', String(head.size));
    headers.set('Cache-Control', IMMUTABLE);
    return new Response(null, { status: 200, headers });
  }

  // Parsed here, not delegated to the binding, so the SAME numbers drive the fetch and the
  // Content-Range header. See parseRangeHeader on why that matters. Null means "whole object",
  // which is also how an unparseable or multi-range header is handled.
  const rangeSpec = parseRangeHeader(range);

  const options: R2GetOptions = {};
  if (rangeSpec) options.range = rangeSpec;
  if (ifNoneMatch) options.onlyIf = { etagDoesNotMatch: ifNoneMatch };

  let object: R2ObjectBody | R2Object | null;
  try {
    object = await env.GATED.get(target.key, options);
  } catch {
    // The binding throws on an unsatisfiable range rather than returning one.
    return refuse(416, 'Range not satisfiable', req, env);
  }
  if (!object) return refuse(404, 'Not found', req, env);

  // No `body` means the `onlyIf` precondition failed — the caller already has this exact object.
  if (!('body' in object)) {
    const headers = baseHeaders(req, env);
    headers.set('ETag', object.httpEtag);
    headers.set('Cache-Control', IMMUTABLE);
    return new Response(null, { status: 304, headers });
  }

  const headers = baseHeaders(req, env);
  object.writeHttpMetadata(headers);
  headers.set('ETag', object.httpEtag);
  headers.set('Accept-Ranges', 'bytes');

  if (rangeSpec) {
    const { start, length } = resolveContentRange(rangeSpec, object.size);
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`);
    headers.set('Content-Length', String(length));
    headers.set('Cache-Control', IMMUTABLE);
    // Streamed straight through: the largest asset is 380 MB and buffering it would exhaust the
    // isolate long before it finished. This is also what makes video seeking work.
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('Content-Length', String(object.size));

  /* Stored with PUBLIC cache-control and served with PRIVATE.
     Not a contradiction, and not a leak. This edge cache sits BEHIND the authorization check
     above, so an entry in it is reachable only by a request that already passed; `private` on the
     stored copy is what makes Cloudflare refuse to store it at all, which would silently reduce
     every grid view to an R2 round-trip. The response the browser sees carries `private`, keeping
     shared proxies out of it. */
  const cacheable = new Response(object.body, { status: 200, headers: new Headers(headers) });
  cacheable.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  ctx.waitUntil(cache.put(cacheKey, cacheable.clone()));

  return deliver(cacheable, req, env, 'miss');
}

/* ── responses ────────────────────────────────────────────────────────────── */

/** Re-stamp a cached or freshly-built response for delivery: browser-facing cache policy, CORS for
 *  this particular origin, and nothing that would make the cached entry per-user. */
function deliver(res: Response, req: Request, env: Env, state: 'hit' | 'miss'): Response {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', IMMUTABLE);
  headers.set('X-Cdn-Gate', state);
  applyCors(headers, req, env);
  return new Response(res.body, { status: res.status, headers });
}

function notModified(res: Response, req: Request, env: Env): Response {
  const headers = baseHeaders(req, env);
  const etag = res.headers.get('ETag');
  if (etag) headers.set('ETag', etag);
  headers.set('Cache-Control', IMMUTABLE);
  return new Response(null, { status: 304, headers });
}

function baseHeaders(req: Request, env: Env): Headers {
  const headers = new Headers();
  applyCors(headers, req, env);
  return headers;
}

/**
 * `Access-Control-Allow-Origin: *` is INVALID alongside credentials — the browser drops the
 * response with a console message and no server-side signal, which is exactly the kind of failure
 * that gets misdiagnosed for a day. So: an exact echo from an allowlist, or no CORS headers at all.
 *
 * These are applied per response rather than stored in the cache entry, so the cached bytes stay
 * origin-agnostic and one entry keeps serving every allowed origin.
 */
function applyCors(headers: Headers, req: Request, env: Env): void {
  const origin = req.headers.get('Origin');
  if (!origin) return;
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return;
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Allow-Credentials', 'true');
  headers.set('Vary', 'Origin');
}

function preflight(req: Request, env: Env): Response {
  const headers = baseHeaders(req, env);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Range, If-None-Match');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/** A refusal, and never a cached one: a 403 stored under an object's URL would later be served to
 *  a caller who IS authorized. */
function refuse(status: number, message: string, req: Request, env: Env): Response {
  const headers = baseHeaders(req, env);
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Type', 'text/plain; charset=utf-8');
  return new Response(`${message}\n`, { status, headers });
}

function json(
  status: number, body: Record<string, unknown>, req: Request, env: Env, setCookie?: string,
): Response {
  const headers = baseHeaders(req, env);
  headers.set('Content-Type', 'application/json');
  headers.set('Cache-Control', 'no-store');
  if (setCookie) headers.append('Set-Cookie', setCookie);
  return new Response(JSON.stringify(body), { status, headers });
}
