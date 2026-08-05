# Claude Code handoff — URL routing, shareable views, and a real data cache

**Target:** `web/apps/client-hub` (the portal). No desktop, no schema, no Worker changes.
**Branch:** `dev/v3.1-url-routing`
**Version:** minor bump (`npm run version:minor`) at the end of Phase 5.

Every phase below leaves the app working and `npm run check` green. Ship after any phase; do not
start the next until the previous is merged.

---

## Why

The portal has four routes and almost no addressable state. Filters, the open asset, the selected
variant and the lightbox all live in `useState`, so:

- A view cannot be sent to anyone. "Look at the approved web renders of the Sofa range" is a
  sequence of clicks, not a link.
- Refresh loses your place. So does a magic-link round trip.
- Back does nothing useful — it leaves the portal entirely.
- `/share/:id` is documented in `docs/pages/portals.mdx` as a working feature and is in fact a stub
  wired to `MOCK_ASSETS`. In production it always renders "Asset not found."

---

## Decisions

These were settled before the work started. Do not relitigate them in code review.

| Decision | Value | Why |
|---|---|---|
| URL style | Readable query params | Self-describing, debuggable, hand-editable, no round trip to decode. Tag counts are small; length is a non-issue. |
| Multi-value encoding | **Repeated params**, not comma-joined | `?entity=Sofa&entity=Chair`. Tag labels are free text from the client's vocabulary; a comma inside a label would silently split one tag into two. `URLSearchParams.getAll()` cannot break this way. |
| Param names | Stable dimension **keys** (`entity`/`format`/`angle`) | Never the client's `dimensionLabels`. A client renaming "Entity" to "Product" must not break links that are already out. |
| Defaults | Omitted from the URL | `/ess` is the canonical clean view. See the round-trip invariant below. |
| Asset detail path | `/:slug/a/:assetId` | Two segments, so it cannot collide with a client slug. |
| Share links | RLS-only, no tokens | The link is an address, not a key. The recipient's own identity decides. Preserves the recorded "permanent URLs, expiring sessions" posture. |
| Data cache | TanStack Query | Replaces the `JSON.stringify(filtersKey)` effect pattern with a real cache, dedupe and stale-while-revalidate. |

### Not in scope

Admin tabs and drawers (`AdminLandingPage`'s `clients`/`users`/`errors`, `ClientDrawer`'s tag and
destination panels) stay on `useState` this round. They are a clean follow-up once the primitives in
Phase 1 exist.

---

## Invariants — violating any of these is a revert

1. **`:slug` is a root catch-all.** Any new single-segment top-level route must be declared *before*
   `<Route path=":slug">` in `App.tsx`. React Router v6 ranks static above dynamic so it would
   probably work anyway; declare it first regardless, because the next person will not check.
2. **No token, secret or session material in a query string.** Performance contract P1 —
   `CLAUDE_CODE_PROMPT_gated-delivery-and-video.md:328`. A per-user query param fragments the edge
   cache to near zero and defeats `?v=<hash>` immutability. This is written down in three places
   because it is the tempting shortcut.
3. **`v` is reserved.** It is the content-hash cache-buster on asset CDN URLs. Do not use `v` as an
   app-route param, even though the namespaces are technically separate.
4. **Identity stays `stable_id` + `child_id`.** URLs carry `assets.id` (UUID) for assets and
   `clients.slug` for clients. Never a filename, shortcode or display name.
5. **`toSlug` output is a published format.** Do not touch `admin/clientForm.ts` normalization; a
   change re-points live portal links.
6. **Everything stays inside `<RouteErrorBoundary>`**, which is keyed on the path so navigating away
   recovers without a reload.
7. **`packages/domain` stays platform-free.** The new URL code goes in `packages/asset-library`
   (which already owns `FilterState`), not `domain`.
8. **No bare `console.error`.** Use `reportError('<concern>.<site>', err)` — lint-enforced.
9. **Client-side checks are not a perimeter.** Nothing here may widen what a role can see; RLS
   remains the only gate. No new `security definer` functions.

---

## Bug this work exposes — fix it in Phase 2, not later

