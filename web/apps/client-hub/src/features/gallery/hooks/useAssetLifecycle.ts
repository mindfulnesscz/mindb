/* Status, permission and deletion for one asset — the staff-only write actions.
 *
 * `perm` is an access boundary, not a label, and it is only half of one: access is decided by
 * `perm` and `status` together (see assetOptions.ts), so changing either here changes who can reach
 * the asset AND, once delivery is gated, which R2 key its bytes live under. Local state mirrors the
 * server optimistically and RESETS on asset change, so a stale value from the previous asset can
 * never be shown as current.
 *
 * NOTE: this writes ONE row. A gallery parent and its children, or a primary and its variants, are
 * separate rows and do not follow each other — see the family-consistency note in
 * supabase/audit/perm_family_mismatch.sql.
 *
 * Deletion is the one destructive action here and is confirm-gated. Note it does NOT clear
 * `deleteBusy` on success: the panel closes, so releasing the button would only re-enable a control
 * that is about to unmount.
 */

import { useEffect, useState } from 'react'
import type { Asset } from '@sotto/asset-library'
import { updateAssetStatus, updateAssetPerm, deleteAssetAndMedia } from '../../../services/assetService'
import { StreamReleaseError } from '../../../services/streamRelease'
import { reconcileCdnObjects } from '../../../services/cdnReconcile'
import { reportError } from '../../../lib/reportError'

export function useAssetLifecycle(
  asset: Asset,
  onStatusChange?: () => void,
  onClose?: () => void,
  /** Rendition siblings of this asset, so a perm change can move the whole set. */
  variants: Asset[] = [],
) {
  const [currentStatus, setCurrentStatus] = useState<Asset['status']>(asset.status)
  const [currentPerm, setCurrentPerm] = useState<Asset['perm']>(asset.perm)
  const [statusBusy, setStatusBusy] = useState(false)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [permBusy, setPermBusy] = useState(false)
  /* A failed visibility write used to be logged and otherwise swallowed, so the selector kept
     showing the value the user picked while the database still held the old one. For an access
     boundary that is the worst possible failure mode: it reads as "this is now staff-only" when
     nothing changed. */
  const [permError, setPermError] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  /** Default ON: changing the level almost always means the deliverable, not the one file on
   *  screen. Unchecking it is the rare deliberate case — e.g. an internal print master. */
  const [applyToVariants, setApplyToVariants] = useState(true)

  /* A gallery child's level is its parent's, forced by a database trigger. Surfacing that here
     rather than letting the panel offer a control whose value snaps back on the next read. */
  const isGalleryChild = asset.parentId != null
  /** The primary of this rendition set: this row if it IS the primary, otherwise the one it hangs
   *  off. Null when the asset has no siblings and the choice is moot. */
  const variantFamilyPrimaryId = asset.variantOf ?? (variants.length > 0 ? asset.id : null)

  useEffect(() => {
    setCurrentStatus(asset.status)
    setCurrentPerm(asset.perm)
    setStatusError(null)
    setPermError(null)
    setApplyToVariants(true)

  }, [asset.id])

  async function changeStatus(newStatus: Asset['status']) {
    if (newStatus === currentStatus || statusBusy) return
    setStatusBusy(true)
    setStatusError(null)
    try {
      await updateAssetStatus(asset.id, newStatus)
      setCurrentStatus(newStatus)
      /* Status is half of the access level — draft or review makes an asset staff-only whatever
         `perm` says — so a status change moves bytes exactly as a visibility change does. */
      void reconcileCdnObjects()
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
    // Forced by the database anyway; refusing here keeps the UI honest instead of showing a value
    // that reverts on the next read.
    if (isGalleryChild) return
    setPermBusy(true)
    setPermError(null)
    try {
      await updateAssetPerm(
        asset.id, newPerm,
        applyToVariants ? variantFamilyPrimaryId : null,
      )
      setCurrentPerm(newPerm)
      /* The row is correct now; the OBJECT still sits at the old level's key until it is moved.
         Not awaited: the move takes as long as copying the bytes, and the person who just chose a
         visibility level should not watch a spinner for it. The queue is durable, so the worst case
         is that it completes a moment later. */
      void reconcileCdnObjects()
      /* Always refetch, not only on a family change. The grid holds its own copy of these rows,
         and a level it thinks is stale is a level it will keep showing — including to the person
         who just changed it, which is exactly how a change that DID apply looks like one that
         did not. */
      onStatusChange?.()
    } catch (err) {
      // Surfaced, not just logged: see setPermError above.
      setPermError(err instanceof Error ? err.message : 'Failed to update visibility')
      reportError('feedback.AssetDetail.updatePerm', err)
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
      /* Not a bare row delete: a video asset's Stream copy is billed for as long as it is held, and
         the row is the only record of which video was whose. Losing the row first strands the video
         permanently. See deleteAssetAndMedia. */
      await deleteAssetAndMedia(asset)
      onStatusChange?.()
      onClose?.()
    } catch (err) {
      /* Cloudflare unreachable is worth a second question rather than a dead end — refusing outright
         turns an outage into a record that can never be removed. */
      if (err instanceof StreamReleaseError && window.confirm(
        `${err.message}\n\nDelete the asset anyway? The video will keep costing Stream storage until `
        + 'it is deleted from the Cloudflare dashboard by hand.',
      )) {
        try {
          await deleteAssetAndMedia(asset, { force: true })
          onStatusChange?.()
          onClose?.()
          return
        } catch (forced) {
          setDeleteError(forced instanceof Error ? forced.message : 'Failed to delete asset')
          setDeleteBusy(false)
          return
        }
      }
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete asset')
      setDeleteBusy(false)
    }
  }

  return {
    currentStatus, currentPerm, statusBusy, statusError, permBusy, permError,
    deleteBusy, deleteError,
    changeStatus, approve, changePerm, removeAsset,
    isGalleryChild,
    variantCount: variants.length,
    canApplyToVariants: variantFamilyPrimaryId != null,
    applyToVariants, setApplyToVariants,
  }
}
