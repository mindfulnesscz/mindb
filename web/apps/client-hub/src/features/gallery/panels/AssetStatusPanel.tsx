/* Lifecycle controls: status, publicity, and the client-side approval decision.
 *
 * Three audiences in one panel, and the split is an authorization boundary rather than styling:
 *   - staff (admin/editor) get the status selector and the perm selector;
 *   - members see status READ-ONLY;
 *   - a client with approval rights gets the decision buttons.
 *
 * `perm` in particular is access control, not a label — `internal` is staff-only and `client` is
 * scoped to the owning tenant, both enforced by RLS. This panel must never offer a value the
 * server would refuse.
 */

import { canApprove, canControlPermission, canReadComments, type Asset, type Role } from '@dc-hub/asset-library'
import { STATUS_OPTIONS, PERM_OPTIONS } from '../assetOptions'

export interface AssetStatusPanelProps {
  role: Role
  isStaff: boolean
  accent: string
  currentStatus: Asset['status']
  currentPerm: Asset['perm']
  statusBusy: boolean
  statusError: string | null
  permBusy: boolean
  permError: string | null
  deleteBusy: boolean
  deleteError: string | null
  /** This row's level is forced to its gallery parent's by a DB trigger — show, don't offer. */
  isGalleryChild: boolean
  /** This asset has rendition siblings, so the change can cover the set. */
  canApplyToVariants: boolean
  variantCount: number
  applyToVariants: boolean
  setApplyToVariants: (v: boolean) => void
  onStatusChange: (s: Asset['status']) => void
  onPermChange: (p: Asset['perm']) => void
  onApprove: () => void
  onDelete: () => void
  note: string
  setNote: (v: string) => void
}

export function AssetStatusPanel({
  role, isStaff, accent,
  currentStatus, currentPerm, statusBusy, statusError, permBusy, deleteBusy, deleteError,
  permError, isGalleryChild, canApplyToVariants, variantCount, applyToVariants, setApplyToVariants,
  onStatusChange: handleStatusChange,
  onPermChange: handlePermChange,
  onApprove: handleApprove,
  onDelete: handleDelete,
  note, setNote,
}: AssetStatusPanelProps) {
  return (
    <>
        {/* Status management (admin/editor) */}
        {isStaff && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Status
            </p>
            <div className="flex gap-2 items-center">
              <select
                value={currentStatus}
                onChange={e => handleStatusChange(e.target.value as Asset['status'])}
                disabled={statusBusy}
                className="flex-1 text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {STATUS_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              {(currentStatus === 'review' || currentStatus === 'draft') && (
                <button
                  onClick={handleApprove}
                  disabled={statusBusy}
                  className="px-4 py-2 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ backgroundColor: accent, boxShadow: `3px 3px 0 #161616` }}
                >
                  {statusBusy ? '…' : '✓ Approve'}
                </button>
              )}
              {currentStatus === 'disconnected' && (
                <button
                  onClick={handleDelete}
                  disabled={deleteBusy}
                  className="px-4 py-2 text-sm font-sans font-semibold text-red-600 border border-red-600 rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {deleteBusy ? '…' : 'Delete permanently'}
                </button>
              )}
            </div>
            {statusError && (
              <p className="text-xs font-sans text-red-600">{statusError}</p>
            )}
            {deleteError && (
              <p className="text-xs font-sans text-red-600">{deleteError}</p>
            )}
          </div>
        )}

        {/* Status — read-only for members */}
        {!isStaff && canReadComments(role) && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Status
            </p>
            <span className="inline-block text-[11px] font-sans font-semibold uppercase tracking-label px-2.5 py-1 border border-border rounded-chip text-cosmos-black">
              {STATUS_OPTIONS.find(o => o.value === currentStatus)?.label ?? currentStatus}
            </span>
          </div>
        )}

        {/* Visibility. Editors and above — canControlPermission, not a bare isStaff, so the rule
            has one name and matches the `assets: staff write` policy the server enforces.
            A gallery child has no control of its own: its level is its parent's, forced by a DB
            trigger, so showing a live selector here would offer a change that silently reverts. */}
        {canControlPermission(role) && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Visibility
            </p>

            {isGalleryChild ? (
              <>
                <span className="inline-block text-[11px] font-sans font-semibold uppercase tracking-label px-2.5 py-1 border border-border rounded-chip text-cosmos-black">
                  {PERM_OPTIONS.find(o => o.value === currentPerm)?.label ?? currentPerm}
                </span>
                <p className="text-[11px] font-sans text-text-muted leading-snug">
                  Inherited from the gallery — every image in a gallery shares one level. To show
                  part of a shoot more widely, split it into its own gallery folder.
                </p>
              </>
            ) : (
              <>
                <select
                  value={currentPerm}
                  onChange={e => handlePermChange(e.target.value as Asset['perm'])}
                  disabled={permBusy}
                  className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 bg-bg text-cosmos-black focus:outline-none focus:border-cosmos-black transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {PERM_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>

                {/* Rendition siblings. On by default — "make this public" nearly always means the
                    deliverable, not the one file on screen. Off is the deliberate rare case. */}
                {canApplyToVariants && (
                  <label className="flex items-start gap-2 text-[11px] font-sans text-cosmos-black cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={applyToVariants}
                      onChange={e => setApplyToVariants(e.target.checked)}
                      disabled={permBusy}
                      className="mt-0.5 accent-cosmos-black"
                    />
                    <span>
                      Apply to all {variantCount > 0 ? `${variantCount + 1} ` : ''}versions
                      <span className="block text-text-muted">
                        {applyToVariants
                          ? 'Every format and size of this asset moves together.'
                          : 'Only this version changes — the others keep their current level.'}
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}

            {permError && (
              <p className="text-xs font-sans text-red-600">{permError}</p>
            )}
          </div>
        )}

        {/* Decision (client-side approval) */}
        {canApprove(role) && !isStaff && (
          <div className="space-y-2">
            <p className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
              Your decision
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleApprove}
                disabled={statusBusy}
                className="flex-1 py-2.5 text-sm font-sans font-semibold text-clear-white rounded-sm transition-all active:translate-y-px disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  backgroundColor: accent,
                  boxShadow: `5px 5px 0 #161616`,
                }}
              >
                {statusBusy ? '…' : '✓ Approve'}
              </button>
              <button className="flex-1 py-2.5 text-sm font-sans font-semibold border border-cosmos-black rounded-sm text-cosmos-black hover:bg-gray-100 transition-colors">
                ↩ Request changes
              </button>
            </div>
            <textarea
              value={note}
              onChange={e => setNote(e.target.value)}
              placeholder="Add a note for the team (optional)…"
              rows={2}
              className="w-full text-sm font-sans border border-border rounded-sm px-3 py-2 resize-none placeholder:text-text-subtle focus:outline-none focus:border-cosmos-black transition-colors"
            />
          </div>
        )}

    </>
  )
}