`web/apps/client-hub/src/features/portal/ClientPortalPage.tsx:228`

```ts
window.history.replaceState(null, '', window.location.pathname)
```

This runs when Supabase returns an auth error in the URL hash. It **drops the query string**. Today
that is harmless; the moment filters live in the query string, any magic-link error silently wipes
the view the user was returning to. Change to:

```ts
window.history.replaceState(null, '', window.location.pathname + window.location.search)
```

The same file's `SignInModal redirectTo={window.location.href}` (`:316`) is already correct and
becomes more useful — the recipient lands back on the exact filtered view. `supabase/config.toml:165`
confirms `http://localhost:5173/**` for the local stack; **verify the production allowlist entry is
also `…/**` rather than a bare origin** — that config lives in the Supabase dashboard and has no
representation in this repo.

---

## Dead code to resolve

Two modules are imported by nothing:

- `src/components/layout/AppLayout.tsx` — an `<Outlet/>`-based app shell with header, nav and client
  switcher. It duplicates `AdminAppHeader` inside `ClientPortalPage`. Its nav points at routes that
  do not exist (`/activity`, `/clients`).
- `src/features/activity/ActivityView.tsx` — 27 lines, referenced by **nothing at all** (not even
  `AppLayout`, despite the nav link).

Decide once, in Phase 3, and say so in the commit: either adopt `AppLayout` as the shell for nested
portal routes and delete `AdminAppHeader`, or delete `AppLayout` and `ActivityView`. Do not leave
both in the tree after this work.

---

# Phase 0 — Characterization tests

**The repo's first rule: prove behaviour before changing structure** (`CONTRIBUTING.md`). Phases 2–4
restructure `GalleryView`, which has no component test today.

Write `web/apps/client-hub/src/features/gallery/GalleryView.characterization.test.tsx` —
`// @vitest-environment jsdom`. Pin today's behaviour, bugs included:

- toggling a tag checkbox narrows the grid
- typing in the toolbar search narrows the grid
- the filters rail's option pool does **not** shrink when a filter is applied (deliberate —
  `stableFilters` in `GalleryView.tsx:37`)
- clicking a card opens the drawer; the close button closes it
- `latestOnly` toggles

## Build the router harness for the END state, now

**No test in this repo currently imports `react-router` at all.** Phase 0 is establishing that
pattern, not following one. `AssetDetail.characterization.test.tsx` is the model for jsdom + service
stubbing only.

Scaffold **both** routes from day one, even though `:slug/a/:assetId` does not exist in `App.tsx`
until Phase 3. The test harness is not the app router, and if you wrap in a bare `<MemoryRouter>` the
Phase 3 change to `useParams()` returns `{}`, `slug` is `undefined`, and every test has to be edited —
which breaks the "unedited" acceptance criterion in Phases 2 and 5.

```tsx
<MemoryRouter initialEntries={['/ess']}>
  <Routes>
    <Route path=":slug" element={<GalleryView />} />
    <Route path=":slug/a/:assetId" element={<GalleryView />} />
  </Routes>
</MemoryRouter>
```

## Full mock set — the short list will not boot

`GalleryView` reaches further than it looks:

| Must be mocked or provided | Why |
|---|---|
| `../../hooks/useAssets`, `../../hooks/useTags` | the data |
| `../../context/RoleContext` `useRole` | **throws** without a provider (`RoleContext.tsx:99`) |
| `../../services/assetService` (`fetchAsset`) | `openAsset`'s sibling resolution |
| `./hooks/useStreamMedia` | Cloudflare Stream URL building |
| `@sotto/database` `DEFAULT_DIMENSION_LABELS` | **has no alias in `vitest.config.ts`** — resolves only through the workspace symlink to a `.ts` entry. Verify it resolves before writing the suite; add an alias if not. |
| The `AssetDetail` service surface | the "clicking a card opens the drawer" case renders the real `AssetDetail`. Copy the ~8 stubs from `AssetDetail.characterization.test.tsx:19-75` (`ratingService`, `commentService`, `assetService`, `eventService`, `destinationService`, `assetActions`, `supabase`, `ImageLightbox`) or stub `AssetDetail` itself and assert on its props. |

