# 01 — Stabilize the recent hardening regressions (fs-scope, prune guard, reconcile)

Prepend the **SHARED CONTEXT block** from the security prompts (`DONE_01_security-hardening-S0-S7.md`).

Two fixes are **already hand-applied to the working tree** (uncommitted). This prompt lands them
properly, adds the regression tests that would have caught them, and makes the reconcile failure
diagnosable. Review the two hand-edits first: `git diff desktop/src-tauri/capabilities/default.json
desktop/src/services/pipeline/cdnUpload.ts desktop/src/services/supabase/cdnReferences.ts`.

---

## A. fs-scope regression (stopgap applied — make it the considered end-state)

**What happened:** S5 replaced the fs capability's static `"allow": [{ "path": "**" }]` scope with
bare permission strings + runtime `FsExt::fs_scope().allow_directory()` grants
(`path_policy::restore_persisted_scope`). Those runtime grants don't reliably cover real working
folders (a `~/Library/CloudStorage/Dropbox-…` source path was refused: *"not allowed on the scope for
allow-write-text-file"*), which broke scanning / `.dchub.json` / readme / package writes. S3 amplified
it (identity's `writeManifest` no longer swallows the error, so one denial aborts identity for the
whole run → "no folder identity" on every asset).

**Stopgap in place:** `capabilities/default.json` restored to the static `**` scope (pre-S5), so the
dev build works after a rebuild.

**Do:**
- Decide the final static scope and commit it: `$HOME/**` if every client source/target/vault/
  creation folder lives under the home dir; keep `**` (or add explicit roots) if any sit on external
  volumes / network mounts. Apply to all `fs:*` perms the pipeline uses. Keep `requireLiteralLeadingDot:
  false`.
- Retire the app's *dependence* on the boot-time runtime grant for basic function — `restore_persisted_scope`
  may stay as harmless defense-in-depth, but the app must not require it to read/write working folders.
- Keep `path_policy` confinement on the custom Rust commands and the CSP — those are the real
  command-surface hardening and must not be reverted.

## B. Prune-guard data-loss fix (hand-edit applied — add the test)

**What happened:** the cross-level prune (`pruneStaleObject` in `pipeline/cdnUpload.ts`) deleted an
asset's old-tier object while excluding the asset's *own* row from the "still referenced" check,
assuming the same run would repoint the DB URL. When the repoint/reconcile doesn't fully land, that
deletes the object the portal is still serving. Observed: `pruned stale thumbnail (was public):
…/48d94348/c1.webp` for objects the DB still pointed at, with the reconcile failing the same run.

**Hand-edit applied:** `pruneStaleObject` now retains the object if **any** live row references it,
including the asset's own; a stale-tier object is pruned only once the row has been repointed (no
owner left) — a genuine orphan. `cdnReferences.ts` doc comment updated so the exclusion isn't
reintroduced.

**Do:** add a regression test in `desktop/src/services/pipeline/` covering:
- a tier change where the asset's row still references the OLD-tier key → the old object is **kept**
  (not pruned);
- after the row is repointed to the new tier (old key has no owner) → the old object **is** pruned;
- a key referenced by a *different* live row (gallery parent sharing a child's media) → kept;
- `dryRun` prunes nothing; references-unavailable fails closed (keeps).
Apply the same coverage to the originals prune path (same helper).

## C. Out-of-appdata pipeline smoke test (so this class of bug fails CI, not a live run)

Add an end-to-end smoke test that runs a slice of the pipeline (scan → identity/`.dchub.json` write →
thumbnail → CDN upload, against a stubbed R2) using a **fixture source folder OUTSIDE appdata**
(e.g. a temp dir), asserting `.dchub.json`/readme/package writes succeed and no "forbidden path" /
"no folder identity" error appears. Wire it into the desktop test job. This is the guard that would
have caught the fs-scope regression before it hit a dev run.

## D. Make the reconcile failure diagnosable (and reduce its causes)

The desktop only surfaces `⟳ CDN reconcile — 0 moved · 2 failed · 1 still queued`; the per-asset
reason is opaque ("see function logs"). From the code, the `2 failed` on the 2026-08-06 run are most
likely:
1. **A gated video's `requireSignedURLs` reconcile failing** — `reconcileStreamFlag` returns false
   (and the asset stays queued) when `CF_STREAM_TOKEN` is unset on the environment. The run had one
   `.MOV` (First Visit Video). Confirm `CF_STREAM_TOKEN` is set on the **dev** project.
2. **A column copy failing with the source already gone** — the desktop prune had been deleting the
   public source before the reconcile tried to copy it (the Part B bug). The Part B fix removes this
   cause going forward.

**Do:** change `supabase/functions/cdn-reconcile/index.ts` to return a per-asset failure list
(`{asset_id, stage, reason}`) in its JSON response, and have the desktop caller
(`services/supabase/cdnReconcile.ts`) log each — replacing the opaque summary. A gated video with no
`CF_STREAM_TOKEN` should log a clear "stream token not configured for this environment" rather than a
bare failure. (Definitive root cause for the specific run is in the dev `cdn-reconcile` edge-function
logs, Supabase dashboard → Edge Functions → Logs — paste them to confirm the exact two.)

---

## Definition of done

- fs-scope committed as a deliberate static scope; a fresh dev build reads/writes an out-of-appdata
  `~/Library/CloudStorage/…` source folder with no "forbidden path" errors.
- Prune-guard regression test (B) + originals coverage, red before the hand-edit / green after.
- Out-of-appdata pipeline smoke test (C) wired into the desktop test job.
- Reconcile returns and the desktop logs per-asset failure reasons (D).
- Update `CLAUDE.md` (fs/native notes) and any `docs/pages/desktop/*` that describe folder access.
- `npm run lint`, `npm run typecheck`, `npm run test:desktop`, `check:rust`/`lint:rust` green.
