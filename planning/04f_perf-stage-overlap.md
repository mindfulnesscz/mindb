# 04f — Stage overlap (run LAST, highest care)

> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`.
> Honour every "Non-negotiables" item in `00_START_HERE.md`. Requires 04a (to measure) and ideally
> 04b/04d (pool helper, log batching) landed first.

## Goal

`runPipeline` and its pre-run are strictly sequential even where stages share nothing. Overlap the
independent ones so wall-clock approaches max(disk, network) instead of their sum. This is the
riskiest perf prompt — do the two LOW-RISK items first; treat the third as optional.

## F1 — parallelise the pre-run fetches (LOW risk)

`features/pipeline/useRunPipeline.ts` awaits, in series: `loadVocabulary` → `requestR2Grant` →
`fetchAssetStorageState` → `fetchPreviewPageLimit`. Dependencies: storage-state and page-limit
need only `sbConfig` (NOT the grant); vocab is independent of all three; the existing "grant failed
⇒ CDN stages disabled" degradation must be preserved exactly.

- `Promise.all` the four (grant failure still only disables CDN: settle independently —
  `Promise.allSettled` or try/catch per promise — and keep each one's current failure log line and
  fallback behaviour byte-identical).
- Keep the existing gating: the three CDN-related fetches only fire under the same conditions as
  today (`sbConfig && clientId && !dryRun && (doThumbnails || doCdnOriginals)`); vocab keeps its
  dirty-check logic untouched.

## F2 — start `scanVersionMap` early (LOW risk)

`syncRunToPortal` runs `scanVersionMap` (a full disk walk of `versions/` subtrees) AFTER every
network sync has finished. Nothing it reads is produced by the run.

- Kick it off (unawaited promise) right after the initial `scanAllAssets` in the pre-run/pipeline
  start; await the promise where its result is consumed (before `syncVersionHistory`).
- Guard: it must not run when `sourceFolder` is unset; on rejection, log exactly as today.
- Note the walk is IO-concurrent already; overlapping it with network stages costs nothing on disk.

## F3 — local publish ∥ CDN uploads (MEDIUM risk — optional, own commit, easy to revert)

`runPublish` (disk-only mirror + reconcile) shares no data with the CDN upload stages
(network + reads of `thumbnails/` artifacts). They can run concurrently:

- In `pipelineService.ts`, wrap the CDN block (thumbs → pages → originals, internally still
  ordered) and the distribute→publish block (internally still ordered: collect BEFORE publish)
  in `Promise.all`.
- **Invariants:**
  - `collect` (distribute) must still precede `publish` and `cloudExport` package jobs — packages
    are filled before they are mirrored. Keep distribute inside the disk chain, before publish.
  - `cloudExport` stays AFTER both chains (it consumes nothing from CDN but the run-log section
    interleaving budget is better spent on one overlap at a time).
  - The Supabase export stays after everything (it consumes `cdnUrls`/`originalUrls`/`pageCounts`).
  - `stats` is shared and mutated by both chains — single-threaded JS makes the counters safe, but
    the final summary must read after the join.
  - **Log interleaving:** two stages' lines will interleave. Prefix each line's stage tag or buffer
    each stage's lines and flush at its section end (04d's batching gives you the hook). Do NOT
    ship interleaved unreadable logs — the run log is an operator tool (see guardrail messages).
  - `isStopping` semantics unchanged: both chains check it; the join respects it.
- Characterization tests: `outOfAppdata.smoke.test.ts` and the stage-order test
  (`'halts before the next stage after Stop is requested'` in `pipelineCollect.characterization.test.ts`)
  assert ordering — update deliberately and minimally, preserving what they guard (stop safety,
  boundary hygiene), not their incidental serial assumptions.

## DO NOT

- Never overlap anything with `runArtifactMigration` — every later stage reads artifacts at their
  migrated location (the comment in `pipelineService.ts` is explicit). It stays a barrier before
  thumbnails.
- Never move the reconcile/disconnect passes relative to their own stage's copies.
- Do not overlap the Supabase export with CDN uploads.
- If F3 turns the log into soup or any characterization test needs weakening (not adjusting),
  ship F1+F2 alone and file F3 as not-worth-it. That is an acceptable outcome.

## Acceptance

- All suites green; stop-safety tests still meaningful (stop during either chain halts the other
  at its next checkpoint).
- Timed runs (04a) before/after, recorded in the commit message.
- `CHANGELOG.md` Unreleased entry.

## Effort

F1+F2 ≈ 2–3 hours. F3 ≈ half a day + careful review.
