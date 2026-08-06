/* View tracking, and the counts staff see.
 *
 * The view event is recorded for EVERY viewer (that is the point of the counter), but the counts
 * are fetched only for staff — a client has no business seeing another viewer's activity.
 */

import { useEffect, useState } from 'react'
import type { Role } from '@sotto/asset-library'
import { trackEvent, fetchEventCounts, type EventCounts } from '../../../services/eventService'
import { reportError } from '../../../lib/reportError'
import { isConfigured } from '../../../lib/supabase'

export function useAssetEvents(assetId: string, userId: string | null, role: Role, isStaff: boolean) {
  const [eventCounts, setEventCounts] = useState<EventCounts>({ views: 0, downloads: 0 })

  // Keyed on assetId ALONE, deliberately: re-running on role or userId would double-count a view.
  useEffect(() => {
    if (!isConfigured()) return
    trackEvent(assetId, 'view', userId, role).catch(() => {})
    if (isStaff) fetchEventCounts(assetId).then(setEventCounts)
      .catch(e => reportError('feedback.AssetDetail.fetchEventCounts', e))
     
  }, [assetId])

  /** Optimistic bump so the count moves the instant the user clicks Download. */
  const bumpDownloads = () => setEventCounts(c => ({ ...c, downloads: c.downloads + 1 }))

  return { eventCounts, bumpDownloads }
}
