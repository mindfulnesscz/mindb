# Claude Code handoff — gated asset delivery, then video on Cloudflare Stream

Two bodies of work in dependency order. **Part A (gated delivery) must land before Part B
(video).** Video playback URLs and preview frames inherit whatever protection model Part A
establishes; building Stream first means retrofitting the player, the grid and the hover
preview a second time.

Written 2026-07-31 against v3.0.0. Supersedes `CLAUDE_CODE_PROMPT_video-stream.md` — that
file's Part B content is folded in below with corrected line numbers. Delete both files once
the Definition of Done at the bottom is met.

**Everything in "Starting facts" was verified on 2026-07-31 by reading the files. Re-verify
before relying on it.** The previous brief's line numbers had already rotted because
`runCdnUpload`/`runOriginalUpload` moved out of `pipelineService.ts` into
`services/pipeline/cdnUpload.ts`. Assume the same will happen to these.

---

## Progress — updated 2026-07-31, branch `feature/video`

| Phase | State |
|---|---|
| 0 — stop the bleeding | **done** |
| 1 — schema | **done** |
| 2 — token minting | **done**, as a Worker route rather than an edge function (see below) |
| 3 — the Worker | **code done**, needs the manual Cloudflare setup and a benchmark |
| 4 — re-key and cut over | not started |
| 5 — guest tier and admin surface | partly moot — see "Guest tier" below |
| 6–9 — Part B, video | not started |

Landed: `supabase/migrations/20260731120000_gated_delivery_levels.sql`,
`supabase/audit/perm_exposure.sql`, `workers/cdn-gate/`,
`web/apps/client-hub/src/services/cdnGate.ts` + `hooks/useCdnCookie.ts`,
`packages/asset-library/src/permissions.test.ts` (the module had no tests at all).
`npm run check` clean · 615 JS tests · 100 pgTAP tests.

**Still to do before any of this protects anything:** the manual Cloudflare half (create
`dc-hub-gated` with NO public access, attach `files.disruptcollective.com` as a custom domain,
`wrangler secret put` ×3), then Phase 4 — until the pipeline writes level-prefixed keys into the
gated bucket, the Worker guards an empty bucket while every object stays on the public domain.

### Corrections to the facts above — verified by reading, 2026-07-31

- **`is_staff()` is `role in ('editor','admin','super_admin')`**, not editor/admin. Widened by
  `20260724120001_super_admin_role.sql`. The Worker and `levelForProfile` match the current
  definition.
- **`assetExport.ts:150` is not a database write.** It is the `readme.md` generator, which
  hardcoded `status: 'published', perm: 'public'` into every Obsidian note regardless of the row.
  It now reports the database's actual values. Worth flagging because these notes are how the
  library gets read, so a wrong access level there is the one most likely to be believed.
- **The pipeline PATCHed `perm` on every run**, which the brief does not mention and which would
  have quietly broken the whole design: an editor's promotion or lock-down was undone by the next
  publish, and with the level in the object key that would have dragged the bytes back too. `perm`
  is now sent on INSERT only (`stripPortalOwnedFields`). `status` deliberately still goes on
  updates — it is how a row whose file returned to disk is un-`disconnected`.
- **Object keys already carry `{client_id}/`** — `r2-grant` hands the desktop
  `keyPrefix: '{client_id}/'`, so Phase 4 inserts one `{level}/` segment in front rather than
  restructuring keys.
- **`can_see_asset` already existed** (`20260729120000`) carrying a `TODO(phase3)` asking for
  exactly the consolidation Phase 1 needed. Its hand-written `perm = 'public' or is_staff() or own
  client` disjunction was **deleted rather than extended**: a fourth level is precisely what makes
  a restatement wrong, and as written it denied a signed-in visitor the ratings and version history
  of a guest-level asset whose row they could plainly see. It now defers entirely to `assets` RLS.
- **Approvals stayed staff-only.** `20260724120003` made them so on purpose; recreating a
  "readable with asset" policy there would have silently re-opened them, because SELECT policies OR.
- **Comments kept their `auth.uid() is not null` guard** from `20260724120004`. Dropping it would
  have opened the comment thread to anonymous visitors as a side effect of a tightening.

### Decisions taken with Petr, 2026-07-31

1. **The cookie is minted by the Worker, not by a Supabase edge function.** P5 is right that the
   cookie is *sent* across sibling subdomains but never says who *sets* it — and a cookie's
   `Domain` must be a parent of the host that sets it, so a response from `*.supabase.co` cannot
   set one for `.disruptcollective.com`. `cdn-gate` gains `POST /auth` (and `DELETE /auth`), which
   validates the caller's Supabase session and resolves their level. The no-I/O rule is about the
   read path; `/auth` runs once per session. There is no `supabase/functions/cdn-token/`.
2. **Two buckets, not one bucket with a route exclusion.** `dc-hub-bucket` keeps
   `cdn.disruptcollective.com` and stays public; a new `dc-hub-gated` has no public access at all
   and is reachable only through the Worker's binding at `files.disruptcollective.com`. A broken
   route then 404s instead of publishing the library — the failure mode is closed. It also means no
   existing public URL breaks, and every gated object gets a new key on a new host, which is the
   re-key the exposure requires anyway.
3. **Guest tier needs no new email-capture flow.** The magic-link sign-in already exists and
   already lands a new visitor on `role='public'` with no client, which `levelForProfile` maps to
   the guest level. Guest access follows authentication, so the tier is verified by construction
   and the open question is closed. Petr notes a real existing bug to fix separately: **Microsoft
   Outlook link-scanning consumes the magic link twice**, so the user's own click fails.
4. **Portal hostnames confirmed:** `hub.disruptcollective.com` (prod),
   `staging.hub.disruptcollective.com`, both under the same registrable domain as the CDN. P5 holds.

### Family-level consistency — a gap the brief did not cover, found in testing

A gallery is ONE deliverable stored as a parent row plus a row per image; a variant set is ONE
deliverable stored as a primary plus a row per rendition. `perm` lived on each row independently
with nothing keeping a family in step, which showed up in the portal as **"as a guest I only see the
first item of a gallery"**: parent `public`, twelve children `client`, so the grid opened empty.

Made likely by Phase 0 itself. Insert-only `perm` plus a changed default means the new default
reaches only NEW rows — so a pipeline run created fresh children at `client` under existing parents
still holding `public`. Both halves were right individually; together they produce mixed families.

