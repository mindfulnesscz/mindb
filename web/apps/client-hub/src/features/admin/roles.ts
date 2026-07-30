/* Role options and who may assign them.
 *
 * `assignableRoles` is an authorization rule, not a UI list: it is what stops an ordinary admin
 * from granting admin or super-admin. The database enforces the same boundary via RLS
 * (`is_admin()` / `is_super_admin()`), so this is defence in depth — but a bug here would offer
 * the option and fail confusingly at the server, which is why it is tested.
 */

export const ROLE_OPTIONS = ['public', 'member', 'editor', 'admin', 'super_admin'] as const

export const ROLE_LABELS: Record<string, string> = {
  public: 'Public', member: 'Member', editor: 'Editor', admin: 'Admin', super_admin: 'Super Admin',
}

/** Admin-tier roles are assignable only by a super admin. */
export function assignableRoles(viewerCanManageAdmins: boolean): readonly string[] {
  return viewerCanManageAdmins
    ? ROLE_OPTIONS
    : ROLE_OPTIONS.filter(r => r !== 'admin' && r !== 'super_admin')
}
