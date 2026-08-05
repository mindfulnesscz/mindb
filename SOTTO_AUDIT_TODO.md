# Sotto — Audit TODO (2026-08-05)

Structured findings from a full read of `/Users/petrmucha/Sites/localhost/dc-hub` at v3.2.0. Grouped by severity. Each item has file:line, the defect, and how it fails. This complements the 2026-07-24 `REFACTOR_PLAN.md` — items that plan already fixed are noted at the bottom.

> Verification note: every finding below was read in the source. The single **critical** item (P0) I re-read line-by-line myself (policy SQL \+ table grants) because it decides whether the product is safe to put in front of a second agency at all.

---

## 🔴 P0 — Critical (fix before any external tenant touches this)

- [ ] **Any signed-in user can make themselves `super_admin`.** `supabase/migrations/20260711000000_baseline.sql:355-356`. The policy `profiles: own update` is `for update using (auth.uid() = id)` with **no `WITH CHECK`**, and the baseline grants `all` on every table in `public` to `authenticated` (`baseline.sql:31`). With no check expression and column-wide UPDATE, an authenticated user can run `supabase.from('profiles').update({ role:'super_admin' }).eq('id', myUid)` from the browser console and it succeeds. Same primitive sets `can_create_clients=true` or reassigns `client_id` to another tenant's UUID (UUIDs are discoverable via the `anon`\-executable `get_client_portal(slug)`), yielding cross-tenant read of that tenant's assets/comments/ratings and, through `cdn-gate`, its gated bytes. The admin-only RPCs (`update_user_role`, `update_user_access`) are bypassed entirely. `permissions.ts` is explicitly documented as *not* the security boundary — RLS is — so this policy **is** the boundary, and it is open. **Fix:** add `with check` freezing `role`/`client_id`/`can_create_clients` to their current values (subselect against the caller's own row), or a `BEFORE UPDATE` trigger that rejects changes to privileged columns; add a `test:rls` case that asserts self-elevation fails.

---

## 🟠 P1 — High (data-integrity, cross-tenant, or destructive)

- [ ] **`r2-grant` issues bucket-wide read/write R2 credentials.** `supabase/functions/r2-grant/index.ts:92-124`. The Cloudflare temp-credential request uses `permission:'object-read-write'` scoped to the whole bucket; the returned `keyPrefix` is advisory only. An editor who is a member of client A can drive the S3 API directly to read/overwrite/delete client B's objects in the same bucket. Scope the grant by object-key prefix (`{client_id}/`), which the Cloudflare API supports.  
        
- [ ] **Self-asserted client membership at sign-up.** `supabase/migrations/20260715100000_member_role_and_user_access.sql:38-50`. `handle_new_user` trusts `raw_user_meta_data->>'client_id'` (client-supplied, only UUID-shape-checked) and provisions the user as a `member` of that tenant. Combined with discoverable client UUIDs, an attacker self-provisions into any tenant. Verify membership (domain allow-list or admin grant), don't trust the metadata.  
        
- [ ] **"Dry run (preview only)" is not dry.** `desktop/src/services/pipelineService.ts:77-89` \+ `features/pipeline/useRunPipeline.ts:134-157`. The flag is honored only by local Collect/Publish; CDN uploads, page-object **deletes** (`cdnUpload.ts:395-419`), cloud uploads, the full Supabase export (inserts/PATCHes, `disconnectStaleRows`), tag-sync deletes, and Stream uploads all run for real. Ticking "preview" to inspect a reorganized tree soft-disconnects rows, deletes R2 page objects, and pushes real cloud uploads.  
        
- [ ] **Existing-rows read failure creates duplicate/every-asset-as-new inserts.** `desktop/src/services/supabase/assetExport.ts:92-101`. On a read error, `readFailed` only skips the disconnect stage — planning and writing proceed against an **empty** `existing` map, so every asset is POSTed as new. Transient 500 → hundreds of insert conflicts, and for any asset whose only row is `disconnected` (excluded from the partial unique index) a duplicate row is created, orphaning its ratings/comments. Abort the write stage when the read fails.  
        
- [ ] **CDN cleanup on disconnect is dead code — gated/orphaned objects never removed.** `desktop/src/services/supabase/exportDisconnect.ts:52` reads `r.download_key`, but the fetch (`assetExport.ts:94-97`) never selects it and nothing in the repo ever writes `assets.download_key`. So `staleObjectKeys` is always empty and `deleteCdnObjects` is unreachable. Disconnected assets stay served from the CDN indefinitely — while `docs/pages/pipeline.mdx` claims the opposite.  
        
- [ ] **Tag sync can delete tags the portal team created.** `desktop/src/services/supabase/tagSync.ts:200-232`. Pass 3 DELETEs every shortcoded DB tag absent from local vocabulary; local vocab is only refreshed when not dirty (`useRunPipeline.ts:65-79`). A machine with a stale dirty cache deletes tags added on the portal since, and enqueues `tag_delete` tasks. No `assessDestruction`\-style guardrail covers tag deletion.  
        
- [ ] **A transient read error during publish silently renames/deletes live target files.** `desktop/src/services/pipeline/publishLocal.ts:85-116` \+ `pipeline/fs.ts:17-23`. `flagDisconnected` 🚫-renames (or hard-deletes inside 📦 mirrors, recursively) everything not in `livePub`, but `livePub` comes from a walk where `listDir` returns `[]` on any read error. One transient permission/IO failure on a subtree marks all its files "not live." No blast-radius guard applies to local target reconciliation.  
        
- [ ] **Unverified native binaries shipped to users.** `scripts/fetch-native-deps.mjs:52-128`. All six PDFium entries have no `sha256`; three of four LibreOffice entries are `sha256:null`. Unpinned downloads only warn and proceed (`:264-267`), and the cache is validated by URL match, never digest (`:242`). The file's own header comment and `check.yml` both *claim* digest pinning that doesn't exist. Mutable GitHub release assets → a swapped `pdfium-*.tgz` is embedded in the signed `.dmg` and shipped as executable code.  
        
- [ ] **CI "edge functions boot" and "portal smoke" gates are vacuous.** `.github/workflows/check.yml:64-76`. The job runs `supabase db start` (Postgres only — no Kong/Auth/ edge runtime), so `smoke-functions.mjs` exits 0 as "skipped" and Playwright `test.skip`s the whole suite (`e2e/smoke.spec.ts:24`, unreachable `:54321`). Green "Check" run proves nothing about functions or the portal. `.env.local` is also gitignored, so the CI dev server has no Supabase URL.

---

## 🟡 P2 — Medium (correctness, robustness, drift)

- [ ] **Identity resolution order differs between CDN and export planning.** `desktop/src/services/supabase/identity.ts:42-72` mints child\_ids in scan order (documented non-deterministic) while `exportPlan.ts:134-140` resolves alphabetically; they agree only because the first writer persists `.dchub.json`, and that write is best-effort (`identity.ts:71` swallows failures). Locked/read-only source \+ a package with ≥2 new files → CDN objects and DB rows keyed to different children, reshuffling every run.  
        
- [ ] **mtime skip loses data.** `desktop/src/services/pipeline/fs.ts:63-69`. `isUnchanged` skips when `dest.mtime >= src.mtime` (size-equality fallback). A file restored from backup/git/unzip (older mtime, new content) is treated as unchanged forever across publish, package sync, and cloud export.  
        
- [ ] **Raster thumbnails never regenerate on content change.** `desktop/src/services/pipeline/thumbnails.ts:77-83`. Cache is existence-only; replacing `foo.png` under the same name keeps the old `foo-thumb.webp` locally and on the CDN.  
        
- [ ] **`processRenameTasks` is a placebo.** `desktop/src/services/supabase/renameTasks.ts:53-58`. Marks every pending task `running`→`completed` doing no work; portal tag renames report "completed" with zero filesystem effect.  
        
- [ ] **Stop button doesn't stop.** `desktop/src/store/pipelineStore.ts:103`. `stopRun` only sets status `stopping`; no stage checks it. UI shows "Stopping…" while uploads/purges/DB writes finish.  
        
- [ ] **Admin UI fails open when Supabase env is absent.** `web/apps/client-hub/src/features/admin/AdminLandingPage.tsx:183`. Missing env → full admin dashboard renders with `isAdmin=true` (`RoleContext` defaults role to `editor`). Bounded to mock data \+ a "type your own Supabase creds" form, but the default direction is wrong — fail closed.  
        
- [ ] **Google Drive duplicate-folder race \+ weak skip.** `desktop/src/services/cloud/gdrive.ts:108-148,267`. Concurrent uploads (CONCURRENCY=8) into a new path each miss the cache and CREATE → up to 8 duplicate same-named Drive folders; remote skip is name+byte-size only (no hash/mtime).  
        
- [ ] **cloudUrls keyed by bare `stem` fallback (F-5-class collision).** `desktop/src/services/pipeline/cloudExport.ts:329-335` vs the `destId:stem` contract in `types.ts:53`. Two packages sharing a stem overwrite one entry → one asset's `download_urls` land on another's row.  
        
- [ ] **Unsanitized taxonomy labels become path segments.** `packages/domain/src/filenameTranslator.ts:65-77` → `join(...)` in `packages.ts:211`, `publishLocal.ts:270`. A portal-editable tag label with `/`, `\`, or `..` writes outside the package and desyncs the purge's name matching.  
        
- [ ] **Unstable pagination in the assets sync read.** `desktop/src/services/supabase/rest.ts:81-102`. `fetchAllForClient` pages by limit/offset with no `order=`; PostgREST order is unspecified, so a \>1000-row client under concurrent writes can skip/duplicate rows between pages (feeds the duplicate-insert path above).  
        
- [ ] **CORS trusts any `*.vercel.app` origin.** `supabase/functions/_shared/cors.ts:64`. Impact is limited (bearer-header auth, no `Allow-Credentials`), but tighten to an exact allow-list.  
        
- [ ] **Docs/permissions model drift.** `docs/pages/web-portal/permissions.mdx:8,11` contradicts `packages/asset-library/src/permissions.ts` (permission control is editor+, not admin-only; members can't comment/approve). A reviewer trusting the table will build the wrong gate.  
        
- [ ] **README materially stale.** `README.md:49-51` says "no automated test suite" and cites a "2.3.0 … five known typecheck errors" baseline at v3.2.0 with CI gating `npm run check` — actively misleading a new contributor to skip tests and tolerate red typechecks. VERSIONING.md (`:16-19`) also lists files `version.mjs` doesn't touch and omits `workers/cdn-gate/package.json`.  
        
- [ ] **`npm run dev` broken on Windows.** `scripts/dev.mjs:53` spawns `npm` without `shell:true` (post-CVE-2024-27980 → EINVAL); `vercel-build.mjs:65` already has the fix. Repo targets Windows.  
        
- [ ] **smoke-functions treats 404 as "booted."** `scripts/smoke-functions.mjs:50` — a function added since the container was created answers 404 and is reported "✓ booted," the exact broken-until-production case it exists to catch.

---

## ⚪ P3 — Low (hardening, hygiene, cleanup)

- [ ] Plaintext OAuth tokens \+ GDrive client secret persisted in `client-local.json` (`desktop/src/services/clientService.ts:79-87`; also the Rust store, `lib.rs:197`). Move to OS keychain.  
- [ ] `csp: null` in `desktop/src-tauri/tauri.conf.json:23-25` disables the webview CSP while the command surface includes an open HTTP proxy and arbitrary-path fs — a minor injection becomes full local exfiltration. Set a real CSP.  
- [ ] `supabase_request` is an open HTTP proxy exposed to the webview (`desktop/src-tauri/src/supabase.rs:14-45`) — SSRF (loopback / cloud-metadata) \+ header exfiltration. Restrict to the Supabase origin.  
- [ ] `generate_document_previews` recursively deletes a caller-supplied `pages_dir` (`render.rs:378-381`) and thumbnail/upload commands take arbitrary read/write paths (`lib.rs:29-131`, `r2.rs:240`, `cloud.rs:117`) not covered by the fs capability scope. Confine to app dirs.  
- [ ] `fs` capability scoped to `**` with dotfiles included (`capabilities/default.json:12-51`).  
- [ ] Reveal bridge on `127.0.0.1:7624` returns `Access-Control-Allow-Origin:*` with no auth (`reveal.rs:60-73`) — any website can trigger Finder/Explorer opens as an existence oracle; also a single 8 KB read (`:56-59`) drops multi-segment requests, and a substring manifest fallback (`:191-201`) can match the wrong package.  
- [ ] `destinationsVisibleToRole` fails open for `super_admin`\-gated destinations (`web/.../destinationService.ts:102` — missing from the rank allow-list).  
- [ ] "No preview" fallback and sibling panels render a Download link ignoring `canDownload` (`AssetImage.tsx:71-79`, `AssetPreviewPanel.tsx:186`) — UI-only; delivery still gated server-side.  
- [ ] `super_admin` can't use the admin magic-link path (`check_email_auth` staff branch omits it, `baseline.sql:263-264`).  
- [ ] Workflows lack `permissions:` blocks (5 of 6\) → default write-all `GITHUB_TOKEN`.  
- [ ] Reconcile workflow defaults `dry_run:false` → a manual "just to see" dispatch moves prod objects (`reconcile-cdn-keys.yml:38-42`).  
- [ ] Readme lookup hardcodes `:c1` (`assetExport.ts:189`) → skips readme for packages whose primary isn't c1.  
- [ ] Version-history writes machine-local `file://` paths to the shared DB (`versionHistory.ts:101`).  
- [ ] mime gaps: `.xlsm/.docm/.tif/.tiff` served as `application/octet-stream` (`cdnUpload.ts:589-610`).  
- [ ] Dead/stale: `reconcileCdn` unwired and drifted (`cdnCleanup.ts:18-58`); `keepHighestVersion` / `preserveStructure` / `onedriveFlatFolder` toggles rendered but never read; stale root `CLAUDE_CODE_PROMPT_*.md` / `CLAUDE_CODE_LOG_*.md` clutter describing pre-3.x architecture.  
- [ ] `onedrive_poll_token` polls forever on an unparseable OAuth error body (`cloud.rs:389-407`).  
- [ ] Node-version inconsistency: README says 22, most workflows use 24 (`db.yml`, `worker.yml`, etc.).

---

## ✅ Confirmed fixed since the 2026-07-24 plan (don't re-do)

- Cross-tenant read leak on ratings/comments/approvals/activity/clients — fixed and consolidated onto `can_see_asset()` (`20260724120000…`, `20260731120000…`).  
- `asset_events` impersonation \+ per-asset rate limit; ratings **write** scoping; `asset_stats` view `security_invoker=on`; `app_errors` rate-limit counter.  
- God-file decomposition is real: `pipelineService.ts` 1,846→98 lines; `supabaseService.ts` 1,693→52-line barrel over \~23 modules.  
- Tests went \~0 → \~382 `it()` blocks \+ characterization tests pinning the destructive paths; `guardrail.ts` blast-radius tripwire; `reportError.ts` chokepoint; `no-console` enforced.  
- Credential posture: no service key on desktop; `validateAnonKey` rejects service-role keys; short-lived R2 grants; secret-free client exports. (Residual: plaintext OAuth tokens — P3 above.)

