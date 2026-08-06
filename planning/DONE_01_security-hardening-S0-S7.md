# Sotto — Security & Hardening: Delegatable Agent Prompts (2026-08-05)

Prompts derived from `SOTTO_AUDIT_TODO.md` (same folder — agents should open it for the full
failure scenario behind each item; these prompts cite the item by section + file:line). Grouped by
**subsystem** so each agent owns a file area and two agents don't edit the same file.

## Order & parallelization

```
  S0 (P0 profiles RLS)  ──►  SHIP FIRST, alone, verify, merge
        │
        └─ then run the rest in parallel, by area:
             S1 edge/DB boundary   S2 pipeline safety   S3 supabase export
             S4 supply-chain/CI    S5 Tauri/Rust        S6 web portal
             S7 hygiene (anytime)
```

- **S0 is the gate.** It's small and critical — do it, verify with an RLS test, merge before the rest.
- S2 and S3 both live under `desktop/src/services/*` (pipeline vs supabase) — mostly different files,
  but coordinate if both are in flight to avoid conflicts.
- Everything else is independent by subsystem.

---

## ▓▓ SHARED CONTEXT (prepend to every prompt) ▓▓

> You are working in **Sotto**, a monorepo at `/Users/petrmucha/Sites/localhost/dc-hub` (v3.2.0):
> Tauri 2 + React desktop (`desktop/`), React/Vite Supabase portal (`web/`), shared TS packages
> (`packages/`), Supabase (`supabase/`: migrations + edge functions), Cloudflare workers (`workers/`).
>
> **The documented model (authoritative — do not break it):** asset identity is `(stable_id,
> child_id)` from the ` __<hash>` package folder + `.dchub.json`; never key on filename. Access =
> `perm` (public/guest/client/internal) AND `status`; `effective_level = status∈(approved,published)
> ? perm : internal`; the level is encoded in the object key; `cdn-gate` authorizes each fetch from a
> signed cookie + object key with no DB lookup. RLS on `public.assets` is the security boundary —
> `permissions.ts` is convenience, not enforcement.
>
> **⛔ Never run a destructive DB command.** No `db:reset`/`supabase db reset`, no `truncate`/unfiltered
> `delete`/`drop`. To apply a new migration use `supabase migration up` (pending only), never a reset.
> Local holds hand-built state that the seed does not recreate.
>
> **Update the docs before finishing.** `docs/pages/**` is maintained and authoritative
> (`pipeline.mdx`, `cloud-storage/*.mdx`, `desktop/*.mdx`, `web-portal/*.mdx`, `data-model/*.mdx`). If
> your change alters documented behavior — the access/identity model, pipeline steps, commands, or
> security posture — update the relevant `.mdx` in the SAME change. If it changes commands or the
> contributor workflow, update `README.md`/`CONTRIBUTING.md`/`VERSIONING.md`. A change that leaves the
> docs contradicting the code is not done.
>
> **Before you finish, the code must pass** (from repo root): `npm run lint` (max-warnings 0),
> `npm run typecheck`, and the relevant tests — `npm run test:packages`, `npm run test:desktop`,
> `npm run typecheck:worker`, `npm run check:rust`/`lint:rust`, and `supabase test db` (`test:rls`) for
> DB changes. Add a regression test for the specific bug you fix — a security fix without a test that
> fails before and passes after is not done. Work on a feature branch. The release path is local →
> staging → production; never suggest deploying to a shared environment "to see if it works."

---

## ▶ S0 — P0: close the self-elevation RLS hole (do first, alone)

**Item:** `SOTTO_AUDIT_TODO.md` → P0. `supabase/migrations/20260711000000_baseline.sql:355-356`
(policy `profiles: own update`) + the table-wide `grant all ... to authenticated` at `:31`.

**Defect:** `for update using (auth.uid() = id)` has **no `WITH CHECK`** and no column restriction, so
any signed-in user can `update({role:'super_admin'})` / set `can_create_clients` / reassign
`client_id` on their own row — bypassing the admin-only RPCs and reaching other tenants' data.

**Build:** a new migration (next timestamp) that stops privileged-column self-edits — either a
replacement policy with a `WITH CHECK` that freezes `role`, `client_id`, `can_create_clients` to the
caller's current values (subselect on their own row), or a `BEFORE UPDATE` trigger rejecting changes
to those columns for non-service callers. Keep legitimate self-edits (name, initials, company, etc.)
working. Confirm the admin RPCs (`update_user_role`, `update_user_access`) still work (they should run
security-definer / service-role).

