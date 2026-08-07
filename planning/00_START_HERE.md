# Sotto — Planning Hub (START HERE)

Numbered so run order is obvious. Each `NN_` file is a delegatable prompt; prepend the SHARED
CONTEXT block from `DONE_01_security-hardening-S0-S7.md` to any prompt before handing it to an agent.
`REF_` files are reference/strategy, not tasks. `DONE_` files are already implemented — kept for
context, don't re-run.

_Last updated 2026-08-07 (00a/00b/00c landed; `02` closed; `04a`–`04f` performance series filed, evidence in `REF_performance-audit.md`; **`04a`–`04e` landed** — the run log carries per-phase durations, every batched stage runs on the shared `asyncPool` instead of a chunked barrier, path arithmetic no longer crosses the Rust bridge per file, the log no longer competes with the run for the main thread, a no-change run writes zero readmes into the client's synced source tree, and a cloud export with a COLD upload cache no longer re-reads or re-lists what it could have asked once. `04f` is next — and it is the riskiest of the series)._

## 🚢 3.2.2 — code complete

`00a`, `00b` and `00c` have all landed on `hotfix/3.2.2` and are green
(`lint`, `typecheck`, `test:packages`, `test:desktop`, `test:rust`, `lint:rust`, `build:desktop`,
`build:docs`). The changelog section is written.

**Two things still gate the release, and neither is a code change:**

1. **Delete the `xvmucha@vutbr.cz` test user in the PRODUCTION dashboard** (confirm it carries both
   `google` and `github` identities first). Until then the next GitHub sign-in does not provision
   cleanly through `handle_new_user`. Carried out of `DONE_00a`.
2. **Re-test the three auth providers on STAGING** (`tvrxnwbhzborkkkdeyuk`), one distinct email
   each. Never against production. Carried out of `DONE_00a`.

Also worth doing before the release is cut: a **timed pipeline run** to confirm 8-way thumbnail
throughput, which `00b` part A restored but which no automated test can observe.

## ▶ Run next — in this order

| # | File | What it does | Status |
|---|---|---|---|
| 04f | `04f_perf-stage-overlap.md` | Parallel pre-run fetches; early scanVersionMap; optional publish ∥ CDN overlap. Riskiest — run LAST. | TODO |
| 05 | `05_asset-conversion-and-tag-inference.md` | The adoption feature: folder→asset conversion (drop/batch/right-click) + path/file-type tag inference. Prompts A–E, has its own dependency graph. | TODO (feature work — after the perf series) |

The evidence behind the 04 series: `REF_performance-audit.md`.

## ✅ Done (implemented — don't re-run)

- `DONE_04e_perf-cloud-export.md` — E1, E2, E3. **E4 (uploads in Rust) deliberately not taken** —
  skippable by its own description, and the one part that cannot be finished honestly without a
  manual >150 MB transfer against a real account. **E1**: a file's content is hashed **at most once,
  ever**. `cloud-upload-cache.json` grew a second section — `{ uploads, hashes }`, `hashes` keyed by
  **source path** and fingerprinted on mtime+size — because "these bytes hash to this" is a property
  of the file, not of where it was sent, so a second destination, a reconnected one and a later run
  all reuse it. The prompt's `md5?` on `CloudCacheEntry` would have been a DEAD FIELD (the early skip
  fires on exactly the condition that would have read it) and is not there. The legacy flat shape is
  still read. **E2**: `ensureGDriveFolderPaths` now returns `Map<path, folderId>` instead of throwing
  the ids away, and `sweepGDriveFolderFiles` lists those folders once (4-wide, same `asyncPool`),
  returning `Map<folderId, Map<name, file>>` or **`null` if any folder failed** — the CDN manifest's
  convention, and for its reason: a listing believed complete when it is not reads as "not uploaded
  yet" and puts a second copy beside the client's file. `listGDriveChildren` was **extended, not
  forked**. Two additions the prompt did not ask for and the change needs: same-named FILES resolve
  canonical-oldest (or two runs update different copies), and a file created during the run is
  **folded back into the listing** — without that, two jobs writing one name into one folder would
  create a duplicate where the per-file lookup used to update in place. **E3**: OneDrive asks Graph
  what is there, compares size before reading anything, and only then compares a native streaming
  **QuickXorHash** (`src-tauri/src/quickxor.rs`, a faithful port with a hand-computed vector and a
  block-size-invariance test for the streaming carry). **Size-only skipping was rejected** — it is
  weaker than the rule Drive's uploader already refuses, and every uncertain answer points at
  uploading. Personal OneDrive publishes no QuickXorHash and uploads as before. **Also fixed,
  unasked**: a stopped export used to discard its whole cache (saved only after the last
  destination), so the next run started cold against a half-updated destination. **Still owed: the
  timed cold-cache run** — clear the cache, run against a small real destination, confirm no
  full-file reads and one `listed N Drive folder(s) once` line in place of N lookups.

