# Sotto — Audit Verification (2026-08-05, evening)

> **Re-check 2026-08-06:** all four items still open below are now FIXED in the current code, plus
> the bucket-wide CDN GC landed. Updated status:
> - `processRenameTasks` placebo → **resolved** (the no-op `renameTasks.ts` was removed entirely).
> - GDrive duplicate-folder race + weak skip → **fixed** (per-segment in-flight dedup
>   `gdriveFolderInflight`; md5 compared, not just size).
> - cloudUrls bare-`stem` collision → **fixed** (keyed by `assetIdentityKey(stable,child)` on both
>   write `recordCloudUrl` and read `exportPlan`).
> - Unsanitized taxonomy labels → **fixed** (`sanitizeSegment()` in `filenameTranslator.ts`).
> - Bucket-wide CDN GC → **landed** (`cdn-gc` edge fn + `cdnGarbageCollection.ts`, commit 200b1f2).
>
> Net: the audit is effectively fully closed. Remaining, both non-blocking: GDrive **G2** (merge the
> already-existing duplicate folders) is still to build, and thumbnail regeneration still fingerprints
> on mtime+size rather than a content hash (a deliberate, documented tradeoff). The prune-guard fix is
> hand-applied on the tree and still needs its regression test (prompt 01).
>
> The original 2026-08-05 verification follows unchanged, for the record.


Re-read the **current** code (post-fix snapshot, HEAD `54d0320`, all `fix/s*` + `chore/s7` branches
in history) and checked every item in `SOTTO_AUDIT_TODO.md` against the actual implementation.

**Headline: 38 of 42 items are genuinely implemented in code. 4 remain open — all P2 correctness,
none security-critical.** Your checklist mostly shows them unchecked because the boxes weren't
ticked, not because the work is missing. P0, all of P1, the entire Tauri/Rust surface (S5), and all
of S7 are done but were left unchecked.

Legend: ✅ done (verified) · ⚠️ done with a narrow residual · ❌ still open · [x]/[ ] = box state in
your file.

---

## 🔴 P0 — 1/1 done

| ✔ | Box | Item | Verified evidence |
|---|---|---|---|
| ✅ | [ ] | profiles self-elevation | New migration `20260805120000_protect_profile_privileged_fields.sql`: policy recreated with `WITH CHECK` calling `profile_privileged_fields_unchanged()` (security-definer, `search_path=''`) that freezes `role`/`client_id`/`can_create_clients` via `is not distinct from`. Benign self-edits still allowed. **pgTAP test** `supabase/tests/profiles_self_update.test.sql` asserts a member gets `42501` on each escalation attempt and the admin RPCs still work. |

## 🟠 P1 — 9/9 done

| ✔ | Box | Item | Verified evidence |
|---|---|---|---|
| ✅ | [ ] | r2-grant bucket-wide creds | Now prefix-scoped: `_shared/r2-grant-policy.ts grantPrefixes()` → `{client_id}/` (public) / `guest|client|internal/{client_id}/` (gated); request throws if prefixes empty. |
| ✅ | [ ] | self-asserted membership | New migration `20260805130000_ignore_untrusted_signup_client_id.sql`: `handle_new_user` derives tenant only from the server-side `domain_whitelist`; never reads `raw_user_meta_data.client_id`; no longer inserts `client_members`. Test `supabase/tests/signup_membership.test.sql`. |
| ✅ | [ ] | "Dry run" isn't dry | `settings.dryRun` now threaded into **every** side-effecting stage (CDN thumbs/pages/originals + prune deletes, Supabase inserts/PATCH/disconnect, manifest write, Stream, rename tasks, version history, tag sync, cloud uploads, collect/publish). Verified stage-by-stage. |
| ✅ | [ ] | existing-rows read fail → dup inserts | `assetExport.ts:120-127` now aborts before planning/writes on read failure. |
| ✅ | [ ] | CDN cleanup dead code | `exportDisconnect.ts` derives stale keys from identity via `@sotto/domain` (`storageTarget`/`pageTarget`), both public + gated tiers; `download_key` now selected+written; `deleteCdnObjects` actually called in `useRunPipeline.ts:232`. |
| ✅ | [ ] | tag sync deletes portal tags | Pass-3 delete now behind `assessFreshDestruction` (requires `sourceFresh` + blast-radius ratio) and doubly locked at the caller (`sourceFresh` false while dirty). |
| ✅ | [ ] | transient read → deletes live files | New `listDirResult` distinguishes empty vs error; reconcile marks unreadable subtrees protected and skips them; symmetric guard on source side; `guardrail.ts` messaging. |
| ✅ | [ ] | unverified native binaries | All PDFium (6/6) + LibreOffice (4/4) entries carry real sha256; `validatePins()` hard-fails unpinned; download hashed + `assertDigest`; cache validated by digest + tree hash. |
| ✅ | [ ] | vacuous CI gates | New `e2e` job runs full `supabase start` (Kong/Auth/edge) with portal `VITE_SUPABASE_*`; `smoke:functions` + `test:e2e` now hard-fail on a missing stack (no more green skip). |

## 🟡 P2 — 11/15 done, 4 open

