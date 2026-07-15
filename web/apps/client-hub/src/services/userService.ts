import { supabase } from '../lib/supabase'
import type { Role } from '@dc-hub/asset-library'

export interface UserProfile {
  id: string
  name: string
  initials: string
  role: string
  clientId: string | null
  clientName: string | null
  email: string
  createdAt: string
  memberClientIds?: string[]
}

/** Normalize legacy DB role before it reaches permission helpers. */
export function normalizeRole(role: string): Role {
  if (role === 'client') return 'member'
  return role as Role
}

export async function fetchAllUsers(): Promise<UserProfile[]> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await supabase.rpc('get_all_profiles')
  if (error) throw new Error(error.message)

  const rows = data ?? []
  const users = await Promise.all(rows.map(async (r) => {
    let memberClientIds: string[] = []
    if (r.role === 'editor') {
      const { data: ids } = await supabase!.rpc('get_user_client_members', { p_user_id: r.id })
      memberClientIds = (ids as string[] | null) ?? []
    }
    return {
      id:         r.id,
      name:       r.name,
      initials:   r.initials,
      role:       normalizeRole(r.role),
      clientId:   r.client_id,
      clientName: r.client_name,
      email:      r.email,
      createdAt:  r.created_at,
      memberClientIds,
    }
  }))
  return users
}

export interface UpdateUserAccessInput {
  userId: string
  role: string
  clientId?: string | null
  memberClientIds?: string[]
}

export async function updateUserAccess(input: UpdateUserAccessInput): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { error } = await supabase.rpc('update_user_access', {
    p_user_id:           input.userId,
    p_role:              input.role,
    p_client_id:         input.clientId ?? undefined,
    p_member_client_ids: input.memberClientIds?.length ? input.memberClientIds : undefined,
  })
  if (error) throw new Error(error.message)
}

/** @deprecated Use updateUserAccess */
export async function updateUserRole(userId: string, role: string): Promise<void> {
  return updateUserAccess({ userId, role })
}
