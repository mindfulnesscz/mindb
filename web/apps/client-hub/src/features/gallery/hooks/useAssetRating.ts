/* The viewer's own rating for one asset.
 *
 * One vote per person per asset is enforced by the DATABASE (`unique (asset_id, user_id)`) and the
 * portal upserts on that conflict, so changing a vote updates the single row rather than adding a
 * second. Guests — signed-in users with no client — may rate public assets; `canRate` allows
 * everyone and RLS decides what they can actually reach.
 */

import { useEffect, useState } from 'react'
import { canRate, type Role } from '@dc-hub/asset-library'
import { fetchMyRating, upsertRating } from '../../../services/ratingService'
import { reportError } from '../../../lib/reportError'
import { isConfigured } from '../../../lib/supabase'

export function useAssetRating(assetId: string, userId: string | null, role: Role) {
  const [myRating, setMyRating] = useState(0)
  const [ratingSaved, setRatingSaved] = useState(false)

  useEffect(() => {
    if (!userId || !canRate(role)) return
    if (!isConfigured()) return
    fetchMyRating(assetId, userId).then(setMyRating)
      .catch(e => reportError('feedback.AssetDetail.fetchMyRating', e))
  }, [assetId, userId, role])

  async function changeRating(value: number) {
    setMyRating(value)          // optimistic: the star fills immediately
    if (!userId) return
    try {
      await upsertRating(assetId, userId, value)
      setRatingSaved(true)
      setTimeout(() => setRatingSaved(false), 2000)
    } catch (err) {
      reportError('feedback.AssetDetail.saveRating', err)
    }
  }

  return { myRating, ratingSaved, changeRating }
}
