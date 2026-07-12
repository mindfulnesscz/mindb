import { supabase } from '../lib/supabase';
export async function fetchComments(assetId) {
    if (!supabase)
        return [];
    // Step 1: fetch comments
    const { data: commentRows, error } = await supabase
        .from('comments')
        .select('id, asset_id, user_id, body, created_at')
        .eq('asset_id', assetId)
        .order('created_at', { ascending: true });
    if (error) {
        console.error('fetchComments error:', error.message);
        return [];
    }
    if (!commentRows?.length)
        return [];
    // Step 2: fetch profiles for those user IDs
    const userIds = [...new Set(commentRows.map(r => r.user_id))];
    const { data: profileRows } = await supabase
        .from('profiles')
        .select('id, name, initials, role')
        .in('id', userIds);
    const profileMap = new Map();
    for (const p of (profileRows ?? [])) {
        profileMap.set(p.id, { name: p.name, initials: p.initials, role: p.role });
    }
    return commentRows.map(row => ({
        id: row.id,
        assetId: row.asset_id,
        userId: row.user_id,
        authorName: profileMap.get(row.user_id)?.name ?? 'Unknown',
        authorInitials: profileMap.get(row.user_id)?.initials ?? '??',
        authorRole: profileMap.get(row.user_id)?.role ?? 'member',
        body: row.body,
        createdAt: row.created_at,
    }));
}
export async function addComment(assetId, userId, body) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { data: inserted, error: insertError } = await supabase
        .from('comments')
        .insert({ asset_id: assetId, user_id: userId, body })
        .select('id')
        .single();
    if (insertError)
        throw new Error(insertError.message);
    const { data: row, error: fetchError } = await supabase
        .from('comments')
        .select('id, asset_id, user_id, body, created_at')
        .eq('id', inserted.id)
        .single();
    if (fetchError)
        throw new Error(fetchError.message);
    const { data: profile } = await supabase
        .from('profiles')
        .select('name, initials, role')
        .eq('id', row.user_id)
        .single();
    const r = row;
    return {
        id: r.id,
        assetId: r.asset_id,
        userId: r.user_id,
        authorName: profile?.name ?? 'Unknown',
        authorInitials: profile?.initials ?? '??',
        authorRole: profile?.role ?? 'member',
        body: r.body,
        createdAt: r.created_at,
    };
}
export async function deleteComment(id) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { error } = await supabase
        .from('comments')
        .delete()
        .eq('id', id);
    if (error)
        throw new Error(error.message);
}
