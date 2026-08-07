# 04b — Supabase asset writes: serial → pooled (biggest single win)

> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`.
> Honour every "Non-negotiables" item in `00_START_HERE.md`. Run 04a first so the effect is measurable.

## Goal

`desktop/src/services/supabase/exportWrite.ts` performs **one awaited HTTP round trip per asset
row**, sequentially, in both `writeParents` and `writeChildren`. At ~150–300 ms per PostgREST call,
a 300-asset library spends 45–90 s doing nothing but waiting in series — the largest silent gap in
the whole run. Pool the calls; change nothing about what each call sends.

## Invariants that MUST survive (read before touching anything)

1. **Parents complete before any child starts.** Children resolve `parent_id`/`variant_of` from
   `parentIdByKey`. Keep the barrier between the two phases; parallelise only *within* each phase.
2. **Per-row PATCH semantics stay.** Do NOT convert updates to bulk upserts. `stripPortalOwnedFields`
   (drops `perm`) and `stripAbsentUrls` rely on PATCH's omitted-fields-untouched behaviour; a bulk
   upsert would clobber portal-owned columns. Creates (POST) may later be batched — **out of scope
   here**; this prompt is concurrency only.
3. **Keys are unique per phase** — `dedupeByKey` runs upstream in `assetExport.ts`, so no two
   in-flight writes touch the same row. State mutations (`result` counters, `parentIdByKey`,
   `existing.set(...)` on create) are single-threaded JS between awaits and remain safe, but keep
   each item's mutations inside its own task; never share a row object across tasks.
4. **`shouldStop` still short-circuits.** Check it before dispatching each task; in-flight requests
   may finish, but no new ones start after stop.
5. Error accounting per row stays identical (one log line + `result.errors++` per failure; one
   failure must not abort the phase).
6. `sbFetch`'s single 401-retry-with-refresh must stay correct under concurrency: several parallel
   requests can hit 401 at token expiry simultaneously. Make `getAccessToken({ forceRefresh: true })`
   single-flight (memoize the in-flight refresh promise in `authService`) so N parallel 401s trigger
   ONE refresh, not N. Check `authService.ts` first — if it already single-flights, note it and move on.

## What to build

1. `asyncPool<T, R>(limit, items, worker)` helper — a true worker pool (next item starts the moment
   a slot frees), NOT chunked `Promise.all` batches. Suggested home: `desktop/src/services/pipeline/pool.ts`
   with unit tests (respects limit, preserves per-item error isolation, stops dispatching on signal).
   **04d reuses this helper — build it well.**
2. `writeParents`: pool the per-parent write at concurrency 8. Collect `parentIdByKey` entries as
   results land.
3. `writeChildren`: after the parent barrier, pool the per-child write at concurrency 8.
4. `writeReadmes` in `assetExport.ts`: pool at 8 as well (it is a serial per-folder loop today) —
   but see 04c, which changes what it writes; if 04c has not landed yet, pool it anyway, the two
   compose cleanly.
5. Keep concurrency as a named constant (`WRITE_CONCURRENCY = 8`) with a comment on why 8
   (matches pipeline convention; PostgREST/Supavisor handles this trivially).

## Tests

- `assetExport.characterization.test.ts` pins this flow hermetically — it MUST stay green. If any
  assertion depends on write ORDER (call sequence in a recorded stub), relax it to set-equality on
  the calls, never by weakening what is asserted about each call's payload.
- `supabaseSync.integration.test.ts` and `rest.test.ts` green.
- Add one test: a phase with 20 rows and a stub that resolves in randomized order produces the same
  created/updated/error counts and the same `parentIdByKey` as the serial path.
- Add one test for the 401 single-flight refresh if you had to build it.

## Acceptance

- All suites green; timed run (04a) shows SUPABASE EXPORT writes phase reduced ~8× on a no-change
  library of ≥50 assets (manual observation is fine, record before/after numbers in the PR/commit).
- `CHANGELOG.md` Unreleased entry.

## Effort

~half a day + review care. HIGH VALUE.