**Acceptance:** tests pass against unmodified `GalleryView`. No production file changed in this phase.

---

# Phase 1 — URL state primitives (pure, unwired)

## Step 1a — the enums need runtime values

`AssetStatus`, `AssetPerm` and `EntityType` are **type-only unions** (`packages/asset-library/src/types.ts:3,12,14`).
A parser cannot validate against a type. Convert each to a const array and derive the type from it, so
the type identity is unchanged and nothing downstream breaks:

```ts
export const ASSET_STATUSES = ['draft','review','approved','published','archived','disconnected'] as const
export type AssetStatus = typeof ASSET_STATUSES[number]

export const ASSET_PERMS  = ['public','guest','client','internal'] as const
export type AssetPerm  = typeof ASSET_PERMS[number]

export const ENTITY_TYPES = ['product','customer','partner','event','company'] as const
export type EntityType = typeof ENTITY_TYPES[number]
```

Export all three arrays from `index.ts`.

**Do not use `STATUS_KEYS_STAFF` / `STATUS_KEYS_CLIENT`** (`features/gallery/statusLabels.ts:20-21`)
as the parse allowlist, even though they are runtime arrays. Two reasons: a `packages/*` module may
not import from `web/apps/client-hub` (inverted dependency, and it would break `test:packages`
resolution), and `STATUS_KEYS_CLIENT` deliberately omits `archived`/`disconnected` — using it would
silently drop `?status=archived` from a legitimate staff link. Optionally re-derive
`STATUS_KEYS_STAFF` from `ASSET_STATUSES` afterwards to remove the duplicate list.

## Step 1b — new file: `packages/asset-library/src/filterUrl.ts`

Lives here because this package already owns `FilterState` and `getDefaultFilters()`. Pure functions,
no React, no `window` — so they run in plain node under the existing
`packages/*/src/**/*.test.ts` include and count toward coverage.

```ts
import type { FilterState } from './types.js'

/** URL param name per FilterState key. Stable — these appear in links that are already out. */
export const FILTER_PARAMS = {
  search:       'q',
  latestOnly:   'latest',
  status:       'status',
  entityTypes:  'type',
  entities:     'entity',
  formats:      'format',
  angles:       'angle',
  perms:        'perm',
} as const

/**
 * FilterState → URLSearchParams.
 *
 * Only values differing from `getDefaultFilters()` are written, so the default view has an empty
 * query string and `/ess` stays the canonical clean URL.
 *
 * Keys are emitted in FILTER_PARAMS order and array values are sorted before emission. This makes
 * the output CANONICAL: one filter set has exactly one string. Phase 5 uses that string as the
 * TanStack Query cache key, so a non-deterministic order would silently halve the hit rate.
 */
export function filtersToSearchParams(filters: FilterState): URLSearchParams

/**
 * URLSearchParams → FilterState, merged over `getDefaultFilters()`.
 *
 * Tolerant by contract: unknown params are ignored, malformed values fall back to the default, and
 * a value not in the allowed enum for `status`/`perm`/`type` is DROPPED rather than passed through.
 * A hand-edited or stale URL must degrade to a valid view, never to a crash or a query that throws
 * at PostgREST.
 */
export function searchParamsToFilters(params: URLSearchParams): FilterState

/** Canonical string form — '' for defaults. The Phase 5 cache key. */
export function filterCacheKey(filters: FilterState): string
```

Encoding rules:

| Key | Form | Notes |
|---|---|---|
| `search` | `q=chair%20oak` | **Trimmed on write.** Omitted when empty after trim |
| `latestOnly` | `latest=1` | Omitted when false. Only `'1'` parses true |
| `status` | `status=approved&status=published` | Repeated. Validate against `ASSET_STATUSES` |
| `perms` | `perm=client` | Repeated. Validate against `ASSET_PERMS` |
| `entityTypes` | `type=product` | Repeated. Validate against `ENTITY_TYPES` |
| `entities` / `formats` / `angles` | `entity=Sofa&entity=Chair` | Repeated. Free text — no validation, `URLSearchParams` handles escaping |

