# 04c — Stop rewriting every readme.md into the Dropbox source tree on every run

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
