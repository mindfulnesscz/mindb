export type Role = 'public' | 'member' | 'editor' | 'admin'

export type AssetStatus = 'draft' | 'review' | 'approved' | 'published' | 'archived' | 'disconnected'
export type AssetPerm = 'public' | 'client' | 'internal'
export type ApprovalState = 'approved' | 'pending' | 'changes' | 'none'
export type EntityType = 'product' | 'customer' | 'partner' | 'event' | 'company'

export interface Client {
  id: string
  name: string
  slug?: string
  accent: string
  initials: string
  logoUrl?: string
  website?: string
  portalBg?: string
  domainWhitelist?: string[]
  dimensionLabels?: { entity: string; angle: string; format: string }
}

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
  downloadUrl?: string
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
