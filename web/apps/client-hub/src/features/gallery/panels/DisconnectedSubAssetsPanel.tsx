/* Sub-assets whose file has left the disk — the one place they can be seen and cleared.
 *
 * WHY THIS EXISTS AT ALL. A gallery image or a rendition sibling is never its own top-level card:
 * the grid filters `parent_id`/`variant_of` out by design, because a gallery is one deliverable and
 * a variant set is one asset. When such a row goes `disconnected`, that same design makes it
 * invisible — the grid excludes it for being a sub-asset, its parent excluded it for being
 * disconnected, and the Disconnected status filter cannot show it either, since it applies the
 * top-level restriction too. The row then sits there indefinitely, holding an R2 object and possibly
 * a billed Stream video, with nothing in the product able to reach it.
 *
 * So it surfaces here, inside the parent it belongs to, rather than being promoted into the grid.
 * A removed image is not a deliverable and must not be browsable like one; it is a loose end, and a
 * loose end belongs next to the thing it hangs off.
 *
 * REMOVAL IS THE ONLY ACTION, and it is deliberately not "restore". A row comes back on its own the
 * moment the file returns to the folder — the pipeline matches on `(stable_id, child_id)` and
 * un-disconnects it (see exportWrite.ts). Offering a button that flipped `status` in the database
 * would produce a published asset with no file behind it, which the next sync would silently undo.
 */

import { useState } from 'react'
import type { Asset } from '@sotto/asset-library'
import { StreamReleaseError } from '../../../services/streamRelease'
import { useStreamMedia } from '../hooks/useStreamMedia'
import { AssetImage } from '../../../components/AssetImage'

export interface DisconnectedSubAssetsPanelProps {
  /** Gallery children that went missing — labelled as images. */
  staleChildren: Asset[]
  /** Rendition siblings that went missing — labelled as versions. */
  staleVariants: Asset[]
  onRemove: (asset: Asset, opts?: { force?: boolean }) => Promise<void>
}

export function DisconnectedSubAssetsPanel({
  staleChildren, staleVariants, onRemove,
}: DisconnectedSubAssetsPanelProps) {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const items = [
    ...staleChildren.map(asset => ({ asset, kind: 'Gallery image' })),
    ...staleVariants.map(asset => ({ asset, kind: 'Version' })),
  ]

  /* A disconnected video has no `thumbnail_url` — its frame lives on Stream — so without this the
     one kind of asset most worth eyeballing before deleting shows as a blank square. */
  const resolveStream = useStreamMedia(items.map(i => i.asset))

  if (items.length === 0) return null

  async function handleRemove(asset: Asset) {
    if (busyId) return
    if (!window.confirm(
      `Permanently delete "${asset.name}"?\n\n`
      + 'Its ratings, comments and download history go with it. This cannot be undone.',
    )) return

    setBusyId(asset.id)
    setErrors(e => ({ ...e, [asset.id]: '' }))
    try {
      await onRemove(asset)
    } catch (err) {
      /* A video that could not be handed back to Cloudflare is the one failure worth a second
         question rather than a dead end: refusing outright turns an outage into a permanently stuck
         record, and proceeding quietly leaves a billed video nothing will ever name again. */
      const retryable = err instanceof StreamReleaseError && window.confirm(
        `${err.message}\n\nRemove the record anyway? The video will keep costing Stream storage `
        + 'until it is deleted from the Cloudflare dashboard by hand.',
      )
      const finalErr = retryable
        ? await onRemove(asset, { force: true }).then(() => null, e => e)
        : err
      if (finalErr) setErrors(e => ({ ...e, [asset.id]: message(finalErr) }))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
        Disconnected · {items.length}
      </p>
      <p className="text-[11px] font-sans text-text-muted leading-snug">
        No longer in this client’s source folder. The record is kept so ratings, comments and
        history survive a temporary disk change — put the file back and the next sync reconnects it.
        Remove it only when the file is gone for good.
      </p>

      <ul className="space-y-1.5">
        {items.map(({ asset, kind }) => {
          const media = asset.streamUid ? resolveStream(asset) : null
          const src = asset.thumbnailUrl ?? media?.still
          return (
            <li
              key={asset.id}
              className="flex items-center gap-2.5 border border-border rounded-sm p-2 bg-gray-150/40"
            >
              <div className="w-10 h-10 shrink-0 rounded-sm overflow-hidden bg-gray-150 flex items-center justify-center">
                {src
                  ? <AssetImage
                      src={src}
                      alt={asset.name}
                      className="w-full h-full object-cover opacity-60"
                      fallbackClassName="w-full h-full"
                      compact
                    />
                  : <span className="text-text-muted text-[13px] leading-none">
                      {asset.streamUid ? '🎞' : '⦾'}
                    </span>
                }
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-[12px] font-sans font-medium text-cosmos-black truncate" title={asset.name}>
                  {asset.name}
                </p>
                <p className="text-[10px] font-sans uppercase tracking-label text-text-muted">
                  {kind} · Disconnected
                </p>
                {errors[asset.id] && (
                  <p className="text-[11px] font-sans text-red-600 mt-0.5">{errors[asset.id]}</p>
                )}
              </div>

              <button
                type="button"
                onClick={() => handleRemove(asset)}
                disabled={busyId !== null}
                title="Delete this record permanently"
                className="shrink-0 text-[11px] font-sans font-semibold text-red-600 border border-red-600 rounded-sm px-2.5 py-1.5 transition-all active:translate-y-px hover:bg-red-50 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {busyId === asset.id ? '…' : 'Remove'}
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : 'Failed to remove'
}
