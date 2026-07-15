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

export interface CreateUserInput {
  email: string
  name?: string
  role: string
  clientId?: string | null
  memberClientIds?: string[]
  sendInvitation: boolean
}

export async function createUser(input: CreateUserInput): Promise<{ id: string; invited: boolean }> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data: session } = await supabase.auth.getSession()
  const token = session.session?.access_token
  if (!token) throw new Error('Not signed in')

  const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/admin-create-user`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      email: input.email,
      name: input.name,
      role: input.role,
      client_id: input.clientId ?? undefined,
      member_client_ids: input.memberClientIds?.length ? input.memberClientIds : undefined,
      send_invitation: input.sendInvitation,
    }),
  })

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(err.error ?? `Create user failed (${res.status})`)
  }

  const body = await res.json() as { id: string; invited: boolean }
  return { id: body.id, invited: body.invited }
}

/** @deprecated Use updateUserAccess */
export async function updateUserRole(userId: string, role: string): Promise<void> {
  return updateUserAccess({ userId, role })
}