| ✔ | Box | Item | Verified evidence |
|---|---|---|---|
| ✅ | [ ] | identity resolution order | Both CDN + planner call one shared `resolveIdentityFiles` with deterministic sort; manifest write no longer swallows errors. |
| ✅ | [ ] | mtime skip loses data | `isUnchanged` now byte-compares via Rust `files_equal` after the size/mtime gate. |
| ⚠️ | [ ] | raster thumbnails regenerate | Existence-only cache gone; Rust `thumbnail_current` fingerprints `src_mtime+size+width+quality`. **Residual:** a content edit preserving *both* size and mtime still wouldn't regenerate (fingerprint is not a content hash). Original bug fixed; narrow edge remains. |
| ❌ | [ ] | `processRenameTasks` placebo | **Still a no-op** (`renameTasks.ts:60-64`): flips running→completed, applies no rename. Now honors dry-run/stop, but performs no work. Note: the *risky* half (tag deletion) is separately guarded, so this is a "does nothing" bug, not a destructive one. |
| ✅ | [ ] | Stop button doesn't stop | `isStopping` wired into run context; every stage + post-run step checks it at checkpoints. |
| ✅ | [x] | admin UI fails open | `RoleContext` defaults to `public`; `AdminLandingPage` renders a locked state when unconfigured. |
| ❌ | [ ] | GDrive dup-folder race + weak skip | **Still open.** `getOrCreateGDriveFolder` still list-then-create with no in-flight dedup (concurrent uploads → duplicate folders); skip still size-only (`md5Checksum` fetched but unused). |
| ❌ | [ ] | cloudUrls bare-`stem` collision | **Still open.** A composite `mapKey` was added but the bare `stem` is still written and is what every consumer reads (`exportPlan.ts`, `damService.ts`), so two same-stem assets still collide. The composite key is dead. |
| ❌ | [ ] | unsanitized taxonomy labels → paths | **Still open.** `translateExportName` only trims whitespace; output goes straight into `join(...)` in `packages.ts`/`publishLocal.ts`. A label with `/` or `..` becomes path structure / can escape the package dir. Lowest-risk of the four but the closest to a safety issue. |
| ✅ | [ ] | unstable pagination | `fetchAllForClient` now appends `&order=id.asc`. |
| ✅ | [ ] | CORS `*.vercel.app` | Now exact allow-list membership (`cors-policy.ts`), no suffix match. |
| ✅ | [x] | docs/permissions drift | `permissions.mdx` now matches `permissions.ts` (control = editor+; members can't comment/approve). |
| ✅ | [ ] | README stale | Rewritten to describe the real test suite + hard-fail smoke; "2.3.0/5 errors" baseline gone. |
| ✅ | [ ] | `npm run dev` on Windows | `dev.mjs:57` now `shell: process.platform === 'win32'`. |
| ✅ | [ ] | smoke-functions 404 = booted | 404 removed from the BOOTED set. |

## ⚪ P3 — 17/17 done

All done. Highlights that were **left unchecked** in your file but are implemented:

- ✅ `csp: null` → full CSP in `tauri.conf.json` (script-src 'self', object-src 'none', connect-src allow-list).
- ✅ `supabase_request` → restricted to the configured Supabase origin (`validated_request_url`, redirects off, unit-tested).
- ✅ arbitrary-path commands + `remove_dir_all` → new `path_policy.rs` confines every path; `render.rs` `remove_dir_all` forced to the exact `<stem>-thumb` sidecar.
- ✅ `fs` capability `**` → global glob removed; appdata + user-approved folders only.
- ✅ reveal bridge → origin allow-list (no `ACAO:*`), streamed read with size caps, exact `.dchub.json` id match.
- ✅ workflow `permissions:` blocks → 6/6 least-privilege.
- ✅ reconcile `dry_run` default → `true` (latent caveat: the commented-out `schedule:` branch would pass `--execute` if re-enabled — worth a note when you turn scheduling on).
- ✅ readme lookup `:c1` hardcode → resolves via the plan's chosen primary.

Already checked in your file and confirmed: keychain token storage, `destinationsVisibleToRole`
super_admin, download-link `canDownload`, super_admin magic-link, `version_history` `file://`, MIME
gaps, dead-code/toggle removal, onedrive poll, Node 24 alignment.

---

## The 4 things genuinely still open (all P2)

1. **`processRenameTasks` is still a no-op.** Portal tag renames report "completed" but nothing is
   applied. Low urgency (non-destructive), but the queue is a placebo until it either does the work
   or is honestly relabelled "applied on next scan."
2. **Google Drive duplicate-folder race + size-only skip.** Concurrent uploads can still create
   duplicate same-named Drive folders; a changed file of identical size is skipped. Fix = in-flight
   folder-create dedup + use the already-fetched `md5Checksum` in the skip test.
3. **cloudUrls bare-`stem` collision.** The composite key added doesn't help because consumers read
   the bare stem; two assets sharing a stem still overwrite each other's `download_urls`. Fix =
   read/write the composite key everywhere, or drop the dead composite.
4. **Unsanitized taxonomy labels become path segments.** A portal-editable label with `/` or `..`
   flows into `join(...)` unescaped. Lowest-risk but the closest to a safety issue — worth a small
   `sanitizeSegment()` before any label becomes a path component.

## Two narrow residuals worth a note (not "open," just imperfect)

- **Thumbnail regen** keys on mtime+size, not a content hash — a same-size, same-mtime content swap
  won't regenerate. Fine in practice; flag if you ever script content edits that preserve timestamps.
- **Reconcile schedule** default is safe now, but re-enabling the dormant `schedule:` trigger would
  pass `--execute`. Fix the input-default handling before you switch scheduling on.

---

## Recommendation on the checkboxes

Your `SOTTO_AUDIT_TODO.md` under-reports reality by ~27 items. I can rewrite its boxes to match this
verification (everything above ticked except the 4 open items, each annotated) so the checklist is
trustworthy again — say the word and I'll update the file in place.
