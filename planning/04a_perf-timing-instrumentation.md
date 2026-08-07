# 04a — Per-stage timing instrumentation (run this FIRST)

> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`
> before handing to an agent. Honour every "Non-negotiables" item in `00_START_HERE.md`.

## Goal

Make run time **observable**. Nothing in the run log carries a timestamp today, which is why
performance regressed across several audits without anyone being able to say where. Every later
perf prompt (04b–04f) measures its effect against the numbers this one produces.

**This prompt changes no pipeline behaviour.** It only adds measurement. Zero-risk by design.

## Background / evidence

- `desktop/src/services/pipelineService.ts` — `runPipeline` runs stages sequentially with no timing.
- `desktop/src/features/pipeline/useRunPipeline.ts` — pre-run (vocab, grant, storage state, page
  limit) and post-run (`syncRunToPortal`: Supabase export, CDN delete, reconcile, stream sync, tag
  sync, VH scan+sync) are all untimed awaits; several are known to be silent multi-second gaps.
- Stage banners exist (`━━━ THUMBNAILS DONE … ━━━`) — the natural place to attach durations.

## What to build

1. A tiny timer helper (suggested: `desktop/src/services/pipeline/timing.ts`):
   `const t = startTimer(); … t.elapsed()` → formatted `12.4s` / `640ms`. Pure, unit-tested.
2. Append duration to every stage-DONE banner:
   - scan (add one line after the initial `scanAllAssets` in `runPipeline` — it has no banner today)
   - artifact migration, thumbnails, CDN thumbs, CDN pages, CDN originals, distribute, publish,
     cloud export (per destination AND total), Obsidian
   - post-run: SUPABASE EXPORT (and inside it: fetch-existing, plan, writes, readmes, disconnect),
     CDN DELETE, reconcile, stream sync, tag sync, scanVersionMap, VH sync
   - pre-run: one line each for vocab refresh, R2 grant, storage-state fetch, page-limit fetch
3. A final `RUN TOTAL — <sum>` summary line listing the top 5 slowest phases with durations.
4. Timing must not change log ordering or stats, and must cost nothing measurable itself
   (`performance.now()`, no extra awaits).

## DO NOT

- Do not reorder, parallelise, or skip anything. That is 04b–04f's job.
- Do not change any stage banner's existing prefix text — `pipelineCollect.characterization.test.ts`
  and friends assert on log substrings (`run.logged('COLLECT DONE')` etc.). **Append** ` in 12.4s`
  after the existing text; run the characterization suites to prove the assertions still match.
- Do not add timestamps to every log line (noise); durations on section boundaries only.

## Acceptance

- `npx vitest run` green (all suites, notably `pipeline*.characterization.test.ts`).
- A dry-run pipeline log shows a duration on every section-DONE line and a RUN TOTAL block.
- Unit test for the formatter (ms, s, m boundaries).

## Effort

~half a day. No migration, no docs page needed; add a line to `CHANGELOG.md` under Unreleased.
