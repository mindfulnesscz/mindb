# Sotto — Planning & Delegation Hub

One folder, everything for the current push. Generated 2026-08-05 from a full read of the repo at
v3.2.0. Two tracks: **security first, then asset management.**

## Read / work in this order

1. **`SOTTO_AUDIT_TODO.md`** — the full findings list (P0→P3), each with file:line, defect, and
   failure scenario. The source of truth for *what* is wrong.
2. **`SOTTO_SECURITY_AGENT_PROMPTS.md`** — ⚑ **start here to build.** The audit split into 8
   delegatable prompts (S0–S7). S0 (the P0 self-elevation RLS hole) ships first, alone; the rest run
   in parallel by subsystem.
3. **`SOTTO_ONBOARDING_PLAN.md`** — the "acquirable by other agencies" thinking: how folder→asset
   conversion actually has to work given the identity model, options, and the honest framing that the
   security fixes gate multi-tenant sales.
4. **`SOTTO_ASSET_MGMT_TODO.md`** — the asset-management feature plan, prioritized by value/effort,
   with the detailed tag-inference design (Part B).
5. **`SOTTO_ASSET_MGMT_AGENT_PROMPTS.md`** — that plan split into 6 delegatable prompts (A–E), with a
   dependency graph. Run after the security track (no file overlap; can start once S0 is merged).

## How to delegate

Each prompt doc opens with a **SHARED CONTEXT** block — prepend it to every prompt you hand an agent.
Then paste one prompt. Each prompt names the files to read first, the exact scope, the traps, and a
definition of done (tests + docs update + the check commands).

## Delegation waves at a glance

```
Security:   S0  →  (S1 S2 S3 S4 S5 S6 S7 in parallel by area)
Assets:     A + B (parallel)  →  C + D (parallel)  →  E
            (Assets can begin once S0 is merged — no file overlap with security.)
```

## Non-negotiables every agent must respect
- Identity is minted in ONE place (`createAssetFolder.ts` / `@sotto/domain`); never key on filename.
- Never run `db:reset` or any destructive DB command; apply migrations with `supabase migration up`.
- Update `docs/pages/**` (and README/VERSIONING where relevant) in the same change.
- Ship green: `npm run lint`, `npm run typecheck`, and the relevant test suites; add a regression test.