Resolved, per Petr, 2026-07-31 — different rules for the two relations, because they mean different
things:

- **Galleries (`parent_id`): hard inheritance, enforced in the database**
  (`20260731130000_gallery_perm_inheritance.sql`). A child's `perm` is forced to its parent's on
  insert and on update, and a parent's change cascades down. Neither write path needs to know:
  whatever the pipeline sends for a gallery child is replaced. Splitting a shoot's visibility means
  splitting it into two gallery folders — `Collection/` hidden, `Selection/` guest-facing — which
  the pipeline already treats as two parents. Consequence: the portal shows a gallery child's level
  read-only, with the reason, rather than offering a control that snaps back.
- **Variants (`variant_of`): soft default, in the portal write path.** A checkbox, **on by
  default** — "make this public" nearly always means the deliverable, not the one file on screen —
  and unchecking it is the deliberate rare case, e.g. an internal print master beside a public web
  version. A trigger cannot implement this, because the choice exists only at the moment of the
  edit. The pipeline complements it: a NEW rendition joining an EXISTING set inherits that set's
  level rather than the create-time default.

The reconciliation in that migration narrows each parent to its **strictest** child rather than
pushing the parent's level down. The literal reading of "children inherit" would have been the
widening direction, and that would mean a schema migration publishing twelve client photos to the
internet as a side effect. Narrowing only ever removes access, and one click in the portal now
widens a whole gallery deliberately.

`supabase/audit/perm_family_mismatch.sql` reports any family that still disagrees.

### Known limitation, accepted

Ephemeral `*.vercel.app` preview deployments cannot load gated objects — a cookie scoped to
`.disruptcollective.com` is never sent to `vercel.app`, and `SameSite=None` walks into
third-party-cookie blocking. Gated content is testable on `staging.hub.disruptcollective.com`.
This is a property of the cookie design, not a bug to chase.

### Staging is live and verified — 2026-07-31

`files-staging.disruptcollective.com` → `dc-hub-cdn-gate-staging` → `dc-hub-gated-staging`.
Both gated buckets exist with `dev-url` disabled and no custom domains (checked, not assumed).
Secrets set per environment, with a **different** `CDN_COOKIE_SECRET` in each so a staging cookie
cannot unlock production bytes. Production Worker and secrets exist but are **not deployed**.

Verified against the live deployment, anonymous:

| Request | Result |
|---|---|
| real gated object | **403** |
| gated key that does not exist | **403** — authorization runs before existence, so the gate does not leak what is there |
| `/`, `/nonsense/path`, unknown level, non-uuid client | **404** |
| `%2e%2e` traversal toward another level | **404** |
| `POST /auth` with no token | **401** |
| repeat GET | `x-cdn-gate: miss` then `hit` ×4 — the edge cache works on a custom domain |
| headers | `private, max-age=31536000, immutable`, ETag, **no `Vary: Cookie`** |
| `If-None-Match` | **304** |
| `bytes=0-99` / `100-` / `-50` / overrun | 206 with correct `Content-Range`, body byte-verified |
| multi-range | 200 full body (RFC 7233 permits ignoring a Range) |

**Two real bugs the live check caught, both fixed:**

1. **`Content-Range: bytes NaN-NaN/1500`.** The Worker read the served range back off
   `object.range`; the runtime does not populate it as the types imply. Body and `Content-Length`
   were correct, so only the header was wrong — the kind of fault that survives a smoke test and
   then stalls a video player. The Range header is now parsed in `authz.ts`, so one set of numbers
   drives both the fetch and the header, with unit tests that assert no input yields NaN.
2. **The cache key dropped the query string.** The pipeline writes one object per logical asset
   under a version-stable key, so a version bump OVERWRITES that key and `?v=<content-hash>` is
   the only thing distinguishing new bytes from old. Stripping it meant the edge would serve
   superseded bytes for a year. The key now includes the query, plus a `CACHE_EPOCH` segment to
   retire entries after a change to response *shape* — `immutable` entries survive a deploy, which
   is how the NaN header kept being served from cache after the fix.

### Still to confirm in a browser (P5, and the brief says confirm rather than assume)

Sign in at `staging.hub.disruptcollective.com` as staff, then devtools → Network:

- `POST files-staging…/auth` returns 200 and sets `dch_cdn`
- an `<img>`/fetch to `files-staging…` **sends** that cookie cross-subdomain
- `https://files-staging.disruptcollective.com/internal/8f3e1c2a-0000-4000-8000-000000000001/probe.txt`
  returns **200** signed in as staff (it is 403 signed out — probe object left in place for this).

### Latency budget — not yet measured

Cache behaviour is confirmed working on the custom domain; absolute numbers still to record here.

---

## Read this first — the library is world-readable today

Not a design gap. A live exposure, and it is the reason Part A exists.

Every pipeline export path hardcodes `perm: 'public'`:

| Location | Line |
|---|---|
| `desktop/src/services/supabase/exportPlan.ts` | `63`, `210`, `235` |
| `desktop/src/services/supabase/assetExport.ts` | `150` |

The Postgres column defaults to `'client'` (`supabase/migrations/20260711000000_baseline.sql:91`),
but the pipeline overrides it on every write. Combined with R2 objects served from a public
bucket domain, the practical position is:

> Every asset the pipeline has ever published is discoverable by anonymous portal visitors
> **and** fetchable by anyone holding the URL, regardless of intent.

Only `desktop/src/services/supabase/draftAssets.ts:63` writes something else
(`status: 'draft', perm: 'internal'`).

The stated intent is the opposite: **apart from thumbnails of genuinely public assets, almost
nothing should be world-readable.** Phase 0 fixes the default before anything else, because
every day the pipeline runs it publishes more rows at `perm: 'public'`.

Also accept, and communicate to Petr, that **URLs already leaked cannot be un-leaked.** Any
object currently reachable on the public domain stays reachable at that URL forever. Closing
the hole means giving objects *new keys* and treating everything published to date as
permanently public.

---

## Scope, in one paragraph

Introduce a four-level access model (`public` / `guest` / `client` / `internal`) enforced at
two layers: Postgres RLS decides who can *discover* an asset row, and a Cloudflare Worker in
front of R2 decides who can *fetch the bytes*. Truly public objects stay on the existing
public domain and never touch the Worker. Everything else moves behind the Worker, which
authorizes from a signed cookie plus the object key alone — no database call, no KV read — and
serves from the edge cache. Then, and only then, add Cloudflare Stream for video playback,
thumbnails and hover previews, with Stream's own signed URLs for anything not public.

