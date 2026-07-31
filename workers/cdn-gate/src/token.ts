/* The CDN cookie: a compact HS256 JWT, minted on sign-in and verified on every object request.
 *
 * Two decisions worth not re-litigating:
 *
 * COOKIE, NEVER A QUERY STRING. A per-user token in the URL gives every user a distinct cache
 * key, fragmenting the edge cache to near-zero hit rate and defeating the `?v=<hash>` immutable
 * caching the pipeline already relies on. One cookie means identical URLs for everyone and one
 * cached copy shared by every authorized viewer. This module therefore never returns a token to
 * a caller — `mint` is consumed only by the Set-Cookie path.
 *
 * PERMANENT URLS, EXPIRING SESSIONS. The link never expires; the cookie does. A leaked URL keeps
 * working and simply returns 403 to anyone not signed in, which is why presigned URLs were
 * rejected: they make every stored `thumbnail_url` a ticking clock.
 */

import type { CdnClaims, Level } from './authz';

/* ── base64url ─────────────────────────────────────────────────────────────── */

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/* ── the signing key ──────────────────────────────────────────────────────────
 * Imported ONCE per isolate and reused. `crypto.subtle.importKey` per request is pure waste, and
 * at 50+ verifications per grid view it is measurable waste.
 *
 * The brief says "hoist to module scope", which cannot be taken literally under Wrangler: the
 * secret arrives in `env`, inside the request handler, so there is nothing to hoist at load time.
 * A module-scope cache populated on the first request achieves exactly the same thing — isolates
 * live across many requests, so the import happens once per isolate, not once per fetch. Keyed by
 * the secret so a rotated binding is picked up rather than silently ignored. */
let cached: { secret: string; key: Promise<CryptoKey> } | null = null;

export function hmacKey(secret: string): Promise<CryptoKey> {
  if (cached === null || cached.secret !== secret) {
    cached = {
      secret,
      key: crypto.subtle.importKey(
        'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'],
      ),
    };
  }
  return cached.key;
}

/* ── mint / verify ─────────────────────────────────────────────────────────── */

export interface MintInput {
  sub: string;
  lvl: Level;
  cid: string | null;
  st: boolean;
  ttlSeconds: number;
  /** Injected so tests are not at the mercy of the clock. */
  now?: number;
}

export async function mint(input: MintInput, secret: string): Promise<{ token: string; exp: number }> {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const exp = now + input.ttlSeconds;
  const header = b64urlEncode(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64urlEncode(
    enc.encode(JSON.stringify({ sub: input.sub, lvl: input.lvl, cid: input.cid, st: input.st, iat: now, exp })),
  );
  const signing = `${header}.${payload}`;
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(signing)));
  return { token: `${signing}.${b64urlEncode(sig)}`, exp };
}

/**
 * Verify and decode, or return null. Null is the ONLY failure mode by design — an expired cookie,
 * a forged signature, a truncated value and no cookie at all are indistinguishable to the caller,
 * because a caller who learns which half failed learns which half to attack.
 */
export async function verify(
  token: string | null, secret: string, now = Date.now(),
): Promise<CdnClaims | null> {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;

  try {
    const key = await hmacKey(secret);
    // crypto.subtle.verify is constant-time; never compare signatures with === here.
    const ok = await crypto.subtle.verify(
      'HMAC', key, b64urlDecode(sig), enc.encode(`${header}.${payload}`),
    );
    if (!ok) return null;

    const claims = JSON.parse(dec.decode(b64urlDecode(payload))) as Partial<CdnClaims>;
    if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
    if (typeof claims.st !== 'boolean') return null;
    if (claims.lvl !== 'guest' && claims.lvl !== 'client' && claims.lvl !== 'internal') return null;
    if (claims.cid !== null && typeof claims.cid !== 'string') return null;
    if (claims.exp * 1000 <= now) return null;

    return { sub: claims.sub, lvl: claims.lvl, cid: claims.cid, st: claims.st, exp: claims.exp };
  } catch {
    return null;
  }
}

/* ── cookie plumbing ──────────────────────────────────────────────────────── */

export const COOKIE_NAME = 'dch_cdn';

/** Pull one cookie out of a Cookie header without a parser dependency. */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * `Domain=.<root>` is what makes this work at all, and it is the reason the mint endpoint lives on
 * this Worker rather than on the Supabase function that resolves the level. A cookie's Domain must
 * be a parent of the host that SETS it: a response from `*.supabase.co` cannot set a cookie for
 * `.disruptcollective.com`, so the portal's images would never carry it. This Worker is already on
 * a sibling subdomain of the portal, so it can.
 *
 * `SameSite=Lax` rather than `None` for the same family of reasons — `<img>` tags cannot pass
 * `credentials: 'include'`, so the cookie only rides along when the request is same-site. That
 * holds for hub.disruptcollective.com → files.disruptcollective.com and does NOT hold for an
 * ephemeral `*.vercel.app` preview, which is a known limitation rather than a bug to chase.
 */
export function setCookieHeader(token: string, domain: string, maxAgeSeconds: number): string {
  return [
    `${COOKIE_NAME}=${token}`,
    `Domain=${domain}`,
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
    'Secure',
    'HttpOnly',
  ].join('; ');
}

export function clearCookieHeader(domain: string): string {
  return `${COOKIE_NAME}=; Domain=${domain}; Path=/; Max-Age=0; SameSite=Lax; Secure; HttpOnly`;
}
