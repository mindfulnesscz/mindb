/* Who may fetch which object — the whole authorization decision, as pure functions.
 *
 * This module does NO I/O, and that is the single most important property in the design. A
 * gallery grid of gated content issues 50+ requests per page view; at 50 signature verifications
 * that is free, and at 50 database lookups the tool stops being browsable. Every fact needed to
 * decide a request is in the signed cookie plus the object key itself — so the key encodes the
 * access level, and a `perm` or `status` change MOVES the object rather than changing a lookup.
 * That cost was bought deliberately.
 *
 * The key parser lives in @sotto/domain, imported rather than restated — this Worker used to
 * carry its own copy because it is a separate bundle, until workers/cdn-gate joined the npm
 * workspace. One definition now serves the pipeline, the re-key script, the reconcile function and
 * this.
 *
 * The four levels, in ascending restriction:
 *
 *   public    anyone with the URL          — lives in the OTHER bucket, served without this Worker
 *   guest     anyone signed in             — the level behind the magic-link sign-in
 *   client    members of that client_id    — plus staff
 *   internal  staff only                   — editor / admin / super_admin
 *
 * The level in the key is the EFFECTIVE level (`assets.effective_level`), not raw `perm`: an
 * asset marked public while still in draft is written under `internal/`. Postgres computes the
 * same value in a generated column, so discovery and delivery cannot disagree.
 */

import { parseObjectPath, type AccessLevel, type ParsedObjectPath } from '@sotto/domain/assetStorage';

/** The four levels, defined once in @sotto/domain. Aliased so this module reads as it always did. */
export type Level = AccessLevel;

/** Claims carried by the signed CDN cookie. Names are short because this cookie rides on every
 *  single image request in a grid — `st` is is_staff, `cid` the caller's client, `lvl` the
 *  highest level they are entitled to. */
export interface CdnClaims {
  sub: string;
  lvl: Level;
  cid: string | null;
  st: boolean;
  exp: number;
}

/** An object key, split into the parts authorization cares about. Defined in @sotto/domain, so
 *  the shape this Worker authorizes on is the same one the writers construct. */
export type GatedKey = ParsedObjectPath;

/**
 * Split a request path into a gated object key, or return null if it is not one.
 *
 * Returning null must mean 404, never "allow": a path this cannot parse is a path whose level this
 * cannot determine, and an undetermined level is not a public one.
 */
export function parseGatedKey(pathname: string): GatedKey | null {
  return parseObjectPath(pathname);
}

/**
 * The decision. `claims` is null for an unsigned, expired, forged or absent cookie — every one of
 * those is simply "not signed in", with no distinction drawn, because telling a caller *why* they
 * failed tells an attacker which half to work on.
 */
export function authorize(target: GatedKey, claims: CdnClaims | null): boolean {
  switch (target.level) {
    // Should not occur — public objects live in the public bucket and never reach this Worker.
    // Allowed rather than refused so a mis-filed object is merely in the wrong place, not broken.
    case 'public':
      return true;
    case 'guest':
      return claims !== null;
    case 'client':
      return claims !== null && (claims.st || claims.cid === target.clientId);
    case 'internal':
      return claims !== null && claims.st;
  }
}

/** The highest level a caller is entitled to, from their profile. Mirrors the RLS policies:
 *  staff see everything, a member sees their own client, and anyone else who is signed in gets
 *  the guest level. */
export function levelForProfile(role: string, clientId: string | null): Level {
  if (role === 'editor' || role === 'admin' || role === 'super_admin') return 'internal';
  if (clientId) return 'client';
  return 'guest';
}

/** editor / admin / super_admin — matches the SQL `is_staff()` as widened by 20260724120001. */
export function isStaffRole(role: string): boolean {
  return role === 'editor' || role === 'admin' || role === 'super_admin';
}

/* ── Range requests ────────────────────────────────────────────────────────────
 * Video seeking and resumable downloads both need these, and both are silent about getting them
 * wrong — a player just stalls.
 *
 * The Range header is parsed HERE rather than handed to the R2 binding as a `Headers` object,
 * even though the binding accepts one. Letting the binding parse it means the numbers for
 * `Content-Range` have to be read back off `object.range`, and that round trip is where the first
 * version of this broke: it shipped `bytes NaN-NaN/1500`, with a correct body and a correct
 * Content-Length, which is exactly the kind of wrong that survives a smoke test. Parsing here
 * makes one set of numbers drive both the fetch and the header. */

export type RangeSpec = { offset: number; length?: number } | { suffix: number };

/**
 * Parse a single byte range, or return null meaning "serve the whole object".
 *
 * Null for multi-range (`bytes=0-9,20-29`) is deliberate and legal: RFC 7233 lets a server ignore
 * a Range it does not wish to satisfy, and answering 200 with the full body is always correct.
 * Multipart/byteranges responses are not worth implementing for an asset CDN.
 */
export function parseRangeHeader(header: string | null): RangeSpec | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, first, last] = m;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    return suffix > 0 ? { suffix } : null;
  }
  if (last === '') return { offset: Number(first) };
  const start = Number(first);
  const end = Number(last);
  if (end < start) return null;
  return { offset: start, length: end - start + 1 };
}

/**
 * Turn a spec into the concrete numbers `Content-Range` needs, clamped to the object's real size.
 * Clamping matters: `bytes=0-99999` on a 1500-byte object is satisfiable, and must report the 1500
 * bytes actually sent rather than the 100000 asked for.
 */
export function resolveContentRange(spec: RangeSpec, size: number): { start: number; length: number } {
  if ('suffix' in spec) {
    const length = Math.min(spec.suffix, size);
    return { start: size - length, length };
  }
  const start = Math.min(spec.offset, size);
  return { start, length: Math.min(spec.length ?? size - start, size - start) };
}