## The model

Four levels, ordered. Numeric ranks are for the token comparison only; the strings are what
appear in the schema and the object key.

| # | Level | Who | Bytes served by |
|---|---|---|---|
| 0 | `public` | anyone with the URL | public domain, no Worker |
| 1 | `guest` | anyone signed in, including a `role='public'` profile created by email capture | Worker |
| 2 | `client` | members of that `client_id`, plus staff | Worker |
| 3 | `internal` | staff only — `is_staff()` is `role in ('editor','admin')` | Worker |

**Effective level, not raw perm.** `perm` says who may see it; `status` says where it is in
its lifecycle. They are independent axes and both gate bytes:

```
effective_level = (status in ('approved','published')) ? perm : 'internal'
```

So an asset marked `public` while still in `draft` serves to editors only. This is what keeps
unapproved work from leaking before sign-off, and it is computed at publish time so the object
key stays the single source of truth (see Performance contract, P2).

**Thumbnails inherit their asset's effective level.** A thumbnail is the content at lower
resolution; a public thumbnail of an internal or unapproved asset leaks the visual. This is the
same bug class as Stream's animated-preview frames in Part B. The consequence is that gallery
grids of gated content go through the Worker at 50+ requests per page view, which is precisely
why the performance contract below is mandatory rather than advisory.

---

## Starting facts (verified 2026-07-31)

| Fact | Where | Why it matters |
|---|---|---|
| Pipeline hardcodes `perm: 'public'` | `exportPlan.ts:63,210,235`; `assetExport.ts:150` | The exposure above. Phase 0. |
| RLS already implements three of four levels correctly | `baseline.sql:364-372` | `public` / `client` / `internal` policies exist and are right; only `guest` is new |
| `is_staff()` is `role in ('editor','admin')` | `baseline.sql:283-289` | Level 3 already means "editors and above" — no new role needed |
| `perm` CHECK constraint | `baseline.sql:91-92` — `check (perm in ('public','client','internal'))` | Must be widened for `guest` |
| `status` CHECK constraint | `baseline.sql:89-90` — `draft/review/approved/published/archived/disconnected` | Source for the effective-level rule |
| Cross-tenant reads already closed | `20260724120000_phase0_rls_tenant_isolation.sql` | Discovery layer is sound; do not re-litigate it |
| Object keys derive from folder identity | `cdnUpload.ts:122` (thumbnails), `:239` (originals), via `storageKey.ts:3` | Where the level segment gets inserted |
| Public URL construction, single seam | `r2Cache.ts:49` — `r2PublicUrl(publicDomain, objectKey, contentHash)` | One function to fork public vs gated hostname |
| `?v=<hash>` cache-busting already exists | `r2Cache.ts:49-53`, 12-char content hash | Reuse it — it is what makes `immutable` safe |
| Immutable caching already set on upload | `docs/pages/desktop/cdn.mdx:86` — `public, max-age=31536000, immutable` | Change `public` → `private` for gated objects |
| Portal download does a cross-origin `fetch` | `web/apps/client-hub/src/lib/assetActions.ts:17` | Needs `credentials: 'include'`; see P5 — current CORS `*` is incompatible with credentials |
| CORS is `AllowedOrigins: ["*"]` | `docs/pages/desktop/cdn.mdx:43-50` | Must become an explicit origin list once cookies are involved |
| Edge-function auth pattern to copy | `supabase/functions/r2-grant/index.ts` — session → role → `client_members` → 503 when unprovisioned | Reuse this shape exactly for token minting |
| Desktop grant client to copy | `desktop/src/services/supabase/r2Grant.ts` | Same call shape for any new function |
| Portal reads URLs straight from the row | `web/apps/client-hub/src/services/assetService.ts:56-58` | `thumbnail_url` / `download_url` / `download_urls`, `encodeURI`'d |
| Writes are consolidated | `exportWrite.ts:34-36` deletes null URL fields so a cached run cannot blank them | Do not add a second write path |
| Videos already reach R2, no extension filter | `runOriginalUpload`, `cdnUpload.ts:194` | Stream can copy from R2; no desktop upload plumbing needed |
| Video thumbnails don't exist | `generate_thumbnail` errors on unknown extensions, `desktop/src-tauri/src/lib.rs:86-101` | Nothing to migrate |
| Thumbnail step skips videos silently | `runCdnUpload` requires a `-thumb.webp` sidecar, `cdnUpload.ts:80` | Videos count as `skipped`, not errors |
| Portal has no video support at all | no `<video>`, no HLS in `web/apps/client-hub/src` | Player is greenfield |
| Obsidian thumb sets exclude video | `GALLERY_THUMB_EXTS` `dam/thumbs.ts:16`, `IMAGE_EXTS` `dam/scan.ts:25`, `THUMB_EXTS` `pipeline/naming.ts:46` | Three sets, not two — the old brief undercounted |
| Hover machinery exists | `features/gallery/MultiAssetHover.tsx` — `MAX_HOVER_TILES`, `AnimatePresence`, shimmer, `useReducedMotion` | Flipbook is new presentation on existing plumbing |

Library size: **13 videos, ~1 GB total, largest 380 MB** (12 ESS, 1 DC). Small enough that cost
is negligible; large enough that the 380 MB file rules out buffering a response body in the
Worker.

---

## Decisions already made — don't re-litigate

Settled with Petr on 2026-07-31.

1. **Gated Worker, not presigned URLs.** URLs stay permanent and pretty; the *session*
   expires, not the link. A leaked URL keeps working — it just returns 403 to anyone not
   signed in. Expiring URLs were explicitly rejected.
2. **Two byte-level tiers, four logical levels.** Infrastructure splits public/gated only.
   Level count is a policy concern and carries zero marginal infra cost.
3. **Thumbnails follow their asset's effective level.** No blanket-public thumbnail tier.
4. **`status` gates bytes independently of `perm`**, via the effective-level rule.
5. **Level is encoded in the object key**, accepting that a `perm` or `status` transition
   moves the object. Bought deliberately to keep reads lookup-free.
6. **Cookie-borne token, never a query-string token.** See P1 — this is a performance
   decision as much as an ergonomic one.
7. **R2 keeps original masters; Stream is added for playback.** Both, not either. Stream does
   not hold your master and cannot return it faithfully.
