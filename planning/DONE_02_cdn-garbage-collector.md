# Sotto — Standalone CDN Garbage Collector (prompt, 2026-08-05)

One delegatable prompt. Uses the **same SHARED CONTEXT block** as
`SOTTO_SECURITY_AGENT_PROMPTS.md` — prepend it (identity non-negotiable, never `db:reset`, update
`docs/pages/**`, ship green with a regression test).

> Context: the per-asset, per-run orphan prune (thumbnails/originals swept across levels, like pages)
> is **already implemented** — this prompt does NOT touch the desktop pipeline. This is the separate
> tool to reclaim the garbage **already accumulated** in the dev/staging/prod buckets (old-level
> copies left by level changes, objects from the CI-cron era and manual runs, anything no live row
> references).

**Goal:** a script you run manually, per environment, that lists every object in both R2 buckets,
computes the set of objects any live asset row legitimately references (all clients, all levels,
including derived page keys and the protected `branding/` namespace), and **removes everything else
— all unlisted content**. Dry-run by default with a clear preview of exactly what will be deleted
(counts, bytes, grouped, sample keys, written to a report file) before you accept; `--execute` to
actually delete.

## Background: how the level model creates orphans

An asset's access level is encoded in its R2 object key. On a level change the `cdn-reconcile` path
**copies** the thumbnail/original to the new level's key, repoints the URL column, and **leaves the
old-level copy in place** (reversibility). Those old copies — plus whatever prior tooling left — are
the garbage this reclaims.

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

## Definition of done

- On a seeded fixture (live rows + planted orphans): the dry-run report correctly classifies a
  reconcile old-level thumbnail/original copy as `old-level-copy`, a `branding/` object as protected,
  a page object of a live row as referenced, and a stale no-row object as `no-matching-row`;
  `--execute` deletes only the orphans; the empty-reference-set and blast-radius aborts both fire in
  tests.
- Runs standalone against a configured environment; audit manifest written.
- New `docs/pages/operations/cdn-garbage-collection.mdx`: how to run it per environment, how to read
  the report, the flags, and the safety rails. Reference it from `CLAUDE.md` storage section.
- `npm run lint` / relevant script checks green.
