# Work log — URL routing, shareable views, and a real data cache

Companion to `CLAUDE_CODE_PROMPT_url-routing.md`. **That file is the spec; this one is the state.**
Read the spec for *why*; read this for *where the work got to and what was learned doing it*.

Branch: **`feature/routing`** — not `dev/v3.1-url-routing` as the spec says. The branch was already
checked out and named for this work when the task started; renaming it would have orphaned the
existing checkout for no gain. Everything else in the spec holds.

## How to verify, at any point

```bash
npx vitest run                       # all packages + portal unit/component tests (fast, ~2s)
npx vitest run <path>                # one file
npm run typecheck --workspace=web/apps/client-hub
npx eslint <path> --max-warnings 0
npm run check                        # the full gate — needs cargo + docs deps, slow
npm run test:e2e                     # needs the local Supabase stack + dev server
```

## Phase status

| Phase | What | State |
|---|---|---|
| 0 | Characterization tests for `GalleryView` | ✅ done |
| 1 | URL state primitives (`filterUrl.ts`, `useFilterParams`) | ✅ done |
| 2 | Filters in the URL | ✅ done |
| 3 | `/:slug/a/:assetId` detail route | ✅ done |
| 4 | `focus` / `lb` params | ✅ done |
| 5 | TanStack Query | ✅ done — version bumped to **3.1.0** |
| 6 | `/share/:id` becomes real | ⬜ not started |

---

## Phase 0 — characterization tests ✅

`web/apps/client-hub/src/features/gallery/GalleryView.characterization.test.tsx` — 22 tests, green
against **unmodified** `GalleryView`. No production file touched.

What is pinned, beyond the spec's list:

- tag OR-within-a-dimension, unchecking, status checkbox, clearing search
- the search input reflects keystrokes (so a Phase 2 debounce cannot be implemented by making the
  box uncontrolled)
- the filtered empty state (`No matches.`) rather than the no-access one
- the option pool is *fetched* with default filters — the mechanism, asserted directly on the
  `filters` object each `useAssets` call receives, not just its visible effect
- a drawer opened on an asset that a later filter excludes **closes**. That is today's behaviour
  (the open asset is resolved out of the current list). Pinned as fact, not preference — if Phase 3
  changes it, that is a deliberate change and this test is the place to argue it.
- role gates: a member sees no `internal`-level asset; staff are offered `archived`/`disconnected`
  in the rail and a member is not

### Things learned writing it — do not re-derive

- **`@dc-hub/database` needs no vitest alias.** The spec flagged this as unverified. It resolves
  through the workspace symlink to `./src/index.ts` and Vitest transforms it fine. Probed with a
  throwaway test; no config change needed.
- **`AssetDetail` is stubbed to its props**, not booted with its eight service mocks. It has its own
  characterization suite next door; what this file is about is *which* asset the gallery hands it,
  with what `focusAssetId` / `autoOpenLightbox`. The stub exposes those as `data-asset-id`,
  `data-focus-id`, `data-lightbox` — which is exactly the surface Phases 3 and 4 change, so those
  phases get their assertions for free.
- **Every assertion is `waitFor`ed.** Filtering is synchronous today and becomes a navigation plus a
  ~250 ms search debounce. A synchronous `expect` would pass now and fail in Phase 2 for a reason
  that is not a behaviour change — which would destroy the "passes unedited" signal.
- **Status labels collide with card chips.** `getByText('Approved')` matches both the rail checkbox
  and the status chip on every approved card. `railCheckbox()` therefore scopes to
  `getByRole('complementary')` (the `<aside>`). Same trap for `Archived`/`Disconnected`.
- **`useTags` is stubbed empty on purpose.** With no DB tags the rail derives its options from the
  unfiltered option pool, which is the `stableFilters` path the spec asks to pin. Stub it non-empty
  and that test silently stops testing anything.
- **The router harness already declares `:slug/a/:assetId`**, which does not exist in `App.tsx`
  until Phase 3. Deliberate — see the file header.
- Fixture `Gamma` is `status: 'draft'` so exactly one asset separates staff from members. It is
  also `latest: false`, so it carries the `latestOnly` case too.

---

## Phase 1 — URL state primitives ✅

Nothing is wired up yet: no production behaviour changed, because nothing imports `useFilterParams`.