8. **Stream pulls from R2 by URL** — the desktop never streams bytes to Stream. But see the
   Part B note: once the bucket path is private, this must become a *signed* R2 URL.

---

## Performance contract — non-negotiable

The tool must stay fast enough to browse. These are requirements, not suggestions; each one
has a specific failure mode if skipped. Treat a violation as a failing test.

**Latency budget.** Measure against this, on a real custom domain (see P9):

| Path | Target added latency |
|---|---|
| Public tier (no Worker) | 0 — unchanged |
| Gated, browser cache hit | 0 — no network |
| Gated, edge cache hit | ≤ 1 ms auth, total comparable to public |
| Gated, cache miss → R2 | ≤ 1 ms + normal R2 fetch |
| Any per-request Supabase call | **forbidden** — costs 50–200 ms |

**P1 — Cookie auth, never a token in the query string.** A per-user token in the URL gives
every user a distinct cache key, fragmenting the cache to near-zero hit rate and defeating the
`?v=` immutability scheme. One cookie, identical URLs for everyone, one cached copy shared by
all authorized viewers.

**P2 — Zero lookups on the read path.** The Worker authorizes from the signed cookie plus the
object key. No database call, no KV read, no `await` except the R2 body. Key shape:

```
gated/{level}/{client_id}/thumbnails/{stableId}/{childId}.webp
gated/{level}/{client_id}/originals/{stableId}/{childId}{ext}
public/{client_id}/thumbnails/{stableId}/{childId}.webp
```

A 50-tile grid must cost 50 signature verifications, not 50 lookups. This is the single
biggest win in the whole design.

**P3 — Hoist the `CryptoKey` to module scope.** `crypto.subtle.importKey()` per request is
pure waste; isolates persist across requests. Import once at module top level.

**P4 — Cache gated bytes keyed by path only. Never `Vary: Cookie`.** Authorization is
per-request; the bytes are identical for everyone allowed to see them, so one cached entry
serves all of them. Adding `Vary: Cookie` fragments per-user and silently destroys the hit
rate. R2 accessed through a binding is **not** cached automatically — you must call
`cache.put()` explicitly, or use Workers Caching. Cache hits are billed as requests but
consume no CPU time.

**P5 — The gated hostname must be a sibling subdomain of the portal.** This is load-bearing
and easy to get wrong. `<img>` tags cannot pass `credentials: 'include'`, so the cookie is only
sent if the request is *same-site*. Portal on `hub.example.com` and gated CDN on
`cdn.example.com` with the cookie set `Domain=.example.com; SameSite=Lax; Secure; HttpOnly`
works. A portal on an unrelated domain (a `*.vercel.app`, say) does **not** — you would be
forced to `SameSite=None`, straight into third-party-cookie blocking. Confirm the production
portal hostname before writing the Worker.

**P6 — `Cache-Control: private, max-age=31536000, immutable` on gated responses.** `private`
keeps shared proxies out, `immutable` stops revalidation entirely, and the existing
`?v=<hash>` handles busting. Repeat grid views then cost zero network requests. Biggest
perceived-speed win available, and nearly free.

**P7 — Stream the body; support Range and ETag.** Return `object.body` directly — never buffer;
the largest asset is 380 MB. Pass `range` through to the R2 binding for video seeking and
resumable downloads, and honour `If-None-Match` via `onlyIf` so revalidation returns 304.

**P8 — Do not enable Smart Placement.** It moves the Worker toward an origin, which helps
DB-bound Workers. With P2 there is no database call, so the Worker belongs at the edge nearest
the user. Default placement is correct.

**P9 — Never benchmark on `workers.dev` or `r2.dev`.** The Cache API is a silent no-op on
`workers.dev`, and `r2.dev` supports no caching at all — which is what staging currently uses.
Both produce misleadingly slow numbers. Measure on a custom domain or route.

**P10 — Never cache an authorization outcome.** Cache bytes only, keyed by path. A 403 cached
under an object's URL will later be served to a user who *is* authorized.

---

## Verify before writing code (~1 hour)

- Production portal hostname and the gated CDN hostname share a registrable domain (P5). If
  not, stop and raise it — the cookie design depends on it.
- Workers Caching vs. the explicit Cache API: current guidance prefers Workers Caching for new
  Workers. Confirm which gives correct behaviour with an R2 binding and Range requests.
- Whether Cloudflare's cache key ignoring the hostname can collide your `public/` and `gated/`
  prefixes. Distinct prefixes should be sufficient; confirm.
- **Part B only:** the Stream copy-from-URL endpoint's behaviour with a *private* R2 object, and
  whether `requireSignedURLs` covers the still-thumbnail and animated-thumbnail endpoints. If
  it does not, "private" videos leak preview frames — a design problem, not a detail.
- **Part B only:** animated thumbnail format options and `fps`/`duration` limits (`fps=2` is the
  requested half-second-per-frame feel); still-thumbnail `time`/`height` params and whether a
  percentage offset is supported.
- Current Stream pricing per minute stored and delivered.

If any answer contradicts this document, the docs win — update this file.

## Open question for Petr

**Guest tier semantics.** Level 1 is email capture: the visitor supplies an address, gets a
`role='public'` profile and a level-1 token. Be explicit with Petr that this is *friction, not
protection* — anyone can type any address. Decide whether it needs email verification before
the token is issued, or whether an unverified address is acceptable for the material that will
live there. `check_email_auth(text)` is already granted to `anon` and may be reusable.

---

# Part A — gated delivery

## Phase 0 — stop the bleeding (~half a day)

- [ ] Change the pipeline's default from `perm: 'public'` to `perm: 'client'` at
      `exportPlan.ts:63`, `exportPlan.ts:210`, `exportPlan.ts:235`, `assetExport.ts:150`.
- [ ] Update `assetExport.characterization.test.ts:76` and any sibling fixtures asserting
      `perm: 'public'`; the characterization tests exist to catch exactly this, so expect
      failures and read each one before changing it.
- [ ] Add a regression test asserting no export path emits `perm: 'public'` unless explicitly
      set on the asset.
- [ ] Write a one-off audit query: count rows by `perm` and `status`, grouped by client. Hand
      the numbers to Petr — this is the "what is currently exposed" answer.
- [ ] Do **not** mass-rewrite existing rows yet. Decide with Petr which assets are genuinely
      public; the rest get re-keyed in Phase 4.

## Phase 1 — schema (~half a day)

