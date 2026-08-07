# Sotto — Google Drive Duplicate-Folder Fix (prompts, 2026-08-05)

> **CLOSED 2026-08-07** on `fix/gdrive-duplicate-folders`. Both halves are in and green.
>
> **G1** — the in-flight per-segment memo and the md5 skip were already in; this run added the
> deterministic **oldest-wins** pick (`pickCanonicalGDriveFolder`, `orderBy=createdTime`), the
> duplicate-set warning drained into the run log, and a pre-resolve of the destination tree before
> the 8-wide batch (`ensureGDriveFolderPaths`). Regression tests: 8 concurrent uploads issue one
> create per segment; two same-named folders resolve to the oldest; a transient failure does not
> poison the folder cache.
>
> **G2** — `desktop/src/services/cloud/gdriveDedupe.ts` (walk → pure planner → `planId`-guarded
> execute) plus the Drive REST helpers in `gdrive.ts`, and **Settings → Cloud destinations → a Drive
> destination → Maintenance** in `features/cloud/panels/GDriveDedupeCard.tsx`. Removals are
> **trashed**, never deleted; a duplicate folder is trashed only after a fresh listing shows it
> empty. Docs: `docs/pages/operations/gdrive-dedupe.mdx`.
>
> Not yet done: a run against a real client Drive. The tests cover a mocked tree only.

Two matched prompts for the Drive duplicate-folder mess (audit item "Google Drive duplicate-folder
race + weak skip", P2 — verification confirmed **still open**). Both use the **same SHARED CONTEXT
block** as `SOTTO_SECURITY_AGENT_PROMPTS.md` — prepend it (identity non-negotiable, never
`db:reset`, update `docs/pages/**`, ship green with a regression test).

**Do G1 first.** G2 merges the existing duplicates; if prevention isn't in yet, the next cloud
export re-creates them right after you've cleaned up.

## The bug (shared background)

Drive has no paths — folders are nodes addressed by id, so `getOrCreateGDriveFolder`
(`desktop/src/services/cloud/gdrive.ts`) walks the destination path and, per segment, **lists** for
a folder of that name and **creates** it if absent. The folder-id cache (`gdriveFolderCache`) is
written only **after** the full walk completes. `cloudExport.ts` uploads with `CONCURRENCY = 8`
(`Promise.all` batches, ~line 223), so the first batch of files into a not-yet-existing folder all
list-empty and all create it — and Drive allows duplicate identical folder names in one parent. You
get up to 8 copies per folder level, files scattered among them. Google Drive for Desktop mirrors
those same-named cloud folders to local disk with " (1)", " (2)"… suffixes — the mess in the
screenshot. **Scope: Google Drive only** — Dropbox and OneDrive upload by path (idempotent parent
creation, no race); the local export destination uses fixed paths.

Secondary defect in the same code: the skip check is size-only (`existing.size === sizeStr` in
`uploadGDriveFile`); `md5Checksum` is fetched in `findGDriveFile` but never compared, so a changed
file of identical byte length is wrongly skipped.

---

# G1 — Prevent new duplicates (the fix)

**Goal:** make Drive folder resolution race-free under concurrency, converge on a canonical folder
when duplicates already exist, and fix the size-only skip. No behavior change for Dropbox/OneDrive.

**Read first:** `desktop/src/services/cloud/gdrive.ts` (`gdriveFolderCache`,
`getOrCreateGDriveFolder`, `findGDriveFile`, `uploadGDriveFile`, `GDRIVE_SIMPLE_MAX`);
`desktop/src/services/pipeline/cloudExport.ts` (the `CONCURRENCY = 8` batch loop ~220–300 and the
gdrive branch); `desktop/src/services/cloud/upload.characterization.test.ts`.

**Build:**

1. **Dedup folder creation at the per-segment level.** The race is per `(parentId, name)`, not per
   full path (two packages under `01 Disrupt Collective` both create that top segment). Change the
   cache to memoize the **in-flight promise** for resolving each segment — key it
   `${sharedDriveId||'root'}::${parentId}/${name}` → `Promise<string>` — so concurrent callers
   wanting the same child folder await one find-or-create instead of each doing their own. Set the
   promise in the map **before** awaiting, so the second caller finds it. (Equivalently/additionally:
   in `cloudExport.ts`, pre-resolve the distinct set of destination folder paths **once, before** the
   concurrent file loop, so the cache is warm when the 8-wide batch starts — do this on top of the
   per-segment memo, not instead of it, so any concurrency stays safe.)

2. **Converge on a canonical folder when duplicates already exist.** Add `orderBy: 'createdTime'` to
   the folder list query and pick the **oldest** match deterministically, so every run resolves to
   the same folder instead of `files[0]` at Drive's whim (which keeps scattering into random
   duplicates). Log when more than one same-named folder is seen, so the mess is visible until G2
   cleans it.