**DoD:** a `supabase/tests/*.sql` (pgTAP) case that asserts a `member` self-elevating to `super_admin`
FAILS and a benign self-edit SUCCEEDS; `supabase test db` green; apply with `supabase migration up`
(never reset). Update `docs/pages/web-portal/permissions.mdx` / `roles.mdx` if they imply this was
already blocked.

---

## ▶ S1 — Multi-tenant boundary: edge functions + sign-up (Supabase)

**Items:** P1 "r2-grant bucket-wide creds" (`supabase/functions/r2-grant/index.ts:92-124`), P1
"self-asserted client membership" (`supabase/migrations/20260715100000_member_role_and_user_access
.sql:38-50`, `handle_new_user`), P2 "CORS trusts any `*.vercel.app`" (`supabase/functions/_shared/
cors.ts:64`).

**Build:**
1. **Scope the R2 grant.** Request Cloudflare temp credentials narrowed to the caller's key prefix
   (`{client_id}/`) instead of `object-read-write` over the whole bucket, so an editor of client A
   cannot touch client B's objects. Verify against the Cloudflare temp-credentials API's
   prefix/object scoping.
2. **Stop self-asserted membership.** `handle_new_user` must not trust a client-supplied
   `raw_user_meta_data->>'client_id'` to grant tenant membership. Gate on a verifiable signal (email
   domain allow-list, an admin-issued invite, or a pending-membership row an admin approves). A new
   user with an unverified `client_id` should land with no tenant access, not `member` of that tenant.
3. **Tighten CORS** to an exact allow-list of known origins rather than any `.vercel.app` suffix.

**DoD:** an edge-function/integration test or pgTAP case proving (1) a cross-client key is refused by
the scoped grant and (2) a self-asserted `client_id` at sign-up does not yield membership. Migration
via `supabase migration up`. Update `docs/pages/cloud-storage/*.mdx` / `auth.mdx` where the grant
scope or sign-up flow is described.

---

## ▶ S2 — Pipeline destructive-safety (desktop)

**Items:** P1 "Dry run isn't dry" (`desktop/src/services/pipelineService.ts:77-89`,
`features/pipeline/useRunPipeline.ts:134-157`), P1 "transient read → renames/deletes live target
files" (`services/pipeline/publishLocal.ts:85-116` + `pipeline/fs.ts:17-23`), P1 "tag sync deletes
portal tags" (`services/supabase/tagSync.ts:200-232`), P2 "Stop button doesn't stop"
(`store/pipelineStore.ts:103`).

**Read first:** `desktop/src/services/guardrail.ts` (the existing blast-radius tripwire — extend its
pattern rather than inventing a new one) and the characterization tests around these paths.

**Build:**
1. **Make "Dry run" actually dry.** Thread the flag into every side-effecting stage — CDN upload +
   page-object deletes, cloud uploads, the full Supabase export (inserts/PATCHes/`disconnectStaleRows`),
   tag-sync deletes, Stream uploads. In dry mode they log intended actions and mutate nothing.
2. **Guard the publish reconcile.** `flagDisconnected` must not rename/delete based on a `livePub`
   built from a walk that silently returns `[]` on IO error (`fs.ts:17-23`). Distinguish "empty
   folder" from "couldn't read" and abort/skip reconciliation of a subtree whose walk errored; route
   through `guardrail.ts`.
3. **Guard tag deletion.** Tag-sync pass-3 deletion must not fire from a stale/dirty local vocab
   (delete tags the portal added). Only delete when the local vocab was freshly synced, and put tag
   deletes behind the same blast-radius check as row disconnects.
4. **Make Stop stop.** Have stages check the `stopping` state at safe checkpoints and halt cleanly.

**DoD:** characterization/unit tests: dry-run performs zero mutations across all stages; a subtree
read-error does not disconnect its files; stale-vocab tag delete is refused; a stopped run ceases at
the next checkpoint. Update `docs/pages/pipeline.mdx` and `docs/pages/operations/safe-reruns.mdx` to
match. `npm run test:desktop` green.

---

## ▶ S3 — Supabase export correctness & data integrity (desktop)

**Items:** P1 "read failure → duplicate/every-asset-new inserts" (`services/supabase/assetExport.ts:
92-101`), P1 "CDN cleanup dead code / gated objects never removed" (`supabase/exportDisconnect.ts:52`
reads `download_key`, never selected/written), P2 "identity resolution order differs"
(`supabase/identity.ts:42-72` vs `exportPlan.ts:134-140`), P2 "unstable pagination" (`supabase/
rest.ts:81-102`), P2 "readme lookup hardcodes :c1" (`assetExport.ts:189`), P2 "mtime skip loses data"
(`pipeline/fs.ts:63-69`), P2 "thumbnails never regenerate on content change" (`pipeline/
thumbnails.ts:77-83`).

