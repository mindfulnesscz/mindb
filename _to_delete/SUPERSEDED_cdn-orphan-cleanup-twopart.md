# Sotto — CDN Orphan Cleanup (follow-up prompt, 2026-08-05)

Two deliverables, discovered during audit verification (not a separate item in
`SOTTO_AUDIT_TODO.md`). Both use the **same SHARED CONTEXT block** as
`SOTTO_SECURITY_AGENT_PROMPTS.md` — prepend it (identity non-negotiable, never `db:reset`, update
`docs/pages/**`, ship green with a regression test).

- **Part 2 (priority) — standalone manual GC.** dev/staging/prod buckets are already full of
  accumulated garbage; a one-shot + repeatable tool is needed to reclaim it. This is the "must."
- **Part 1 — per-run prune extension.** Cheap forward hygiene so new garbage stops accumulating.

They can go to two different agents. Do **Part 2 first** — it also cleans everything Part 1 would
have prevented.

> **Status update (2026-08-06):** Part 1 is implemented and regression-tested. Part 2 remains the
> priority follow-up and now has a standalone delegatable prompt in `SOTTO_CDN_GC_PROMPT.md`.

Background (both parts): an asset's access level is encoded in its R2 object key. On a level change
the `cdn-reconcile` path **copies** the thumbnail/original to the new level's key, repoints the URL
column, and **leaves the old-level copy in place** (reversibility). Pages are swept across all
levels every pipeline run; thumbnails/originals are not — so their old-level copies accumulate, plus
whatever the earlier CI-cron era and manual runs left behind.

## Object namespaces (verified — the reference model depends on getting these exactly right)

Public bucket (`R2_BUCKET` on `R2_PUBLIC_DOMAIN`):
- `{client}/thumbnails/{stable}/{child}.webp`
- `{client}/originals/{stable}/{child}{ext}`
- `{client}/pages/{stable}/{child}/{NNN}.webp`
- `branding/{client}/logo.{ext}`  ← **NOT asset-row-referenced; PROTECTED namespace**

Gated bucket (`R2_GATED_BUCKET`, reachable only via the `cdn-gate` Worker):
- `{level}/{client}/thumbnails|originals|pages/...` where `level ∈ {guest,client,internal}`
  (`public` lives in the public bucket).

Notes: some **legacy** keys carry `thumbnails/{stable}/{child}.webp` with no client segment
(`rekey-gated-objects.mjs:326-327`). Cloudflare **Stream** thumbnails are NOT in R2 — out of scope.
Canonical key rules live in `packages/domain/src/assetStorage.ts` (`storageTarget`, `pageTarget`,
`parseObjectPath`) — use that module, never re-derive the shapes by hand.

---

# Part 2 — Standalone manual CDN garbage collector (PRIORITY)

**Goal:** a script you run manually, per environment, that lists every object in both R2 buckets,
computes the set of objects any live asset row legitimately references (all clients, all levels,
including derived page keys and the protected `branding/` namespace), and **removes everything else
— all unlisted content**. Dry-run by default with a clear preview of exactly what will be deleted
(counts, bytes, grouped, sample keys, written to a report file) before you accept; `--execute` to
actually delete.

## Where it lives

New script `scripts/gc-cdn-objects.mjs`, reusing the plumbing `scripts/rekey-gated-objects.mjs`
already has: the **parent R2 access key** (has `ListBucket`, which the temp grant does NOT — that
limitation is why the old reconcile jammed), the S3 helpers, and the per-environment config loader
(`scripts/environments/*.env` / `bootstrap-env.mjs`). Read all rows via the Supabase **service
role**. Runs standalone — no desktop app, no running stack.

## The reference set (safety-critical — get this complete or the GC deletes live content)

Read every row of `public.assets` for **all clients** (id, client_id, stable_id, child_id, perm,
status, thumbnail_url, download_url, download_key, preview_page_count). For each row build the set of
keys it legitimately owns:

1. **Derived keys** via `@sotto/domain`: `storageTarget(effectiveLevel, client, 'thumbnails', stable,
   child, '.webp')`, the original, and `pageTarget(...)` for pages `1..preview_page_count`, at the
   row's `effectiveLevel`.
2. **Stored keys**: parse the object key out of `thumbnail_url`, `download_url`, and `download_key`
   verbatim — some rows' stored URL disagrees with their identity (same caveat reconcile documents),
   and the stored value is authoritative for "still referenced."
3. **Originals by prefix, not exact ext**: if you can't reconstruct the original's extension, protect
   the whole `{level}/{client}/originals/{stable}/{child}.` prefix (any extension) rather than risk
   deleting a live original you merely failed to reconstruct.

Then classify every listed object:
- **Referenced** (in the set) → keep.
- **Protected namespace**: `branding/{client}/...` → keep. Enumerate EVERY writer to R2 before
  finalizing this list — grep for `PUT`/`putObject`/`upload_to_r2` across `supabase/functions`,
  `scripts`, `desktop` — and protect each namespace not tied to an asset row by default, with an
  explicit opt-in flag to include it. (Confirmed writers today: the asset pipeline
  thumbnails/originals/pages, and `r2-branding-upload` → `branding/`.)
