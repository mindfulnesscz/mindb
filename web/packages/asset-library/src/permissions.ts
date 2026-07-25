import type { Role, Asset, AssetPerm } from './types.js'

const VISIBLE_PERMS: Record<Role, AssetPerm[]> = {
  public: ['public'],
  member: ['public', 'client'],
  editor: ['public', 'client', 'internal'],
  admin: ['public', 'client', 'internal'],
  super_admin: ['public', 'client', 'internal'],
}

/** editor, admin, or super_admin — anyone with agency-side access. */
export function isStaff(role: Role): boolean {
  return role === 'editor' || role === 'admin' || role === 'super_admin'
}

export function canViewAsset(role: Role, asset: Asset, viewingClientId?: string): boolean {
  if (!VISIBLE_PERMS[role].includes(asset.perm)) return false
  if (role === 'member' && viewingClientId && asset.clientId !== viewingClientId) return false
  return true
}

/**
 * Anyone may rate (guests included) — but submitting still needs a user
 * session (see the userId guard in the UI); anonymous visitors without a
 * session can see stats but can't post a vote until they have one.
 */
export function canRate(_role: Role): boolean {
  return true
}

/** Rating averages and counts are public — visible to everyone, guests included. */
export function canSeeStats(_role: Role): boolean {
  return true
}

/** Members and staff can read the comment thread; guests cannot. */
export function canReadComments(role: Role): boolean {
  return role !== 'public'
}

/** Writing comments is staff-only — members can read but not post. */
export function canComment(role: Role): boolean {
  return isStaff(role)
}

/** Approve / request changes is staff-only — members only rate. */
export function canApprove(role: Role): boolean {
  return isStaff(role)
}

export function canDownload(role: Role, asset: Asset): boolean {
  const releasable = asset.status === 'approved' || asset.status === 'published'
  // Guests may download public assets that have been released.
  if (role === 'public') return asset.perm === 'public' && releasable
  if (role === 'member') return releasable
  return true
}

export function canSetStatus(role: Role): boolean {
  return isStaff(role)
}

export function canSwitchClient(role: Role): boolean {
  return isStaff(role)
}

/** Editing existing clients — admins and super admins. */
export function canEditClients(role: Role): boolean {
  return role === 'admin' || role === 'super_admin'
}

/**
 * Creating clients — super admins always; admins only when a super admin has
 * granted them the capability (`granted`).
 */
export function canCreateClients(role: Role, granted = false): boolean {
  return role === 'super_admin' || (role === 'admin' && granted)
}

/** Granting admin / super_admin roles — super admin only. */
export function canManageAdmins(role: Role): boolean {
  return role === 'super_admin'
}

/**
 * @deprecated Use canEditClients (edit) or canCreateClients (create) instead.
 * Kept as an alias for existing call sites; maps to the edit capability.
 */
export function canManageClients(role: Role): boolean {
  return canEditClients(role)
}

export function canControlPermission(role: Role): boolean {
  return role === 'admin' || role === 'super_admin'
}
