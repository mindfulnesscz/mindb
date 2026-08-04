/* The two query params that belong to the detail drawer rather than to the grid.
 *
 * Kept apart from `FILTER_PARAMS` (`@sotto/asset-library/filterUrl`) because they are scoped to
 * `/:slug/a/:assetId` and are not part of `FilterState` — `useFilterParams` treats them as foreign
 * and preserves them untouched, which is what lets a filter change happen without closing the
 * lightbox.
 *
 * IDS, NOT INDICES. `focus` carries the child's or variant's own id, because an index is meaningless
 * the moment a sibling is added or disconnected — a shared link would then open a different image
 * than the one that was shared. `useAssetChildren` already resolves an id to a carousel position;
 * there is deliberately no carousel-position param.
 *
 * As with the filter params, these names appear in links that are already out. `v` is not available
 * and never will be: it is the content-hash cache-buster on asset CDN URLs.
 */

export const DETAIL_PARAMS = {
  /** Child or variant of `:assetId` to focus. */
  focus: 'focus',
  /** `1` — open the lightbox on the focused item. */
  lightbox: 'lb',
} as const

export interface DetailState {
  focusId?: string
  lightbox: boolean
}

export function readDetailParams(search: string): DetailState {
  const params = new URLSearchParams(search)
  return {
    focusId: params.get(DETAIL_PARAMS.focus) || undefined,
    // Only the literal '1', for the same reason `latest` is strict: a guessed value should read as
    // "not set" rather than silently opening a lightbox over the view.
    lightbox: params.get(DETAIL_PARAMS.lightbox) === '1',
  }
}

/**
 * Rewrite just these two params, leaving every other one — the whole filter set included — in place
 * and in order.
 *
 * Omitting a field CLEARS it. There is no partial update: both values are set together at every
 * call site (opening an asset, selecting a variant, opening the lightbox), and a merge-by-default
 * would make "close the lightbox" the one operation that could not be expressed.
 */
export function writeDetailParams(search: string, next: Partial<DetailState>): string {
  const params = new URLSearchParams(search)
  params.delete(DETAIL_PARAMS.focus)
  params.delete(DETAIL_PARAMS.lightbox)
  if (next.focusId) params.append(DETAIL_PARAMS.focus, next.focusId)
  if (next.lightbox) params.append(DETAIL_PARAMS.lightbox, '1')
  return params.toString()
}
