# 04f — Stage overlap (DONE — F1 + F2 landed, F3 deliberately not)

> **Outcome (2026-08-07).** F1 and F2 shipped in one commit. **F3 was measured and dropped** — the
> prompt's own escape hatch, taken on evidence rather than on difficulty. Details below; the rest of
> this file is the original prompt, kept for context.
>
> **F1 — the four pre-run reads are one wait.** They are dispatched together in
> `features/pipeline/preRun.ts`, a new module, and their results are applied, logged and degraded in
> the OLD order — the lines are emitted after the join, not as each read lands. A failed grant still
> disables the CDN steps with the same line and still discards the two reads that have already
> finished, because `preview_page_limit` decides how many pages a degraded run renders **locally**.
> Timings: one ranked `PRE-RUN READS` phase, the four reads as steps.
>
> **F2 — the version-history walk runs under the run.** `runPipeline` starts it right after the
> source scan (`ctx.earlyVersionScan` ⇒ `ctx.versionScan`) and the portal sync awaits it where it
> consumes it. A rejection is carried as a value, not left on the promise: the await is minutes away,
> and an unhandled rejection would replace the one log line the failure is meant to produce.
> `VERSION SCAN` is now the WAIT, with the walk's own duration reported on the same line.
>
> **Measured, from `run-timings.jsonl` on the dev machine** (local Supabase, 15–53 assets — the
> before rows are runs from earlier the same day):
>
> | | pre-run cost |
> |---|---|
> | before (sum of four phases) | 394 / 679 / 755 / 780 / 847 / 910 ms |
> | after (`PRE-RUN READS`) | 561 ms and 1017 ms — **equal to the `R2 grant` step, exactly** |
>
> The three other reads now cost nothing: 26 + 26 + 31 ms of hidden work in the 14:01 run. So the
> saving here is ~60–85 ms, because `r2-grant` (350–1000 ms, an edge function) dominates a pre-run
> against LOCAL Supabase. Against a remote project, where each PostgREST read is 150–300 ms rather
> than 20 ms, the same change hides ~0.5 s. F2 is not in these numbers — `VERSION SCAN` was 6 ms on a
> 15-asset library, and its cost scales with the `versions/` subtrees, so **it still needs one run
> against a real client library** to be worth anything. The line to look for:
> `Version map ready in 3ms (walked in 6.1s alongside the run)`.
>
> **F3 — publish ∥ CDN: not worth it, on measurement.** Every phase of nine real runs, worst case
> for each chain:
>
> | | disk chain (`DISTRIBUTE` + `PUBLISH`) | CDN chain | overlap ceiling |
> |---|---|---|---|
> | 29 assets, 23.7 s run | 0.8 s | ~1 s | 0.8 s (3%) |
> | 15 assets, 163 s run | ~0.2 s | 148 s | 0.2 s (0.1%) |
> | 15 assets, 2.1 s run | ~0.2 s | 0.9 s | 0.2 s (9% of a run nobody waits on) |
>
> `min(disk, network)` IS the saving, and the disk chain never exceeded 0.8 s. Against that:
> `runPublish` is where the 🚫-rename and the package hard-delete live, so this is concurrency around
> the most destructive stage in the product; the two chains' log lines interleave at per-file
> granularity, and the prompt's own fix for that (buffer a stage, flush at its section end) LOSES the
> timestamps, because `appendLog` stamps a line when the store hears about it, not when the stage
> emitted it — so a buffered `CDN ORIGINALS` would read as having taken zero seconds; the progress
> bar would be fed by two stages at once with no arbitration; and a `Promise.all` join lets one
> chain's failure finish the run while the other is still copying files into a client's folder.
> Each of those is fixable, and none of them is worth 0.8 s. **What would change the verdict:** a
> timed run on a real client library showing `PUBLISH` + `DISTRIBUTE` as a meaningful share of the
> run. The two hot phases in the real data are `CDN ORIGINALS` (143 s / 15 assets) and `CLOUD EXPORT`
> (163 s) — both single-destination network transfers, where the win is bandwidth or skipping, not
> overlap.

---

## The original prompt (run LAST, highest care)

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