**Build:**
1. **Abort the write stage when the existing-rows read fails.** Today `readFailed` only skips the
   disconnect stage while planning/writing proceed against an empty `existing` map → mass inserts +
   duplicates. On read failure, do not write.
2. **Wire CDN cleanup on disconnect.** Either select+populate `download_key` (and write it on export)
   or derive stale object keys from `(stable_id, child_id)` + `@sotto/domain/assetStorage`, so
   `deleteCdnObjects` actually runs for disconnected assets across BOTH the public and gated tiers.
   Reconcile with what `runCdnUpload` writes.
3. **Make identity resolution deterministic and agreed.** CDN keying (`identity.ts`, scan order) and
   export planning (`exportPlan.ts`, alphabetical) must resolve child_ids the same way; stop relying
   on a best-effort manifest write that swallows failures (`identity.ts:71`).
4. **Add `order=` to `fetchAllForClient` pagination** so limit/offset paging is stable under
   concurrent writes.
5. **Fix the readme `:c1` hardcode** so packages whose primary isn't `c1` still attach their readme.
6. **mtime skip + thumbnail cache** should detect content change (hash or size+mtime both), not
   `dest.mtime >= src.mtime` alone / existence-only — a restored-from-backup file or a same-name
   content swap must re-publish and re-thumbnail.

