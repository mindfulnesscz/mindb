# 04d — Worker pools instead of chunked barriers · pure-string path joins · log batching

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