Export all three functions from `packages/asset-library/src/index.ts`.

## Step 1c — new file: `packages/asset-library/src/filterUrl.test.ts`

**The round trip is over the canonical form, not over arbitrary input.** Sorting arrays and trimming
`search` on write means a `FilterState` with unsorted tags or a padded search string is *not* its own
round-trip fixed point — asserting otherwise fails immediately. State it as idempotence:

```ts
const canonical = searchParamsToFilters(filtersToSearchParams(f))
expect(searchParamsToFilters(filtersToSearchParams(canonical))).toEqual(canonical)
```

Required cases:

- **Idempotent round trip** as above, over a table of representative `FilterState` values.
- **Canonicalization, asserted explicitly:** arrays come back sorted; `search: '  chair  '` becomes
  `'chair'`. Do not leave this implicit in the round trip.
- **Defaults omitted:** `filtersToSearchParams(getDefaultFilters()).toString() === ''`.
- **Canonical string:** two `FilterState` objects with the same tags in different array order produce
  the same string. Assert the exact string, not just equality — Phase 5 uses it as a cache key.
- **Comma safety:** a tag label containing `,` and one containing `&` survive a round trip intact.
  This is the whole reason for repeated params — pin it.
- **Tolerance:** `?status=banana&unknown=1&latest=yes` yields `getDefaultFilters()`.
- **Order independence:** `?entity=A&q=x` and `?q=x&entity=A` parse identically.

Note on coverage: these files are measured (`vitest.config.ts:50`) but `packages/asset-library` has
**no threshold**, so the ratchet cannot fail on them. Write the tests because the logic is
link-breaking, not because a gate demands it.

## Step 1d — new file: `web/apps/client-hub/src/hooks/useFilterParams.ts`

Thin React binding. The only file in this phase that touches React Router.

```ts
/**
 * Filter state, backed by the URL.
 *
 * Drop-in for `useState<FilterState>` in GalleryView — same [value, setter] shape, so the call site
 * changes by one line.
 *
 * REPLACE, not push. A filter change is a refinement of where you are, not a new place: pushing
 * would put one history entry per checkbox and make Back a slow rewind through every intermediate
 * state. Opening an asset pushes (Phase 3); filtering does not.
 *
 * Params this hook does not own — `focus`, `lb`, and Supabase's own hash — are preserved untouched.
 */
export function useFilterParams(): [FilterState, (next: FilterState | ((f: FilterState) => FilterState)) => void]
```

### Do NOT implement this over `useSearchParams`'s setter

`react-router-dom/dist/index.js:1030-1034`:

```js
let setSearchParams = React.useCallback((nextInit, navigateOptions) => {
  const newSearchParams = createSearchParams(
    typeof nextInit === "function" ? nextInit(searchParams) : nextInit)
  ...
}, [navigate, searchParams])
```

`searchParams` is **closed over from render, not read fresh**. The functional form therefore does not
behave like `useState`: two `setFilters(f => …)` calls in the same tick both see the pre-navigation
params and the second silently wins. `GalleryView.tsx:176` already uses the updater form, and Phase 4b
adds more writers that can fire in the same handler. The setter's identity also churns on every URL
change (dep `[searchParams]`), poisoning any dep list built on it.

Implement over `useNavigate()` + `useLocation()`, reading `location.search` **inside** the callback
(or keep a `useRef` mirror of the latest params). Reading is still fine via `useSearchParams()`, or
just `new URLSearchParams(location.search)`.

Memoize the parsed `FilterState` on the search string so object identity is stable across renders —
`useAssets` keys off it and an unstable object refetches every render.

## Step 1e — new file: `web/apps/client-hub/src/hooks/useFilterParams.test.tsx`

`// @vitest-environment jsdom`, `MemoryRouter initialEntries={['/ess?entity=Sofa']}`. Assert:

- initial parse
- the setter rewrites the URL
- it uses `replace` (history length unchanged)
- an unrelated param (`?foo=1`) survives a filter change
- **two setter calls in one event handler both land** — the P9 regression above

