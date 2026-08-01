import type { Role, Asset, AssetPerm } from './types.js'

/**
 * The level that actually decides access, mirroring the generated `assets.effective_level`
 * column (20260731120000) exactly:
 *
 *   effective_level = (status in ('approved','published')) ? perm : 'internal'
 *
 * `perm` says who may see it; `status` says where it is in its lifecycle. They are independent
 * axes and both gate, so an asset marked `public` while still in `draft` is staff-only — that
 * is what keeps unapproved work from being shown before sign-off. Postgres RLS enforces this on
 * discovery and the same value is encoded in the R2 object key for byte delivery; this copy
 * exists so the UI agrees with both rather than guessing from `perm` alone.
 */
export function effectiveLevel(asset: Pick<Asset, 'perm' | 'status'>): AssetPerm {
  return asset.status === 'approved' || asset.status === 'published' ? asset.perm : 'internal'
}

/**
 * `guest` is visible to every role here, including `public`.
 *
 * That is not a hole: role `public` covers both an anonymous visitor and a signed-in
 * email-capture profile, and this module cannot tell them apart. The distinction is enforced
 * where it counts — RLS requires `auth.uid() is not null` for the guest level, and the CDN
 * Worker requires a valid token — so an anonymous visitor never receives a guest-level row to
 * filter in the first place. A display filter that only ever REMOVES rows the server already
 * returned is the wrong place to re-litigate authentication.
 */
const VISIBLE_PERMS: Record<Role, AssetPerm[]> = {
  public: ['public', 'guest'],
  member: ['public', 'guest', 'client'],
  editor: ['public', 'guest', 'client', 'internal'],
  admin: ['public', 'guest', 'client', 'internal'],
  super_admin: ['public', 'guest', 'client', 'internal'],
}

/** editor, admin, or super_admin — anyone with agency-side access. */
export function isStaff(role: Role): boolean {
  return role === 'editor' || role === 'admin' || role === 'super_admin'
}

export function canViewAsset(role: Role, asset: Asset, viewingClientId?: string): boolean {
  if (!VISIBLE_PERMS[role].includes(effectiveLevel(asset))) return false
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
  // Guests may download public and guest-level assets that have been released. `releasable` is
  // the same lifecycle test effectiveLevel applies, spelled out here because staff download
  // unreleased work deliberately.
  if (role === 'public') return (asset.perm === 'public' || asset.perm === 'guest') && releasable
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

/**
 * Who may change an asset's visibility. Editors and above — confirmed 2026-08-01.
 *
 * This said `admin || super_admin` and was never called anywhere, while the panel gated the
 * selector on `isStaff`. So the codebase carried two different answers to "who sets visibility"
 * and shipped the more permissive one. That is the worst shape for an access rule: the written
 * one looks authoritative in review, and the real one is a condition inline in a component.
 *
 * Editors is the intended answer, and it matches what the server already enforces — the
 * `assets: staff write` policy is `is_staff()`, so narrowing this to admins would have produced a
 * UI that hides a control the API accepts. Now it is one named predicate, used.
 *
 * NOTE the scope question this does NOT answer: `is_staff()` grants editors every client, while
 * `client_members` exists and r2-grant already scopes non-admins by it. Whether an editor should
 * be able to change visibility on a client they are not assigned to is a separate decision, and
 * today the answer is yes.
 */
export function canControlPermission(role: Role): boolean {
  return isStaff(role)
}
