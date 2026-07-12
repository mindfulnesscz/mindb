import { supabase } from '../lib/supabase';
export async function fetchMyRating(assetId, userId) {
    if (!supabase)
        return 0;
    const { data, error } = await supabase
        .from('ratings')
        .select('value')
        .eq('asset_id', assetId)
        .eq('user_id', userId)
        .limit(1)
        .maybeSingle();
    if (error) {
        console.error('fetchMyRating error:', error.message);
        return 0;
    }
    return data?.value ?? 0;
}
export async function upsertRating(assetId, userId, value) {
    if (!supabase)
        throw new Error('Supabase not configured');
    const { error } = await supabase
        .from('ratings')
        .upsert({ asset_id: assetId, user_id: userId, value }, { onConflict: 'asset_id,user_id' });
    if (error)
        throw new Error(error.message);
}
