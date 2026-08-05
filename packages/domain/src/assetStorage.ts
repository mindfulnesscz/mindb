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
 * resolve @sotto/domain like everyone else. `parseObjectPath` below is that parser, and it is now
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

/**
 * The three namespaces an asset's bytes live in.
 *
 * `pages` holds per-page document previews — one object per rendered page, for the portal's page
 * viewer. They are DERIVED bytes and carry the same level as the document they came from: a
 * `client` deck whose pages landed under a public key would be a leak of the deck's content, so the
 * level is resolved from the asset row exactly as it is for thumbnails, and `cdn-reconcile` moves
 * them when it changes.
 */
export type ObjectKind = 'thumbnails' | 'originals' | 'pages';

export interface StorageTarget {
  tier: 'public' | 'gated';
  /** Full object key within that tier's bucket. */
  key: string;
}

/**
 * The level → tier/prefix rule, in ONE place.
 *
 * Both key builders below route through this. Four components have to agree on the key shape (see
 * the module header), and the level prefix is the part the Worker authorizes from — so it must not
 * be spelled out twice.
 */
function targetForTail(level: AccessLevel, tail: string): StorageTarget {
  return level === 'public'
    ? { tier: 'public', key: tail }
    : { tier: 'gated', key: `${level}/${tail}` };
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
  return targetForTail(level, `${clientId}/${kind}/${stableId}/${childId}${ext}`);
}

/**
 * File name for one page of a document's previews. 1-based.
 *
 * Zero-padded to three digits so lexical order is page order everywhere it is listed — a shell, an
 * R2 prefix listing, the portal. `10.webp` sorting before `2.webp` would silently reorder a deck.
 * Matches what the renderer writes locally (`render::page_path`).
 */
export function pageObjectName(page: number): string {
  return `${String(page).padStart(3, '0')}.webp`;
}

/**
 * The object key for ONE page of a document's per-page previews.
 *
 *   public tier   {client_id}/pages/{stable_id}/{child_id}/001.webp
 *   gated tier    {level}/{client_id}/pages/{stable_id}/{child_id}/001.webp
 *
 * A directory per asset rather than a flat `{child_id}-001.webp`, so every page of one document
 * shares a prefix. That is what makes "delete the pages beyond page N" a prefix listing instead of a
 * guess — needed when a document shrinks or an administrator lowers the page limit, because pages
 * left behind in R2 are invisible locally and visible to a client.
 */
export function pageTarget(
  level: AccessLevel,
  clientId: string,
  stableId: string,
  childId: string,
  page: number,
): StorageTarget {
  return targetForTail(
    level,
    `${clientId}/pages/${stableId}/${childId}/${pageObjectName(page)}`,
  );
}

/** Key prefix holding every page of one document — for listing and pruning. */
export function pagePrefix(
  level: AccessLevel,
  clientId: string,
  stableId: string,
  childId: string,
): string {
  return targetForTail(level, `${clientId}/pages/${stableId}/${childId}/`).key;
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

/** One page object that has to move because the asset's level changed. */
export interface PageMove {
  /** The level the object is currently sitting under. */
  from: AccessLevel;
  fromTier: 'public' | 'gated';
  sourceKey: string;
  targetKey: string;
  targetTier: 'public' | 'gated';
}

/**
 * Every page object that would be in the wrong place if this asset is at `level`.
 *
 * Extracted from `cdn-reconcile` so the decision is testable without a Deno runtime, an R2 bucket or
 * a queue. Nothing in the toolchain type-checks or exercises the edge functions, and the first
 * version of this logic — written inline — shipped two bugs that only appeared in production:
 *
 *   1. it LISTED each level prefix, but the function's credentials are `object-read-write`, which
 *      does not include ListBucket. Every list 403'd, every asset was marked failed, and the move
 *      queue stopped draining — which broke video, because the same pass sets `requireSignedURLs`.
 *   2. it treated a missing source object as a failure. Only ONE of the four levels holds a given
 *      page, so three misses per page are the normal case.
 *
 * Addressed from the recorded page COUNT rather than a listing, for reason 1. The caller treats a
 * missing source as silence, for reason 2 — this function deliberately returns the full cross-product
 * of levels and pages, because which ones exist is not knowable without asking R2.
 *
 * Returns nothing for a zero count (a raster, a video, or a client whose page limit is 0), so the
 * overwhelming majority of assets cost no work at all.
 */
export function planPageMoves(
  level: AccessLevel,
  clientId: string,
  stableId: string,
  childId: string,
  pageCount: number,
): PageMove[] {
  if (!Number.isFinite(pageCount) || pageCount <= 0) return [];

  const targetTier = tierFor(level);
  const moves: PageMove[] = [];
  for (const from of ALL_ACCESS_LEVELS) {
    if (from === level) continue; // already where it belongs
    for (let page = 1; page <= pageCount; page++) {
      moves.push({
        from,
        fromTier: tierFor(from),
        sourceKey: pageTarget(from, clientId, stableId, childId, page).key,
        targetKey: pageTarget(level, clientId, stableId, childId, page).key,
        targetTier,
      });
    }
  }
  return moves;
}

/** Every level an object could be sitting under. Order is stable so plans are comparable. */
export const ALL_ACCESS_LEVELS: readonly AccessLevel[] = ['public', 'guest', 'client', 'internal'];

/**
 * Page-preview URLs for a document, derived from its THUMBNAIL URL.
 *
 * The portal has no page URL column — there is one object per page, so storing fifty URLs per asset
 * would be absurd. It could rebuild each address from client id + level + identity, but that means
 * the portal restating the key rule and the level lookup, and any drift between the two shows up as
 * a broken image or a 403.
 *
 * Deriving from the thumbnail avoids all of it. The thumbnail is at
 * `{domain}/{level}/{client}/thumbnails/{stable}/{child}.webp` and a page at
 * `{domain}/{level}/{client}/pages/{stable}/{child}/001.webp` — same domain, same level, same
 * identity, one segment different. Whatever tier and level the thumbnail resolved to, the pages
 * inherit by construction, so they cannot disagree.
 *
 * The `?v=` stamp is carried over deliberately. It is the thumbnail's content hash, not the page's,
 * but both are rendered from the same source document: change the document and the thumbnail's hash
 * changes too, which busts the cached pages along with it. Reusing it is therefore correct coupling
 * rather than a shortcut.
 *
 * Returns an empty array for a missing thumbnail, a zero count, or a URL that is not a thumbnail
 * address — the portal renders nothing rather than guessing at an address.
 */
export function pageUrlsFromThumbnail(
  thumbnailUrl: string | null | undefined,
  count: number,
): string[] {
  if (!thumbnailUrl || count <= 0) return [];

  const q = thumbnailUrl.indexOf('?');
  const base = q === -1 ? thumbnailUrl : thumbnailUrl.slice(0, q);
  const query = q === -1 ? '' : thumbnailUrl.slice(q);

  // `/thumbnails/{stable}/{child}.webp` → `/pages/{stable}/{child}/`
  const match = base.match(/^(.*)\/thumbnails\/([^/]+)\/([^/]+)\.webp$/);
  if (!match) return [];
  const [, prefix, stableId, childId] = match;

  return Array.from(
    { length: count },
    (_, i) => `${prefix}/pages/${stableId}/${childId}/${pageObjectName(i + 1)}${query}`,
  );
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