| File | What |
|---|---|
| `packages/asset-library/src/types.ts` | `ASSET_STATUSES`, `ASSET_PERMS`, `ENTITY_TYPES` as const arrays, types derived from them |
| `packages/asset-library/src/filterUrl.ts` | `FILTER_PARAMS`, `filtersToSearchParams`, `searchParamsToFilters`, `filterCacheKey` |
| `packages/asset-library/src/filterUrl.test.ts` | 46 tests |
| `web/apps/client-hub/src/hooks/useFilterParams.ts` | the React binding |
| `web/apps/client-hub/src/hooks/useFilterParams.test.tsx` | 16 tests |
| `eslint.config.js` | ignore `**/.temp/**` and `**/.wrangler/**` — see below |

### Decisions taken while implementing

- **Spaces encode as `+`, not `%20`.** The spec's table shows `q=chair%20oak`; `URLSearchParams`
  emits `q=chair+oak`. That is correct `application/x-www-form-urlencoded` and it round-trips
  through the same class, so it was left alone — hand-rolling the encoding to match the spec's
  illustration would risk a serialize/parse mismatch for cosmetics. Pinned by the `A+B` tag test.
- **Repeated values are de-duplicated as well as sorted.** Not in the spec, but `?entity=A&entity=A`
  and `?entity=A` are the same filter, and without dedupe they would be two cache keys.
- **Empty repeated values are dropped.** `?entity=` is a truncated link, not a filter for the empty
  tag.
- **`STATUS_KEYS_STAFF` was NOT re-derived from `ASSET_STATUSES`.** The spec lists it as optional.
  The two lists hold the same six values in different orders, and `STATUS_KEYS_STAFF`'s order is the
  rail's display order — deriving it would silently reorder the UI, which is not what this phase is
  for. The duplication is still there and is still worth removing, deliberately, later.
- **`useFilterParams` keeps a ref mirror of `{search, hash}`**, assigned during render *and*
  synchronously inside the setter. A `useEffect` sync would be too late: it runs after paint, and
  the second setter call in one handler needs the first one's result immediately. This is what makes
  the "two setter calls both land" test pass.
- **The setter omits `pathname`.** The router resolves a partial path against the current location,
  so the same hook works unchanged on `/:slug` and `/:slug/a/:assetId` — no `slug` needed.

### Repo hygiene fix included

`npm run lint` failed with ~213 errors on any machine that had run `supabase start` or
`wrangler dev`: eslint was linting bundled vendor code in `supabase/.temp/` and
`workers/cdn-gate/.wrangler/tmp/`. Both are gitignored, so CI never saw them and the gate was red
only for developers — which is how a gate gets skipped. Added to eslint's `ignores`. This was found
because the spec asks for `npm run check` green at every phase and it could not be run at all.

### Verified while doing it

- **History is asserted via `useNavigationType()`, not `window.history.length`.** `MemoryRouter`
  never touches `window.history`, so a length check in a jsdom test passes no matter what the hook
  does. Any future "does it push or replace?" test must use the navigation type.

---

## Phase 2 — filters in the URL ✅

Three production edits, one new test file.

- `GalleryView.tsx` — `useState<FilterState>` → `useFilterParams()`, one line. No prop signature
  changed anywhere downstream, as the spec predicted.
- `GalleryView.tsx` — the toolbar search is debounced at 250 ms (`SEARCH_DEBOUNCE_MS`).
- `ClientPortalPage.tsx:228` — `replaceState` now keeps `window.location.search`.
- `GalleryView.url.test.tsx` — 16 tests: cold load, interaction → URL, debounce, history.

**Phase 0's 22 characterization tests pass unedited.** That is the acceptance criterion and it held
with no adjustment at all.

### The debounce, precisely

Two effects, not one timer plus a ref:

```ts
const [searchDraft, setSearchDraft] = useState(filters.search)
useEffect(() => { setSearchDraft(filters.search) }, [filters.search])   // adopt external changes
useEffect(() => {                                                       // trailing edge
  if (searchDraft === filters.search) return
  const t = setTimeout(() => setFilters(f => ({ ...f, search: searchDraft })), 250)
  return () => clearTimeout(t)
}, [searchDraft, filters.search, setFilters])
```