- **Orphan** (unlisted, not protected) → delete candidate. Tag each with a reason: `old-level-copy`
  (identity matches a live row but at a non-current level), `no-matching-row` (stable/child not in
  any row), `legacy-no-client`, `unknown-shape`.

Handle `disconnected` rows explicitly: by default **protect** any object a disconnected row still
references (conservative — the row was kept for its ratings/comments), and report those separately;
add a `--drop-disconnected` flag to also reclaim them.

## Preview / report (the "overview before I accept")

Default is **dry-run**. Produce, per environment and per bucket:
- totals: object count + bytes; referenced vs orphan count + reclaimable bytes;
- orphans grouped by reason, by client, and by level; a sample of keys per group;
- a machine-readable report file (JSON) plus a human summary, written to disk so it can be inspected
  and diffed before acceptance.

`--execute` deletes; require an interactive confirmation that echoes the totals unless `--yes` is
passed. Log every deletion to an audit manifest file. Paginate LIST and batch deletes; be resumable
and rate-limit-aware (buckets are large). Never touch anything outside the two configured buckets;
never touch Stream.

## Hard safety rails (this deletes "all unlisted content" — it must be impossible to nuke a live bucket)

- **Abort if the reference set is empty or implausibly small.** If the Supabase read fails, returns
  zero rows, or returns fewer than a sane floor, STOP — do not proceed to treat the whole bucket as
  orphaned. A failed query must never become a full wipe.
- **Blast-radius gate.** If orphans exceed a high fraction of total objects (e.g. > 60%), refuse
  without an explicit `--force`, and print why.
- **Environment guard.** Require an explicit `--env <dev|staging|production>`; require a second
  confirmation for `production`.
- Dry-run is the default; `--execute` is never implied.

## Definition of done (Part 2)

- On a seeded fixture (live rows + planted orphans): the dry-run report correctly classifies a
  reconcile old-level thumbnail/original copy as `old-level-copy`, a `branding/` object as protected,
  a page object of a live row as referenced, and a stale no-row object as `no-matching-row`;
  `--execute` deletes only the orphans; the empty-reference-set and blast-radius aborts both fire in
  tests.
- Runs standalone against a configured environment; audit manifest written.
- New `docs/pages/operations/cdn-garbage-collection.mdx`: how to run it per environment, how to read
  the report, the flags, and the safety rails. Reference it from `CLAUDE.md` storage section.
- `npm run lint` / relevant script checks green.

---

# Part 1 — Per-run prune extension (forward hygiene)

**Goal:** extend the existing per-asset, all-levels prune from pages to **thumbnails and originals**
in `desktop/src/services/pipeline/cdnUpload.ts`, so each pipeline run self-heals these orphans the
way it already does for pages — stopping new garbage from accumulating between GC runs.

## Read first
`desktop/src/services/pipeline/cdnUpload.ts`: `ALL_LEVELS` (~34), `fetchTieredManifest` (~86),
`routeFor`/`storageTarget`/`tierFor`/`assetUrl`; the **pages** prune (~316–435, the reference —
`ALL_LEVELS.flatMap(...)` deleting from the bucket each stale level implies, filtered by
`!plannedKeys.has(k)`, best-effort); the **thumbnails** stage (~162–235, no cross-level prune today);
the **originals** stage (~482–585, current-level stale-sibling only). Also
`desktop/src/services/supabase/exportDisconnect.ts` `referencedObjectKeys` (shared-key protection).

## Build
Mirror the pages prune for thumbnails and originals: after each upload loop, for the asset compute
its thumbnail/original key under all four levels, take those present in `remoteKeys`, drop the
current-level target and anything in `plannedKeys`, delete the rest from the bucket each stale level
implies. Keep the existing current-level extension-variant cleanup on originals (additive).

Must: operate only on THIS asset's `stable_id`/`child_id` (bounded, never a bucket-wide prune — that
is Part 2); never delete the just-written key or current target; **protect shared keys** (verify
whether gallery children can reference a parent's thumbnail/original at a different level — gallery
images inherit the parent's level by DB trigger, so normally co-levelled, but confirm; guard the way
`referencedObjectKeys` does, and when unsure skip + log); honor `settings.dryRun` and `shouldStop`;
best-effort (a delete failure logs and continues, never fails the run — match the page prune).

## Definition of done (Part 1)
- Characterization test: after an asset's level changes and a run completes, no thumbnail/original
  remains at any non-current level, the current-level object + URL are correct, the shared-key guard
  prevents deleting a referenced key, and dry-run deletes nothing.
- Update `docs/pages/pipeline.mdx` (thumbnails/originals now pruned across levels like pages) and the
  reconcile residue note in `cdn-reconcile/index.ts` / `CLAUDE.md`.
- `npm run lint`, `npm run typecheck`, `npm run test:desktop` green.
