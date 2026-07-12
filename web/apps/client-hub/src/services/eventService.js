import { supabase } from '../lib/supabase';
export async function trackEvent(assetId, eventType, userId, role) {
    if (!supabase)
        return;
    await supabase
        .from('asset_events')
        .insert({ asset_id: assetId, event_type: eventType, user_id: userId || null, role });
}
export async function fetchEventCounts(assetId) {
    if (!supabase)
        return { views: 0, downloads: 0 };
    const { data } = await supabase
        .from('asset_events')
        .select('event_type')
        .eq('asset_id', assetId);
    const rows = (data ?? []);
    return {
        views: rows.filter(r => r.event_type === 'view').length,
        downloads: rows.filter(r => r.event_type === 'download').length,
    };
}
