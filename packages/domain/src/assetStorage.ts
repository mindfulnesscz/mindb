/* Where an asset's bytes live — the single answer, shared by everything that needs it.
 *
 * Three callers have to agree, and if any two of them disagree the symptom is a broken image or a
 * leak rather than a type error:
 *
 *   the desktop pipeline   decides where to UPLOAD
 *   the re-key script      decides where to MOVE existing objects
 *   the cdn-gate Worker    parses the key back to decide WHO MAY FETCH it
 *
 * The Worker cannot import this (it is a separate deployment with its own bundle), so its parser
 * carries the same shape written out by hand — `workers/cdn-gate/src/authz.ts`, `parseGatedKey`.
 * Change the key shape here and that must change with it; `assetStorage.test.ts` states the shape
 * explicitly so the mismatch is at least visible.
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

/** Strip the cache-busting stamp — for comparing a stored URL against a computed target. */
export function stripVersion(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}
