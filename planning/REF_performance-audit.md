# REF — Run-speed audit (2026-08-07)

Reference, not a task. The findings behind the `04a`–`04f` prompt series. Reviewed against the
code as of 2026-08-07, after the metadata-only `isUnchanged` fix (publish no longer byte-compares,
so Dropbox online-only files stay online-only during local export).

## What is already good — do not "optimize"

- **Thumbnails/document previews**: 8-wide async Rust commands, metadata-fingerprint render cache,
  one LibreOffice conversion per document (thumb + pages). The reference standard.
- **R2 CDN stages**: local mtime+size cache, one tiered ListObjectsV2 manifest sweep, content-hash
  dedupe in Rust.
- **Version-history sync**: bulk upserts, batch 500 — the pattern the asset export should copy.
- **Source scan**: concurrent walk.
- **Dropbox upload**: streamed in Rust with remote-skip.

## Ranked findings

| # | Finding | Where | Cost shape | Prompt |
|---|---|---|---|---|
| P1 | Asset rows written one awaited HTTP call at a time | `supabase/exportWrite.ts` | N × RTT serial (45–90 s / 300 assets) | 04b |
| P2 | Every readme.md rewritten (timestamp) into the Dropbox source tree every run | `readmeService.ts`, `assetExport.ts` | N serial writes + Dropbox re-sync storm | 04c |
| P3 | Chunked `Promise.all` barriers idle 7 slots on one slow item; pages-upload outer loop serial per document; prune/delete loops serial | `thumbnails.ts`, `cdnUpload.ts`, `cloudExport.ts`, `cdnCleanup.ts` | slowest-item × chunks | 04d-A |
| P4 | `join()`/`dirname()` are IPC round trips, called once per file in every walk | `pipeline/*`, `dam/*` | thousands of IPC hops | 04d-B |
| P5 | Pre-run fetches serial; `scanVersionMap` runs after all network syncs; publish (disk) serialized behind CDN (network) | `useRunPipeline.ts`, `pipelineService.ts` | sum instead of max | 04f — first two fixed; **publish ∥ CDN dropped**, ceiling measured at 0.2–0.8 s (see `DONE_04f`) |
| P6 | Per-line store updates for log + progress thrash the main thread | `pipelineStore` consumers | UI jank disguised as run time | 04d-C |
| P7 | No timings anywhere — regressions are invisible | run log | — | 04a |
| G1 | Drive: per-file `files.list` on every cache miss | `gdrive.ts` `findGDriveFile` | N × RTT when cache cold | 04e-E2 |
| G2 | Drive: full local re-hash (`file_md5`) on unchanged-remote path → forces Dropbox download | `gdrive.ts` `uploadGDriveFile` | full read per cache-missed unchanged file | 04e-E1 |
| G3 | Drive/OneDrive bytes cross the webview twice (readFile → fetch) | `gdrive.ts`, `onedrive.ts` | memory + copy for big files | 04e-E4 |
| G4 | OneDrive has no skip-if-unchanged | `cloudExport.ts` | full re-upload per cache miss | 04e-E3 |

## Recent gdrive changes — review verdict

`DONE_02_gdrive-duplicate-folder-fix` is correct: canonical-oldest folder pick, per-segment
in-flight memo, sequential pre-resolve, duplicate notices, trash-not-delete in the dedupe tool.
No functional regressions found. G1–G4 above are performance follow-ups on the same code, not bugs
in the fix. One minor robustness note: the module-lifetime folder-id cache never invalidates — a
folder trashed mid-session 404s until app restart; evict-on-404-and-re-resolve-once is cheap when
someone is next in that file.

## Known deliberate residuals (do not "fix" as perf work)

- Thumbnail fingerprints are mtime+size, not content hash — documented tradeoff (`00_START_HERE`).
- `resolveChildId` full-file hash on manifest miss is correct (identity needs it); a bulk rename on
  a Dropbox source will trigger mass downloads once — acceptable, log-worthy, not a bug.
- `files_equal` (Rust) is retired from the pipeline path but kept for a future explicit
  deep-compare action.

## Run order and measurement discipline

04a → (04b, 04c in either order) → 04d → 04e → 04f. Each prompt lands with before/after timings
from 04a recorded in its commit. Full suites green at every step; characterization tests are
adjusted only where the serial order itself was the incidental thing they pinned — never weakened
on what they guard (destruction guards, stop safety, export boundary, PATCH semantics).