- `DONE_04d_perf-worker-pools-and-ipc.md` — all three parts. **A**: every chunked
  `for (i += 8) { await Promise.all(chunk) }` is now `asyncPool`, so a slot refills the moment it
  frees instead of the whole batch waiting on its slowest member — thumbnails (rasters and
  documents), all three CDN upload stages, cloud export, both `pruneStaleObject` sweeps and
  `deleteCdnObjects`. **No width was raised**: 8 for uploads/renders, 4 for the destructive sweeps.
  Page previews were additionally FLATTENED — documents used to run one at a time with pages 8-wide
  inside, so a two-page deck used two slots; jobs now pool across documents with a **completion
  latch** that keeps each document's stale-page sweep strictly after its own pages settle (the sweep
  deletes everything under the asset's page prefixes this run did not claim, so overlapping it with
  a sibling page's upload would race a delete against that write). Every converted site is followed
  by `if (isStopping()) return;` — the chunked loops returned out of the stage on stop, and without
  it a stopped run would start printing banners it never printed. **B**: `services/pipeline/paths.ts`
  — pure `joinPath`/`parentPath`/`baseName` replacing `@tauri-apps/api/path` in the scan, publish,
  collect and DAM walks, which were paying an IPC round trip **per directory entry**. `.` and `..`
  are deliberately NOT resolved (canonicalisation belongs in Rust behind `path_policy`), and it lives
  in the desktop rather than `@sotto/domain` because a new module there breaks every local edge
  function until the container is recreated. **C**: log lines buffer for 100 ms and `setProgress` is
  throttled to ~10 Hz, but **section banners flush synchronously** carrying everything buffered
  before them, so order is never affected; `finishRun` flushes and cancels the trailing progress
  timer. Also: the log view now renders the last 1,500 lines rather than the whole array, and four
  components that subscribed to the WHOLE store (including the one holding `useRunPipeline`) take
  per-field selectors — without that the batching bought nothing. Tests: `paths.test.ts` (including
  agreement with `vfs.pathApi()`, the normal form the characterization suites compare against) and
  `store/pipelineStore.test.ts`. **Still owed: the timed before/after run.**

- `DONE_04c_perf-readme-churn.md` — a no-change run now writes **zero** readmes. Every package
  folder gets a `readme.md`, and each carried a `_Last synced: <timestamp>_` line, so its content
  differed from the copy on disk every run and every run rewrote the whole library — inside the
  client's **synced Dropbox source tree**, which then spent the minutes after each run re-uploading
  hundreds of tiny files saying the same thing as before. `buildReadme` is now a pure function of its
  input (**do not reintroduce a clock, a random id, or anything else that varies between two runs
  over identical data** — the skip depends on it), and `writeReadme` reads the existing file,
  compares, and writes only on a difference. **The comparison is against DISK, never a record of what
  the last run wrote**: that is what heals a teammate's edit or a deletion in the shared folder, and
  a missing/unreadable file reads as "write it" so every failure errs toward writing. Stats still
  flow — a changed rating, view count, `status` or `perm` changes the content and that one readme is
  written. One summary line replaces the old per-target count (which was wrong: targets are not one
  per folder). Same path, same name, so Obsidian is unaffected. Tests: `readmeService.test.ts` and
  `supabase/assetExportReadme.test.ts`. **Still owed: the timed no-change run** and a manual check
  that Dropbox shows no re-sync storm afterwards — neither is observable from a test.

