# 04d — Worker pools instead of chunked barriers · pure-string path joins · log batching

> **LANDED 2026-08-07.** All three parts. Green on `lint` (max-warnings 0), `typecheck`,
> `test:packages`, `test:desktop`, `build:docs`. Rust untouched.
>
> ## Part A — pools (`asyncPool` from `DONE_04b`, unchanged)
>
> Converted, all of them: `thumbnails.ts` (rasters **and** documents), `cdnUpload.ts`
> (`runCdnUpload`, `runPagesUpload`, `runOriginalUpload` and both `pruneStaleObject` sweeps),
> `cloudExport.ts` (per-destination upload loop) and `cdnCleanup.ts` `deleteCdnObjects`.
>
> **No width was raised.** Uploads and renders stay at **8**; the prune/delete sweeps run at **4**,
> named `PRUNE_CONCURRENCY` / `DELETE_CONCURRENCY` with the reason on them — every request in those
> is destructive and the lists are short, so there is nothing to gain from eight. The win throughout
> is slot refill, not more slots.
>
> **Stop semantics are preserved exactly, and that took an explicit line.** The chunked loops
> `return`ed out of the stage on stop, so a stopped stage printed no DONE banner and (in the CDN
> stages) did not save the R2 cache. `asyncPool` stops *dispatching* but still resolves, so every
> converted site is followed by `if (ctx.isStopping?.()) return;`. Without it a stopped run would
> have started printing banners it never printed before.
>
> **Page previews: the outer loop was flattened, as the prompt asked.** Identity and destination are
> resolved for every document first (in `docs` order, so the "no folder identity" reports still read
> in scan order), then all `(doc, page)` jobs pool eight-wide **across** documents. Per-document
> prune ordering survives as a **completion latch**: each document counts its own pages down and
> sweeps on the last one. This is load-bearing — the sweep deletes everything under the asset's page
> prefixes that this run did not claim, so starting it beside a sibling page's upload would race a
> delete against the write about to claim that key. A document whose pages were not all dispatched
> (Stop) never reaches zero and is not swept, which is the correct reading of a partial upload.
>
> **The prune sweeps enumerate their candidates up front and then dispatch.** That is equivalent to
> the serial version because every candidate key is bounded to one `${stableId}/${childId}`: no two
> targets can propose the same key, so the `remoteKeys.delete` a successful prune performs cannot
> remove another target's candidate out from under it. `pruneStaleObject` itself was not touched —
> the keep/delete decision, the still-referenced guard, the `[DRY]` branch and the bucket routing are
> byte-identical.
>
> **One deliberate simplification inside the rule "routing must be byte-identical":** `runPagesUpload`
> had two hand-written copies of the credential table (one for the upload route, one for the stale
> delete). Both are now the existing shared `bucketForLevel` helper plus the domain — provably the
> same pairs, and one fewer place for a fifth copy to appear.
>
> ## Part B — `services/pipeline/paths.ts`
>
> `joinPath` / `parentPath` / `baseName`, pure, with `paths.test.ts` covering trailing slashes,
> doubled slashes, backslashes, empty segments and the root edge cases — **plus a test that asserts
> they agree with `vfs.pathApi()`**, which is the normal form every characterization suite has always
> compared against. Call sites replaced in `pipeline/{fs,scan,publishLocal,packages,collect,
> cloudExport}.ts` and `dam/{canvas,scan,scope,thumbs}.ts` + `damService.ts`.
>
> **Two decisions worth keeping:**
>
> - **`.` and `..` are NOT resolved.** Nothing in the pipeline composes them, and silently collapsing
>   them would be a way to climb out of a folder `path_policy` had approved. Canonicalisation stays
>   in Rust, behind the scope check.
> - **It lives in the desktop, not `@sotto/domain`.** It would fit the domain contract perfectly, but
>   a NEW `packages/domain/src/*.ts` module makes every local edge function answer `BOOT_ERROR` until
>   the container is recreated (the runtime bind-mounts those files individually at creation). No
>   edge function needs these; the desktop does. `appDataDir()` and friends stay on the real API —
>   `r2Cache.ts` and `runTimings.ts` were left alone deliberately, they call it once per run.
>
> ## Part C — log and progress batching
>
> In `store/pipelineStore.ts`, as closure state on the store rather than module state. Ordinary
> lines buffer for **100 ms**; **`section` lines flush synchronously**, taking everything buffered
> before them along — so ORDER IS NEVER AFFECTED, a tail keeps its stage structure, and a crash
> inside a stage does not lose the lines that said where it was. `setProgress` is throttled to ~10 Hz
> **with a trailing timer**, so the last value always lands rather than leaving the bar at 97 %.
> `finishRun` flushes and cancels the trailing timer (else a stale percentage arrives after 100);
> `startRun` resets everything; `clearLog` drops the buffer instead of flushing it into an emptied
> log. A `flushLog()` action is exposed for anywhere that needs the log synchronously.
>
> **The characterization suites were unaffected, as predicted** — they capture `appendLog` through
> the ctx, never through the store. Verified rather than assumed. New coverage:
> `store/pipelineStore.test.ts` (buffering, banner flush, no reordering, 200 lines → **one** store
> update, finishRun/clearLog behaviour, progress coalescing and the trailing value).
>
> **Not in the prompt, but Part C is incomplete without it:** the log view mapped the whole array,
> so it now renders the most recent **1,500** lines and reports how many are hidden (the store still
> holds them all — the cap bounds the DOM, not the record). And four components subscribed to the
> WHOLE store with `usePipelineStore()`, including the one holding `useRunPipeline` — so every log
> flush re-rendered the pipeline view and the stats strip. They take per-field selectors now, which
> is what makes the batching actually pay.
>
> ## Still owed
>
> **The timed before/after run.** As with `04a`–`04c`, it needs a real library and a signed-in
> session; take the numbers from the `RUN TOTAL` delta line, which now prints them directly.
>
> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`.
> Honour every "Non-negotiables" item in `00_START_HERE.md`. Requires the `asyncPool` helper from
> 04b (build it here if 04b has not landed).

Three mechanical inefficiencies that cost time in EVERY stage. Each is independently shippable;
land as three commits in this order.

## Part A — chunked `Promise.all` barriers → true worker pool

Every batched stage uses `for (i += 8) { await Promise.all(chunk) }`, so each chunk waits for its
slowest member — one 500 MB upload stalls 7 idle slots. Replace with `asyncPool(8, …)`:

- `pipeline/thumbnails.ts` — both loops (rasters, documents). **Keep concurrency 8**: the comment
  and `DONE_00b` are explicit that each call spawns one render worker and 8 is the measured sweet
  spot; the win here is slot refill, not more slots.
- `pipeline/cdnUpload.ts` — `runCdnUpload`, `runOriginalUpload`, and `runPagesUpload`. For pages,
  ALSO flatten the outer per-document loop: today documents run one at a time with pages 8-wide
  inside, so a 2-page doc leaves 6 slots idle. Pool over all (doc, page) jobs; keep each document's
  **stale-page prune sweep** strictly after that document's own page uploads complete (group jobs
  per doc with a completion latch, or pool docs 4-wide × pages 4-wide — either is acceptable if the
  per-doc prune ordering is preserved).
- `pipeline/cloudExport.ts` — the per-destination upload loop.
- The serial prune/delete loops: `pruneStaleObject` sweeps in `cdnUpload.ts` and
  `pipeline/cdnCleanup.ts` `deleteCdnObjects` — pool at 4–8. These are destructive deletes: the
  guardrail (`assessDestruction`) decision and the per-key bucket routing must be byte-identical;
  only the dispatch parallelises. `shouldStop` checked before each dispatch.

## Part B — `join()`/`dirname()`/`basename()` are IPC round trips

`@tauri-apps/api/path` calls cross the JS↔Rust bridge. The scan/publish/collect/DAM walks call
them once per file — thousands of pointless IPC hops per run. All paths involved are absolute
POSIX strings on macOS (Sotto ships macOS only — see `00_START_HERE`).

- Add pure helpers to `pipeline/fs.ts` (or `@sotto/domain`): `joinPath(...parts)`,
  `parentPath(p)`, `baseName(p)` — normalize `\` → `/`, collapse duplicate slashes, no IPC.
- Replace call sites in `pipeline/*` (`scan.ts`, `fs.ts` `collectFiles`, `publishLocal.ts`,
  `packages.ts`, `collect.ts`, `cloudExport.ts`) and `dam/*` walks.
- KEEP `@tauri-apps/api/path` for genuinely platform-y things: `appDataDir()` stays.
- Tests mock `@tauri-apps/api/path` via `vfs.pathApi()` — after this change those call sites no
  longer hit the mock, which is fine because the pure helpers must produce identical strings. The
  vfs `norm()` function shows the expected normal form; match it. Add unit tests for the helpers
  (trailing slashes, doubled slashes, backslashes, root edge cases) and keep every characterization
  suite green — they compare exact path strings and will catch any divergence.

## Part C — log/progress batching

`appendLog` fires one Zustand store update per line and `setProgress` one per file; on a large
library that is thousands of main-thread React updates competing with the run itself.

- Buffer log lines and flush to the store on a ~100 ms interval (and synchronously on stage
  boundaries + run end, so tests and tails stay deterministic where it matters).
- Throttle `setProgress` to ~10 Hz.
- Verify the log view renders a virtualized/windowed list; if it maps the whole array, cap or
  virtualize it.
- Characterization tests capture `appendLog` directly through the ctx (not the store), so they are
  unaffected — verify this before assuming; if any test reads the store, flush synchronously in the
  test path.

## DO NOT

- Do not raise concurrency numbers anywhere (8 stays 8) — this prompt changes *scheduling*, not load.
- Do not touch reconciliation/purge decision logic (`flagDisconnected`, `purgePackageMirror`,
  guardrails) beyond the dispatch mechanics of already-decided deletes.
- Do not reorder log SECTION banners relative to their stage's work.

## Acceptance

- All suites green (`vitest`, packages, rust untouched).
- Timed run (04a): visible reduction in every stage on a mixed library; record before/after.
- `CHANGELOG.md` Unreleased entry.

## Effort

~1 day.
