/* Loading and empty states for the gallery.
 *
 * `EmptyReason` matters more than it looks: "nothing here", "your filters excluded everything" and
 * "you cannot see these" are three different messages, and the wrong one makes a permissions
 * problem look like an empty account.
 */




export function CardSkeleton() {
  return (
    <div className="border border-border rounded-sm overflow-hidden bg-surface animate-pulse">
      <div className="aspect-square bg-gray-150" />
      <div className="p-3 space-y-2">
        <div className="h-3.5 bg-gray-150 rounded-chip w-3/4" />
        <div className="h-3 bg-gray-150 rounded-chip w-1/2" />
      </div>
    </div>
  )
}

// ── Empty states ──────────────────────────────────────────────


export type EmptyReason = 'no-assets' | 'filtered' | 'no-access'

export function EmptyState({ reason }: { reason: EmptyReason }) {
  const copy: Record<EmptyReason, { heading: string; body: string }> = {
    'no-assets':  { heading: 'No assets yet.',        body: 'Nothing has been delivered to this workspace yet.' },
    'filtered':   { heading: 'No matches.',           body: 'Nothing fits the current filters. Try clearing some.' },
    'no-access':  { heading: 'Nothing to see here.',  body: "You don't have access to any assets in this workspace." },
  }
  const { heading, body } = copy[reason]
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <p className="font-serif text-xl font-medium text-cosmos-black mb-2">{heading}</p>
      <p className="font-sans text-sm text-text-muted">{body}</p>
    </div>
  )
}

// ── Detail drawer, before there is an asset to put in it ──────
/* Only reachable by ADDRESS. Clicking a card always has the row in hand, so these two states exist
 * purely for `/:slug/a/:assetId` arrived at cold — a forwarded link, a reload, a bookmark. Both
 * occupy the drawer's footprint rather than replacing the grid: the grid behind them is still a
 * usable page, and swapping it for a full-page error would throw away a working view because one
 * link was stale. */

/** Matches AssetDetail's own drawer footprint, so the panel does not resize when the asset lands. */
const DRAWER = 'w-[400px] shrink-0 border-l border-border h-full overflow-y-auto bg-surface'

export function DetailSkeleton() {
  return (
    <aside className={DRAWER} aria-busy="true">
      <div className="p-5 space-y-4 animate-pulse">
        <div className="aspect-square bg-gray-150 rounded-sm" />
        <div className="h-4 bg-gray-150 rounded-chip w-2/3" />
        <div className="h-3 bg-gray-150 rounded-chip w-1/3" />
        <div className="h-3 bg-gray-150 rounded-chip w-1/2" />
      </div>
    </aside>
  )
}

/**
 * The link resolves to nothing this viewer can see.
 *
 * ONE message for "no such asset" and "not yours", because RLS returns nothing in both cases and
 * this component must not try to tell them apart — distinguishing them would confirm the existence
 * of an asset the viewer may not see, from the client, where nothing can be enforced anyway.
 */
export function DetailNotAvailable({ onClose }: { onClose: () => void }) {
  return (
    <aside className={DRAWER}>
      <div className="flex items-center justify-between px-5 h-11 border-b border-border">
        <span className="text-[10px] font-sans font-bold uppercase tracking-label text-text-muted">
          Asset
        </span>
        <button
          onClick={onClose}
          className="text-lg leading-none text-text-muted hover:text-cosmos-black transition-colors"
          aria-label="Close"
        >
          ×
        </button>
      </div>
      <div className="px-5 py-8 text-center">
        <p className="font-serif text-lg font-medium text-cosmos-black mb-2">Not available.</p>
        <p className="font-sans text-sm text-text-muted">
          This link points at an asset that no longer exists, or that isn't shared with you.
        </p>
      </div>
    </aside>
  )
}

// ── Filters rail ──────────────────────────────────────────────

