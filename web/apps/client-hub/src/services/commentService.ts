import { supabase } from '../lib/supabase'

export interface RealComment {
  id: string
  assetId: string
  userId: string
  authorName: string
  authorInitials: string
  authorRole: string
  body: string
  createdAt: string
}


export async function fetchComments(assetId: string): Promise<RealComment[]> {
  if (!supabase) return []

  // Step 1: fetch comments
  const { data: commentRows, error } = await (supabase as any)
    .from('comments')
    .select('id, asset_id, user_id, body, created_at')
    .eq('asset_id', assetId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('fetchComments error:', error.message)
    return []
  }

  if (!commentRows?.length) return []

  // Step 2: fetch profiles for those user IDs
  const userIds = [...new Set((commentRows as { user_id: string }[]).map(r => r.user_id))]
  const { data: profileRows } = await (supabase as any)
    .from('profiles')
    .select('id, name, initials, role')
    .in('id', userIds)

  const profileMap = new Map<string, { name: string; initials: string; role: string }>()
  for (const p of (profileRows ?? [])) {
    profileMap.set(p.id, { name: p.name, initials: p.initials, role: p.role })
  }

  return (commentRows as { id: string; asset_id: string; user_id: string; body: string; created_at: string }[]).map(row => ({
    id: row.id,
    assetId: row.asset_id,
    userId: row.user_id,
    authorName: profileMap.get(row.user_id)?.name ?? 'Unknown',
    authorInitials: profileMap.get(row.user_id)?.initials ?? '??',
    authorRole: profileMap.get(row.user_id)?.role ?? 'member',
    body: row.body,
    createdAt: row.created_at,
  }))
}

export async function addComment(
  assetId: string,
  userId: string,
  body: string,
): Promise<RealComment> {
  if (!supabase) throw new Error('Supabase not configured')

  const { data: inserted, error: insertError } = await (supabase as any)
    .from('comments')
    .insert({ asset_id: assetId, user_id: userId, body })
    .select('id')
    .single()

  if (insertError) throw new Error(insertError.message)

  const { data: row, error: fetchError } = await (supabase as any)
    .from('comments')
    .select('id, asset_id, user_id, body, created_at')
    .eq('id', (inserted as { id: string }).id)
    .single()

  if (fetchError) throw new Error(fetchError.message)

  const { data: profile } = await (supabase as any)
    .from('profiles')
    .select('name, initials, role')
    .eq('id', (row as { user_id: string }).user_id)
    .single()

  const r = row as { id: string; asset_id: string; user_id: string; body: string; created_at: string }
  return {
    id: r.id,
    assetId: r.asset_id,
    userId: r.user_id,
    authorName: profile?.name ?? 'Unknown',
    authorInitials: profile?.initials ?? '??',
    authorRole: profile?.role ?? 'member',
    body: r.body,
    createdAt: r.created_at,
  }
}

export async function deleteComment(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase not configured')

  const { error } = await (supabase as any)
    .from('comments')
    .delete()
    .eq('id', id)

  if (error) throw new Error(error.message)
}
