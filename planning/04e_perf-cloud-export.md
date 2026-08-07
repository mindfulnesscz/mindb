# 04e — Cloud export: kill the cold-cache penalty (Drive sweep, MD5 memo, OneDrive skip)

> Delegatable prompt. Prepend the SHARED CONTEXT block from `DONE_01_security-hardening-S0-S7.md`.
> Honour every "Non-negotiables" item in `00_START_HERE.md`. `DONE_02_gdrive-duplicate-folder-fix`
> is context — its invariants (canonical-oldest folder pick, pre-resolve, duplicate notices) must
> survive untouched.

With a warm `cloud-upload-cache.json`, cloud export is already fast (mtime+size skip, zero
network). The problem is every **cache-missed** file, and the whole library misses when the cache
is cold (first run, new destination id, cleared appdata, or a Dropbox sync that touched mtimes).

## E1 — `file_md5` re-reads the whole source on the unchanged path (fix first — data-safety class)

`services/cloud/gdrive.ts` `uploadGDriveFile`: when the remote file matches by size, `getMd5()`
hashes the **entire local file** to confirm the match. On a Dropbox online-only source this forces
a full download — the same bug class as the publish byte-compare fixed on 2026-08-07 (see
`claude/audits/2026-08-05-…` project docs and `pipeline/fs.ts` `isUnchanged`'s comment).

- Extend `CloudCacheEntry` (`pipeline/cloudExport.ts`) with `md5?: string` recorded alongside
  `mtimeMs`/`size` after each hash or upload.
- In the upload path, when `(size, mtimeMs)` match the cache entry, pass the cached md5 into
  `uploadGDriveFile` instead of re-hashing (thread it through the existing `getMd5` thunk — the
  thunk returns the cached value; the Rust `file_md5` call remains the fallback when no cached md5
  exists).
- Result: any given file content is hashed at most once, ever.

## E2 — per-file Drive LIST → one children sweep per destination folder

`findGDriveFile` costs one `files.list` round trip per cache-missed file (~200–400 ms). The
comment in `cloudExport.ts` ("One ListObjectsV2 sweep of a key prefix at the start of an upload
phase…") describes exactly the right design — apparently intended and never landed for Drive.

- Before the upload loop for a gdrive destination, list children of every resolved destination
  folder ONCE (`listGDriveChildren` already exists in `gdrive.ts` and pages correctly; request
  fields `id,name,mimeType,size,md5Checksum,webViewLink` — extend its fields list, do not fork it).
  The folder set is already known: `ensureGDriveFolderPaths` resolves it.
- Build `Map<folderId, Map<name, GDriveRemoteFile>>`; `uploadGDriveFile` accepts an optional
  pre-listed lookup and skips `findGDriveFile` when provided. A failed sweep degrades to the
  current per-file behaviour (match the R2 manifest's `null` = "no manifest" convention).
- The R2 stage (`fetchTieredManifest` in `pipeline/cdnUpload.ts`) is the reference implementation
  of this pattern, including the safety comment about false-absent erring toward re-upload.

## E3 — OneDrive: no skip-if-unchanged at all

`cloudExport.ts` reads the file and uploads unconditionally on every cache miss. Add remote
metadata check (Graph: GET item by path, compare `size` + `file.hashes.quickXorHash` — compute
QuickXorHash locally in Rust, or fall back to size-only + upload when hash unavailable). Keep it
simple; even size-match + cache-entry-write closes most of the gap. Bytes must stop being read
(`readFile`) when the skip decision is reachable without them.

## E4 (stretch — separate commit, skippable) — move Drive/OneDrive upload bodies to Rust

`readFile()` pulls whole files across the IPC boundary into webview memory, then `fetch` uploads
them (twice-copied; resumable path included). Dropbox already went through Rust
(`upload_to_dropbox`, cloud.rs) for exactly this reason. Mirror it: `upload_to_gdrive` /
`upload_to_onedrive` commands, streaming from disk, `#[tauri::command(async)]` (non-negotiable —
see `DONE_00b`), path-policy-checked like every native command. The JS module keeps auth, folder
resolution, skip logic; only the byte transfer moves. If this lands, E1's md5 fallback also runs
in Rust and never enters the webview.

## DO NOT

- Do not weaken the export boundary: `assetsOnly` filtering and its test
  (`pipelineExportBoundary.test.ts`) stay green.
- Do not change duplicate-folder semantics (canonical-oldest, notices, dedupe tool contracts —
  `gdriveDedupe.test.ts` green).
- Do not change the F-6 collision reporting in package jobs.
- `upload.characterization.test.ts` and `refresh.characterization.test.ts` pin provider call
  shapes — extend fixtures, never delete assertions.

## Acceptance

- All suites green; new tests: md5 memo hit path (no `file_md5` invoke when cached), sweep
  fallback on list failure, OneDrive skip path.
- Manual timed run with a deliberately cleared `cloud-upload-cache.json` against a small test
  destination: cache-miss unchanged files produce no full-file reads (E1) and no per-file LIST (E2).
- `CHANGELOG.md` Unreleased entry; update `docs/pages/**` where cloud-destination behaviour is
  described.

## Effort

E1+E2+E3 ≈ 1 day. E4 ≈ +1 day, separate commit, needs a manual big-file test (>150 MB).
