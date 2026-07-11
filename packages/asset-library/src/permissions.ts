import type { Role, Asset, AssetPerm } from './types.js'

const VISIBLE_PERMS: Record<Role, AssetPerm[]> = {
  public: ['public'],
  member: ['public', 'client'],
  editor: ['public', 'client', 'internal'],
  admin: ['public', 'client', 'internal'],
}

export function canViewAsset(role: Role, asset: Asset, viewingClientId?: string): boolean {
  if (!VISIBLE_PERMS[role].includes(asset.perm)) return false
  if (role === 'member' && viewingClientId && asset.clientId !== viewingClientId) return false
  return true
}

export function canRate(role: Role): boolean {
  return role !== 'public'
}

export function canComment(role: Role): boolean {
  return role !== 'public'
}

export function canApprove(role: Role): boolean {
  return role !== 'public'
}

export function canDownload(role: Role, asset: Asset): boolean {
  if (role === 'public') return false
  if (role === 'member') return asset.status === 'approved' || asset.status === 'published'
  return true
}

export function canSetStatus(role: Role): boolean {
  return role === 'editor' || role === 'admin'
}

export function canSwitchClient(role: Role): boolean {
  return role === 'editor' || role === 'admin'
}

export function canManageClients(role: Role): boolean {
  return role === 'admin'
}

export function canControlPermission(role: Role): boolean {
  return role === 'admin'
}
