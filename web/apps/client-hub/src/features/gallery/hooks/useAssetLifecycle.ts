/* Status, permission and deletion for one asset — the staff-only write actions.
 *
 * `perm` is an access boundary, not a label: `internal` is staff-only and `client` is scoped to the
 * owning tenant, both enforced by RLS. Local state mirrors the server optimistically and RESETS on
 * asset change, so a stale value from the previous asset can never be shown as current.
 *
 * Deletion is the one destructive action here and is confirm-gated. Note it does NOT clear
 * `deleteBusy` on success: the panel closes, so releasing the button would only re-enable a control
 * that is about to unmount.
 */

import { useEffect, useState } from 'react'
import type { Asset } from '@dc-hub/asset-library'
import { updateAssetStatus, updateAssetPerm, deleteAsset } from '../../../services/assetService'
import { reportError } from '../../../lib/reportError'

export function useAssetLifecycle(
  asset: Asset,
  onStatusChange?: () => void,
  onClose?: () => void,
) {
  const [currentStatus, setCurrentStatus] = useState<Asset['status']>(asset.status)
  const [currentPerm, setCurrentPerm] = useState<Asset['perm']>(asset.perm)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [permBusy, setPermBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setCurrentStatus(asset.status)
    setCurrentPerm(asset.perm)
    setStatusError(null)
     
  }, [asset.id])

  async function changeStatus(newStatus: Asset['status']) {
    if (newStatus === currentStatus || statusBusy) return
    setStatusBusy(true)
    setStatusError(null)
    try {
      await updateAssetStatus(asset.id, newStatus)
      setCurrentStatus(newStatus)
      onStatusChange?.()
    } catch (err) {
      setStatusError(err instanceof Error ? err.message : 'Failed to update status')
    } finally {
      setStatusBusy(false)
    }
  }

  const approve = () => changeStatus('approved')

  async function changePerm(newPerm: Asset['perm']) {
    if (newPerm === currentPerm || permBusy) return
    setPermBusy(true)
    try {
      await updateAssetPerm(asset.id, newPerm)
      setCurrentPerm(newPerm)
    } catch (err) {
      reportError('AssetDetail.updatePerm', err)
    } finally {
      setPermBusy(false)
    }
  }

  async function removeAsset() {
    if (deleteBusy) return
    if (!window.confirm(`Permanently delete "${asset.name}"? This cannot be undone.`)) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await deleteAsset(asset.id)
      onStatusChange?.()
      onClose?.()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete asset')
      setDeleteBusy(false)
    }
  }

  return {
    currentStatus, currentPerm, statusBusy, statusError, permBusy, deleteBusy, deleteError,
    changeStatus, approve, changePerm, removeAsset,
  }
}
