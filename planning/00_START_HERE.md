# Sotto — Planning Hub (START HERE)

Numbered so run order is obvious. Each `NN_` file is a delegatable prompt; prepend the SHARED
CONTEXT block from `DONE_01_security-hardening-S0-S7.md` to any prompt before handing it to an agent.
`REF_` files are reference/strategy, not tasks. `DONE_` files are already implemented — kept for
context, don't re-run.

_Last updated 2026-08-06 (00a/00b/00c filed for the 3.2.2 hotfix)._

## 🚢 In the 3.2.2 hotfix

`00a`, `00b`, `00c` are queued for **3.2.2** — branch `hotfix/3.2.2`, changelog section already open.
`00b` part A is **landed** (`d66d3b2`) but has **never been compiled** — run `npm run check` before
merging. Everything else is open.

## ▶ Run next — in this order

| # | File | What it does | Status |
|---|---|---|---|
| 00a | `00a_auth-oauth-identity-bugs.md` | A failed OAuth/magic-link return silently restores the **previous** user's session — presents as "I signed in and I'm in someone else's account," indistinguishable from a cross-tenant leak. Fix the app-level auth-return path + regression tests; document GoTrue identity linking. | **DO FIRST** — client-visible, security-adjacent |
| 00b | `00b_desktop-ui-freeze-and-libreoffice.md` | Part A (sync Tauri commands freezing the main thread) **landed, uncompiled** — needs `npm run check` + a timed run to confirm 8-way throughput. B/C open: LibreOffice Dock tile, no subprocess timeout, silent host-LibreOffice fallback. | **A LANDED (unverified)** · B/C open |
| 00c | `00c_out-folder-hygiene-and-artifact-layout.md` | What the client sees. **C1** destinations receive assets only (do first — its boundary test is C3's safety net). **C2** hide the `.json` manifests; thumbnails stay visible. **C3** every render artifact, including the document title slide, moves into one visible `thumbnails/` folder beside the assets. Target trees for all three package shapes are in the file. | QUEUED for 3.2.2 — all three |
| 02 | `02_gdrive-duplicate-folder-fix.md` | **G1 (prevent the race) is DONE** — in-flight folder dedup + md5 skip are in. Only **G2 remains**: the manual tool to merge the duplicate folders that already exist (+ optional `orderBy: createdTime` oldest-pick so runs converge). | PARTIAL — do G2 |
| 03 | `03_asset-conversion-and-tag-inference.md` | The adoption feature: folder→asset conversion (drop/batch/right-click) + path/file-type tag inference. Prompts A–E, has its own dependency graph. | TODO (feature work — after the fixes) |

## ✅ Done (implemented — don't re-run)

- `DONE_01_security-hardening-S0-S7.md` — the security audit fixes. **Re-verified 2026-08-06: the audit is now effectively fully closed.** All four items that were still open at the first verification are fixed: `processRenameTasks` placebo removed; GDrive race + weak skip; cloudUrls stem collision (now keyed by stable identity); taxonomy-label path sanitization. See `REF_audit-verification.md`.
- `DONE_02_cdn-garbage-collector.md` — bucket-wide CDN GC. Landed as the `cdn-gc` edge function + `cdnGarbageCollection.ts` desktop client (commit `200b1f2`).
- `DONE_03_stabilize-hardening-regressions.md` — the S5/S3 regressions. Landed in 3.2.2: the fs
  capability is a deliberate `$HOME/**` + `/Volumes/**` + `$APPDATA/**` scope declared once via
  `fs:scope`; folder pickers grant recursively; `path_policy` re-reads persisted roots on a scope
  miss (the fresh-install case); prune-guard and out-of-appdata smoke tests added; `cdn-reconcile`
  returns per-asset `{asset_id, stage, reason}` and the desktop logs it.
- CDN **per-asset** cross-level orphan prune (commit `7e3b3d4`). Its still-referenced guard is now
  covered by `desktop/src/services/pipeline/cdnPruneGuard.test.ts`.
- **LibreOffice bundling itself works.** Verified 2026-08-06 on the installed build:
  `Sotto.app/Contents/Resources/resources/native/libreoffice/…/soffice` is present. It is excluded
  from `bundle.resources` on purpose (Tauri dereferences symlinks → 800MB becomes 1.5GB and the
  sealed signature breaks) and placed with `ditto` by `npm run build:app`. Don't "fix" the config.

## 📎 Reference (not tasks)

- `REF_audit-findings.md` — the full P0–P3 findings list with file:line.
- `REF_audit-verification.md` — implemented-vs-checklist with evidence, plus the 2026-08-06 re-check.
- `REF_onboarding-and-scaling.md` — the "acquirable by other agencies" analysis (identity model, custom domains, onboarding friction).
- `REF_asset-mgmt-and-tag-inference-plan.md` — value/effort plan + the detailed tag-inference design that `03` implements.
- `docs/pages/ideas/slimming-the-bundled-libreoffice.mdx` — the ~800MB trim, relevant before auto-update is turned on.

## Known deliberate residual (not a task)
- Thumbnail regeneration fingerprints on **mtime + size, not a content hash** (`render.rs`), so a content edit preserving both won't regenerate. Documented tradeoff (hashing = read every file), not a bug.
- **The per-thumbnail `.json` sidecars are render caches, not metadata** — they hold the source size+mtime and the width/quality settings, the only way to know a render is stale. Deleting them re-renders the library. `00c` C2 **hides** them rather than consolidating: eight concurrent renderers writing one shared manifest is last-writer-wins, and a corrupt write would invalidate a whole gallery instead of one thumbnail.
- **CDN object keys are built from folder identity (`stable_id`/`child_id`), never from filenames** (`cdnUpload.ts:4`). Renaming or moving a local artifact changes no key and orphans nothing — don't re-derive this fear when touching the layout. It is what makes `00c` C3 affordable.
- **`-thumb` stays in artifact filenames after `00c` C3**, even though location becomes authoritative. It keeps every legacy substring filter working as a safety net. Dropping it is a separate later decision.
- **Automatic OAuth identity linking** (GoTrue): a second provider returning the same verified email links into the existing user rather than creating a new one. Intended upstream behaviour, no hosted toggle. Documented in `00a` — the actionable half is the silent-failure bug, not the linking.
- **LibreOffice initialises AppKit on macOS even under `--headless`**, so it can take a Dock tile. Upstream behaviour. Mitigated with flags in `00b`; do NOT patch the nested `Info.plist` — that breaks the sealed signature notarisation depends on.

## Non-negotiables for every agent
- Identity is minted in ONE place (`createAssetFolder` / `@sotto/domain`); never key on filename.
- Never `db:reset`; apply migrations with `supabase migration up`.
- Update `docs/pages/**` (and README/VERSIONING where relevant) in the same change.
- Ship green (`lint`, `typecheck`, the test suites) and add a regression test for anything you fix.
- **Never exercise auth providers against production.** Use staging (`tvrxnwbhzborkkkdeyuk`) with a distinct email per provider; a test user in prod mutates real auth state and links identities you then have to unpick.
- **Any Tauri command that does blocking work must be `#[tauri::command(async)]`.** Sync commands run on the main thread and freeze the window (Tauri v2 docs). This caused `00b`.
- **Package the desktop app with `npm run build:app`, never a bare `tauri build`** — the latter silently ships without LibreOffice.
- **`validate_preview_area` is a security guard, not a naming convention.** It is what stands in front of `remove_dir_all`. Any change to the previews layout rewrites it — never relaxes it.
