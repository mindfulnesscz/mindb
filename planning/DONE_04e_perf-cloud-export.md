# 04e — Cloud export: kill the cold-cache penalty (Drive sweep, MD5 memo, OneDrive skip)

> **LANDED 2026-08-07 — all four parts, in two commits.** Green on `lint` (max-warnings 0),
> `typecheck` (packages + desktop), `test:packages`, `test:desktop`, `test:rust`, `lint:rust`,
> `build:desktop`, `build:docs`.
>
> ## E1 — the hash memo, and where it actually lives
>
> The prompt asked for `md5?: string` on `CloudCacheEntry`. **That field would have been dead**, and
> it is not there. `CloudCacheEntry` is keyed by `destId::nestedName`, and the early skip fires on
> exactly the condition the prompt named — `(size, mtimeMs)` match — so there is no path that
> reaches `uploadGDriveFile` with a matching entry to read a cached md5 from.
>
> What the memo needs to be keyed by is the **source path**, because "these bytes hash to this" is a
> property of the file and not of where it was sent. So `cloud-upload-cache.json` grew a second
> section: `{ uploads, hashes }`, `hashes` keyed by source path and fingerprinted on mtime+size,
> holding `md5` and/or `quickXor`. The flat legacy shape is still read (an upgrade that discarded a
> warm cache would re-upload the library to prove nothing changed).
>
> That gives the property the prompt actually wanted — a file's content is hashed **at most once,
> ever** — across destinations, across runs, and across a stopped run. What it deliberately does
> **not** claim to fix: a genuinely cold app data folder still hashes each file once, and a sync
> client that rewrites mtimes still invalidates the fingerprint. There is no way to prove content
> equality without reading the bytes; the point is never reading them twice.
>
> ## E2 — the Drive sweep
>
> `ensureGDriveFolderPaths` now RETURNS `Map<path, folderId>` (it resolved them and threw the ids
> away). `sweepGDriveFolderFiles` lists those folders — four at a time, through the same `asyncPool`
> everything else uses — and returns `Map<folderId, Map<name, file>>`, or `null` if ANY folder
> failed. `uploadGDriveFile` takes it as an optional 11th argument and skips `findGDriveFile` when
> its folder is covered.
>
> **`listGDriveChildren` was extended, not forked**, as instructed: `webViewLink` added to its
> `fields` and to `GDriveChild`. The dedupe tool ignores it.
>
> Two things the prompt did not mention but the change needs:
>
> - **Same-named FILES get the canonical-oldest rule too.** The listing is ordered by `createdTime`
>   and first-wins, so the sweep picks what `pickCanonicalGDriveFolder` would. Without it two runs
>   could update different copies of one name.
> - **A file created during the run is folded back into the listing** (`rememberCreatedFile`).
>   Without this the sweep would be a REGRESSION on one path the per-file lookup handled: two jobs
>   writing the same name into one folder (a flattened export where two galleries each hold an
>   `01.jpg`). The second used to find the first's file and update it; against a snapshot taken
>   before either ran it would create a second copy — the exact shape `DONE_02` spent a release
>   removing for folders.
>
> ## E3 — OneDrive
>
> Graph GET on the item path first, `size` compared before anything is read, and only on a size
> match the local **QuickXorHash** computed and compared with `file.hashes.quickXorHash`.
>
> **Size-only skipping was rejected**, and this is the one place the prompt's wording is ambiguous
> ("fall back to size-only + upload when hash unavailable"). Skipping on size alone is weaker than
> the rule Drive's uploader deliberately refuses — `upload.characterization.test.ts` has pinned
> "updates when Drive has no MD5 instead of trusting size alone" for exactly this reason — and it
> would leave a client on an old file forever whenever an edit preserved the byte count. So: no
> comparable hash ⇒ upload, which is what the code did before this existed. Every other uncertain
> answer (404, 401, 5xx, a folder, a malformed body) resolves the same way.
>
> `desktop/src-tauri/src/quickxor.rs` is a faithful streaming port of Microsoft's reference
> implementation, `#[tauri::command(async)]` and path-policy-checked like every other native command.
> Its base64 is written out rather than pulled in as a dependency (twelve lines, fixed 20-byte
> input). Six unit tests: a hand-computed single-byte vector proving both the byte layout and the
> length fold, and a block-size invariance test that is the only thing standing between the
> `shift_so_far` carry and a hash that is wrong only on files big enough to be worth skipping.
> **Personal OneDrive publishes SHA-1/SHA-256 and no QuickXorHash** — those destinations upload as
> before. Adding SHA-256 would be a small follow-up (`sha2` is already a dependency).
>
> ## Also fixed, unasked: a stopped export threw away its own cache
>
> `saveCloudCache` ran only after the LAST destination, and both stop paths `return`ed before it. So
> stopping a long export — a normal thing to do — discarded every record of what had already been
> sent and every hash already paid for, and the next run started cold against a destination that was
> half up to date. It is flushed on the way out now. Squarely the same problem this prompt is about,
> which is why it is in the same commit.
>
> ## E4 — taken after all, and it was wrong about the premise
>
> Deferred in the first commit, then done in a second (`upload_stream.rs` + `cloud/uploadStream.ts`)
> after the question "why does Dropbox use a different approach?" turned up something the prompt had
> taken on trust.
>
> **`upload_to_dropbox` did not stream from disk.** It did `std::fs::read` — the whole file into a
> `Vec<u8>` — and `dropbox_upload_session` then did `bytes[offset..end].to_vec()`, copying each 48 MB
> chunk again. So the model E4 said to "mirror" was a smaller copy, not no copy, and mirroring it
> would have moved Drive/OneDrive's buffer from the webview into Rust and called it done. The comment
> in `upload.characterization.test.ts` asserting it streamed had been wrong since it was written.
>
> **There was also no reason for the split.** `git log -S "files/upload" -- '*.ts'` finds no JS
> Dropbox upload, ever; `cloud.rs` arrives whole in the subtree import. The CSP looks like a cause
> and is a consequence — it allows `api.dropboxapi.com` but not `content.dropboxapi.com`, while
> explicitly allowing every host Drive and OneDrive upload to. The allowlist was written around a
> split that already existed.
>
> So: ONE `cloud_upload_stream` command, `reqwest::Body::wrap_stream` over a `tokio::fs::File`, used
> by all three. The JS keeps auth, folder resolution, the skip decision and the upload shape.
>
> - **≤ each provider's own threshold stays in memory** (Drive multipart ≤5 MiB, OneDrive PUT
>   ≤4 MiB). Those bodies are bounded by the provider, the multipart one interleaves metadata with
>   the bytes, and both are simpler read whole. That also kept every pinned small-file assertion
>   intact rather than rewriting it.
> - **The destination is BOUND** — HTTPS, host matched exactly or as a dot-suffix against
>   `UPLOAD_HOSTS`, checked before a byte is read. Unbound this is an exfiltration primitive carrying
>   an `Authorization` header the app supplied, which is the rule `supabase_request` already follows
>   (`native-security.mdx`). `googleapis.com.attacker.example` is in the refusal test.
> - **`Content-Length` is set natively from the range actually sent**, never passed in. A streaming
>   body has no length hyper can infer, so without it the request goes out chunked — which Graph's
>   sessions and Drive's resumable PUT reject. This is the part that could not be reasoned about, so
>   there is a test that runs a real socket and asserts the bytes on the wire.
> - **Dropbox's blocking read is gone** — it was `std::fs::read` inside an `async fn`, pinning a
>   runtime thread, which is the shape `CLAUDE.md` warns about.
>
> Two new direct dependencies, both already in `Cargo.lock` transitively: reqwest's `stream` feature
> and `tokio-util` (`io`). The lock gains exactly one crate, `wasm-streams`, which no native target
> compiles.
>
> **Still owed by hand:** a real >150 MB transfer per provider. The socket test proves the framing;
> it cannot prove Graph and Drive accept it.
>
> ## Still owed by hand
>
> The prompt's timed cold-cache run, which no automated test can produce: clear
> `cloud-upload-cache.json`, run against a small real destination, and confirm from the
> `CLOUD EXPORT › <dest>` step timings that unchanged files produce no full-file reads and that the
> `listed N Drive folder(s) once` line replaces N per-file lookups.

---

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