- [ ] Migration: widen the `perm` CHECK to `('public','guest','client','internal')`.
- [ ] RLS policy for `guest`: readable by any authenticated user. Model it on the existing
      three at `baseline.sql:364-372`.
- [ ] Add a generated or trigger-maintained `effective_level` column on `public.assets`
      implementing the `perm`/`status` rule, so Postgres and the Worker cannot disagree. If
      generated, note `status` and `perm` are both plain columns so a `stored generated` column
      is viable.
- [ ] Extend the `assets` RLS so discovery honours `effective_level`, not raw `perm` — an
      unapproved public asset must not appear to anonymous visitors.
- [ ] `npm run db:types` (needs Docker); commit the regenerated
      `packages/database/src/database.types.ts`.
- [ ] `supabase db lint --level warning` clean; migration replays from zero via
      `supabase db reset`.
- [ ] Extend `supabase/tests/rls_tenant_isolation.test.sql` with guest-tier and
      unapproved-asset cases.

## Phase 2 — token minting (~1 day)

- [ ] Edge function `supabase/functions/cdn-token/`, modelled on `r2-grant/index.ts`: same auth
      chain, same explicit 503 when unprovisioned. Resolves the caller's level and `client_id`.
- [ ] Mint an HS256 JWT with `{ user_id, level, client_id, is_staff, exp }`. Short TTL —
      15–60 min. Shared secret in function secrets *and* Worker secrets; add to
      `supabase/functions/.env` and `.env.example`.
- [ ] Set it as `Domain=.{root}; SameSite=Lax; Secure; HttpOnly; Path=/` (P5).
- [ ] Portal refreshes the cookie on login and on a timer comfortably inside its TTL. A grid
      that 403s mid-scroll because the cookie lapsed is the failure mode to avoid.
- [ ] Unit-test the level resolution against every role × perm × status combination.

## Phase 3 — the Worker (~2–3 days)

