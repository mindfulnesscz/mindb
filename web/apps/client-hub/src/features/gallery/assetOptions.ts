/* The status and permission choices staff can set on an asset.
 *
 * `perm` is an access boundary, not a label, and these two lists together decide it: the level that
 * actually gates both row discovery and byte delivery is `perm` AND `status` combined —
 *
 *     effective_level = (status in ('approved','published')) ? perm : 'internal'
 *
 * — so setting `public` on a `draft` asset grants nothing until it is approved. That is deliberate:
 * it is what stops unapproved work being published by a stray dropdown. RLS enforces the same rule
 * on discovery and the same value is encoded in the R2 object key for delivery, so these lists must
 * stay in step with `packages/asset-library/src/permissions.ts` and the migration that defines it.
 */

import type { Asset } from '@sotto/asset-library'

export const STATUS_OPTIONS: { value: Asset['status']; label: string }[] = [
  { value: 'draft',        label: 'Draft' },
  { value: 'review',       label: 'In review' },
  { value: 'approved',     label: 'Approved' },
  { value: 'published',    label: 'Published' },
  { value: 'archived',     label: 'Archived' },
  { value: 'disconnected', label: 'Disconnected' },
]

/* Ordered widest-open first, so the list reads as a ladder rather than a set of flags. The labels
   say WHO, not what the value is called — "Public" alone gave no hint that it means anyone on the
   internet holding the URL, which is the choice most worth being unambiguous about. */
export const PERM_OPTIONS: { value: Asset['perm']; label: string }[] = [
  { value: 'public',   label: 'Public — anyone with the link' },
  { value: 'guest',    label: 'Guest — anyone signed in' },
  { value: 'client',   label: 'Client — this client, plus staff' },
  { value: 'internal', label: 'Internal — staff only' },
]