The first effect is what makes Back, Clear and a cold load put text *into* the box; the second is
what keeps the box from writing per keystroke. The equality guard stops a pointless navigate on
mount. `setFilters` is stable (`useCallback` on `[navigate]`), so it is safe in a dep list —
that was one of the stated reasons not to build the hook on `useSearchParams`.

### Testing notes for whoever extends this

- **`visited[]`** in `GalleryView.url.test.tsx` records every distinct URL the router has been at.
  Use it to assert "this interaction produced ONE url", which a final-value check cannot distinguish
  from "it produced five and the last one was right". That is how the debounce is actually pinned.
- **`GalleryView.characterization.test.tsx` is not to be edited.** New behaviour goes in
  `GalleryView.url.test.tsx` (or a new sibling). If a phase makes a characterization test fail, that
  is the signal to stop, not to adjust the test.
- Under `MemoryRouter`, clearing the last filter leaves `location.search === ''` — no stray `?`. The
  spec's warning about `"?"` surviving in router state did not reproduce here, but the e2e specs
  still assert `page.url()` because that is the string a client is actually given.

---

## Phase 3 — the detail drawer is a route ✅

| File | What |
|---|---|
| `App.tsx` | `<Route path=":slug/a/:assetId" element={<ClientPortalPage />} />`, with the catch-all warning in a comment |
| `features/gallery/detailUrl.ts` | new — `DETAIL_PARAMS`, `readDetailParams`, `writeDetailParams` |
| `features/gallery/hooks/useOpenAsset.ts` | new — resolves the path id to a top-level asset + focus |
| `features/gallery/GalleryStates.tsx` | new `DetailSkeleton`, `DetailNotAvailable` |
| `features/gallery/GalleryView.tsx` | four `useState`s deleted; `openAsset` is a synchronous `navigate` |
| `features/gallery/GalleryView.detailRoute.test.tsx` | new — 21 tests |
| deleted | `components/layout/AppLayout.tsx`, `features/activity/ActivityView.tsx` |

Phase 0's characterization tests still pass unedited. Total suite: 452.

### Deviation from the spec — `focus` and `lb` are WRITTEN in Phase 3, not Phase 4

The spec puts `focus` and `lb` in Phase 4 and has Phase 3 navigate to `primary.id` alone. Doing
exactly that would have lost two behaviours that work today, for the length of one commit: clicking a
hover tile focuses that sibling, and clicking a gallery-child tile opens the lightbox on it. Both
lived in the `focusSiblingId` / `openLightboxOnFocus` state this phase deletes, so there was nowhere
to park them.

So the cut moved by one step:

- **Phase 3** — `focus`/`lb` are written when an asset is OPENED, and read from the URL. One
  direction, one writer.
- **Phase 4** — interactions *inside* the drawer (variant picker, carousel, lightbox open/close)
  write them back. That is the part that needs state lifted out of `useAssetChildren`.

