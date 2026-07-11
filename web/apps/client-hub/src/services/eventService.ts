import { supabase } from '../lib/supabase'

export interface EventCounts {
  views: number
  downloads: number
}

export async function trackEvent(
  assetId: string,
  eventType: 'view' | 'download',
  userId: string | null,
  role: string,
): Promise<void> {
  if (!supabase) return
  await (supabase as any)
    .from('asset_events')
    .insert({ asset_id: assetId, event_type: eventType, user_id: userId || null, role })
}

export async function fetchEventCounts(assetId: string): Promise<EventCounts> {
  if (!supabase) return { views: 0, downloads: 0 }
  const { data } = await (supabase as any)
    .from('asset_events')
    .select('event_type')
    .eq('asset_id', assetId)
  const rows = (data ?? []) as { event_type: string }[]
  return {
    views:     rows.filter(r => r.event_type === 'view').length,
    downloads: rows.filter(r => r.event_type === 'download').length,
  }
}
