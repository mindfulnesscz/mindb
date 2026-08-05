export type Role = 'public' | 'member' | 'editor' | 'admin' | 'super_admin'

/* The three closed vocabularies below are CONST ARRAYS with the type derived from them, not bare
 * type unions. The type identity is unchanged — `typeof X[number]` is the same union it always was —
 * but a parser can now validate against them at runtime, which a type cannot do.
 *
 * That is what `filterUrl.ts` needs: a URL is untrusted input, and `?status=banana` has to be
 * dropped rather than passed through to PostgREST as an enum value it will reject.
 *
 * Order is display order where one exists, not alphabetical.
 */

export const ASSET_STATUSES = ['draft', 'review', 'approved', 'published', 'archived', 'disconnected'] as const
export type AssetStatus = typeof ASSET_STATUSES[number]

/**
 * Who MAY see an asset, in ascending order of restriction. `guest` (added 2026-07-31) means
 * anyone signed in, whoever they are — the level behind email capture.
 *
 * This is only half the access question: `status` gates independently, and the value that
 * actually decides both row discovery and byte delivery is the two combined. See
 * `effectiveLevel` in ./permissions.
 */
export const ASSET_PERMS = ['public', 'guest', 'client', 'internal'] as const
export type AssetPerm = typeof ASSET_PERMS[number]

export type ApprovalState = 'approved' | 'pending' | 'changes' | 'none'

export const ENTITY_TYPES = ['product', 'customer', 'partner', 'event', 'company'] as const
export type EntityType = typeof ENTITY_TYPES[number]

/**
 * A client's portal-owned identity. Defined once, in @sotto/database, next to the generated row type
 * it is projected from — this used to be a second, hand-maintained declaration of the same fields,
 * free to drift from both the schema and desktop's copy. Re-exported under its original name so
 * consumers are unaffected.
 *
 * Note `dimensionLabels` is now REQUIRED and always fully populated: `toClientIdentity` defaults each
 * label individually, so callers no longer have to repeat the fallbacks at every use site.
 */
export type { ClientIdentity as Client } from '@sotto/database'

export interface Asset {
  id: string
  clientId: string
  name: string
  entityType: EntityType
  entity: string
  formats: string[]
  angle: string
  status: AssetStatus
  perm: AssetPerm
  version: string
  latest: boolean
  avg: number
  count: number
  comments: number
  approval: ApprovalState
  thumbnailUrl?: string
  /** CDN original — primary Download button. */
  downloadUrl?: string
  /* ── Document page previews ───────────────────────────────────────────────
     Both absent for anything that is not a previewed document. There is no page URL column: the
     addresses are derived from `thumbnailUrl` via `pageUrlsFromThumbnail`, which keeps the domain
     and access level the thumbnail already resolved to. */
  /** Pages rendered and published — how many the viewer can show. */
  previewPageCount?: number | null
  /** Pages the document actually has. Above `previewPageCount` when the client's limit capped it;
   *  the difference is what the viewer turns into "download the asset to see the rest". */
  previewPageTotal?: number | null
  /* ── Video ────────────────────────────────────────────────────────────────
     Cloudflare Stream carries playback and stills; R2 still holds the master, which is what
     `downloadUrl` points at. Both absent for everything that is not a video. */
  streamUid?: string | null
  /** Stream's own encoding state. Only `ready` means its delivery URLs resolve. */
  streamStatus?: string | null
  /** Video length in seconds. Null until encoding finishes; needed to place preview frames. */
  streamDuration?: number | null
  /** Cloud share links (Dropbox / OneDrive / Drive) from pipeline export. */
  downloadUrls?: { destId?: string; provider: string; name: string; url: string }[]
  /** Rename-proof package identity — used for Reveal in Finder via desktop bridge. */
  stableId?: string | null
  updatedAt: string
  parentId?: string | null
  childCount?: number
  /** Folder-based stable identity variants (Task 3) — null/undefined for the primary row */
  variantOf?: string | null
  /** Full tag arrays (entity/angle carry only the first element above, for back-compat) —
   * used to compute the shared-vs-unique tag split across a variant group. */
  entities?: string[]
  angles?:   string[]
  tagsAll?:  string[]
}

export interface Comment {
  id: string
  assetId: string
  author: string
  role: Role
  body: string
  createdAt: string
}

export interface AssetActions {
  download?: (asset: Asset) => void | Promise<void>
  openInFolder?: (asset: Asset) => void | Promise<void>
}

export interface FilterState {
  search: string
  latestOnly: boolean
  status: AssetStatus[]
  entityTypes: EntityType[]
  entities: string[]
  formats: string[]
  angles: string[]
  perms: AssetPerm[]
}
