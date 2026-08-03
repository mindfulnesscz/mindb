/* Which sibling is focused inside the detail, and whether the lightbox is up.
 *
 * CONTROLLED when the mount supplies `onChange`, LOCAL otherwise. Both mounts are real:
 *
 * — the portal's drawer keeps both values in the URL (`?focus=…&lb=1`), so it passes a callback and
 *   the props are the truth. Anything else would give two sources for one fact, and the URL would
 *   lose whichever race it was in.
 * — `/share/:id` has no route of its own to write to and passes nothing. Without the local fallback
 *   its lightbox would open and snap shut on the next render, because the prop it was reading from
 *   never changed.
 *
 * ONE value, ONE callback — not `onFocusChange` plus `onLightboxChange`. The portal's implementation
 * navigates, and two navigations in the same handler each read the pre-navigation URL, so the second
 * silently wins (the same trap `useFilterParams` documents at length). A whole-value update cannot
 * express that bug.
 */

import { useEffect, useState } from 'react'
import type { DetailState } from '../detailUrl'

export interface DetailFocus extends DetailState {
  /** Focus a sibling by id — `undefined` means the parent itself. `lightbox` defaults to unchanged. */
  setFocus: (focusId: string | undefined, opts?: { lightbox?: boolean }) => void
  closeLightbox: () => void
}

export function useDetailFocus(
  assetId: string,
  props: {
    focusAssetId?: string
    lightbox?: boolean
    onChange?: (next: DetailState) => void
  },
): DetailFocus {
  const controlled = props.onChange !== undefined
  const [local, setLocal] = useState<DetailState>({
    focusId: props.focusAssetId,
    lightbox: !!props.lightbox,
  })

  // Uncontrolled only: a different asset means a fresh start. In controlled mode the props already
  // carry the change, and writing state here would be a second copy of it.
  useEffect(() => {
    if (!controlled) setLocal({ focusId: props.focusAssetId, lightbox: !!props.lightbox })
  }, [assetId, controlled])

  const state: DetailState = controlled
    ? { focusId: props.focusAssetId, lightbox: !!props.lightbox }
    : local

  function commit(next: DetailState) {
    if (props.onChange) props.onChange(next)
    else setLocal(next)
  }

  return {
    ...state,
    setFocus: (focusId, opts) =>
      commit({ focusId, lightbox: opts?.lightbox ?? state.lightbox }),
    closeLightbox: () => commit({ focusId: state.focusId, lightbox: false }),
  }
}
