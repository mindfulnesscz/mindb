/* The portal's one query cache.
 *
 * Module-level, so it outlives any component and is shared by every hook — that is what makes Back
 * and Forward render from cache instead of re-querying PostgREST.
 *
 * `refetchOnWindowFocus: false` because a portal is a browsing surface, not a dashboard. Refetching
 * every time someone tabs back from their mail client is noise on screen and a bill at the database,
 * and nothing here is a live figure that going stale would misinform anyone about.
 *
 * `retry: 1` — one retry covers a dropped connection; more turns a genuine failure (a bad filter, an
 * RLS denial) into a slow one, with the error still arriving in the end.
 */

import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
})
