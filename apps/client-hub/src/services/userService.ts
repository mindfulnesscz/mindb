import { supabase } from '../lib/supabase'

export interface UserProfile {
  id: string
  name: string
  initials: string
  role: string
  clientId: string | null
  clientName: string | null
  email: string
  createdAt: string
}

export async function fetchAllUsers(): Promise<UserProfile[]> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data, error } = await (supabase as any).rpc('get_all_profiles')
  if (error) throw new Error(error.message)

  return ((data ?? []) as any[]).map(r => ({
    id:         r.id,
    name:       r.name,
    initials:   r.initials,
    role:       r.role,
    clientId:   r.client_id,
    clientName: r.client_name,
    email:      r.email,
    createdAt:  r.created_at,
  }))
}

export async function updateUserRole(userId: string, role: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { error } = await (supabase as any).rpc('update_user_role', {
    p_user_id: userId,
    p_role: role,
  })
  if (error) throw new Error(error.message)
}
