/* The status and permission choices staff can set on an asset.
 *
 * `perm` is an access boundary, not a label: `internal` is staff-only and `client` is scoped to the
 * owning tenant, both enforced by RLS. The lists here must stay in step with those policies.
 */

import type { Asset } from '@dc-hub/asset-library'

export const STATUS_OPTIONS: { value: Asset['status']; label: string }[] = [
  { value: 'draft',        label: 'Draft' },
  { value: 'review',       label: 'In review' },
  { value: 'approved',     label: 'Approved' },
  { value: 'published',    label: 'Published' },
  { value: 'archived',     label: 'Archived' },
  { value: 'disconnected', label: 'Disconnected' },
]

export const PERM_OPTIONS: { value: Asset['perm']; label: string }[] = [
  { value: 'public',   label: 'Public' },
  { value: 'client',   label: 'Client' },
  { value: 'internal', label: 'Internal' },
]