- [ ] New `workers/cdn-gate/` with Wrangler config, R2 binding, and the JWT secret.
- [ ] Route only `gated/*` (or the gated hostname) to the Worker. Public objects must not
      invoke it at all (P2, and it keeps the public tier at exactly today's speed).
- [ ] Verify the cookie signature with the module-scope `CryptoKey` (P3). Reject unsigned,
      expired, malformed.
- [ ] Parse `{level}` and `{client_id}` from the key and apply: `public` → allow;
      `guest` → any valid token; `client` → `token.client_id === path.client_id || is_staff`;
      `internal` → `is_staff`. No I/O (P2).
- [ ] Serve from cache before R2, keyed by path only, no `Vary: Cookie` (P4). Never cache the
      403 (P10).
- [ ] Set `Cache-Control: private, max-age=31536000, immutable` (P6).
- [ ] Stream `object.body`; implement Range and `If-None-Match`/304 (P7).
- [ ] CORS: explicit origin allowlist plus `Access-Control-Allow-Credentials: true`. `*` is
      invalid with credentials — this will fail silently in the browser if wrong.
- [ ] Confirm Smart Placement is off (P8).
- [ ] Tests: each level × each role, expired token, absent token, forged signature, wrong
      `client_id`, Range request, conditional request, cache hit and miss.
- [ ] Benchmark on a custom domain (P9) against the latency budget. Record the numbers in this
      file.

## Phase 4 — re-key and cut over (~1–2 days)

- [ ] Fork `r2PublicUrl` (`r2Cache.ts:49`) into public-domain and gated-hostname variants,
      keeping `?v=<hash>` in both.
- [ ] Insert the level segment into key construction at `cdnUpload.ts:122` and `:239`, via
      `storageKey.ts`.
- [ ] Teach `runCdnUpload`/`runOriginalUpload` to write `private, max-age=31536000, immutable`
      for gated objects and leave public objects as they are.
- [ ] One-off migration script: for every asset, compute `effective_level`, copy the object to
      its new key, update `thumbnail_url`/`download_url`, delete the old object. Idempotent and
      resumable — assume it will be interrupted.
- [ ] Handle `download_urls` (the cloud-storage JSON array) — decide whether those third-party
      links are in scope or explicitly out, and write the answer down.
- [ ] A `perm`/`status` mover: when either changes, move the object to its new level path and
      update the row. Reuse the existing `changePerm` seam
      (`web/apps/client-hub/src/services/assetService.ts:247-251`); run it in the background,
      idempotently.
- [ ] Update `assetActions.ts:17` to `credentials: 'include'`.
- [ ] Verify `<img>` loads in the grid actually carry the cookie — open devtools and confirm,
      do not assume (P5).
- [ ] Reconcile with the existing `r2-upload-cache.json` dedupe so a re-run after re-keying
      does not re-upload the library.

## Phase 5 — guest tier and admin surface (~1 day)

- [ ] Add `guest` to `PERM_OPTIONS` (`features/gallery/assetOptions.ts:18`) and the selector in
      `panels/AssetStatusPanel.tsx`.
- [ ] Email-capture flow issuing a `role='public'` profile, per the open question above.
- [ ] Update the comments in `assetOptions.ts:3` and `hooks/useAssetLifecycle.ts:3` that
      enumerate the levels — they currently describe three.
- [ ] Docs: rewrite `docs/pages/cloud-storage/security.mdx` and the warning at
      `docs/pages/desktop/cdn.mdx:5`, which both currently state that no private delivery layer
      exists. Add a page describing the four levels, the effective-level rule, and the
      performance contract.
- [ ] Update `CLAUDE.md` — its storage/delivery section says private protection is not
      implemented.

---

# Part B — video on Cloudflare Stream

## Findings, 2026-08-02 — answers to the "verify before writing code" list

**Scope confirmed with Petr: FULL Stream** — playback, thumbnails and hover previews. The
alternative was tempting and was considered: the cdn-gate Worker now serves Range requests, honours
ETags and streams bodies without buffering, so a plain `<video>` pointed at the gate already plays a
380 MB file with seeking. Stream is taken for adaptive bitrate and for the previews, not because
playback is otherwise impossible.

**The real problem, measured.** Production holds **10 videos and 9 of them have no thumbnail** —
blank cards in the portal. Staging has 2, one blank. `generate_thumbnail` errors on unknown
extensions, so `runCdnUpload` counts videos as `skipped` and the row keeps a null `thumbnail_url`.

### The three extension sets — do NOT change all three

The brief says to add video extensions to `GALLERY_THUMB_EXTS`, `IMAGE_EXTS` and `THUMB_EXTS`, and
to confirm which actually need it. Confirmed, and the answer is that one of them must be left alone.
(All three moved: they are in `desktop/src/services/`, not `packages/domain/src/`.)

| Set | Where | Drives | Add video? |
|---|---|---|---|
| `THUMB_EXTS` | `pipeline/naming.ts:46` | which files `runThumbnails` hands to the Rust `generate_thumbnail` | **NO** |
| `GALLERY_THUMB_EXTS` | `dam/thumbs.ts:16` | which files get a thumbnail in the Obsidian vault gallery | yes, once a URL exists |
| `IMAGE_EXTS` | `dam/scan.ts:25` | whether a folder counts as a gallery (`isGalleryFolder`) | only if video galleries are wanted — a product call |

`THUMB_EXTS` is the trap. It feeds the LOCAL generator, which cannot decode video — that is why
videos have no thumbnails today. Adding video extensions there does not produce thumbnails, it
produces an error per video on every run. Stream generates the frame remotely; the pipeline stores
a URL rather than generating a file.

### Does `requireSignedURLs` cover thumbnails? — YES. Tested 2026-08-02.

This was the one that could have undermined Part A for video. The docs disagreed with themselves:
the **thumbnails** page said *"If signed URLs are required, you must use a signed URL instead of
video UIDs"*, while **securing-your-stream** enumerated what is protected — manifests, the iframe
player, MP4 downloads — and did not mention thumbnails at all. Not good enough to bet a client's
confidentiality on, so it was measured rather than assumed.

**Method.** A throwaway video was uploaded to the production Stream account, `requireSignedURLs`
was set to `true`, and every delivery endpoint was fetched **unsigned**. Then the same endpoints
were fetched on a video with the flag `false` (the pre-existing `Top Coating.mp4`) as a control,
to prove the URLs were well-formed and that a 401 meant the flag and not a typo. Then a token was
minted and the endpoints re-fetched signed. The probe video was deleted afterwards; the account is
back to its one pre-existing video.

| endpoint | unsigned, flag ON | unsigned, flag OFF (control) | signed |
|---|---|---|---|
| `thumbnails/thumbnail.jpg` | **401** | 200 · 1651 B JPEG | **200 · 13826 B** |
| `thumbnails/thumbnail.gif` | **401** | 200 · 96808 B GIF | **200 · 2.7 MB** |
| `thumbnails/thumbnail.jpg?time=2s&height=600` | **401** | — | — |
| `manifest/video.m3u8` | **401** | 200 · 1633 B | **200 · 987 B** |
| `downloads/default.mp4` | **401** | — | — |
| `iframe` | **401** | — | — |

**Conclusion: thumbnails are protected exactly like playback.** Stills, animated previews, and
parameterised variants all 401 without a token. Gated videos do not leak preview frames, and
Stream thumbnails are safe to use at every access level. Part B proceeds as designed.

**Two mechanics worth writing down, both learned the hard way:**

1. **`requireSignedURLs` does NOT take effect as an upload form field.** Passing it in the
   multipart POST that creates the video is silently ignored — the video comes back
   `requireSignedURLs: false`. It must be set by a **separate `POST /stream/{uid}`** with a JSON
   body afterwards. So `stream-upload` cannot treat "uploaded" as "protected": it has to set the
   flag as its own step and **verify the response says `true`** before recording the `stream_uid`.
   A video that is live but unflagged is exactly the leak this test was checking for.
2. **The token replaces the UID in the path** — `customer-<CODE>.cloudflarestream.com/<TOKEN>/
   thumbnails/thumbnail.jpg`, not a query parameter. The same token opens playback, stills and
   animated previews, so one mint serves a whole card. Tokens are ~581 characters, which matters
   for a grid: a hundred thumbnails means a hundred long URLs, so mint per-view and cache, do not
   mint per-`<img>`. `POST /stream/{uid}/token` with an `exp` mints one without a signing key.

**Copying from a URL requires an unauthenticated, range-capable source.** `POST /stream/copy`
failed with *"Performed a HTTP HEAD and HTTP GET range request, could not determine the size of
the file"* against a source that would not serve ranges. Our gated R2 objects are behind the
Worker and reject anonymous requests, which is the whole point of Part A — so the plan below
(mint a short-lived **presigned R2 URL** for Stream to pull from, never hand it a gated URL) is
the right shape.

**A range GET is enough; HEAD is not required.** Worth stating precisely, because R2 binds a
presigned URL to the method it was signed for — measured on staging, in both directions:

| | `HEAD` | range `GET` |
|---|---|---|
| signed as `GET` | **403** | 206 · `Content-Range: bytes 0-9/359046` |
| signed as `HEAD` | 200 · `Content-Length: 359046` | **403** |

So one presigned URL cannot answer both, and the obvious reading of Stream's error — "it needs
HEAD, therefore this approach is impossible" — is wrong. The range response carries the total
size, which is all Stream is after. Confirmed by handing `POST /stream/copy` a GET-only presigned
staging object: it returned 200 and went to `downloading`. That probe was deleted.

### Thumbnail parameters, confirmed from the docs

| | still `.jpg` | animated `.gif` |
|---|---|---|
| `time` | default `0s` | default `0s` |
| `height` / `width` | default `640` | default `640` |
| `fit` | `crop` (default), `clip`, `scale`, `fill` | same |
| `duration` | — | default `5s` |
| `fps` | — | default `8` |

`time` accepts a percentage as well as a duration, which is what a poster frame wants — `time=50%`
picks the midpoint without knowing the video's length.

### Blocked on

1. **Stream enabled on the Cloudflare account.** The API answers 403 to the R2 token, which is
   R2-scoped, so whether Stream is provisioned at all is unknown from here.
2. **A token with `Stream:Edit`.** Neither `CF_R2_TOKEN` nor `CF_WORKERS_TOKEN` carries it. Name it
   `CF_STREAM_TOKEN`, matching the scheme.

---


Pick up only once Part A is live. Goal: videos in a client library get uploaded to Stream for
playback, get automatic thumbnails, and show a short frame preview on hover.

**Ingestion changed because of Part A.** The original brief had Stream copy from the R2
*public* URL. Once originals sit behind the Worker that no longer works — Stream cannot read a
gated object. The `stream-upload` function must mint a short-lived **signed R2 URL** for Stream
to pull from. This is the one place where an expiring URL is correct: it is server-to-server,
never seen by a user.

## Phase 6 — plumbing (~1 day) — DONE 2026-08-03, commit 28e779b

- [x] Migration: add `stream_uid text` and `stream_status text` to `public.assets`, nullable.
      No backfill shim, no dual path. Then `npm run db:types` and commit the regenerated types.
- [x] Edge function `supabase/functions/stream-upload/`, modelled on `r2-grant`: same auth
      chain, same 503-when-unprovisioned. Input `client_id`, asset identity. Output
      `stream_uid` + status. Secrets into `.env` and `.env.example`.
- [x] Mint the presigned R2 ingestion URL inside that function; never hand Stream a gated URL.
      It **must answer a range `GET`** — that is where Stream reads the size from. HEAD is
      attempted and may 403; R2 binds a presigned URL to one method (table above). Verified
      end to end against staging.
- [x] Set `requireSignedURLs` on any video whose `effective_level != 'public'` — as **its own
      `POST /stream/{uid}` after upload, and assert the response says `true`**. The field is
      silently ignored when passed in the upload form (measured). Treating "uploaded" as
      "protected" is precisely the leak this was tested for, so it fails loudly instead.
- [x] **Reconcile the flag when the level changes.** This is the R2 re-keying problem again: the
      level is baked into the delivery object, so `perm`/`status` edits must propagate. Cheaper
      here — one POST, no bytes move — and `cdn_move_queue` already fires on exactly this
      condition, so `cdn-reconcile` should flip `requireSignedURLs` alongside moving the key.
      Without it, a video demoted `public` → `client` keeps serving to anyone holding the UID.
- [x] `requestStreamUpload` in `desktop/src/services/supabase/`, mirroring `r2Grant.ts`
      including its gateway-vs-refusal error split, so a dead edge runtime reads as unreachable
      rather than misconfigured.

**Found while building it — Stream has no environment separation.** Staging and production share
one Cloudflare account (`db6804f8…`) and one `CF_STREAM_TOKEN`. R2 gets two buckets per
environment; Stream gets nothing equivalent, so both environments' videos sit in one list and are
indistinguishable by eye. Every video is therefore tagged `meta.project_ref` with the Supabase ref
of the database that owns it — derived from `SUPABASE_URL`, never configured, so it cannot drift
from the database it names. **Any future cleanup script must filter on it**; a naive "delete the
staging videos" would otherwise take production's with them.

**Manual step before this works:** `CF_STREAM_TOKEN` is a THIRD Cloudflare token (Stream:Edit) and
is currently only in the local `scripts/environments/*.env`. It has to be set as a Supabase
function secret on both projects:

```
supabase secrets set CF_STREAM_TOKEN=<value> --project-ref <staging-ref>
supabase secrets set CF_STREAM_TOKEN=<value> --project-ref <production-ref>
```

Until it is set, `stream-upload` returns 503 (explicitly "not provisioned", never a silent skip),
and `cdn-reconcile` keeps re-keying images normally — it only needs the token once videos exist,
and refuses to mark a video reconciled it could not verify.

## Phase 7 — pipeline (~1 day) — DONE 2026-08-03

Three items landed differently from how they were written here. The plan was drafted before the
export path had been read; the reasons are below rather than in a commit nobody will find.

- [x] ~~In or just after `runOriginalUpload`~~ **After the Supabase export**, in `syncRunToPortal`.
      `stream-upload` attaches a video to an asset ROW and reads the master's location off it, and
      a brand-new asset has no row until the export creates it. Placed after `reconcileCdnObjects`
      too, so the master is already at the key its access level requires rather than one about to
      move.
- [x] ~~Extend `r2-upload-cache.json`~~ **`assets.stream_source_hash`**, a column. The local cache
      is per-machine, so a second editor's run would see no record of an upload and redo it; and
      the cache is keyed by R2 object, which is the wrong grain — this question is about an asset.
      The hash is already in `download_url`'s `?v=`, so the check costs a string comparison.
- [x] Transcoding is async — nothing blocks. Statuses land as `queued`/`inprogress` and the portal
      flips them to `ready`.
- [x] ~~Write through `exportPlan.ts` → `exportWrite.ts`~~ **the edge function writes it itself**,
      which is still one write path, just not that one. Creating the video and recording it must
      be one operation: the function deletes the video if the write fails, because a video nothing
      references still serves and still bills. Routing it back through the export would put a
      process boundary in the middle of that. Nothing is lost — the export uses PATCH semantics
      and never touches columns it does not know about, so a run cannot null these.
- [x] The three extension sets — **only one of them wanted changing**, and it was not the one this
      plan predicted:
      - `IMAGE_EXTS` (`dam/scan.ts`) — **changed**, via a separate `isVideoFile` test rather than
        by adding video to a set named "image". A folder of cuts is as much a gallery as a folder
        of stills, and before this it got no vault note at all.
      - `GALLERY_THUMB_EXTS` (`dam/thumbs.ts`) — **left alone; adding video is a regression.** It
        picks ONE file alphabetically to represent the folder and asks Rust to render it. Rust
        cannot decode video, so a mixed folder starting with `A-roll.mp4` would stop producing the
        still it produces today. Stream could render one, but only behind a signed URL that
        expires, and a markdown note is static — it has nowhere to put a token.
      - `THUMB_EXTS` (`pipeline/naming.ts`) — **left alone.** Adding video would not produce
        thumbnails, it would produce one Rust error per video per run.

The stage asks the DATABASE which videos need work, not the run. A video missed earlier — crash,
token not yet set, Stream down — is picked up by the next run without anyone noticing it was
missed. Scoping to files touched this run would make a miss permanent.

## Phase 8 — portal playback (~1 day) — DONE 2026-08-03, commit 52e308f

- [x] Player in `AssetDetail`. Stream's iframe embed is the zero-effort option; hls.js only if
      custom controls are wanted.
- [x] Mint Stream playback tokens in the same place as the CDN cookie, for
      `effective_level != 'public'`.
- [x] Build the still-thumbnail URL from `stream_uid` wherever `thumbnailUrl` is used today, so
      video cards stop being blank. Keep the `stream_status !== 'ready'` fallback — reuse the
      existing shimmer.
- [x] **Sign thumbnail URLs too — required, now confirmed.** Thumbnails 401 without a token
      (measured 2026-08-02, table above), so a gated video's card is blank unless its stills and
      previews carry one. The token replaces the UID in the path. **One token per view, not per
      `<img>`:** they are ~581 characters and a grid holds a hundred cards.

**Two things worth carrying into Phase 9.**

`VITE_STREAM_DOMAIN` needs **nothing done in Vercel** — `scripts/vercel-build.mjs` reads the
committed `.env.<mode>` file and forces those values over the dashboard's, deliberately, so a stale
Vercel variable cannot point staging at production Auth. Adding it to `.env.staging` and
`.env.production` is the whole job. (Unset would not have been a failure either: delivery falls
back to `videodelivery.net`, account-agnostic and checked against a real video on this account.)

The value is the account's Stream subdomain, `customer-<code>.cloudflarestream.com` — visible in
the embed code of any video in **Cloudflare dashboard -> Stream**, and in the `thumbnail` field of
any `GET /accounts/{id}/stream` response.

`CF_STREAM_TOKEN` is now needed by a second function, `stream-token`. It is already set on both
projects, so nothing to do; noted because a future project will need it before video works there.

## Phase 9 — hover preview (~half a day) — DONE 2026-08-03

- [x] Start with Stream's animated thumbnail: one `<img>` swapped in on hover, `fps=2`, wired
      into the hover state already in `MultiAssetHover`/`GalleryView`.
- [x] Lazy-load on first hover — never eagerly for a whole grid.
- [x] Hold a static frame when `useReducedMotion()` is true. The codebase is consistent about
      this and an auto-playing preview is exactly what that rule is for.
- [ ] **Still open, deliberately:** only if GIF quality disappoints — N stills at computed
      timestamps stepped by an interval. Not judged yet, because that needs real client footage
      rather than a test clip. Same hover plumbing, ~1 day. A sprite sheet would be better but
      needs local ffmpeg — see "Do not do this".

**Measured, because the size is the whole design constraint.** The same 5-second preview came
back at **2.7 MB** for a detailed clip at Stream's defaults and **37 KB** for a simple one at
`fps=2, height=480` — two orders of magnitude, decided entirely by the footage. A grid that loaded
them eagerly would look fine against a test library and fall over on a real shoot, which is why the
`<img>` is not rendered until a card has been hovered once. It stays mounted afterwards and only
fades, so returning to a card is instant off the browser cache.

The last item stays open on purpose: **GIF quality has not been judged against real client footage
yet.** The N-stills fallback is still the right escalation if it disappoints, and nothing here
blocks it — it reuses the same hover plumbing.

Also added, not in the plan: a play marker on video cards. Without one a video is indistinguishable
from an image until it is opened, which made the new stills read as ordinary photographs.

---

## Do not do this

**Don't proxy video segments through the Worker.** Stream serves from its own domain with its
own CDN and adaptive bitrate. HLS playback is 100–300 segment requests per view; routing that
through your Worker adds latency and cost for no benefit. Stream's signed URLs are the correct
seam.

**Don't put the token in a query string.** See P1. It fragments the cache per-user and
undoes P6.

**Don't add a per-request database or KV lookup to the Worker.** See P2. It is the one change
that would make the tool feel slow, and it is easy to add by accident when a new requirement
arrives.

**Don't add local video decoding.** It means bundling ffmpeg as a Tauri sidecar: binary size,
per-platform packaging, licensing review. Most expensive item on the list, and Stream removes
the need. If offline thumbnails are ever truly needed, raise it as its own work with Petr.

**Don't reintroduce filename-keyed lookups.** v3.0.0 deleted the shortcode identity path and
the stem-keyed maps that silently dropped assets when two packages held the same filename.
Anything new keys on `stable_id` + `child_id`. See `CHANGELOG.md` 3.0.0 and
`desktop/src/domain/assetGrouping.test.ts` for the regressions that guard this.

**Don't assume a leaked URL can be revoked.** It cannot. Re-keying is the only remedy.

---

## Definition of done

**Part A**

- No export path writes `perm: 'public'` by default; the audit query's numbers are recorded and
  reviewed with Petr.
- An anonymous request to a `client`-level object's URL returns 403. Signed in as a member of
  that client, the same URL returns the bytes.
- A member of client A cannot fetch client B's object even with the exact URL.
- An asset in `draft` marked `perm: 'public'` serves only to editors, and does not appear to
  anonymous visitors in the portal.
- A `perm` change moves the object and the old key 404s.
- Grid browsing of gated content meets the latency budget on a custom domain, with numbers
  recorded in this file. Second view of a grid issues zero network requests for thumbnails.
- Cookie is verified present on `<img>` requests in devtools, not assumed.
- `docs/` and `CLAUDE.md` no longer claim private delivery is unimplemented.

**Part B**

- A video in a client's `OUT` folder ends up in R2 originals (download), on Stream (playback),
  with a working thumbnail in the portal grid and in its Obsidian note.
- A gated video's playback URL **and** its thumbnail/preview URLs both refuse an
  unauthenticated request.
- Hovering a video card plays a short frame preview; reduced-motion holds a still.
- Re-running the pipeline changes nothing — no re-upload, no new `stream_uid` — and renaming
  the file keeps the same Stream asset and DB row.
- A video whose folder lacks a ` __<hash>` suffix is reported and skipped, matching how R2
  uploads already behave.

**Both**

- `npm run check` + `npm test` clean; migrations replay from zero via `supabase db reset`;
  `supabase db lint --level warning` clean.

---

## Testing notes

There's a working pattern for integration tests against the local stack in
`desktop/src/services/supabaseSync.integration.test.ts`: mock `@tauri-apps/api/core` to
delegate `invoke` to real `fetch`, mock `authService`'s token with the seeded local admin
(`admin@acme.test` / `dchub-local`), and let the test hit `127.0.0.1:54321`. It self-skips when
the stack is down so CI stays green. Reuse it for `cdn-token` and `requestStreamUpload`.

Worker tests want Miniflare/`wrangler dev` with a local R2 binding. Remember the Cache API is a
no-op on `workers.dev` (P9) — assert caching behaviour against a local or custom-domain
deployment, or the tests will pass while telling you nothing.

If CDN steps fail locally with a gateway error, the edge runtime container has no restart
policy and has died silently before: `docker start supabase_edge_runtime_dc-hub`.

## Estimate

| | |
|---|---|
| Part A (Phases 0–5) | 6–9 days |
| Part B (Phases 6–9) | 3.5 days |
| **Total** | **~10–13 days** |

Running cost of the gate itself is the $5/month Workers Paid subscription; at this library's
scale everything else stays inside R2 and Workers free allowances. Stream delivery is the only
line item that scales with use.
