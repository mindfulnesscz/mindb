# 04c — Stop rewriting every readme.md into the Dropbox source tree on every run

> **LANDED 2026-08-07** as `6f6dc11` (`perf(supabase): write readme.md only where it changed`).
> Green on `lint`, `typecheck`, `test:packages`, `test:desktop`, `build:docs`.
> Both parts of the prompt shipped, plus one thing it did not ask for.
>
> **1. The content is deterministic.** `_Last synced: <ISO timestamp>_` is gone from
> `readmeService.buildReadme`, which is now a pure function of its `ReadmeInput`. The header comment
> says why in the imperative, because this is the invariant the whole change rests on: *do not
> reintroduce a clock, a random id, or anything else that varies between two runs over identical
> data* — a single such line silently restores the old behaviour and nothing fails visibly. The
> footer's "Regenerated automatically on every pipeline run" stays literally true: it is still
> rebuilt in memory every run, it is only *written* when it differs.
>
> **2. Identical writes are skipped.** `writeReadme` reads the existing file, compares, and returns
> whether it wrote. **The comparison is against the file ON DISK, never against a cache of what the
> last run wrote** — that is what makes a teammate's Dropbox edit or an accidental deletion heal on
> the next run rather than being skipped forever. A missing, unreadable or garbled file all read as
> "write it": the read is only ever an optimisation, so every failure mode errs toward writing.
> `writeReadmes` tallies the two outcomes and the export logs one summary line —
> `readme.md: 3 updated · 245 unchanged in 120ms` — never one line per file.
>
> **3. Not in the prompt: the log line it replaced was wrong.** The old
> `readme.md written for ${written}/${targets.length} folder(s)` counted TARGETS, and targets are not
> one per folder (see `DONE_04b` — a package holding several galleries contributes one target each
> for the same `readme.md` path). It has been replaced rather than extended.
>
> **Stats still flow, by design.** A changed rating, view count, `status` or `perm` changes the
> content, so that readme *is* written. That is the intended behaviour and it is what keeps the notes
> from going stale; "zero writes" is only ever the answer for genuinely unchanged data.
>
> **Nothing moved.** Same path, same name, same format minus one line — Obsidian reads them exactly
> as before, and `.dchub.json` was not touched (identity was never in this file).
>
> **Tests:** `readmeService.test.ts` (no wall clock in the output; write-on-missing,
> skip-on-identical, write-on-changed-stat-and-only-then, and heal-a-teammate's-edit — the last one
> is the guard on "disk is the truth, not a cache") and `supabase/assetExportReadme.test.ts`, which
> drives the real export: a second pass over unchanged data performs **zero** writes, a stats change
> triggers exactly the one write, and an externally edited readme is rewritten.
> `assetExport.characterization.test.ts` stayed green — it never pinned the timestamp line.
> Docs: `docs/pages/pipeline.mdx`. Changelog: Unreleased → Changed.
>
> **Still owed (manual, as with every 04x):** the timed no-change run — the readme step's
> `SUPABASE EXPORT › readmes` sub-step duration and the absence of a Dropbox re-sync storm after the
> run. No automated test can observe either.
>
> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`.
> Honour every "Non-negotiables" item in `00_START_HERE.md`.

## Goal

`desktop/src/services/readmeService.ts` embeds `_Last synced: <ISO timestamp>_` in every
`readme.md`, and `writeReadmes` (`desktop/src/services/supabase/assetExport.ts`) regenerates the
file for **every package folder on every run**. Because the timestamp always differs, every run
rewrites every readme — serially — into the **synced Dropbox source tree**. Three costs: the serial
writes; Dropbox re-uploading hundreds of tiny files after each run (sync churn the operator sees
for minutes afterwards); and pointless mtime churn in the source of truth.

A no-change run should write **zero** readmes.

## What to change

1. **Make the content deterministic.** Remove the `_Last synced_` line from `buildReadme` (or derive
   it from data that only changes when the data changes — simplest is removal; the file already says
   it is auto-generated). Note the file's own footer text ("Regenerated automatically on every
   pipeline run") stays truthful: it is regenerated *in memory* every run; it is only *written* when
   different.
2. **Skip identical writes.** In `writeReadme` (or its caller), read the existing `readme.md`
   (`readTextFile`, tiny file, cheap even on Dropbox) and compare to the newly built content;
   write only when different or missing. Count and log skips once in summary form
   (`readme.md: 3 updated · 245 unchanged`), not per file.
3. Stats still flow: a changed rating/view count legitimately changes the content → that readme is
   written. That is correct and stays.
4. If 04b landed, this loop is already pooled; otherwise leave it serial — after this change the
   loop is almost always a no-op, so pooling matters less here.

## DO NOT

- Do not move readme generation off the source tree or change its path/name — Obsidian reads it.
- Do not cache "already written" in appdata as the primary mechanism — the file on disk is the
  truth (a teammate's Dropbox edit or deletion must be healed by the next run). Read-and-compare.
- Do not touch `.dchub.json` — identity is out of scope here.
- `readmeService.buildReadme` is also used by the draft-asset flow (`draftAssets.ts` / Task 6 in
  git history) — check callers before changing the signature.

## Tests

- Unit: `buildReadme` output is deterministic for fixed input (no wall-clock content). Note
  `Date.now`-free.
- Unit/integration: second `writeReadmes` pass over unchanged data performs zero writes (spy on
  `writeTextFile`), and a stats change triggers exactly that one write.
- `assetExport.characterization.test.ts` green — if it pins the timestamp line, update the fixture
  deliberately (that is the point of this change), keeping every other assertion intact.

## Acceptance

- All suites green.
- Timed no-change run: readme phase reports `0 updated · N unchanged`, and Dropbox shows no
  re-sync storm after the run (manual check).
- `CHANGELOG.md` Unreleased entry.

## Effort

~2–3 hours.
