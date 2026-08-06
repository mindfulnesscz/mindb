# Sotto — Planning Hub (START HERE)

Numbered so run order is obvious. Each `NN_` file is a delegatable prompt; prepend the SHARED
CONTEXT block from `DONE_01_security-hardening-S0-S7.md` to any prompt before handing it to an agent.
`REF_` files are reference/strategy, not tasks. `DONE_` files are already implemented — kept for
context, don't re-run.

_Last updated 2026-08-06 (post re-verification)._

## ▶ Run next — in this order

| # | File | What it does | Status |
|---|---|---|---|
| 01 | `01_stabilize-hardening-regressions.md` | Land the two hand-applied fixes (fs-scope + prune-guard) properly, add the regression + out-of-appdata smoke tests, make the reconcile failure diagnosable. | **DO FIRST** — two edits are uncommitted on the working tree |
| 02 | `02_gdrive-duplicate-folder-fix.md` | **G1 (prevent the race) is DONE** — in-flight folder dedup + md5 skip are in. Only **G2 remains**: the manual tool to merge the duplicate folders that already exist (+ optional `orderBy: createdTime` oldest-pick so runs converge). | PARTIAL — do G2 |
| 03 | `03_asset-conversion-and-tag-inference.md` | The adoption feature: folder→asset conversion (drop/batch/right-click) + path/file-type tag inference. Prompts A–E, has its own dependency graph. | TODO (feature work — after the fixes) |

## ✅ Done (implemented — don't re-run)

- `DONE_01_security-hardening-S0-S7.md` — the security audit fixes. **Re-verified 2026-08-06: the audit is now effectively fully closed.** All four items that were still open at the first verification are fixed: `processRenameTasks` placebo removed; GDrive race + weak skip; cloudUrls stem collision (now keyed by stable identity); taxonomy-label path sanitization. See `REF_audit-verification.md`.
- `DONE_02_cdn-garbage-collector.md` — bucket-wide CDN GC. Landed as the `cdn-gc` edge function + `cdnGarbageCollection.ts` desktop client (commit `200b1f2`).
- CDN **per-asset** cross-level orphan prune (commit `7e3b3d4`). `01` hardens its guard against deleting still-referenced objects (hand-edit applied; test pending).

## 📎 Reference (not tasks)

- `REF_audit-findings.md` — the full P0–P3 findings list with file:line.
- `REF_audit-verification.md` — implemented-vs-checklist with evidence, plus the 2026-08-06 re-check.
- `REF_onboarding-and-scaling.md` — the "acquirable by other agencies" analysis (identity model, custom domains, onboarding friction).
- `REF_asset-mgmt-and-tag-inference-plan.md` — value/effort plan + the detailed tag-inference design that `03` implements.

## Known deliberate residual (not a task)
- Thumbnail regeneration fingerprints on **mtime + size, not a content hash** (`render.rs`), so a content edit preserving both won't regenerate. Documented tradeoff (hashing = read every file), not a bug.

## Non-negotiables for every agent
- Identity is minted in ONE place (`createAssetFolder` / `@sotto/domain`); never key on filename.
- Never `db:reset`; apply migrations with `supabase migration up`.
- Update `docs/pages/**` (and README/VERSIONING where relevant) in the same change.
- Ship green (`lint`, `typecheck`, the test suites) and add a regression test for anything you fix.