**Acceptance:** `npm run test:packages` green, `npm run check` green, no behaviour change in the app —
nothing imports `useFilterParams` yet.

---

# Phase 2 — Filters in the URL

1. `GalleryView.tsx:23` — replace
   `const [filters, setFilters] = useState<FilterState>(getDefaultFilters())`
   with `const [filters, setFilters] = useFilterParams()`.

   Everything downstream already takes `filters` / `onChange` as props (`FiltersRail`, the toolbar
   search input, `activeFacets` on `AssetDetail`). No prop signature changes.

2. `ClientPortalPage.tsx:228` — the `replaceState` fix above.

3. `stableFilters` (`GalleryView.tsx:37`) stays `getDefaultFilters()` and stays out of the URL. It is
   the option pool, not a view.

4. Debounce the toolbar search input at ~250 ms **before** it reaches the setter, so typing writes
   one history-replace per pause rather than one per keystroke. Keep the input controlled by local
   state and push to the URL on the trailing edge; otherwise the cursor jumps.

**Acceptance**
- Phase 0 characterization tests still pass **unedited**. If one needed adjusting, the restructure
  changed behaviour — stop and find out why.
- `/ess?entity=Sofa&status=approved&latest=1` loads with those filters applied on a cold load.
- Applying filters then reloading reproduces the view.
- Back after several filter changes leaves the portal in one step (replace, not push).
- Clearing all filters returns the URL to bare `/ess` with no empty params. **Assert against
  `window.location.search` (or Playwright's `page.url()`), not `useLocation().search`** — navigating
  to an empty query leaves `"?"` in router state while the address bar shows a clean path.

---

# Phase 3 — Asset detail route

## `App.tsx`

```tsx
{/* Public asset share links */}
<Route path="share/:id" element={<AssetDetailPage />} />

{/* Client portals. `:slug` is a root catch-all — declare any new top-level route ABOVE it. */}
<Route path=":slug" element={<ClientPortalPage />} />
<Route path=":slug/a/:assetId" element={<ClientPortalPage />} />
```

Two sibling routes to one element, deliberately — not a nested route with an `<Outlet/>`.
`ClientPortalPage` owns the client fetch, the sign-in gate and the `CompleteProfile` gate, and all
three must run identically on both paths. A nested route would either duplicate those gates or force
`GalleryView` to render an `Outlet`, which puts the drawer outside the component that owns the grid
it overlays. (This is also where you resolve the `AppLayout` question above.)

Two things verified so you do not have to worry about them: route ranking is unambiguous — `":slug"`
scores 4, `":slug/a/:assetId"` scores 19, and with no splat the segment count already makes each match
exclusive. And rendering the same component type at the same depth reconciles rather than remounts, so
`ClientPortalPage` does **not** refetch the client when the drawer opens (its effect is keyed
`[slug]`). `RouteErrorBoundary` likewise uses `resetKey` in `componentDidUpdate`, not as a React
`key`, so it will not tear down the tree.

## `GalleryView.tsx`

It currently imports no router hooks and has no `slug` — it gets `activeClient` from `useRole()`,
which carries `id`, not `slug`. Add:

```ts
const { slug, assetId } = useParams<{ slug: string; assetId?: string }>()
const navigate = useNavigate()
const location = useLocation()
```

`slug` types as `string | undefined` but is always defined at runtime: `GalleryView` is rendered only
from `ClientPortalPage.tsx:340`, which is itself only reachable on a `:slug` route.

Replace the `selectedId` / `focusSiblingId` / `openLightboxOnFocus` state cluster with URL-derived
values:

- `assetId` drives which asset is open. `resolvedDetail` **stays** as local state — it is a fetch
  result cache for an asset not in the current list, not view state.
- `openAsset(primary, focusId, opts)` becomes a `navigate()`:
  `navigate({ pathname: \`/${slug}/a/${primary.id}\`, search: location.search }, ...)`.
  **Carry `location.search` forward** — opening an asset must not drop the filters, or Back returns
  to an unfiltered grid.
- `onClose` becomes `navigate({ pathname: \`/${slug}\`, search: location.search })`.

Opening an asset **pushes**. It is a new place, and Back closing the drawer is the behaviour users
expect from a modal-over-list.

The sibling-resolution logic in `openAsset` (`GalleryView.tsx:101-134`) — resolving a child or
variant id up to its parent via `fetchAsset` — moves into an effect keyed on `assetId`, because the
same resolution now has to run on a **cold load** of `/ess/a/<childId>`, where there is no
`primary` in hand. Extract it to a hook: `src/features/gallery/hooks/useOpenAsset.ts`, returning
`{ asset, focusId, loading, notFound }`.

Handle cold-load states explicitly. A direct link to an asset the viewer cannot see must render
"Not available" over the grid, not an empty drawer and not a crash.

**Acceptance**
- Clicking a card changes the URL to `/ess/a/<uuid>` and keeps the filter params.
- Cold load of that URL opens the grid *and* the drawer.
- Back closes the drawer and restores the same filtered grid.
- Cold load of `/ess/a/<child-uuid>` opens the parent with the child focused.
- Cold load of a UUID the viewer has no access to renders a handled "Not available" state.
- Cold load of a malformed id renders the same handled state — no unhandled rejection.

---

# Phase 4 — Child, variant and lightbox state

Two more params on `/:slug/a/:assetId`:

| Param | Meaning | Maps to |
|---|---|---|
| `focus=<uuid>` | Child or variant to focus | `AssetDetail focusAssetId` |
| `lb=1` | Lightbox open on the focused item | `AssetDetail autoOpenLightbox` |

The plumbing already exists — `useAssetChildren(asset, isStaff, focusAssetId, autoOpenLightbox)`
resolves an id to the right carousel index, variant selection and lightbox index in one effect
(`src/features/gallery/hooks/useAssetChildren.ts:58-78`). Ids, not indices: an index is meaningless if
a sibling is added or disconnected.

Do it in two steps.

**4a — one-way, URL → state.** Read `focus` and `lb` from the search params and pass them down as
`focusAssetId` / `autoOpenLightbox`. Nothing new to write; this alone makes hand-built and forwarded
links work.

**4b — two-way, state → URL.** `selectedVariantId` and `lightboxIndex` currently live inside
`useAssetChildren` and change on user interaction. Lift **those two only** so interaction writes back:

- selecting a variant → rewrite `focus`, `replace` (a refinement)
- opening the lightbox → set `lb=1`, **push**, so Back closes the lightbox rather than the whole drawer
- stepping the carousel → rewrite `focus` to the new child's id, `replace`, so a 40-frame scrub does
  not bury the grid 40 entries deep in history

`carouselIdx` is **derived, not lifted**. It stays inside the hook; the URL carries the focused child's
id and the hook resolves it to an index, exactly as it already does for `focusAssetId`. There is no
carousel-position param.

The five values that stay put: `children`, `variants`, `staleChildren`, `staleVariants`, `childView`.
The hook's header comment (`:1-18`) explains why they move together — keep it intact.

**Acceptance**
- `/ess/a/<parent>?focus=<child>&lb=1` cold-loads straight into the lightbox on that child.
- Opening the lightbox in the UI puts `lb=1` in the URL; Back closes it and leaves the drawer open.
- Stepping the carousel does not grow history.
- A `focus` id that is neither a child nor a variant of `:assetId` is ignored, and the parent opens
  normally.

---

# Phase 5 — TanStack Query

```bash
npm i @tanstack/react-query --workspace=web/apps/client-hub
```

`main.tsx`:

```tsx
<StrictMode>
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <AuthProvider><RoleProvider><App /></RoleProvider></AuthProvider>
    </BrowserRouter>
  </QueryClientProvider>
</StrictMode>
```

One module-level `QueryClient`. Defaults: `retry: 1`, `refetchOnWindowFocus: false` (a portal is a
browsing surface, not a dashboard; refocus refetches are noise and cost PostgREST calls).

Convert three hooks. Keep every public return shape identical so no call site changes.

| Hook | Query key | `staleTime` |
|---|---|---|
| `useAssets` | `['assets', clientId, role, filterCacheKey(filters)]` | 30 s |
| `useTags` | `['tags', clientId]` | 5 min |
| `useClients` | `['clients']` | 5 min |

**`filterCacheKey` from Phase 1 is the cache key.** That is the point of making it canonical: the URL
string and the cache key are the same value, so Back and Forward hit warm cache by construction.

Notes:

- `placeholderData: keepPreviousData` reproduces the current "keep stale assets visible during
  re-fetch" behaviour (`useAssets.ts:42`, `hasData.current`). Delete the ref.
- `JSON.stringify({filters, role, clientId, rev})` and the `rev` counter both go.
- **Invalidation, precisely.** `useAssets` has exactly one call-site file — `GalleryView.tsx:38` and
  `:40`. So:
  - `GalleryView` `onDeletedDisconnected` (`:156`) and `onStatusChange` (`:229`) →
    `invalidateQueries({ queryKey: ['assets'] })`
  - `AdminLandingPage.handleSaved` (`:35`) calls `useClients().reload` — **not** `useAssets` →
    `invalidateQueries({ queryKey: ['clients'] })`
  - `ClientDrawer` needs **no change**. It has no `reload`; it takes an `onSaved` prop that *is*
    `handleSaved`.
- Keep the `usingMock` path. When `!isConfigured()`, the `queryFn` returns
  `applyFilters(MOCK_ASSETS, ...)`. Same branch, moved inside the fetcher.
- **`invalidateQueries({queryKey: ['assets']}) is a prefix match.** It invalidates the option-pool
  query too. Either scope invalidation to the live key, or accept the pool refetch — but decide
  deliberately and say which in the commit, because the next paragraph is about not refetching it.
- `GalleryView` calls `useAssets` twice — the option pool with `stableFilters`, and the live filters.
  At the default view both produce `filterCacheKey === ''`, so the keys are **identical** and it is
  one fetch. Once a filter is applied the keys diverge and the pool key stays stable per client, so it
  is still fetched once and shared. Do not "fix" this into two artificial keys.
- The `StrictMode` double-mount hazard documented in `useAssets.ts:35-38` disappears — Query owns
  dedupe. Delete that comment along with the code it explains.

**Acceptance**
- Phase 0 tests pass unedited.
- Toggling a filter off and back on renders instantly from cache with no network request (verify in
  devtools, or with a fetch spy in a test).
- A status change in the detail drawer updates the grid.
- Demo mode (no Supabase configured) still works end to end.
- `npm run check` green. `npm run version:minor`.

---

# Phase 6 — `/share/:id` becomes real

Independent of Phases 1–5; ship whenever.

`features/gallery/AssetDetailPage.tsx` currently does `MOCK_ASSETS.find(a => a.id === id)`. Replace
with `fetchAsset(id)` and render four states:

| State | Render |
|---|---|
| loading | skeleton |
| found | `<AssetDetail asset={asset} mount="page" />` |
| null, no session | "Sign in to view this asset" + sign-in CTA |
| null, has session | "You don't have access to this asset" |

RLS does the deciding. `effective_level = 'public'` is the only level an anonymous visitor can match;
everything else needs a session, and `client`/`internal` need the right one. There is nothing to
enforce in this component — and nothing it may enforce, since a client-side check is not a perimeter.

Two things to get right:

- **Broken images are the likely failure, not a blank page.** A row can be visible while its bytes
  are gated. `perm='guest'` is exactly this case: RLS returns the row to any signed-in user, but the
  images come from the gated bucket via `cdn-gate`, which needs the CDN cookie. `useCdnCookie`
  **already runs app-wide** from `AuthContext.tsx:59`, inside the `AuthProvider` that wraps `<App/>`
  — there is no per-route hookup to add and you should not look for one. The actual work is an image
  fallback: a gated-and-unauthorized thumbnail must render a placeholder, not a broken-image icon.
- **Do not add view-event writes.** `asset_events` is capped at 120/asset/minute and share links are
  public — the cap exists because of exactly this surface
  (`REFACTOR_PLAN.md:1044`, section `:1029-1050`). Whatever `AssetDetail` already fires is fine; do
  not add more.

Fix **both** back links — `AssetDetailPage.tsx:14` in the not-found branch and `:28` in the header.
Both are `Link to="/"`, which sends a client to the staff admin landing. For a signed-in user with a
`client_id`, link to their portal; for anyone else, drop the link and show the sign-in CTA only.
Resolving a slug from `asset.clientId` for an anonymous viewer would need a new RPC — do not add one.

Then update `docs/pages/portals.mdx` and `docs/pages/web-portal/overview.mdx` with the real route
table, including `/:slug/a/:assetId` and the filter params. The docs currently describe `/share/:id`
as working, which is what let it rot.

---

## Route table after all phases

```
/                          admin landing / staff sign-in
/settings                  Supabase connection config
/share/:id                 single asset, RLS-gated, no client chrome
/:slug                     client portal gallery
  ?q= &latest= &status= &perm= &type= &entity= &format= &angle=
/:slug/a/:assetId          gallery + detail drawer
  ?focus=<uuid> &lb=1  (plus all filter params, carried through)
```

## e2e — add to `e2e/smoke.spec.ts`

Local stack only; the existing containment comment in `playwright.config.ts` applies.

1. Apply two filters → read `page.url()` → `page.reload()` → same assets listed, same checkboxes on.
2. Click a card → URL contains `/a/` and still contains the filter params → reload → drawer open.
3. `goBack()` → drawer closed, filtered grid intact.
4. Open the lightbox → `goBack()` → lightbox closed, drawer still open.
5. Copy a `/:slug/a/:id` URL into a fresh context with no session → sign-in gate, no crash.

## Final check

```bash
npm run check      # version, toolchain, db types, lint, builds, typecheck, docs, clippy
npm run test:packages
npm run test:e2e   # local stack must be up
```

---

## Appendix — verified facts, so you don't re-derive them

Static verification against the tree at the time of writing. If something here is wrong, the plan
built on it needs revisiting, not working around.

- `react-router-dom@6.30.4`. `computeScore`: `":slug"` → 4, `":slug/a/:assetId"` → 19. No splats, so
  segment count makes each match exclusive. Declaration order is hygiene, not a requirement.
- Same component type at the same route depth reconciles without remounting (`_renderMatches` applies
  no `key`), so `ClientPortalPage`'s `[slug]`-keyed client fetch does not re-run when the drawer opens.
- `RouteErrorBoundary` uses `resetKey` in `componentDidUpdate` to clear `state.error` — it is not a
  React `key`. Navigation will not tear down the tree.
- `packages/asset-library` imports React in exactly one file, `ErrorBoundary.tsx:18`. `filters.ts`,
  `types.ts`, `permissions.ts`, `mock.ts` are React-free.
- `no-restricted-imports` in `eslint.config.js:102-116` is scoped to `packages/domain/src/**/*.ts`
  only. Nothing blocks `filterUrl.ts` in `asset-library`.
- `no-console: ['warn', {allow:['warn']}]` plus `lint --max-warnings 0` is what makes the
  `reportError` invariant real.
- jsdom + `@testing-library/react@16.3.2` + `@testing-library/jest-dom@7.0.0` are in root devDeps.
  `vitest.setup.ts` registers matchers and `afterEach(cleanup)` behind a `typeof document` guard.
  Per-file `// @vitest-environment jsdom` is the established pattern.
- `react-router-dom` is hoisted to root `node_modules`, so `MemoryRouter` imports cleanly from a test.
- `FiltersRail`'s `onChange` is `(f: FilterState) => void` (`FiltersRail.tsx:205`); the wider setter
  type is assignable, so no prop signature changes in Phase 2.
- `toSlug` (`features/admin/clientForm.ts:21`) is already pinned as a published format by
  `clientForm.test.ts:32-39`.
- `?v=<content-hash>` is generated in `packages/domain/src/assetStorage.ts:99,111` and consumed in
  `workers/cdn-gate/src/index.ts:56,154`. That is why `v` is reserved.
- **Not verified by running anything.** `node_modules` holds a darwin-arm64 rollup binary, so the
  suite could not be executed during review. Run `npm run check` yourself before trusting any of it.
