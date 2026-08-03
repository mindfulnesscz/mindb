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
| 3 | `/:slug/a/:assetId` detail route | ⬜ not started |
| 4 | `focus` / `lb` params | ⬜ not started |
| 5 | TanStack Query | ⬜ not started |
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

## Open questions carried forward

- **Supabase production redirect allowlist.** The spec asks to verify the production entry is
  `…/**` and not a bare origin. That config lives in the Supabase dashboard, has no representation
  in this repo, and cannot be checked from here. **Still unverified — someone with dashboard access
  must confirm it before Phase 2 ships**, or a magic-link round trip will drop the query string in
  production even after the `replaceState` fix.
- **Dead code (`AppLayout`, `ActivityView`).** Decision due in Phase 3; not made yet.