- `DONE_04b_perf-supabase-write-concurrency.md` — the biggest silent gap, closed. The Supabase
  export was issuing **one awaited PostgREST round trip per asset row**, in series, for parents and
  then children; at 150–300ms a trip a 300-asset library spent 45–90s of every run waiting. Both
  phases now dispatch `WRITE_CONCURRENCY = 8` at a time through the new
  **`services/pipeline/pool.ts` `asyncPool`** — a real worker pool (next item starts the moment a
  slot frees), which is the helper `04d` Part A reuses. **What each request sends is untouched**:
  still one `PATCH`/`POST` per row, never a bulk upsert, because that is what `stripPortalOwnedFields`
  and `stripAbsentUrls` depend on. The **parent→child barrier survives** (a child needs its parent's
  uuid), per-row error accounting is identical, and `shouldStop` halts dispatch while in-flight
  requests finish. `writeReadmes` is pooled too, but **grouped by `packageDir` and serial within a
  group** — a package holding several galleries contributes one target each for the same
  `readme.md` path, and naive pooling would race two full-file overwrites (test is red without the
  grouping). Also fixed a real bug the concurrency exposed: `getAccessToken({ forceRefresh: true })`
  is now **single-flight**, because GoTrue rotates the refresh token on use and eight simultaneous
  401s each calling `refreshSession()` can trip reuse detection and revoke the session the first
  call just renewed. New tests: `pipeline/pool.test.ts`, `supabase/exportWrite.test.ts` (20 rows
  through a stub that settles out of order — same tallies, same `parentIdByKey`), `authService.test.ts`.
  **Still owed: the timed before/after run.** It needs a signed-in session against a real project
  and ≥50 assets, so no automated test can produce it — take the numbers from the `RUN TOTAL` delta
  line on `SUPABASE EXPORT › writes`. What _was_ measured is the mechanism, on a throwaway harness
  with a 200ms stubbed round trip: 60 rows took **1.6s pooled against 12.0s serial (7.4×)**, which
  is the ceiling for 60 rows at width 8 (⌈60/8⌉ = 8 waves). Real latency varies per row, where the
  pool's slot refill should do slightly better than a chunked barrier would.