3. **Fix the weak skip.** In `uploadGDriveFile`, when a same-name remote exists, compare
   `md5Checksum` (already fetched) — not size alone — before skipping. Size can stay as a fast
   pre-filter; when size matches, confirm md5 before treating it as unchanged (compute the local
   hash; accept the read for the same-size case — correctness over the lazy-skip optimization). If
   md5 differs, take the existing "update in place" path (no second same-name file).

**Constraints:** Drive-only — do not touch the Dropbox/OneDrive branches. Preserve Shared Drive
support (`supportsAllDrives`, `corpora=drive`, `driveId`). Keep the resumable/multipart create paths
intact. The promise-memo must not cache a **rejected** creation (evict on error so a transient
failure doesn't poison the folder id for the rest of the run).

**Definition of done:** a test that N concurrent `uploadGDriveFile` calls targeting the same new
folder path resolve to **one** folder id and issue **one** create (mock the Drive REST calls, assert
create-count == 1); a test that with two same-named folders present the resolver deterministically
picks the oldest; a test that a same-size, different-md5 file updates rather than skips. Update
`docs/pages/pipeline.mdx` (cloud export — Drive folder resolution is now race-safe and
content-checked). `npm run lint`, `npm run typecheck`, `npm run test:desktop` green.

---

# G2 — Merge existing duplicate folders (cleanup tool)

**Goal:** a manual, per-destination maintenance action that finds same-named sibling folders in a
Drive destination, merges each set into one canonical folder, and deletes the emptied duplicates —
with a **dry-run preview** before anything moves. The Drive analogue of the CDN GC.

**Where it lives:** a desktop maintenance action for a cloud destination, reusing the app's existing
Drive token + refresh + `sharedDriveId`/`remotePath` config (the OAuth token lives in the desktop
keychain, so this belongs in the app, not a standalone node script). Add the Drive REST helpers it
needs beside the others in `desktop/src/services/cloud/gdrive.ts`; wire a "Clean up duplicate
folders" action into the cloud-destination settings UI (`features/settings` / wherever cloud
destinations are managed).

**Read first:** G1's changes to `gdrive.ts`; how destinations expose token/`sharedDriveId`/
`remotePath` (`desktop/src/services/clientService.ts`, `services/cloud/*`).

**Build:**

1. **Walk** the destination subtree from `remotePath` (resolved to a folder id), recursively listing
   child folders (`supportsAllDrives`).
2. **Group** sibling folders by name at each level; a group with >1 member is a duplicate set.
3. **Choose canonical** = oldest by `createdTime` (matches G1's pick, so future runs align).
4. **Merge**: move every child (files *and* subfolders) from the non-canonical duplicates into the
   canonical folder via `files.update` with `addParents`/`removeParents` (`supportsAllDrives=true`).
   On a **file name collision** inside the canonical folder, dedupe by md5/size — keep one, and if
   they differ keep both but log it (never silently drop a differing file). Recurse so nested
   duplicate subfolders merge too (merge depth-first so children are canonical before their parent
   is deleted).
5. **Delete** each duplicate folder only after confirming it has no remaining children.

**Preview / safety:**
- **Dry-run by default.** Produce a report: each duplicate set (name, count, ids, createdTime),
  which is canonical, how many files/subfolders would move, collision count, folders that would be
  deleted — plus totals. Require explicit confirmation (and an `execute` flag) before any move/delete.
- Operate **only within** the destination's `remotePath` subtree; never touch anything outside it.
- **Abort if the walk looks wrong** (e.g. the `remotePath` root doesn't resolve, or listing fails) —
  never proceed to delete on partial data.
- Write an audit log of every move/delete. Be resumable and rate-limit-aware (Drive quotas).
- Preserve Shared Drive vs My Drive semantics throughout.

**Definition of done:** on a mocked Drive tree with a duplicated folder at two levels and a file-name
collision, the dry-run report lists the merges correctly and executing leaves exactly one folder per
name with all files consolidated (differing-content collisions preserved + logged); an aborted/partial
listing performs no deletes. New `docs/pages/operations/gdrive-dedupe.mdx` documenting how to run it,
read the report, and the safety rails; reference it from the cloud-export docs. `npm run lint`,
`npm run typecheck`, `npm run test:desktop` green.
