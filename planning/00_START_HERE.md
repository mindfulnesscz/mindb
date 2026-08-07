# Sotto — Planning Hub (START HERE)

Numbered so run order is obvious. Each `NN_` file is a delegatable prompt; prepend the SHARED
CONTEXT block from `DONE_01_security-hardening-S0-S7.md` to any prompt before handing it to an agent.
`REF_` files are reference/strategy, not tasks. `DONE_` files are already implemented — kept for
context, don't re-run.

_Last updated 2026-08-07 (00a/00b/00c landed; `02` closed; `04a`–`04f` performance series filed, evidence in `REF_performance-audit.md`; **`04a` landed** — the run log now carries per-phase durations, so `04b` onwards has a baseline)._

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
| 04b | `04b_perf-supabase-write-concurrency.md` | Asset-row writes pooled 8-wide instead of one awaited HTTP call per row (~8× on the biggest silent gap). Builds the shared `asyncPool`. | TODO |
| 04c | `04c_perf-readme-churn.md` | Stop rewriting every readme.md into the Dropbox source tree every run (timestamp removed, skip-if-unchanged). | TODO |
| 04d | `04d_perf-worker-pools-and-ipc.md` | Chunked barriers → true worker pools; pure-string path joins (kill per-file IPC); log/progress batching. | TODO (after 04b for the pool helper) |
| 04e | `04e_perf-cloud-export.md` | Drive folder-children sweep instead of per-file LIST; MD5 memo (stops cold-cache Dropbox downloads); OneDrive skip-if-unchanged; stretch: uploads in Rust. | TODO |
| 04f | `04f_perf-stage-overlap.md` | Parallel pre-run fetches; early scanVersionMap; optional publish ∥ CDN overlap. Riskiest — run LAST. | TODO |
| 05 | `05_asset-conversion-and-tag-inference.md` | The adoption feature: folder→asset conversion (drop/batch/right-click) + path/file-type tag inference. Prompts A–E, has its own dependency graph. | TODO (feature work — after the perf series) |

The evidence behind the 04 series: `REF_performance-audit.md`.

## ✅ Done (implemented — don't re-run)

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