- `DONE_04a_perf-timing-instrumentation.md` — run time is observable. Every section-DONE banner
  carries its own duration, the source scan got the line it never had, and the run closes with a
  `RUN TOTAL` block: wall clock from the Run button, the five slowest top-level phases with their
  share, and a `measured … of …` line so untimed work shows as the difference. Sub-steps (the
  Supabase export's fetch/plan/writes/readmes/disconnect, one cloud destination of several) report
  where they happen but stay out of the ranking. The timeline is module state in
  `services/pipeline/timing.ts` **on purpose** — a run's phases span `runPipeline`, the stage
  modules and the post-run sync in `useRunPipeline`, and threading a collector through
  `exportAssetsToSupabase`'s fourteen positional arguments would have been a bigger change than the
  measurement it exists to add. Zero behaviour change: nothing reordered, nothing skipped, no banner
  text altered (durations are appended). Covered by `pipeline/timing.test.ts` (formatter boundaries,
  ranking, idempotent `done()`) and `pipelineTiming.integration.test.ts`, which drives a real run
  and fails if any section-DONE banner loses its duration.
  **Runs are also persisted and compared** (`services/pipeline/runTimings.ts`): one JSON line per
  run in `run-timings.jsonl` under app data, capped at 500 and reachable from Settings →
  Diagnostics, with the `RUN TOTAL` block carrying the change since the last COMPARABLE run — same
  client, same stages enabled, same dry-run flag, stopped runs excluded on both sides. Asset count
  is not matched on (it drifts every run) but is printed, so an unfair comparison is visible. **Add
  any new stage flag to `STAGE_FLAGS` there**, or two different runs will compare as equals.
  **Record before/after numbers from this in every later 04x commit — the delta line gives them to
  you directly.**

- `DONE_02_gdrive-duplicate-folder-fix.md` — Drive's duplicate folders, both halves.
  **G1**: folder resolution is race-safe (one shared in-flight resolve per path segment, the
  destination tree pre-resolved before the 8-wide batch) and converges — several same-named folders
  resolve to the **oldest**, deterministically, with the duplicate set reported in the run log.
  **G2**: `services/cloud/gdriveDedupe.ts` plus **Settings → Cloud destinations → a Drive
  destination → Maintenance** merges the copies already out there: read-only preview, `planId`
  re-check before anything moves, trash rather than delete, and a fresh emptiness check on every
  folder before it goes. Docs: `operations/gdrive-dedupe.mdx`. **Still worth doing by hand: one run
  against a real client Drive** — the tests use a mocked Drive tree.

- `DONE_00a_auth-oauth-identity-bugs.md` — a failed OAuth/magic-link return silently restored the
  **previous** user's session. **A1**: the return is resolved once, at app level
  (`lib/authReturn.ts`), before any session is trusted; the portal client is
  `detectSessionInUrl: false`; two regression tests, red before (`ef632b1`). **A2**: GoTrue identity
  linking documented (`ab82ff2`). **A3 was deferred deliberately** — linked-provider badges need
  `auth.identities` aggregated into `get_all_profiles`, which is a migration plus a `db:types` regen
  in a hotfix whose changelog documents exactly one migration. Worth a normal release.
  **Its two manual production steps are still open — see the 3.2.2 section above.**
- `DONE_00b_desktop-ui-freeze-and-libreoffice.md` — the beachball, and the bundled engine.
  **Part A**: any Tauri command doing blocking work is `#[tauri::command(async)]`; a sync command
  runs on the OS event loop and froze the window for the whole render phase (~6.4s per document),
  while also serialising the pipeline's 8-at-a-time batching onto one thread (`d66d3b2`).
  **Parts B/C** (`06a571a`): LibreOffice runs under the full headless flag set so macOS cannot give
  the nested bundle a Dock tile; both subprocesses run under a 60s deadline and are killed on expiry;
  a release build on macOS/Windows hard-errors instead of silently borrowing a host LibreOffice.
  Compiled and green — the "landed but never compiled" caveat is closed. A **timed run** to confirm
  8-way throughput is still worth doing by hand.
- `DONE_00c_out-folder-hygiene-and-artifact-layout.md` — what the client sees (`affecad`). All three
  parts landed together. **C1**: destinations receive assets only, gated by one predicate at the
  export boundary, with a boundary test over local publish (both layouts), the package mirror and
  each cloud provider — which also caught a real leak, page previews being published into local
  targets because the walk recursed into directories before filtering. **C2**: the `.json` render
  caches are hidden; thumbnails and previews stay visible. **C3**: every artifact, including the
  document title slide, moved into one `thumbnails/` folder beside the assets, with
  `validate_preview_area` rewritten to compute both outputs from the source and compare exactly.
  Migration is automatic, re-renders nothing and moves no CDN object.
  **Known gap:** hiding is a leading dot, which Windows does not honour — `FILE_ATTRIBUTE_HIDDEN` is
  not set, because Sotto ships macOS only and has no Windows CI. Documented in `render.rs`.
- `DONE_01_security-hardening-S0-S7.md` — the security audit fixes. **Re-verified 2026-08-06: the audit is now effectively fully closed.** All four items that were still open at the first verification are fixed: `processRenameTasks` placebo removed; GDrive race + weak skip; cloudUrls stem collision (now keyed by stable identity); taxonomy-label path sanitization. See `REF_audit-verification.md`.
- `DONE_02_cdn-garbage-collector.md` — bucket-wide CDN GC. Landed as the `cdn-gc` edge function + `cdnGarbageCollection.ts` desktop client (commit `200b1f2`).
- `DONE_03_stabilize-hardening-regressions.md` — the S5/S3 regressions. Landed in 3.2.2: the fs
  capability is a deliberate `$HOME/**` + `/Volumes/**` + `$APPDATA/**` scope declared once via
  `fs:scope`; folder pickers grant recursively; `path_policy` re-reads persisted roots on a scope
  miss (the fresh-install case); prune-guard and out-of-appdata smoke tests added; `cdn-reconcile`
  returns per-asset `{asset_id, stage, reason}` and the desktop logs it.
- CDN **per-asset** cross-level orphan prune (commit `7e3b3d4`). Its still-referenced guard is now
  covered by `desktop/src/services/pipeline/cdnPruneGuard.test.ts`.
- **LibreOffice bundling itself works.** Verified 2026-08-06 on the installed build:
  `Sotto.app/Contents/Resources/resources/native/libreoffice/…/soffice` is present. It is excluded
  from `bundle.resources` on purpose (Tauri dereferences symlinks → 800MB becomes 1.5GB and the
  sealed signature breaks) and placed with `ditto` by `npm run build:app`. Don't "fix" the config.

## 📎 Reference (not tasks)

- `REF_performance-audit.md` — the 2026-08-07 run-speed audit behind the `04a`–`04f` series (ranked findings, gdrive review verdict, what NOT to "optimize").
- `REF_audit-findings.md` — the full P0–P3 findings list with file:line.
- `REF_audit-verification.md` — implemented-vs-checklist with evidence, plus the 2026-08-06 re-check.
- `REF_onboarding-and-scaling.md` — the "acquirable by other agencies" analysis (identity model, custom domains, onboarding friction).
- `REF_asset-mgmt-and-tag-inference-plan.md` — value/effort plan + the detailed tag-inference design that `05` implements.
- `docs/pages/ideas/slimming-the-bundled-libreoffice.mdx` — the ~800MB trim, relevant before auto-update is turned on.

## Known deliberate residual (not a task)
- **No provider skips on size alone** (`04e`). Drive refuses it when Drive publishes no md5, and
  OneDrive refuses it when Graph publishes no `quickXorHash` — an edit preserving the byte count
  would otherwise leave a client on the old file indefinitely. Every uncertain answer in a skip
  decision (404, 401, 5xx, an absent hash, a failed listing) must point at UPLOADING. Adding a
  size-only shortcut "because it closes most of the gap" reintroduces exactly the class of silent
  staleness the pinned Drive test exists to prevent.
- **A pre-listed Drive folder must be updated when the run writes into it** (`04e`,
  `rememberCreatedFile`). The sweep is a snapshot; without the write-back, two jobs writing the same
  name into one folder create a duplicate where the old per-file lookup updated in place. If the
  sweep is ever reworked, that write-back is the part that is not an optimisation.
- **`services/pipeline/paths.ts` does not resolve `.` or `..`** (`04d` Part B). Nothing in the
  pipeline composes them, and collapsing them in JS would be a way to climb out of a folder
  `path_policy` had approved. Canonicalisation stays in Rust, behind the scope check. Same file:
  `appDataDir()` and every other OS question still goes through `@tauri-apps/api/path`.
- **A `section` log line flushes the buffer synchronously** (`04d` Part C). Everything else waits up
  to 100 ms. That is what keeps stage banners current in a tail, keeps breadcrumbs attributable, and
  guarantees batching never reorders a log. If you add a log type that must be immediate, flush it
  the same way rather than lowering the interval.
- Thumbnail regeneration fingerprints on **mtime + size, not a content hash** (`render.rs`), so a content edit preserving both won't regenerate. Documented tradeoff (hashing = read every file), not a bug.
- **The per-thumbnail `.json` sidecars are render caches, not metadata** — they hold the source size+mtime and the width/quality settings, the only way to know a render is stale. Deleting them re-renders the library. `00c` C2 **hid** them rather than consolidating, and consolidating stays wrong: eight concurrent renderers writing one shared manifest is last-writer-wins, and a corrupt write would invalidate a whole gallery instead of one thumbnail.
- **CDN object keys are built from folder identity (`stable_id`/`child_id`), never from filenames** (`cdnUpload.ts:4`). Renaming or moving a local artifact changes no key and orphans nothing — don't re-derive this fear when touching the layout. It is what made `00c` C3 affordable, and what makes its migration free.
- **`-thumb` stays in artifact filenames** even though location is now authoritative (`00c` C3). It keeps every legacy substring filter working as a safety net for libraries that have not run yet. Dropping it is a separate later decision.
- **The artifact layout rule lives in ONE place** — `packages/domain/src/artifactLayout.ts`. It replaced eight ad-hoc `-thumb` substring tests, one of which was always going to be the one someone forgot. Compose paths from it; never add a fourth copy of the rules.
- **Automatic OAuth identity linking** (GoTrue): a second provider returning the same verified email links into the existing user rather than creating a new one, inheriting that user's `role` and `client_id` — `handle_new_user` is first-sign-in-only. Intended upstream behaviour, no hosted toggle. Now in the product docs: [One user, many identities](../docs/pages/auth.mdx). The actionable half was the silent-failure bug, and that is fixed.
- **LibreOffice initialises AppKit on macOS even under `--headless`**, so it can take a Dock tile. Upstream behaviour. Mitigated with the full headless flag set in `DONE_00b`; do NOT patch the nested `Info.plist` — that breaks the sealed signature notarisation depends on. `soffice.bin` directly is the next lever if flags ever prove insufficient.

## Non-negotiables for every agent
- Identity is minted in ONE place (`createAssetFolder` / `@sotto/domain`); never key on filename.
- Never `db:reset`; apply migrations with `supabase migration up`.
- Update `docs/pages/**` (and README/VERSIONING where relevant) in the same change.
- Ship green (`lint`, `typecheck`, the test suites) and add a regression test for anything you fix.
- **Never exercise auth providers against production.** Use staging (`tvrxnwbhzborkkkdeyuk`) with a distinct email per provider; a test user in prod mutates real auth state and links identities you then have to unpick.
- **Any Tauri command that does blocking work must be `#[tauri::command(async)]`.** Sync commands run on the main thread and freeze the window (Tauri v2 docs). This caused `DONE_00b`.
- **Package the desktop app with `npm run build:app`, never a bare `tauri build`** — the latter silently ships without LibreOffice.
- **`validate_preview_area` is a security guard, not a naming convention.** It is what stands in front of `remove_dir_all`. Any change to the previews layout rewrites it — never relaxes it.
