/* Where an asset's bytes live — the single answer, shared by everything that needs it.
 *
 * Four callers have to agree, and if any two of them disagree the symptom is a broken image or a
 * leak rather than a type error:
 *
 *   the desktop pipeline   decides where to UPLOAD
 *   the re-key script      decides where to MOVE existing objects
 *   the cdn-reconcile fn   moves them when a level changes
 *   the cdn-gate Worker    parses the key back to decide WHO MAY FETCH it
 *
 * All four import THIS module. The Worker was the exception — it restated the parse by hand,
 * because it lives in its own bundle — until workers/cdn-gate joined the npm workspace and could
 * resolve @dc-hub/domain like everyone else. `parseObjectPath` below is that parser, and it is now
 * the only copy: a change to the key shape can no longer be half-made.
 *
 * Two tiers of delivery, four levels of access:
 *
 *   public/    the object stays in the PUBLIC bucket on the public domain, key unchanged. Fast,
 *              no Worker, no cookie. Anyone with the URL.
 *   gated/     the object lives in the GATED bucket, which has no public access at all, and is
 *              reachable only through the Worker — which authorizes from the level segment below.
 *
 * The level in the key is the EFFECTIVE level, never raw `perm`: an asset marked public while
 * still in draft belongs under `internal/`. Postgres computes the same value in a generated
 * column, so discovery and delivery cannot disagree.
 */

export type AccessLevel = 'public' | 'guest' | 'client' | 'internal';

/** Anything a caller might hand us — the DB columns are plain text. */
export interface LevelInputs {
  perm: string | null | undefined;
  status: string | null | undefined;
}

const RELEASED = new Set(['approved', 'published']);
const LEVELS = new Set<string>(['public', 'guest', 'client', 'internal']);

/**
 * `perm` says who may see it; `status` says where it is in its lifecycle. Both gate, so the value
 * that actually decides access is the two combined:
 *
 *     effective_level = (status in ('approved','published')) ? perm : 'internal'
 *
 * Mirrors the generated `assets.effective_level` column (migration 20260731120000). An unknown or
 * missing `perm` resolves to `internal` rather than to a default — the safe direction for a value
 * that decides who can read something.
 */
export function effectiveLevel(asset: LevelInputs): AccessLevel {
  const status = asset.status ?? '';
  const perm = asset.perm ?? '';
  if (!RELEASED.has(status)) return 'internal';
  return LEVELS.has(perm) ? (perm as AccessLevel) : 'internal';
}

/** `public` bytes are served straight from the public bucket; everything else goes through the Worker. */
export function tierFor(level: AccessLevel): 'public' | 'gated' {
  return level === 'public' ? 'public' : 'gated';
}

export type ObjectKind = 'thumbnails' | 'originals';

export interface StorageTarget {
  tier: 'public' | 'gated';
  /** Full object key within that tier's bucket. */
  key: string;
}

/**
 * The object key for one asset file.
 *
 *   public tier   {client_id}/thumbnails/{stable_id}/{child_id}.webp
 *   gated tier    {level}/{client_id}/originals/{stable_id}/{child_id}{ext}
 *
 * Public keys are deliberately UNCHANGED from what the pipeline has always written, so promoting
 * an asset to public and re-keying it lands on the address it already had, and nothing that is
 * legitimately public has to move at all.
 *
 * Keys derive from folder identity — `stable_id` + `child_id` — never from the filename, so
 * renaming a file keeps its address. Do not reintroduce filename-keyed lookups here.
 */
export function storageTarget(
  level: AccessLevel,
  clientId: string,
  kind: ObjectKind,
  stableId: string,
  childId: string,
  ext = '',
): StorageTarget {
  const tail = `${clientId}/${kind}/${stableId}/${childId}${ext}`;
  return level === 'public'
    ? { tier: 'public', key: tail }
    : { tier: 'gated', key: `${level}/${tail}` };
}

/**
 * The URL a portal row stores.
 *
 * `?v=<content-hash>` is carried on BOTH tiers and is load-bearing on both: the pipeline writes one
 * object per logical asset under a version-stable key, so a version bump OVERWRITES that key and
 * the stamp is the only thing distinguishing new bytes from old. The Worker's cache key includes
 * it for exactly that reason.
 *
 * It is cache-busting, never authorization — a gated URL is as guessable as a public one, and that
 * is fine: the cookie is what decides, so the link can stay permanent and pretty while the SESSION
 * expires instead.
 */
export function assetUrl(domain: string, objectKey: string, contentHash?: string): string {
  const base = `${domain.replace(/\/+$/, '')}/${objectKey}`;
  if (!contentHash) return base;
  return `${base}?v=${contentHash.slice(0, 12)}`;
}

/* ── Reading a key back ────────────────────────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedObjectPath {
  level: AccessLevel;
  clientId: string;
  /** Everything after the client segment — `thumbnails/<stable>/<child>.webp` and friends. */
  rest: string;
  /** The full object key, decoded. What actually gets fetched. */
  key: string;
}

/**
 * Split a gated request path into its parts, or return null if it is not one.
 *
 *     /client/8f3e…/thumbnails/a1000001/c1.webp
 *      ^level ^client_id       ^rest
 *
 * Null must mean 404, never "allow": a path whose level cannot be determined is not a public one.
 * This is the Worker's whole authorization input, so it is deliberately strict — a client segment
 * that is not a uuid means the key was not written by this pipeline, and a `..` segment must never
 * be able to walk from one level into another.
 */
export function parseObjectPath(pathname: string): ParsedObjectPath | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null; // malformed percent-encoding
  }

  const key = decoded.replace(/^\/+/, '');
  const segments = key.split('/');
  if (segments.length < 3) return null;
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null;

  const [level, clientId, ...rest] = segments;
  if (!LEVELS.has(level)) return null;
  if (!UUID.test(clientId)) return null;

  return { level: level as AccessLevel, clientId, rest: rest.join('/'), key };
}

/**
 * Would the Worker be able to serve an object written at this key?
 *
 * Anything that WRITES a gated key checks this first. It is cheap and exact, and its absence let
 * nine production objects land at addresses the gate could not parse — a 404 on a file the portal
 * was offering. Asserting the reader's contract at the moment of writing is the whole point.
 */
export function isServableGatedKey(key: string): boolean {
  return parseObjectPath(key) !== null;
}

/** Strip the cache-busting stamp — for comparing a stored URL against a computed target. */
export function stripVersion(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
