/* Status display names and the per-audience status key lists.
 *
 * Staff and clients see DIFFERENT keys: a client must never be offered `archived` or
 * `disconnected`, which are internal lifecycle states.
 */
import type { Asset } from '@dc-hub/asset-library'

export const STATUS_LABELS: Record<string, string> = {
  draft:        'Draft',
  review:       'In review',
  approved:     'Approved',
  published:    'Published',
  archived:     'Archived',
  disconnected: 'Disconnected',
}

// ── Asset card ────────────────────────────────────────────────


export const STATUS_KEYS_STAFF: Asset['status'][]  = ['review', 'approved', 'published', 'draft', 'archived', 'disconnected']
export const STATUS_KEYS_CLIENT: Asset['status'][] = ['review', 'approved', 'published', 'draft']

