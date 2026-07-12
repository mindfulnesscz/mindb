import { supabase } from '../lib/supabase';
export async function fetchAllUsers() {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { data, error } = await supabase.rpc('get_all_profiles');
    if (error)
        throw new Error(error.message);
    return (data ?? []).map(r => ({
        id: r.id,
        name: r.name,
        initials: r.initials,
        role: r.role,
        clientId: r.client_id,
        clientName: r.client_name,
        email: r.email,
        createdAt: r.created_at,
    }));
}
export async function updateUserRole(userId, role) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { error } = await supabase.rpc('update_user_role', {
        p_user_id: userId,
        p_role: role,
    });
    if (error)
        throw new Error(error.message);
}