**DoD:** unit tests for each (read-fail → no writes; disconnect → correct keys deleted incl. gated;
same child_id resolution from both planners on the same input; stable pagination; non-c1 readme
attach; content-changed-older-mtime re-publishes). Update `docs/pages/pipeline.mdx` (the "cleans up R2
objects" claim and CDN key description) and `docs/pages/desktop/identity.mdx` if wording drifts.
`npm run test:desktop` green.

---

## ▶ S4 — Supply chain, CI gates & contributor docs (scripts / workflows)

**Items:** P1 "unverified native binaries" (`scripts/fetch-native-deps.mjs:52-128,242,264-267`), P1
"vacuous CI gates" (`.github/workflows/check.yml:64-76`, `scripts/smoke-functions.mjs`, `e2e/`), P2
"npm run dev broken on Windows" (`scripts/dev.mjs:53`), P2 "smoke-functions treats 404 as booted"
(`smoke-functions.mjs:50`), P2 "README stale" + P2 "VERSIONING drift", P3 "workflows lack permissions"
(5 of 6), P3 "reconcile defaults dry_run:false" (`reconcile-cdn-keys.yml:38-42`).

**Build:**
1. **Pin + verify every native binary.** Add real `sha256` for all PDFium + LibreOffice entries;
   make an unpinned download a hard failure (not a warning); validate the cache by digest, not URL.
   Bring the code in line with its own header comment and `check.yml`'s claim of digest pinning.
2. **Make the CI "edge boot" and "portal smoke" steps real or honestly skip.** Either start the full
   Supabase stack (Kong/Auth/edge runtime — `supabase start`, not just `db start`) and provide the
   portal its `VITE_SUPABASE_*` env so `smoke-functions.mjs` and Playwright actually run, or make a
   non-running stack a hard failure rather than a green "skipped." A 404 from a not-loaded function
   must NOT count as "booted."
3. **Fix `dev.mjs` on Windows** (`shell: process.platform === 'win32'`, as `vercel-build.mjs` already
   does).
4. **Add least-privilege `permissions:` blocks** to the five workflows missing them.
5. **Default the reconcile workflow to `dry_run:true`.**
6. **Refresh `README.md` + `VERSIONING.md`** to the real state: there IS a test suite (vitest +
   Playwright + pgTAP + Rust) gated by `npm run check`; drop the "2.3.0 / five known errors" baseline;
   correct the PR checklist, app count ("four"), lockfile count, and the files `version.mjs` actually
   touches (incl. `workers/cdn-gate/package.json`).

**DoD:** a swapped/absent binary fails the fetch; a CI run with no stack fails (not greens) the
function/portal steps; `dev.mjs` spawns on win32; workflows show least privilege. Docs match reality.
Relevant script/worker checks green.

---

## ▶ S5 — Tauri / Rust desktop hardening

**Items (P3, plus high-impact command-surface):** open HTTP proxy (`desktop/src-tauri/src/supabase.rs:
14-45`), `csp: null` (`tauri.conf.json:23-25`), arbitrary-path commands (`lib.rs:29-131`, `r2.rs:240`,
`cloud.rs:117`; `render.rs:378-381` `remove_dir_all` on a caller path), over-broad `fs` capability
(`capabilities/default.json:12-51`, `**`), reveal bridge (`reveal.rs:60-73` `ACAO:*` no auth; `:56-59`
single-read; `:191-201` substring manifest match).

**Read first:** `CLAUDE.md` (native-engine + path rules) and confirm the "never shell out by bare
name" / one-shot-PDFium-worker invariants aren't disturbed.

**Build:**
1. **Constrain `supabase_request`** to the configured Supabase origin (no arbitrary URL/host) — kill
   the SSRF + header-exfiltration surface.
2. **Set a real CSP** in `tauri.conf.json` (script-src/connect-src to what the app needs) instead of
   `null`.
3. **Confine path-taking commands** (`generate_thumbnail`, `generate_document_previews`,
   `upload_to_r2`, `upload_to_dropbox`) to app/working directories; make `remove_dir_all` refuse a
   path outside the app's previews area.
4. **Narrow the `fs` capability** from `**` to the directories the app actually uses.
5. **Harden the reveal bridge:** drop `Access-Control-Allow-Origin:*` (or add an auth token), read the
   request in a loop (not one 8 KB read), and anchor the `.dchub.json` match instead of an unanchored
   `contains(stable_id)`.

**DoD:** Rust unit tests where practical; manual verification that thumbnails/uploads/previews/reveal
still work within the confined paths and that an out-of-scope path is refused. `npm run check:rust` +
`lint:rust` green. Update `docs/pages/desktop/*.mdx` and `CLAUDE.md` if any documented behavior
(paths, bridge, CSP) changes.

---

## ▶ S6 — Web portal permission fixes

**Items:** P2 "admin UI fails open when env absent" (`web/.../admin/AdminLandingPage.tsx:183`,
`RoleContext.tsx:32`), P2 "permissions.mdx contradicts code" (`docs/pages/web-portal/
permissions.mdx:8,11`), P3 "download link ignores canDownload" (`AssetImage.tsx:71-79`,
`AssetPreviewPanel.tsx:186`), P3 "destination super_admin fails open" (`destinationService.ts:102`),
P3 "super_admin can't use admin magic-link" (`check_email_auth`, `baseline.sql:263-264`).

**Build:**
1. **Fail closed when Supabase env is absent** — do not render the full admin dashboard with
   `isAdmin=true`; require config / an authenticated staff session first. Fix `RoleContext`'s
   permissive default.
2. **Gate the fallback + sibling download links** on the same `canDownload(role, asset)` the primary
   button uses (use the sibling's own asset in the sibling map, not the parent).
3. **Add `'super_admin'` to `destinationsVisibleToRole`'s rank allow-list** so a super_admin-gated
   destination isn't downgraded to member-visible.
4. **Include `super_admin` in `check_email_auth`'s staff branch** (migration via `migration up`) so
   the admin magic-link path works for them.
5. **Correct `docs/pages/web-portal/permissions.mdx`** to match `packages/asset-library/src/
   permissions.ts` (permission control is editor+, not admin-only; members can't comment/approve).

**DoD:** tests for the download-gating and destination-visibility fixes; manual check that a
no-env deploy shows a locked state; permissions doc matches code. `npm run test:packages`/
`test:desktop` (web) + `typecheck` green.

---

## ▶ S7 — Hygiene & cleanup (low priority, batch anytime)

**Items (P3):** plaintext OAuth tokens on disk → OS keychain (`clientService.ts:79-87`, `lib.rs:197`);
remove stale root `CLAUDE_CODE_PROMPT_*.md` / `CLAUDE_CODE_LOG_*.md`; delete dead settings toggles
(`keepHighestVersion`/`preserveStructure`/`onedriveFlatFolder`) or wire them; add mime types
(`.xlsm/.docm/.tif/.tiff`, `cdnUpload.ts:589-610`); stop writing machine-local `file://` paths to
`version_history` (`versionHistory.ts:101`); fix `onedrive_poll_token` infinite poll (`cloud.rs:389-407`);
`reconcileCdn` dead/drifted (`cdnCleanup.ts:18-58`) — remove or wire to both tiers; align Node version
(README 22 vs workflows 24).

**Build:** work through as a cleanup pass; each is small and independent. Prefer deleting dead code
over documenting it. For the token-storage item, move OAuth tokens/secrets to the OS keychain rather
than plaintext `client-local.json` / the plaintext store.

**DoD:** repo is tidier, no dead toggles in the UI, secrets off plaintext disk; lint/typecheck/tests
green; note removed files in the PR. Update any doc referencing removed behavior.

---

### After both tracks
Security (this doc) ships first; then the asset-management track
(`SOTTO_ASSET_MGMT_AGENT_PROMPTS.md`). The two don't overlap in files, so once S0 is merged the
security agents and the Wave-1 asset agents (A + B) can run concurrently.
