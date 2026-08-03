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
| 1 | URL state primitives (`filterUrl.ts`, `useFilterParams`) | ⬜ not started |
| 2 | Filters in the URL | ⬜ not started |
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

## Open questions carried forward

- **Supabase production redirect allowlist.** The spec asks to verify the production entry is
  `…/**` and not a bare origin. That config lives in the Supabase dashboard, has no representation
  in this repo, and cannot be checked from here. **Still unverified — someone with dashboard access
  must confirm it before Phase 2 ships**, or a magic-link round trip will drop the query string in
  production even after the `replaceState` fix.
- **Dead code (`AppLayout`, `ActivityView`).** Decision due in Phase 3; not made yet.
