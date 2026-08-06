# Sotto — Planning Hub (START HERE)

Numbered so run order is obvious. Each `NN_` file is a delegatable prompt; prepend the SHARED
CONTEXT block from `DONE_01_security-hardening-S0-S7.md` to any prompt before handing it to an agent.
`REF_` files are reference/strategy, not tasks. `DONE_` files are already implemented — kept for
context, don't re-run.

_Last updated 2026-08-06._

## ▶ Run next — in this order

| # | File | What it does | Status |
|---|---|---|---|
| 01 | `01_stabilize-hardening-regressions.md` | Land the two hand-applied fixes (fs-scope + prune-guard) properly, add the regression + out-of-appdata smoke tests, make the reconcile failure diagnosable. | **DO FIRST** — fixes live regressions, two edits are uncommitted on the working tree |
| 02 | `02_gdrive-duplicate-folder-fix.md` | G1 prevent the Drive folder-clone race; G2 manual merge tool to clean the existing duplicates. | TODO (you're hitting this now) |
| 03 | `03_cdn-garbage-collector.md` | Standalone manual GC to reclaim accumulated orphaned R2 objects (dev/staging/prod) with a dry-run preview. | TODO |
| 04 | `04_asset-conversion-and-tag-inference.md` | The adoption feature: folder→asset conversion (drop/batch/right-click) + path/file-type tag inference. Prompts A–E, has its own dependency graph. | TODO (feature work — after the fixes) |

## ✅ Done (implemented — don't re-run)

- `DONE_01_security-hardening-S0-S7.md` — the security audit fixes. Verified 38/42 items landed (see `REF_audit-verification.md`). Remaining open items were low-priority P2s; the important ones (P0 self-elevation, P1 tenant/pipeline) are done.
- CDN **per-asset** cross-level orphan prune (thumbnails/originals swept across levels each run) — you implemented this; commit `7e3b3d4`. Note: `01` hardens its guard against deleting still-referenced objects.

## 📎 Reference (not tasks)

- `REF_audit-findings.md` — the full P0–P3 findings list with file:line.
- `REF_audit-verification.md` — what was actually implemented vs. the checklist, with evidence.
- `REF_onboarding-and-scaling.md` — the "acquirable by other agencies" analysis (identity model, custom domains, onboarding friction).
- `REF_asset-mgmt-and-tag-inference-plan.md` — value/effort plan + the detailed tag-inference design that `04` implements.

## Non-negotiables for every agent
- Identity is minted in ONE place (`createAssetFolder` / `@sotto/domain`); never key on filename.
- Never `db:reset`; apply migrations with `supabase migration up`.
- Update `docs/pages/**` (and README/VERSIONING where relevant) in the same change.
- Ship green (`lint`, `typecheck`, the test suites) and add a regression test for anything you fix.
