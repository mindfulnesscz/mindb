export type Role = 'public' | 'member' | 'editor' | 'admin' | 'super_admin'

export type AssetStatus = 'draft' | 'review' | 'approved' | 'published' | 'archived' | 'disconnected'
/**
 * Who MAY see an asset, in ascending order of restriction. `guest` (added 2026-07-31) means
 * anyone signed in, whoever they are — the level behind email capture.
 *
 * This is only half the access question: `status` gates independently, and the value that
 * actually decides both row discovery and byte delivery is the two combined. See
 * `effectiveLevel` in ./permissions.
 */
export type AssetPerm = 'public' | 'guest' | 'client' | 'internal'
export type ApprovalState = 'approved' | 'pending' | 'changes' | 'none'
export type EntityType = 'product' | 'customer' | 'partner' | 'event' | 'company'

/**
 * A client's portal-owned identity. Defined once, in @dc-hub/database, next to the generated row type
 * it is projected from — this used to be a second, hand-maintained declaration of the same fields,
 * free to drift from both the schema and desktop's copy. Re-exported under its original name so
 * consumers are unaffected.
 *
 * Note `dimensionLabels` is now REQUIRED and always fully populated: `toClientIdentity` defaults each
 * label individually, so callers no longer have to repeat the fallbacks at every use site.
 */
export type { ClientIdentity as Client } from '@dc-hub/database'

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