Net effect is the same and no phase regresses. Phase 4a as written in the spec ("one-way, URL →
state") is therefore already done.

### Decisions taken

- **`openAsset` no longer fetches anything.** It was an async click handler that resolved a sibling
  to its parent before it could set state. Now the card's own id goes in the path, the sibling's in
  `focus`, and every bit of resolution lives in `useOpenAsset` — where it has to be anyway, because a
  cold load has no click to hang the work off. The click path is synchronous.
- **The path id may be a child or a variant.** `/ess/a/<child-id>` opens the child's parent with the
  child focused. Required by the spec's acceptance list, and it is what makes a link forwarded from
  someone's lightbox work — a gallery child is never a card in the grid.
- **Closing PUSHES.** Open pushes, so Back closes; close pushes too, so Back reopens. Every URL the
  viewer visited is in history and Back always undoes the last thing. Replace-on-close was the
  alternative and would leave two identical adjacent entries.
- **`notFound` does not distinguish "no such asset" from "not yours".** RLS returns nothing in both
  cases. Telling them apart would confirm the existence of an asset the viewer may not see, from the
  client, where nothing can be enforced anyway. One message: "Not available."
- **The not-available and loading states occupy the DRAWER, not the page.** The grid behind them is
  still a working view; replacing it because one link is stale throws that away.
- **Dead code: both deleted.** `AppLayout` is an `<Outlet/>`-based shell whose nav points at routes
  that do not exist (`/activity`, `/clients`), and this phase deliberately chose sibling routes over
  a nested shell — adopting it would contradict the routing decision being made in the same commit.
  `ActivityView` was hardcoded sample data referenced by nothing. `src/components/layout/` and
  `src/features/activity/` are gone.

### Behaviour that genuinely changed

**A filter change no longer closes the open drawer.** Before, the open asset was looked up in the
current list, so filtering it out of the grid closed the drawer under the viewer. It is an address
now: the grid narrows and what you were looking at stays.

Phase 0 pinned the old behaviour as a fact (with a comment saying so) and *still passes* — because in
that file `fetchAsset` is stubbed to return `null`, so the excluded asset resolves to "not
available" and the drawer stub is absent either way. The new behaviour is pinned deliberately in
`GalleryView.detailRoute.test.tsx` → "a filter change while the drawer is open keeps it open", where
`fetchAsset` also knows the top-level fixtures. **If that Phase 0 test is ever revisited, this is the
paragraph to read.**

### Verified while doing it

- Opening an asset does **not** re-canonicalise the filter params — `writeDetailParams` preserves
  foreign params byte-for-byte and in order. Canonicalisation happens only when the rail writes. So
  `/ess?entity=Chair&latest=1` → `/ess/a/id-beta?entity=Chair&latest=1`, not the sorted form. A
  viewer who is only looking around never has their link quietly rewritten.
- `ClientPortalPage` does not refetch the client when the drawer opens (same component type at the
  same route depth reconciles). Confirmed by the spec's static analysis and consistent with the
  tests, which would otherwise flicker the gate.

---

## Phase 4 — drawer interactions write the URL ✅

Phase 4a (URL → state) landed with Phase 3. This is 4b: the variant picker, the carousel and the
lightbox write back.

| File | What |
|---|---|
| `hooks/useAssetChildren.ts` | `carouselIdx` / `selectedVariantId` / `lightboxIndex` removed; fetch effect no longer keyed on focus |
| `hooks/useDetailFocus.ts` | new — focus + lightbox, controlled or local |
| `AssetDetail.tsx` | derives all three from the focused **id**; new `onDetailStateChange` prop |
| `panels/AssetPreviewPanel.tsx` | reports the item acted on instead of setting an index |
| `GalleryView.tsx` | `setDetailState` — the push/replace rule |
| `GalleryView.detailState.test.tsx` | new — 17 tests, the real component tree |

469 tests. `AssetDetail`'s own characterization suite passes unedited, which is the evidence that
gutting `useAssetChildren` did not change what the detail loads or renders.

### Why the fetch effect had to be split

`useAssetChildren`'s single effect both fetched and resolved focus, so `focusAssetId` was one of its
dependencies. Phase 4b makes every carousel arrow rewrite `focus` — which would have re-run
`fetchChildAssets` **and** `fetchVariants` on every arrow press. Deriving the three positions instead
of storing them is what removes `focusAssetId` from the fetch's dep list. The hook's header comment
now records this; the live-vs-stale explanation is untouched.

`childView` stays in the hook — it is the one value with no URL representation (which way you are
looking at a set of files is not worth an entry in a shared link). Its effect only ever **promotes**
to `carousel`, never demotes: `children` gets a new identity on every refetch, so a symmetric effect
would silently undo the viewer's Grid choice whenever anything else in the drawer reloaded.

### ONE callback, not two

`onDetailStateChange(next: DetailState)` carries focus and lightbox together. Two callbacks would mean
two `navigate()` calls in one handler, each reading the pre-navigation URL — the second silently
winning. That is the same trap `useFilterParams` documents, and a whole-value update cannot express
it. `writeDetailParams` is whole-value for the same reason: with merge-by-default, "close the
lightbox" would be the one operation that could not be said.

### Controlled or local

`useDetailFocus` is controlled when `onDetailStateChange` is supplied and local otherwise. Both mounts
are real: the portal drawer keeps the state in the URL, and `/share/:id` has no route of its own to
write to. Without the local fallback the share page's lightbox would open and snap shut on the next
render, reading from a prop that never changed. **Phase 6 depends on this.**

### The push/replace rule

```ts
const opensLightbox = next.lightbox && !lightbox
navigate({ … }, { replace: !opensLightbox })
```

Push on the false→true lightbox transition only. Back then closes the lightbox and leaves the drawer
up. Everything else replaces — variant selection and carousel stepping are refinements, and scrubbing
40 frames must not bury the grid 40 entries deep. Closing the lightbox replaces too, so the
open/close pair can never grow history on its own.

### Small URL-cleanliness decisions

- Selecting the primary variant clears `focus` rather than setting `focus=<the asset itself>`.
- `?lb=1` with no `focus` opens on the first item that has media — a `focus` pointing at something
  with no media of its own does not leave the lightbox shut.

---

## Phase 5 — TanStack Query ✅

`@tanstack/react-query@^5.101.4` in `web/apps/client-hub`. Version bumped to **3.1.0**; the
`CHANGELOG.md` placeholder is filled in.

| File | What |
|---|---|
| `lib/queryClient.ts` | new — one module-level client, `retry: 1`, `refetchOnWindowFocus: false` |
| `main.tsx` | `QueryClientProvider` **outside** `BrowserRouter` |
| `hooks/useAssets.ts` | rewritten; key `['assets', clientId, role, filterCacheKey(filters)]`, 30 s |
| `hooks/useTags.ts` | `['tags', clientId]`, 5 min |
| `hooks/useClients.ts` | `['clients']`, 5 min |
| `GalleryView.cache.test.tsx` | new — 10 tests, the real `useAssets` over a stubbed `fetchAssets` |

Deleted along the way: the `JSON.stringify({filters, role, clientId, rev})` key, the `hasData` ref,
the `rev` counter, and the StrictMode double-mount comment (Query owns dedupe now).

479 tests. No call site changed.

### Deviation from the spec — invalidation stayed inside the hooks

The spec lists per-call-site edits: `GalleryView`'s `onDeletedDisconnected`/`onStatusChange` calling
`invalidateQueries({queryKey: ['assets']})`, and `AdminLandingPage.handleSaved` invalidating
`['clients']`. Instead each hook's `reload()` **is** the invalidation of its own key. Same effect,
same keys, and it satisfies the spec's own stronger requirement — "keep every public return shape
identical so no call site changes" — literally. `GalleryView` and `AdminLandingPage` are untouched by
this phase. `ClientDrawer` needed no change either way.

### The prefix-match decision, as the spec asks

**`invalidateQueries({queryKey: ['assets']})` is a prefix match and it invalidates the option-pool
query too. That is deliberate.** Both callers of `reload` are real mutations — a status change, or a
sweep of disconnected assets — and after one of them the pool is *genuinely* stale: delete an asset
and its tags may no longer be in the vocabulary the rail offers. Scoping the invalidation to the live
key would save one query and leave the rail listing a tag nothing has. Pinned by
`GalleryView.cache.test.tsx` → "invalidation reaches the option pool as well as the live view".

### Measured, not assumed

- **The default view is ONE fetch**, though `GalleryView` calls `useAssets` twice. Both keys reduce to
  `filterCacheKey === ''`, so Query dedupes them. Do not "fix" this into two artificial keys.
- **Toggling a filter off costs nothing.** Asserted as a `fetchAssets` call count, not as a render.
- **Two orderings of the same filter set are one key** — the canonicalisation from Phase 1 earning
  its keep.
- Opening and closing the drawer refetches nothing.

### Testing note

`GalleryView.cache.test.tsx` is the only suite that runs the real `useAssets`; it stubs
`fetchAssets` one level lower and counts calls. It builds a **fresh `QueryClient` per test** with
`retry: false` — a module-level client would carry results between tests and the counts would depend
on execution order. Its `ready()` helper waits for the grid to have rendered, not merely for
`fetchAssets` to have been *called*: the rail has no checkboxes to click until the option pool's data
has landed.

---

## Open questions carried forward

- **Supabase production redirect allowlist.** The spec asks to verify the production entry is
  `…/**` and not a bare origin. That config lives in the Supabase dashboard, has no representation
  in this repo, and cannot be checked from here. **Still unverified — someone with dashboard access
  must confirm it before Phase 2 ships**, or a magic-link round trip will drop the query string in
  production even after the `replaceState` fix.
- **Dead code (`AppLayout`, `ActivityView`).** Decision due in Phase 3; not made yet.
