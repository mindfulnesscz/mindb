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

// ── Filters rail ──────────────────────────────────────────────

