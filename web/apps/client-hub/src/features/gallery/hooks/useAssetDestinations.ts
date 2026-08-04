/* Cloud share links and the desktop "Reveal in Finder" bridge, role-gated.
 *
 * A stored download link whose destination definition is missing is shown to STAFF ONLY: it may
 * point somewhere a client should not see, and the definition is what carries that judgement.
 * Failing closed is the only safe default.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Asset, Role } from '@sotto/asset-library'
import {
  fetchDestinations, destinationsVisibleToRole, roleAtLeast, type PortalDestination,
} from '../../../services/destinationService'
import { isConfigured } from '../../../lib/supabase'
import { revealInDesktop } from '../../../services/revealService'

export function useAssetDestinations(
  activeClientId: string | undefined,
  role: Role,
  isStaff: boolean,
  selectedAsset: Asset,
  asset: Asset,
) {
  const [destinations, setDestinations] = useState<PortalDestination[]>([])
  const [revealBusy, setRevealBusy] = useState(false)
  const [revealMsg, setRevealMsg] = useState('')

  // Definitions are per client, so this refetches on client switch and nothing else.
  useEffect(() => {
    if (!activeClientId || !isConfigured()) return
    fetchDestinations(activeClientId).then(setDestinations).catch(() => setDestinations([]))
  }, [activeClientId])

  const visibleDests = useMemo(
    () => destinationsVisibleToRole(destinations, role),
    [destinations, role],
  )

  const cloudLinks = useMemo(() => {
    const urls = selectedAsset.downloadUrls ?? []
    if (urls.length === 0) return []
    return urls.filter(link => {
      const dest = visibleDests.find(d =>
        (link.destId && d.id === link.destId) || d.name === link.name,
      )
      // Unknown dest (a stored link with no matching definition): staff only.
      if (!dest) return isStaff
      return true
    })
  }, [selectedAsset.downloadUrls, visibleDests, isStaff])

  const canReveal = useMemo(() => {
    const sid = selectedAsset.stableId ?? asset.stableId
    if (!sid) return false
    // Staff can always try Reveal when the package has a stable id (desktop bridge).
    if (isStaff) return true
    return destinations.some(d =>
      d.enabled && d.allowRevealLocal && roleAtLeast(role, d.minRole),
    )
  }, [destinations, role, selectedAsset.stableId, asset.stableId, isStaff])

  return {
    destinations, visibleDests, cloudLinks, canReveal,
    revealBusy, setRevealBusy, revealMsg, setRevealMsg, revealInDesktop,
  }
}
