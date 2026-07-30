# DC Hub — Codebase Audit, SWOT & Bulletproofing Refactor Plan

_Prepared 2026-07-24. Based on a direct read of the repository at `/Users/petrmucha/Sites/localhost/dc-hub` (branch `fix/packages-export`). Focus: functionality and technical hardening._

---

## 1. Executive summary

DC Hub is a well-conceived, monorepo digital-asset pipeline: a Tauri 2 + React desktop app that scans, transforms and publishes assets; a React/Vite Supabase-backed client portal; a Supabase database with edge functions; and a Nextra docs site. The architecture is coherent and the _domain thinking_ is unusually mature — the folder-based stable-identity design is a real differentiator and is cleanly implemented.

The gap between the current state and "bulletproof" is **not architecture — it is verification and containment**. Two of ~21,000 lines of TypeScript are covered by tests. Business logic is concentrated in a handful of 1,000–1,800-line service files. There is no linter. Error handling swallows failures into `console`. And there is at least one concrete multi-tenant data-leak in the database policies. None of these are hard to fix; together they are what stands between "works on David's machine" and "safe to put in front of paying clients."

**The three things that matter most, in order:**

1. **Close the cross-tenant RLS leak** on `ratings`, `comments`, `approvals`, `activity`, and `clients` (Section 6 / Phase 0). This is a security bug, not tech debt.
2. **Get the core pipeline and identity logic under test** before refactoring anything (Phase 1). You cannot safely decompose the god-files without a safety net.
3. **Decompose the four god-files and unify the desktop/web data layer** (Phases 2–3).

---

## 2. Codebase map

| Area                    | Stack                       | Source LOC      | Notes                                                            |
| ----------------------- | --------------------------- | --------------- | ---------------------------------------------------------------- |
| `desktop/src`           | React + TS (Tauri frontend) | ~10,800 TS/TSX  | Feature-sliced (`features/`, `services/`, `domain/`, `store/`)   |
| `desktop/src-tauri/src` | Rust                        | ~1,300          | 6 modules, 13 `#[tauri::command]`s, only 2 `unwrap/expect/panic` |
| `web/apps/client-hub`   | React + Vite + Supabase     | ~8,700 TS/TSX   | Client portal, 11 services, role/auth contexts                   |
| `web/packages/*`        | TS libs                     | (in above)      | `asset-library` + `database` shared packages exist               |
| `supabase/migrations`   | SQL                         | ~730 (10 files) | 12 tables, RLS enabled, thoughtful policies                      |
| `supabase/functions`    | Deno/TS                     | 3 functions     | `admin-create-user`, `r2-grant`, `r2-branding-upload`            |
| `docs`                  | Nextra/MDX                  | —               | Genuinely maintained developer docs                              |
| `scripts`               | Node `.mjs`                 | —               | env bootstrap, dev orchestration, versioning                     |

**Stack:** Tauri 2, React, TypeScript (strict), Rust, Supabase (Postgres + RLS + Edge Functions), Cloudflare R2 CDN, Vite, Nextra. One shared release version across the monorepo.

---

## 3. Functionality audit

### What exists and works

- **Asset pipeline** (`pipelineService.ts`, 1,846 LOC): scans folders, filters by include/exclude marks, resolves highest versions, translates filenames via vocabulary, publishes to local/cloud/CDN targets, generates thumbnails via Rust. This is the heart of the product and is feature-complete.
- **Folder-based stable identity** (`domain/stableId.ts`): clean, small, single-source-of-truth regex (`ID_SUFFIX_PATTERN`). Exactly the fragility fix the design called for. **This is the strongest code in the repo.**
- **Filename/vocabulary translation** (`domain/filenameTranslator.ts`, `naming.ts`): three-dimension taxonomy, tag inheritance, tolerant folder-marker matching. Has tests.
- **Cloud + CDN** (`cloudService.ts`, `src-tauri/r2.rs`): Dropbox/OneDrive/GDrive upload, R2 publishing with cache-busting, credential grant via edge function.
- **Client portal**: gallery, asset detail, lightbox, multi-asset hover, ratings/comments/approvals, activity feed, admin (users, tags, destinations, branding), role + domain-whitelist auth.
- **Identity migration tooling** (`desktop/scripts/migrate-identity.ts`): dry-run-gated, matches existing records rather than recreating.
- **Ops**: 4 CI workflows, migration replay validation, staged deploys with production approval gate. **Better than typical for a project this size.**

### Functional gaps / risks

- **No automated verification of the pipeline's most destructive operations** (package mirror wipes, OUT cleanup, R2 publishing). The recent git history (`fix: package OUT mirror cleanup`, `wipe target mirrors`, `restore package collect on migrated clients`) shows this area churns and regresses — exactly where tests are absent.
- **Desktop and web reimplement the same domain** (both have a `clientService`; desktop has a 1,693-LOC `supabaseService`). No code is shared between them — `desktop/src` imports nothing from `web/packages`. Divergence risk on every schema change.
- **Stale-asset detection**: memory notes R2 auto-deletion was deemed too destructive; confirm the "surface for confirmation" path is actually implemented, not just planned.
- **Anonymous portal writes**: `asset_events` allows `insert with check (true)` — intended for view/download counters, but unbounded anonymous insert is a spam/abuse vector.

---

## 4. Technical health scorecard

_Snapshot as measured 2026-07-24. Phases 0–1 (see §7) have since closed four rows:
**Linting** (ESLint gate, 0 errors / 0 warnings), **Database security** (F-1 fixed, deployed,
and now covered by 41 pgTAP tests), the `console`-swallowing half of **Error handling** (all
bare `console.error` sites route through `reportError`, CI-enforced), and **Test coverage**
(27 → 474 tests: 371 TS, 43 Rust, 60 pgTAP; no e2e yet).
Phase 1 surfaced three real defects — F-4/F-5/F-6 — all since fixed; see §7. Phase 2b has also
closed the largest **File size / modularity** hotspot: `pipelineService` 1,894 → 92 lines plus 12
stage modules, none over 400._

| Dimension              | State                          | Evidence                                                                                                                           |
| ---------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Type safety            | **Good**                       | `strict: true` in desktop + web; only 21 `any`, 3 `@ts-ignore`                                                                     |
| Test coverage          | **Critical gap**               | 2 test files total; 0 web tests, 0 Rust tests, 0 e2e, 0 RLS tests                                                                  |
| Linting                | **Missing**                    | No eslint/prettier/biome config anywhere                                                                                           |
| Error handling         | **Weak**                       | 195 `catch` blocks; 33 only `console`; 79 raw `console.*`; no structured logging/telemetry                                         |
| File size / modularity | **Poor in hotspots**           | `pipelineService` 1,846, `supabaseService` 1,693, `AdminLandingPage` 1,255, `damService` 978, `AssetDetail` 901, `GalleryView` 766 |
| Secrets hygiene        | **Good**                       | `.env`/`staging.env` gitignored; only anon keys tracked; explicit guard rejecting `service_role` key entry                         |
| Database security      | **Mostly good, one real leak** | RLS enabled on all 12 tables; per-permission asset policies; **but cross-tenant read leak on metadata tables** (Section 6)         |
| CI/CD                  | **Good**                       | check + test + rust check gating; migration replay; staged deploy w/ prod approval                                                 |
| Rust safety            | **Good**                       | Only 2 `unwrap/expect/panic` across 1,300 LOC                                                                                      |
| Code duplication       | **Moderate**                   | Desktop/web siloed; two type sources; overlapping services                                                                         |
| TODO debt              | **Clean**                      | 0 TODO/FIXME/HACK markers                                                                                                          |

---

## 5. SWOT analysis (functionality & technical)

### Strengths

- **Sound, differentiated architecture.** Bring-your-own-storage model and folder-based stable identity are deliberate, well-reasoned, and correctly implemented (`stableId.ts` is exemplary).
- **Clean domain layer.** Small, pure, single-responsibility modules in `desktop/src/domain` — easy to test and reason about.
- **TypeScript strict everywhere**, minimal escape hatches. Rust code is panic-averse.
- **Mature ops for the project's age**: replayable migrations, RLS on every table, staged deploys with a production approval gate, maintained docs, single-version monorepo discipline.
- **Good secrets discipline**: browser-safe keys only in git, active guard against pasting the service-role key.
- **Zero TODO/FIXME debt** — the team closes loops rather than leaving markers.

### Weaknesses

- **Almost no test coverage** (2 files / ~21k LOC). The most destructive code paths (mirror wipes, publishing) are untested and demonstrably regression-prone per git history.
- **God-files** concentrate risk: four files carry the bulk of business logic; changes there are high-blast-radius.
- **No linter / formatting standard** — style and correctness drift go uncaught.
- **Error handling swallows failures** into `console`; no structured logging, no user-facing error taxonomy, no telemetry.
- **Desktop and web duplicate domain logic** with no shared code, guaranteeing divergence on schema change.
- **One concrete multi-tenant data leak** in RLS (see Threats / Section 6).

### Opportunities

- **Extract a shared `@dc-hub/core` package** (identity, naming, taxonomy, Supabase types + data access) consumed by both desktop and web — kills duplication and the divergence risk in one move. The `web/packages` scaffold already proves the pattern.
- **Characterization tests + fixtures** for the pipeline turn the biggest liability into the biggest confidence gain, and make the god-file decomposition safe.
- **RLS policy tests** (pgTAP or seeded integration tests) make multi-tenant isolation a _proven_ property, which is a sellable trust signal for an agency-client product.
- **Structured logging + error boundaries** convert silent failures into diagnosable events — directly reduces the "works on my machine" support burden.

### Threats

- **Cross-tenant metadata leak (active security bug).** `ratings`, `comments`, `approvals`, `activity` are readable by _any_ authenticated user (`auth.role() = 'authenticated'`), and `clients` is fully readable by any authenticated user. A client user can enumerate other clients and read comments/ratings/approvals on assets they shouldn't see, including on `internal` assets. **Fix before any external client onboards.**
- **Regression risk in publishing** without tests — a bad mirror-wipe or version-filter change can destroy or mis-publish client deliverables. This is a data-loss, not just a UX, risk.
- **Unbounded anonymous `asset_events` inserts** — spam/abuse and skewed analytics.
- **Key-person / single-maintainer risk** amplified by god-files and thin tests: onboarding or handoff is hard, and the safety net to catch a new contributor's mistake doesn't exist yet.

---

## 6. Security findings (detail)

**F-1 (High) — Cross-tenant read leak on metadata tables.** `baseline.sql` policies:

create policy "ratings: authenticated can read"   on public.ratings   for select using (auth.role() = 'authenticated');  
create policy "comments: authenticated can read"  on public.comments  for select using (auth.role() = 'authenticated');  
create policy "approvals: authenticated can read" on public.approvals for select using (auth.role() = 'authenticated');  
create policy "activity: authenticated can read"  on public.activity  for select using (auth.role() = 'authenticated');  
create policy "clients: authenticated can read"   on public.clients   for select using (auth.role() = 'authenticated');

These grant read to _every_ logged-in user regardless of client. Fix: gate each by the asset's client/permission, mirroring the `version_history` policy which already does this correctly:

-- comments (and ratings/approvals analogously)  
create policy "comments: readable with asset" on public.comments for select  
  using (exists (  
    select 1 from public.assets a  
    where a.id = asset_id  
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())  
  ));  
-- clients: staff see all, clients see only their own  
create policy "clients: own or staff" on public.clients for select  
  using (public.is_staff() or id = public.my_client_id());

**F-2 (Medium) — Unbounded anonymous `asset_events` inserts** (`with check (true)`). Add a minimal constraint (valid `event_type`, existing/public `asset_id`) and/or rate-limit at the edge.

**F-3 (Low) — Table-level `grant all ... to anon`.** Standard Supabase pattern (RLS is the real gate), but it means RLS is the _only_ line of defense. This raises the importance of F-1's fix and of adding RLS tests (Phase 1).

---

## 7. Structured refactoring plan

Principle: **prove behavior before changing structure.** Each phase is independently shippable and leaves the app releasable.

### Phase 0 — Stop the bleeding (days, do first) — ✅ **COMPLETE** (2026-07-29)

- ✅ **Fix F-1** cross-tenant RLS policies; add F-2/F-3 mitigations. Ship as one migration.
  - `20260724120000_phase0_rls_tenant_isolation.sql` re-scopes `comments`, `ratings`,
    `approvals`, `activity` to "readable with the parent asset" and `clients` to
    "own or staff". Four follow-ups (`…120001`–`…120004`) refine super-admin,
    client creation, and member feedback scope. Present on `origin/main` and
    `origin/staging`, so `db.yml` has applied it to both backends.
  - F-2: the real gap was **event impersonation**, not the insert itself — `asset_events`
    now requires `user_id is null or user_id = auth.uid()`. `event_type` was already
    CHECK-bounded and `asset_id` FK-bound in baseline. Rate limiting deferred to Phase 4.
  - F-3: **accepted, not fixed.** `grant all … to anon` is the standard Supabase
    pattern and RLS is the intended gate. What makes this safe is the Phase 1 RLS
    test suite — that is where this finding actually gets closed.
- ✅ **Add a linter**: ESLint 9 flat config + typescript-eslint + react-hooks, `eslint . --max-warnings 0`,
  wired into `npm run lint`, `npm run check`, and a dedicated `Lint` step in `check.yml`.
  Baseline was 53 errors / 44 warnings; now **0 / 0**. Every exemption is an explicit
  override block in `eslint.config.js` with a reason — no accumulating warning count.
  - `no-console` allows only `warn` in app code, and `console.error` **only** inside the
    two `reportError.ts` files. The seam below is therefore CI-enforced: a new bare
    `console.error` anywhere else fails the build.
  - One dated exemption: `@typescript-eslint/no-explicit-any` is off for the five portal
    files whose every `any` is a `(supabase as any)` cast. **Delete that block in Phase 3**
    when generated types land; do not add files to it.
  - ⏸️ **Prettier is deliberately NOT applied to source.** `.prettierrc.json`'s `semi: false`
    contradicts desktop's semicolon style, and a tree-wide run rewrites 166 files, strips
    the column alignment desktop uses throughout, and destroys `git blame` over ~19k LOC.
    `npm run format` / `format:check` exist and `eslint-config-prettier` keeps the two from
    fighting, but there is **no format gate**. Adopt per-file during Phase 2's decomposition,
    where the diff is already large. Decision made 2026-07-29.
- ✅ **Add an error-reporting seam**: `reportError(context, err)` in
  `desktop/src/services/reportError.ts` and `web/apps/client-hub/src/lib/reportError.ts`.
  All 26 remaining bare `console.error` / `.catch(console.error)` sites now route through it
  with a `Module.operation` context string. `toMessage` also unwraps Supabase `PostgrestError`
  objects, which `String()` would have flattened to `[object Object]`.
  - Two `throw new Error(...)` sites now attach `{ cause: e }` (needed a `lib: ES2022`
    bump in `tsconfig.base.json` + `desktop/tsconfig.json` — lib only, target stays ES2020).
- _Exit criteria:_ ✅ `npm run check` green with the lint gate (version → lint → desktop build →
  web typecheck → docs build → cargo check) and 27/27 tests passing. RLS fix is deployed;
  the two-account spot check is superseded by the Phase 1 RLS suite, which proves it
  as a regression-locked property instead of a one-off manual observation.

### Phase 1 — Build the safety net (1–2 weeks) — ✅ **COMPLETE** (2026-07-29)

**290 tests, from 27.** `npm test` 206 (was 27) · `npm run test:rust` 43 (was 0) · `npm run test:rls` 41 (was 0).

- ✅ **Characterization tests for the pipeline.** `desktop/src/test/vfs.ts` is an in-memory
  Tauri filesystem that records every copy/remove/rename, so the destructive stages can be
  asserted on their _side effects_ rather than their log output. `invokeStub.ts` records the
  Rust bridge calls. The tests drive the real `runPipeline` — not a reimplementation — so
  Phase 2 can move this code into stage modules and they should keep passing untouched.
  - `pipelineCollect.characterization.test.ts` (27) — anchor filling, harvest scope,
    version filtering, name translation, marks, **mirror purge**, dry run, idempotency.
  - `pipelinePublish.characterization.test.ts` (26) — both layouts, stable-id stripping,
    sibling-OUT rule, nested packages, **🚫 disconnect vs hard-delete**, dry run.
  - `pipelineCdn.characterization.test.ts` (26) — **object key construction**, and that
    identity survives a file rename, a version bump and a folder retitle.
  - Purge safety is pinned explicitly: an empty harvest aborts before deleting, and
    dotfiles (`.dchub.json`) and extension-less files are spared.
- ✅ **Domain unit tests** — 110 across `stableId`, `naming`, `version`, `vocabulary`,
  `client`, plus the pre-existing `assetGrouping` / `filenameTranslator`.
- ✅ **RLS integration tests** — `supabase/tests/rls_tenant_isolation.test.sql` (pgTAP, 41):
  two tenants, a member each, a staff editor, a client-less user and anon, asserted across
  assets/comments/ratings/approvals/activity/clients. Runs in `db.yml` via `supabase test db`.
  **F-1 is now a regression-locked property.**
- ✅ **Rust tests** (43) — the hand-rolled SigV4 date math (leap years incl. the 100/400-year
  rules), URI encoding (spaces, `+`, bracket tags, multibyte UTF-8, uppercase hex), XML
  scraping, and `derive_signing_key` against the **published AWS test vector**.
- _Exit criteria:_ ✅ met. Also wired: `test:rust` into `check.yml`, `supabase test db` into `db.yml`.

#### Findings surfaced by Phase 1 — three real defects, all now FIXED (2026-07-29)

Each was first pinned as a passing test asserting the wrong behaviour, then fixed, then the
test flipped to assert the fix. None was fixed silently, and each fix is regression-locked.

| #         | Severity                           | Defect |
| --------- | ---------------------------------- | ------ |
| **F-4** ✅ | **High** (integrity, cross-tenant) | `ratings: own insert` checked `auth.uid() = user_id` but **never asset visibility**, so a member of tenant A could inject ratings onto tenant B's client-scoped and internal assets. The author could not read the row back, making it _invisible_ write-only pollution that skewed the average rating B's members and staff do see. Phase 0's F-1 fix covered reads only. **Fixed** by gating the insert/update CHECK on `can_see_asset()`. `rls_tenant_isolation.test.sql`, "writes" section. |
| **F-5** ✅ | **High** (data loss, CDN)          | `resolveCdnIdentity` returned a map keyed by **filename**, not absolute path. Two packages holding an identically-named deliverable collided: both uploaded to the _second_ package's object key, so one asset's original silently overwrote the other's and one portal download served the wrong file. The on-disk manifests were correct — only the lookup collapsed. This data shape is known-real (`assetGrouping.test.ts` documents "two 'Deda Energie' packages, each holding plyn.pdf"). **Fixed** by keying the identity and URL maps by absolute path. `pipelineCdn.characterization.test.ts`. |
| **F-6** ✅ | Medium (silent drop)               | In Collect, two OUT files that _translate_ to the same name: the first was copied, the second then lost the `isUnchanged` mtime comparison against the copy just made and was counted "unchanged". Its content never reached the client and **no issue was raised** — indistinguishable from a genuinely current file. **Fixed** by tracking claimed destinations and reporting the loser. `pipelineCollect.characterization.test.ts`. |

##### How they were fixed

- **F-4** → `20260729120000_ratings_asset_scoped_writes.sql`. Adds `public.can_see_asset(uuid)`
  and gates both the INSERT `WITH CHECK` and the UPDATE `USING` + `WITH CHECK` on it, so the
  write rule is symmetric with the read rule: **you may rate exactly what you may see**.
  UPDATE needs both halves — `USING` alone would still let an existing rating be re-pointed at
  an invisible asset.
  - ⚠ The helper is deliberately **`security INVOKER`**. A first attempt used `security definer`
    and the RLS suite immediately caught that it was *more permissive* than the read policies it
    was meant to mirror: a member could rate their own client's `internal` assets. The reason is
    subtle and worth knowing before touching these policies — the read policies' `EXISTS` on
    `assets` is evaluated **as the caller**, so the assets RLS (`internal` ⇒ staff only) filters
    it. That nested filtering is load-bearing; `definer` bypasses it. Documented in the migration.
- **F-5** → `resolveCdnIdentity` now keys by **absolute path**, plus a directory-scoped
  `cdnStemKey(absPath)` entry for the thumbnail that several extension variants of one stem
  legitimately share. Consumers (`runCdnUpload`, `runOriginalUpload`, `reconcileCdn`) look up by
  path. `cdnUrls` / `originalUrls` are path-keyed too, and `exportAssetsToSupabase`'s four
  lookups take the asset's `absPath` — without that second half a same-named pair would still
  have written one package's URL onto the other package's row. `cloudUrls` already carried a
  composite `destId:stem` key and is unchanged.
- **F-6** → both `syncPackageFromOut` (collect) and `copyOne` (publish) now track the
  destinations claimed during the run. The first writer is kept and the loser is reported as an
  error issue naming both files, instead of losing an `isUnchanged()` mtime comparison against
  the copy just made and being counted as "unchanged". The guard is per-run and keyed on the
  destination, so genuine idempotent re-runs stay silent.

Test totals after the fixes: **296** — 209 TS, 43 Rust, 44 RLS.

One lesser behaviour is also locked rather than left to chance: **anon can read ratings** on a
public asset while comments correctly require a session (`ratings` has no `auth.uid()` guard).

Phase 1 also found that **whitelist filter mode collected nothing** from a conventional tree —
every directory needed the include mark, but the OUT folder cannot carry one and still match
`isOutFolder`, so the walk could never reach a deliverable. Rather than fix an unusable second
filtering mode, `filterMode` and `includeMark` were **removed outright** (2026-07-29): exclusion
via `excludeMark` is now the only mode. Nothing could have depended on the whitelist path, since
it produced no output. Removed from the domain, both services, the settings store/loader, the
Settings UI and its dead CSS, the docs, and the tests.

### Phase 2 — Decompose the god-files (2–3 weeks, safe once Phase 1 lands)

#### Reordered 2026-07-29 — share-first, then split

**Direction set by the product owner:** as much as possible must be shared by desktop and web;
the asset *display* layer should eventually run on the desktop too, so staff never switch apps;
ultimately **web is a slightly limited version of desktop**. Today that is not the case, but the
architecture is being shaped around it now.

That inverts the original Phase 2 → Phase 3 order. Decomposing `supabaseService` into
desktop-shaped modules first would mean re-splitting it when the shared half is extracted —
two moves and two test rewrites. So the package boundaries are decided FIRST and the god-files
are decomposed *into* them.

Two facts found while planning:

- **`packages/asset-library` already is the shared asset layer** (`Asset`/`Client` types,
  `permissions`, `filters`, React-free today) — and **only web imports it**. Desktop imports
  nothing from it. That is the largest single lever toward "display layer on desktop".
- **`packages/auth` already proves the both-platforms pattern**: shared logic, per-platform
  transport, imported by _both_ `desktop/src/services/authService.ts` and the portal. New shared
  code should copy that shape rather than invent one.

Both blocking constraints are now **resolved** (2026-07-29):

- ✅ **React 19 everywhere.** Web moved 18.3.1 → 19.2.8 (`react`, `react-dom`, `@types/*`,
  `react-router-dom` → 6.30.4 for its React-19 peer). **No application code needed changing** —
  the portal had no `ReactDOM.render`, `defaultProps`, `propTypes`, `useRef()`-no-arg or
  `forwardRef` usage. `asset-library`'s peer tightened from `^18 || ^19` to `^19.0.0` so a
  single supported version is now declared, not merely installed.
  - ⚠ Worth knowing: the bump initially left **two Reacts in one tree** — a stale hoisted
    `react@18.3.1` at the root still satisfied the `peerOptional ^18 || ^19` of `motion` and
    `react-router-dom`, while the app itself resolved a nested 19. Those libraries' hooks and
    context would have bound to a *different React instance* than the app. `npm dedupe`
    collapsed it. **Re-check `npm ls react --all` after any React-adjacent dependency change** —
    a single declared version does not guarantee a single installed one.
- ✅ **Transport is a solved shape, not a new abstraction.** See below.
- Careful with `Client`: it means portal identity (`accent`, `slug`, `domainWhitelist`) in
  asset-library and machine-local config (`sourceFolder`, `cloudDestinations`) in desktop. The
  identity half is shareable; the machine-local half never will be. Do not merge them naively.

##### What "transport" means, and why it is nearly free

"Transport" is only the pipe that performs the HTTP request — never the query. Both apps talk to
the *same* Supabase project, the same PostgREST endpoints, with the same URLs and headers. The
sole difference is **who makes the call**:

| | Web portal | Desktop |
| - | ---------- | ------- |
| Caller | browser `fetch` via supabase-js | TS → `invoke('supabase_request')` → **Rust `reqwest`** |
| Why | native to the platform | `supabase.rs`: "native networking, no webview CORS surface" |

So the shareable part is everything *except* those few lines: which table, which columns, which
filters, and how rows map to domain objects. Code that hardcodes `supabase.from('assets')…` is
web-only; code that receives its caller can serve both.

Three facts make this much smaller than it first appears:

1. **Desktop already depends on `@supabase/supabase-js`** (`^2.110.2`) and already holds a typed
   `DcHubClient` built by `@dc-hub/auth` — both apps share one auth client today.
2. **supabase-js accepts a custom `fetch`** (`createClient(url, key, { global: { fetch } })`), so
   desktop can keep Rust networking *and* use the typed query builder plus the generated
   `Database` types from `@dc-hub/database`.
3. **Desktop's `sbFetch` is already fetch-shaped** — it returns `{ ok, status, text(), json() }`.
   The adapter is essentially written.

So 2c's seam is simply: shared query modules take a `DcHubClient`; each app constructs that
client with its own fetch. That is the `@dc-hub/auth` pattern extended, not a new invention.

- 🔎 To check during 2c: desktop's auth client uses the *default* webview fetch and works, which
  suggests the webview can reach Supabase directly and the Rust proxy may no longer be needed for
  the sync path either. The proxy's stated reason (keeping a service-role key out of the webview)
  does not apply to today's code — `makeHeaders` sends the anon key plus the user's session JWT,
  exactly what a browser sends. If confirmed, the transport difference disappears entirely.

| Step | Scope | State |
| ---- | ----- | ----- |
| 2a | `@dc-hub/domain` — extract the platform-free domain | ✅ **done** |
| 2b | `pipelineService` (1,894) → orchestrator + 12 stage modules | ✅ **done** |

##### 2b — `pipelineService` split (done 2026-07-29)

**1,894 → 92 lines.** `runPipeline` is now a coordinator and nothing else: it owns the stats
object, the stage order, and the settings flags that gate each stage. Everything else moved into
`desktop/src/services/pipeline/`:

| Module | Lines | Holds |
| ------ | ----- | ----- |
| `types.ts` | 70 | `RunContext`, `R2Config`, `CloudUrlEntry`, `VersionEntry`, `AssetVersions` |
| `naming.ts` | 46 | the four settings-shaped adapters over `@dc-hub/domain` |
| `fs.ts` | 64 | `listDir`, `listDirLogged`, `collectFiles`, `isUnchanged` |
| `r2Cache.ts` | 54 | mtime+size upload cache, public URL shape |
| `collect.ts` | 81 | COLLECT stage (`runDistribute`) |
| `thumbnails.ts` | 98 | THUMBNAILS stage |
| `cdnCleanup.ts` | 120 | `reconcileCdn`, `deleteCdnObjects` |
| `scan.ts` | 160 | `scanAllAssets`, `scanVersionMap` |
| `packages.ts` | 246 | 📦 discovery, harvest, **mirror purge** |
| `publishLocal.ts` | 347 | PUBLISH stage + disconnect reconciliation |
| `cloudExport.ts` | 359 | Dropbox / OneDrive / Drive export |
| `cdnUpload.ts` | 366 | thumbnail + original upload, identity-derived keys |

**No hotspot over 400 lines — the Phase 2 exit criterion for this file is met.**

What makes this a refactor rather than a rewrite: **all 82 pipeline characterization tests passed
without a single test being modified.** They drive the real `runPipeline`, so they were blind to
the internal layout — which is exactly why Phase 1 came first. Code was moved by line range
rather than retyped, so the diff is a move, not a rewrite.

Two structural improvements fell out:

- **The `damService` ⇄ `pipelineService` import cycle is gone.** Both `damService` and
  `supabaseService` needed only to *name* a `RunContext`, and imported the orchestrator to get it
  while the orchestrator imported them back. They now import `./pipeline/types`, and nothing
  imports `pipelineService` except its external consumers.
- **`pipelineService` keeps the public surface** (`RunContext`, `CloudUrlEntry`, `scanVersionMap`,
  `deleteCdnObjects`, …) as re-exports, so the split did not ripple into `PipelineView`.

Each module opens with a comment stating *why* it exists and which invariant it protects — the
empty-harvest guard in `packages.ts`, the permanence of an R2 object key in `cdnUpload.ts`, the
🚫-versus-delete asymmetry in `publishLocal.ts`, the non-deterministic scan order in `scan.ts`.

| 2c | `supabaseService` (1,438) → barrel + 13 modules, shared/desktop line drawn | ✅ **done** |
| 2d | Portal god-components → 15 modules; `AssetDetail` needs hook extraction | ⚠️ **partial** |

##### 2c — `supabaseService` split (done 2026-07-29)

**1,438 → 47 lines** (a barrel) plus 13 modules under `desktop/src/services/supabase/`, grouped by
*how shareable they are*, because that is what Phase 3 turns on:

| Group | Module | Lines | |
| ----- | ------ | ----- | - |
| **SHARED-READY** — pure, no transport, no filesystem | `rowMapping` | 72 | stem → the row the portal renders |
| | `taxonomyKeys` | 19 | the stable `slot.group.leaf` keys tags are addressed by |
| **DESKTOP-SIDE** — touches the Tauri filesystem | `manifest` | 225 | `.dchub.json` ⇄ `child_id` resolution |
| | `identity` | 76 | absolute path → (stable_id, child_id) |
| **QUERIES** — data access via `./rest` | `assetQueries` | 105 | reads against `public.assets` |
| | `draftAssets` | 74 | the Vocabulary "create folder" flow |
| | `destinations` | 61 | destination defs, OAuth tokens stripped |
| | `tagSync` | 238 | local leaves → `public.tags` |
| | `versionHistory` | 175 | the `versions/` subtree |
| | `connection` | 26 | Settings' reachability probe |
| | `assetExport` + 4 stages | 156+ | the pipeline's full sync — split in 2c-1 below |
| (pre-existing) | `rest` / `r2Grant` / `renameTasks` | 68/42/65 | transport, grants, rename tasks |

**Coverage came first, again.** `parseAssetForSupabase` — the mapper behind every asset card, filter
and search result in the portal — had **zero** tests; the 8 existing `supabaseService` tests need a
live Postgres and are skipped in CI. Two hermetic suites were written *before* moving anything:
`supabaseMapping.characterization.test.ts` (27) and `supabase/taxonomyKeys.test.ts` (14). Desktop
tests went 124 → 165.

Behaviours they pinned that would have been easy to "simplify" wrongly:

- The display **name** de-duplicates by label (so two shortcodes sharing one display name do not
  render as "Product Product"), while the taxonomy **arrays** keep the label in *every* dimension it
  belongs to (per-dimension membership is what filters query). Two rules pulling opposite
  directions, both required.
- Unknown shortcodes stay visible as `[ZZZ]` in the name but are **excluded** from the searchable
  tag list.
- `version` is `''` when absent while `year_month` is `null` — matching their column nullability,
  not each other.
- `slugifyKeyPart` **drops** accented characters rather than transliterating: `Šumava` → `umava`.
  Worth knowing before relying on it for Czech or Slovak client names.

##### 2c-1 — `assetExport` characterized, then split (done 2026-07-29)

`assetExport` was left at 489 lines by 2c because it was one imperative flow over shared locals and
its only tests needed a live Postgres. Both halves are now done.

**First, coverage.** `src/test/restStub.ts` records the REST layer the way `invokeStub` records the
Rust bridge — the sync's entire behaviour is *which rows it would INSERT, PATCH or disconnect*, and
that is visible in the requests. With the vfs harness supplying real `.dchub.json` manifests, the
flow became hermetically testable: **23 tests**, no database.

What they pin (each one a real product rule, not a shape assertion):

- **Variants vs galleries are not interchangeable.** Files directly in OUT are one deliverable in
  several renditions → `variant_of` → the portal shows a *picker*. A folder under OUT is many
  related-but-distinct files → `parent_id` → the portal shows a *grid*. Conflating them once made
  the portal render a 60-chip picker for a photo grid.
- **A version bump keeps the same `child_id`**, so the row — and its ratings and comments — survives.
- **Only the highest version becomes a row**; older ones are history via `syncVersionHistory`.
- **Extension pairs of one stem are not two variants** (`foo.pdf` + `foo.png` used to stamp
  `variant_of` onto the primary's own row, hiding the group).
- **A variant group's primary is renamed to the tags every variant shares**, with all variants'
  tags rolled up onto it so filtering by a tag on one variant still surfaces the group.
- **Stale rows are soft-marked, never deleted** — a row carries ratings, comments, approvals and
  events, and an unmounted drive must not be able to destroy them. CDN keys are only *reported*.
- **A duplicate hash claimed by two folders skips both** rather than corrupting either.
- **PATCH omits absent URL fields**, so a run with the upload phase cached cannot blank the image
  the portal already serves. Absent means "no opinion", not "clear it".

**Then the split — 489 → 156 lines** plus four stages that hand data over explicitly:

| Stage | Module | Lines |
| ----- | ------ | ----- |
| shared shapes | `exportTypes` | 60 |
| 1 identify — folder identity, or refuse to guess | `exportIdentify` | 57 |
| 2 plan — assets → rows (+ manifests) | `exportPlan` | 254 |
| 3 write — parents, then children | `exportWrite` | 136 |
| 4 disconnect — soft-mark what left the disk | `exportDisconnect` | 40 |
| orchestrator | `assetExport` | 156 |

**All 23 tests passed unmodified against the split.** Explicit hand-off replaced the shared locals,
which is what made division possible at all.

One real improvement fell out rather than being planned: the disconnect stage is now skipped when
the existing-rows read failed. Previously a failed read left an empty map, and "no row for this key"
was indistinguishable from "row absent" — so a transient read failure could have disconnected every
asset. Now `readFailed` gates stage 4, and a test covers it.

**Also now visible:** the QUERIES group is platform-free apart from its caller — each function takes
a `SupabaseConfig` and goes through `./rest`. Phase 3 can lift these into a package by passing the
transport in, exactly as `@dc-hub/auth` already does. That is why the split was grouped this way
rather than by entity.


##### 2a — `@dc-hub/domain` (done 2026-07-29)

Six modules moved out of `desktop/src/domain` into `packages/domain`, with their tests:
`stableId`, `naming`, `version`, `vocabulary`, `filenameTranslator`, `assetGrouping`. They form a
closed set — the only cross-imports are internal — so this was mechanical, and the 84 tests that
moved with them prove it. `client.ts` deliberately stayed behind: it mixes portal identity with
machine-local config and needs the real split in 2c.

Why this package and not `asset-library`: `asset-library` is destined to hold shared **UI**
(React peer dep), and the pipeline domain must stay React-free so a Node script or edge function
can use it too. Mixing them would drag React into desktop's pipeline modules.

- Resolution follows the established raw-TS pattern: tsconfig `paths` + a Vite alias, added for
  desktop **and** web (the portal can now import it whenever 2c/2d needs it), plus a matching
  alias in `desktop/vitest.config.ts`.
- Shared-package tests live with the code, not inside an app, so they are verifiable without
  booting desktop or web. Root `vitest.config.ts` runs them; `npm test` = packages then desktop.
- **The platform-free contract is CI-enforced**, not just documented: `no-restricted-imports` in
  `eslint.config.js` fails the build on any `@tauri-apps/*`, `@supabase/*`, `react`, `node:*` or
  out-of-package import inside `packages/domain`. Verified to fire.


- **`pipelineService.ts` (1,846) → orchestrator + stages**: `scan/`, `transform/`, `publish-local/`, `publish-cloud/`, `publish-cdn/`, `readme/`. Keep `runPipeline` as a thin coordinator; each stage pure-ish and independently tested.
- **`supabaseService.ts` (1,693) → per-entity data modules** (assets, clients, tags, events, identity) behind a typed client. This directly feeds Phase 3.
- **`damService.ts` (978)** and portal **`AdminLandingPage.tsx` (1,255)**, **`AssetDetail.tsx` (901)**, **`GalleryView.tsx` (766)** → split by concern (data hooks vs. presentational components).
- _Exit criteria:_ no source file > ~400 LOC in the hotspots; tests still green (that's the point).
  - ✅ **The two service god-files are done.** `pipelineService` 1,894 → 92 (+12 stages, max 366)
    and `supabaseService` 1,438 → 47 (+17 modules, max 254). No characterization test needed
    changing across either split — the point of doing Phase 1 first.
  - ✅ **Met (2026-07-30).** Every file that was over 400 has been split:

    | File | Was | Now | Where the rest went |
    | ---- | --- | --- | ------------------- |
    | `AdminLandingPage.tsx` | 1,322 | 215 | 11 modules (2d) |
    | `damService.ts` | 978 | 346 | 8 `dam/*` modules |
    | `AssetDetail.tsx` | 923 | 354 | 6 hooks + 3 panels (2d-2) |
    | `GalleryView.tsx` | 766 | 216 | 4 modules |
    | `PipelineView.tsx` | 682 | 28 | `runPlan` + `useRunPipeline` + `summaryRows` + 4 panels |
    | `cloudService.ts` | 671 | 46 | `cloud/{oauth,dropbox,onedrive,gdrive}` |
    | `CloudDestinations.tsx` | 557 | 103 | `connectDest` + `useDestAuth` + `destLabels` + 2 panels |
    | `VocabularyView.tsx` | 511 | 145 | `createAssetFolder` + `useAssetGenerator` + `useVocabSync` + 2 panels |
    | `TagsAdmin.tsx` | 416 | 128 | `tags/{tagTree,useTagAdmin,GroupCard,LeafTable,LeafRow}` |

    The only file left above 400 is `packages/database/src/database.types.ts` (858) — **generated**
    from the schema, so it is exempt by definition rather than by exception.

    Two of these were named hotspots with no hermetic coverage, so they got the prove-then-move
    treatment `assetExport` had: `damService` (17 tests first) and `cloudService` (48 tests first).

### Toolchain — one compiler, enforced (2026-07-29)

Found while verifying 2b, and worth its own section because the failure mode is silent.

The repo has **three separate npm installs** — the root workspace (serving `packages/*` and
`web/apps/*`), `desktop/`, and `docs/` — and nothing made them agree on a TypeScript version.
They did not:

| Context | Declared | Resolved |
| ------- | -------- | -------- |
| root | (nothing — npx fell back to a hoisted transitive copy) | 5.9.3 |
| `desktop/` | `~5.8.3` | 5.8.3 |
| `docs/` | `^5.0.0` | 5.9.3 |
| 4 packages + web app | `^5.6.0` each | 5.9.3 (hoisted) |

**The two compilers disagreed about real code.** Four `fetch(…, { body: uint8array })` calls in
`cloudService.ts` were errors under 5.9.3 and silent under 5.8.3: TS 5.7 made `Uint8Array` generic
over its backing buffer (`Uint8Array<ArrayBufferLike>`), and `BodyInit` rejects possibly-shared
memory. `npm run check` was green the whole time, because it used the compiler that did not care.

A future routine bump of desktop's TypeScript would have surfaced those as a surprise wall of
errors, attributed to whatever change happened to be in flight.

**Fixes, in order:**

1. The four errors were **real and are fixed properly**, not cast away. `readFile` already returns
   the precise `Uint8Array<ArrayBuffer>`; only `cloudService`'s own parameter declarations widened
   it. Narrowing three declarations makes the types *more accurate* — those bytes are always
   network-bound, so non-shared memory is genuinely required — with **zero runtime change**.
   Verified clean under both 5.8.3 and 5.9.3 before unifying.
2. **Every manifest now pins the same EXACT version** (`5.9.3`, no `^`, no `~`). A range is the
   mechanism by which two installs drift while both look correctly configured. All three trees
   report 5.9.3, and only one copy exists per tree.
3. **`scripts/toolchain.mjs` enforces it**, mirroring `scripts/version.mjs`: root `package.json` is
   the source of truth, `check` fails on any divergence *or on any range*, and `set <x.y.z>`
   rewrites all seven manifests at once. Wired into `npm run check` next to `version:check`.
   Verified to fail on a re-introduced `^` range.

To bump the compiler deliberately: `npm run toolchain:set 5.9.4`, then reinstall all three trees.
Add future must-not-drift tools to `PINNED` in that script rather than writing another one.

✅ **The rest of the toolchain is now unified too** (item T2). Everything both apps compile with
is pinned to one exact version, verified by building and testing each tree afterwards:

| Tool | Was | Now | Notes on the bump |
| ---- | --- | --- | ----------------- |
| `typescript` | 5.9.3 / 5.8.3 / 5.9.3 (+4 ranges) | **5.9.3** | see above — hid 4 real errors |
| `vite` | desktop 7.3.5, web 6.4.3 | **7.3.5** | web 6→7; `@tailwindcss/vite` and `@vitejs/plugin-react` both already allowed `^7` |
| `@vitejs/plugin-react` | 4.6.0 / 4.3.0 | **4.7.0** | |
| `vitest` | root 4.1.10, desktop 3.2.7 | **4.1.10** | desktop 3→4: all 124 tests pass unchanged |
| `@types/node` | 26 / 22 / 20 | **26.1.0** | three different ideas of the standard library |
| `@supabase/supabase-js` | 2.110.2 / 2.110.0 | **2.110.8** | the client type `DcHubClient` is built from |
| `react` + `react-dom` | 19.2.7 / 19.2.8 | **19.2.8** | |
| `@types/react` + `-dom` | 19.1.8 / 19.2.17 | **19.2.17 / 19.2.3** | |

`scripts/toolchain.mjs` enforces all ten. `peerDependencies` are deliberately left as ranges — a
library must not dictate an exact version to its host.

**One documented carve-out:** `docs/` keeps React 18. Nextra's *peer* range allows 19, but the site
sits on **Next 13.5**, and React 19 needs Next 15 — so unifying it means a Nextra 2→4 + Next 13→15
migration, unrelated to making desktop and web siblings. `docs/` still follows `typescript` and
`@types/node`. Backlog item 13.

---

### Architecture — one workspace (A1, done 2026-07-29)

The pinning above made the old layout *safe*; this removes the cause. **`desktop/` is now a
workspace member**, so the two sibling apps and the shared packages install from **one lockfile
into one hoisted `node_modules`**.

```
BEFORE                                          AFTER
package.json  ["packages/*","web/apps/*"]       package.json  ["packages/*","web/apps/*","desktop"]
  → package-lock.json                             → package-lock.json          ← desktop included
desktop/package-lock.json      (separate)       docs/package-lock.json         (separate, see below)
docs/package-lock.json         (separate)
```

Result: `desktop/node_modules` is **empty** — every dependency is hoisted and shared with web, so
the two apps cannot resolve different copies of anything. `npm run setup` is one `npm ci` for the
product (plus one for docs). Verified: `npm ci` from scratch, all four gates, and the Tauri CLI
still resolving (`npm --prefix desktop run tauri -- --version` → 2.11.4).

Dependents updated: `scripts/setup`, `scripts/version.mjs` (lockfile map), and
`release-desktop.yml`'s `cache-dependency-path`. `tauri.conf.json` needed no change — its
`beforeDevCommand`/`beforeBuildCommand` run with `desktop/` as cwd and npm still resolves the
workspace's own scripts, and `frontendDist: "../dist"` is path-relative.

#### Why `docs/` is NOT a workspace member

It was tried, and it broke the docs build in a way worth recording, because the failure is not
obvious and would recur on any future attempt.

`docs/` is on Nextra 2 / Next 13 / React 18. Adding it to the workspace produced **two copies of
Next — 13.5.11 nested under `docs/`, and 16.2.12 hoisted at the root** — even though `docs/` is the
only manifest that declares Next at all. Cause: Nextra 2 declares a very loose peer
(`next >= 9.5.3`), npm auto-installs peers, and it satisfied that by hoisting the *latest* Next,
while docs' own `^13.5.6` was nested to bind to its React 18. Transitive packages then resolved
across the two: `next-seo` loaded `next/head` from the hoisted 16 while the build ran from the
nested 13, giving `MODULE_NOT_FOUND` on an internal Next path.

The React 18 carve-out is therefore not just a version exception — it structurally prevents
workspace membership. `docs/` keeps its own install until item 13 migrates it to Nextra 4 / Next 15
/ React 19, at which point it can join and this section can be deleted.

That is also the honest architectural line: the workspace holds the **product** — two sibling apps
plus the packages they share. `docs/` is a static site on its own dependency era.

#### Still available (not done)

`web/apps/client-hub` is the only app under `web/`, and `web/packages/*` no longer exists — so
`web/apps/` is two directory levels holding one thing. Flattening to `apps/client-hub` /
`apps/desktop` would make the layout state the rule (`apps/*` are deliverables, `packages/*` are
shared). Not done: it is pure churn, and unlike the lockfile consolidation it buys no guarantee.

---

##### 2d — portal components (2026-07-29, partial)

**Logic first, again.** The portal had **zero** tests. Three pure modules came out with 35 hermetic
tests (no DOM), now running in CI via the root vitest config:

- `gallery/assetFacets.ts` — `sharedLabels` / `uniqueLabel` are what make a variant picker readable:
  shared tags name the GROUP, each variant is labelled by what is left of its own name. Get it
  wrong and every chip reads identically.
- `admin/clientForm.ts` — `toSlug` produces the client's portal URL (`/:slug`), so its rules are a
  published format: a change re-points a live link. (It drops accents: `Šumava` → `umava`, the same
  trade-off as `slugifyKeyPart` on the desktop side.)
- `admin/roles.ts` — `assignableRoles` is an authorization boundary, not a UI list: it stops an
  ordinary admin granting admin or super-admin. RLS enforces the same rule server-side.

**Then the component split:**

| Component | Before | After | Extracted |
| --------- | -----: | ----: | --------- |
| `AdminLandingPage` | 1,322 | **215** | `DCMark`, `DomainInput`, `LogoField`, `ClientDrawer`, `AdminClientCard`, `AdminSignIn`, `UserCreateDrawer`, `UsersView`, `styles`, `clientForm`, `roles` |
| `GalleryView` | 766 | **216** | `AssetCard`, `FiltersRail`, `GalleryStates`, `statusLabels` |
| `AssetDetail` | 923 | 850 | `StarRating`, `assetOptions`, `assetFacets` |

**⚠️ `AssetDetail` is NOT done, and its shape explains why.** It holds **22 `useState` calls** and a
dozen effects, with the render delegating to one inline `content` — so the bulk is *state*, not
markup, and moving JSX out achieves nothing. A real split means extracting cohesive state into
custom hooks: `useAssetRating`, `useAssetComments`, `useAssetStatus`, `useAssetChildren`,
`useAssetVariants`, `useAssetEvents`. That is a behaviour-bearing change to the portal's most
stateful component, and unlike every other split in Phase 2 there is **no test that would catch a
broken effect** — the 35 new tests cover pure logic, not rendering. Doing it blind would be the one
place in this whole sequence where the prove-then-move rule was skipped.

##### 2d-1 — `AssetDetail` hooks (done 2026-07-29)

**First the test stack, then the extraction** — the same order as everywhere else.

`jsdom` + `@testing-library/react` + `jest-dom`, pinned exactly and added to `toolchain.mjs`'s
enforced set. Component suites opt into jsdom per file with `// @vitest-environment jsdom`, so the
pure-logic tests keep running in plain node (~10× faster). The root vitest config now picks up
`.tsx` under `web/apps/*` too.

**16 characterization tests** written against the *unchanged* component, asserting observable
behaviour rather than structure — because the risk in extracting hooks is a broken effect:

- what it fetches on mount (rating keyed by asset AND user; the comment thread; a view event)
- that children and variants load **only** when `childCount > 0`, so a plain asset costs no
  round-trips
- that it **re-fetches on asset change** but **not** on an unrelated re-render — a dependency array
  that re-ran every render would hammer the API from the portal
- role gating: staff get view/download counts, a member does not
- that it still renders when **every** service rejects — a failed fetch must not blank the panel

Writing them corrected two of my own assumptions: `useAuth` returns `{ session }` (not `{ user }`),
and children/variants are gated on `childCount`. Both were behaviours I would have guessed wrong.

**Then six hooks, 923 → 622 lines:**

| Hook | Lines | Owns |
| ---- | ----: | ---- |
| `useAssetEvents` | 29 | view tracking + staff-only counts, keyed on assetId alone so a view is never double-counted |
| `useAssetRating` | 39 | the viewer's own vote, optimistic |
| `useAssetDestinations` | 65 | share links + Reveal, with the fail-closed rule for unknown destinations |
| `useAssetChildren` | 77 | children, variants, focus, carousel, lightbox — **one** hook on purpose |
| `useAssetComments` | 84 | the thread; read ≠ write permission |
| `useAssetLifecycle` | 86 | status, perm, delete; resets on asset change |

**All 16 tests passed unmodified after the extraction.**

`useAssetChildren` bundles six pieces of state deliberately: one effect sets them all, because
opening from a hover tile has to pick the child, switch to carousel, set the index, choose the
variant and maybe open the lightbox — all from one decision about `focusAssetId`. Splitting that
into six hooks would replace one readable effect with six that must fire in the right order.

##### 2d-2 — `AssetDetail` panels (done 2026-07-30)

**923 → 354 lines**, now under the criterion. Three presentational panels, each taking the matching
hook's return as a bundle rather than a dozen loose props — the hooks had already grouped the state
by concern, so the prop surface follows the same seams:

| Panel | Lines | |
| ----- | ----: | - |
| `AssetPreviewPanel` | 191 | children grid/carousel or thumbnail, lightbox, download tracking |
| `AssetStatusPanel` | 157 | status, publicity, approval — three audiences, an authorization boundary |
| `AssetCommentsPanel` | 98 | thread + composer; read ≠ write permission |

**All 16 characterization tests passed unmodified at every step.**

One thing the compiler caught worth noting: the carousel and lightbox setters are used with the
functional-updater form (`setCarouselIdx(i => i + 1)`), so typing them as `(i: number) => void`
silently narrows what a panel may do. They take `Dispatch<SetStateAction<T>>`.

Note the presentational modules (`AssetCard`, `StarRating`, `GalleryStates`) were written
props-only precisely so the desktop app can mount them once the display layer is shared.

---

### Phase 2 sweep — the remaining oversized files (2026-07-30)

Continuing past 2d, same prove-then-move rule each time.

| File | Before | After | New tests |
| ---- | -----: | ----: | --------: |
| `AssetDetail.tsx` | 923 | **354** | (16 from 2d-1, unchanged) |
| `taxonomyImport.ts` | 403 | **35** barrel | **31** |
| `damService.ts` | 978 | **346** | **17** |
| `cloudService.ts` | 671 | **46** | **48** |
| `PipelineView.tsx` | 682 | **28** | **19** |
| `CloudDestinations.tsx` | 557 | **103** | **15** |
| `VocabularyView.tsx` | 511 | **145** | **17** |
| `TagsAdmin.tsx` | 416 | **128** | **22** |

**Sweep complete.** No hand-written file in the repo is over 400 lines. Totals: **595** tests —
492 TypeScript (188 packages + web, 304 desktop), 43 Rust, 60 pgTAP. All four gates green.

**`taxonomyImport` → `taxonomy/{validate,build,apply}`.** The split follows what each part touches:
`validate` is pure, `build` is pure plus a browser download, `apply` is the only part that writes to
the database. That matters because validation guards a **destructive import** — a client's whole tag
tree is replaced from a JSON file, and tags are what every filter, Obsidian export and asset row
references by key. 31 tests now pin the rules, including the ones that would build a broken tree: a
dangling `parent_key`, a self-parent, a two-node cycle and a longer cycle — and that a _deep valid
chain_ is not mistaken for one.

**`damService` → `dam/{paths,fs,scope,thumbs,scan,notes,canvasLayout,canvas}`.** The 17 tests target
`patchMeta`, which edits notes the user writes in. Two properties matter more than formatting:

- it must **preserve what it does not own** — prose, extra sections, manual links;
- it must report `changed: false` for a no-op, or every run rewrites every note and Obsidian and git
  see churn on files nobody edited. **Idempotency is tested for each patch type.**

Also pinned: a destination name containing regex characters (`Client (final)`) must not corrupt the
row match, and `stableId` must stay deterministic or the canvas reshuffles on every run.

⚠ **Process note.** Rebuilding the `dam/*` modules from `git show HEAD:…` silently reintroduced
whitelist filter mode and a `prefer-const` fix that had been removed _earlier in this same working
tree_. HEAD is not the working tree — extracting from it reverts uncommitted work. Both were caught
(typecheck and lint respectively) and removed, and a grep confirmed no `filterMode`/`includeMark`
remains. Worth remembering while the branch stays uncommitted. Every split after this one worked
from a **snapshot of the working file** instead.

#### `cloudService` → one module per provider (48 tests first)

The three providers share almost nothing but a shape, so they are now three files plus the PKCE
plumbing they do share: `cloud/{oauth,dropbox,onedrive,gdrive}`, with `cloudService.ts` reduced to the
`refreshCloudToken` dispatcher and a barrel. OneDrive is the outlier twice over — it authenticates by
**device code**, not a loopback redirect, and it is the only one that **rotates** its refresh token on
every exchange (dropping the new one silently disconnects the destination).

The tests needed a third harness beside `vfs` and `invokeStub`: **`test/fetchStub.ts`**, because these
calls go out through the webview's `fetch` rather than through Rust. What they pin is what fails
silently:

- **drive targeting** — a wrong `driveId` uploads a client's deliverables into someone else's drive
  and still returns 200; `graphDriveBase` is the single point where that is decided;
- **the size boundaries** — 4 MiB (Graph rejects a larger single PUT) and 5 MiB (Drive's multipart
  create is memory-bound), tested _at_ the boundary and one byte over, with exact `Content-Range`
  assertions because Graph stalls a session on a mislabelled chunk;
- **Drive's same-size skip** — too eager and a re-export keeps the OLD file; too timid and every run
  re-uploads every asset. Also pinned: a changed file is **updated in place**, since Drive allows
  duplicate names and the client would open the wrong one.

#### `PipelineView` → `runPlan` (pure) + `useRunPipeline` + panels

682 → 28 lines. The valuable extraction is **`runPlan.ts`**: the checkbox grid is not the run
configuration, it is an _input_ to it. A checked local destination overrides `targetFolder` and forces
`doPublish`; no cloud destination suppresses `doFlatExport`. Those rules decide **where a client's
deliverables land**, and they previously lived inside a 131-line closure verifiable only by doing a
real run. 19 tests now pin them — including that the overrides are **one-directional** (a destination
may switch a stage on, never one the operator deliberately switched off) and that **exactly three**
settings fields change, so a fourth appearing later cannot slip in silently.

#### `CloudDestinations` → `connectDest` + `useDestAuth` + panels

The device-code flow polls for up to fifteen minutes, so it can outlive the screen that started it.
`connectDest.ts` makes that testable without React, and the two tests that matter are about
**cancellation**: a token arriving after the operator backed out must be _discarded_, and `null`
(cancelled) must stay distinguishable from a throw (failed) — only the second is an error worth
showing. The identity check is pinned too: a token with no account attached leaves the row saying
"Connected" without saying to what.

#### `VocabularyView` → `createAssetFolder` + `useAssetGenerator` + `useVocabSync`

`createAssetFolder.ts` is the **only place a `stable_id` is minted**, and everything an asset ever
accumulates hangs off it. 17 tests cover the two unrecoverable failures — a **colliding** id (the new
folder claims another asset's history) and a **missing manifest** entry (the first pipeline run creates
a second row beside it, splitting one asset in two) — plus the load-bearing detail that the seeded
placeholder is **extensionless**, so the scanner skips an unfinished asset instead of publishing it
empty to a client. A failed draft row is reported as **partial**, naming what was already written, so
the operator does not retry into two folders for one asset.

#### `TagsAdmin` → `tags/tagTree` (pure) + `useTagAdmin` + components

There is no `kind` column: whether a row is a group or a leaf is **inferred** from `parentId` and
`shortcode`, and that inference is the contract between portal and desktop. 22 tests pin it, including
the case the obvious implementation loses: a leaf whose parent is missing (or is itself a leaf) is an
**orphan** and must stay visible — a leaf that renders nowhere is a shortcode still baked into
filenames that nobody can edit or delete. One test asserts every leaf lands in **exactly one** bucket.

---

### Phase 3 — Unify the data layer ✅ (done 2026-07-30)

- **Create `packages/core`** (or extend `web/packages/database`) holding: `ID_SUFFIX_PATTERN` + identity, naming/taxonomy, generated Supabase types (single source), and typed data-access functions.
- **Generate `database.types.ts` from Supabase** in CI (`supabase gen types`) so types can never drift from the schema; delete hand-maintained copies.
- **Consume `core` from both desktop and web.** Desktop's `supabaseService` and web's services become thin adapters over shared functions.
- _Exit criteria:_ one identity regex, one type source, one client-service implementation; desktop imports `@dc-hub/core`.

#### What was already true

Surveying first changed the shape of this phase. Two of the three exit criteria were **already met** by
Phase 2: `ID_SUFFIX_PATTERN` has exactly one definition (`packages/domain/src/stableId.ts`), and
`@dc-hub/database` was already the single type source, with the portal's `lib/database.types.ts` down
to a two-line deprecated re-export. So this was not a consolidation job. It was a **drift** job.

#### `packages/core` was NOT created — deliberately

Four shared packages already exist with clear remits: `domain` (platform-free rules), `database`
(generated types), `auth`, `asset-library`. A fifth named `core` would have been a name, not a
boundary — and "core" is the name things accumulate in. Each piece went to the package that already
owned its concern. The exit criteria are about duplication, and they are met; the package name in the
original plan was a means, not the goal.

#### The types HAD drifted, silently

`supabase gen types typescript --local` against a schema replayed from the migrations differed from the
committed file by one line: `can_see_asset`, the function added by the F-4 ratings migration, was
missing. Nothing failed, because **a missing type is not a type error** — code calling that RPC was
simply untyped, and would have stayed that way.

So generation is now a command and agreement is a gate: `scripts/db-types.mjs write|check`, wired into
`npm run check` and into the `db.yml` validate job, which already boots a database from the migrations.
`check` **skips** when the local stack is down so `npm run check` still works offline; CI's run is the
enforcing one, and is the stronger check anyway — it compares the committed types against a schema
replayed from zero. On drift it prints which type lines differ, not a 900-line diff.

The old `db:types` script was a shell redirect, which would have written the CLI's error output into
the types file on failure. The script validates the output before writing.

#### The real duplication: one row, two implementations

Both apps read the `clients` row and both projected it into a domain object, separately:

| | desktop (before) | portal (before) |
| --- | --- | --- |
| row type | hand-written `DbClientRow` | generated `ClientRow` |
| columns read | 5 (`id,name,accent,slug,logo_url`) | all |
| `dimension_labels` | defaulted inline | defaulted inline, again |
| the accent column | called **`brandColor`** | called `accent` |

Every row of that table is a way for the two to disagree, and the third one is the sharp edge: a field
added for the portal was simply **absent on desktop, with nothing to say so**. A hand-written row type
cannot drift loudly.

Now there is one projection — `packages/database/src/clients.ts`:

- `ClientIdentity` — the portal-owned facts. Desktop's `Client` **extends** it and adds only what is
  machine-local (folder paths, per-machine destination toggles, OAuth tokens); the portal's `Client` in
  `@dc-hub/asset-library` **is** it, re-exported under the old name so no consumer changed. That is the
  standing goal in miniature: the portal as a slightly limited desktop, not a parallel implementation.
- `CLIENT_IDENTITY_SELECT` — one column list, so the two apps cannot read different subsets.
- `toDimensionLabels` — the defaulting, once. It defaults **each label independently**, because a client
  who renamed one dimension and left the others must keep that rename; all-or-nothing defaulting
  discards it. There were **four** copies of the `{ entity: 'Entity', … }` literals; now there is one.
- `dimensionLabelsToJson` — the one cast needed on the way back into a `Json` column, in one place
  instead of spelled differently at each write site.

`brandColor` → `accent`, so one column has one name. Safe without an on-disk migration, and checked
before doing it: `LocalClientConfig` never persisted it — it is re-derived from the row on every load.

`dimensionLabels` also became **required** on the shared type, since the projection always populates it.
That is what removes the fallbacks at the use sites rather than merely centralising them, and the
compiler found all four places that had been constructing a client without labels.

**14 tests** cover the projection, aimed at what the database actually hands over: `Json` that may be
any shape at all, nullable columns becoming `undefined` rather than leaking `null`, partial label
objects, and that `CLIENT_IDENTITY_SELECT` names every column the projection reads.

#### Two smaller drift removals

- `PortalClient` in `ClientPortalPage` was a hand-written mirror of `get_client_portal`'s return table;
  it now derives from the generated RPC type, so it is covered by the drift gate. Its nullability is
  restored explicitly — the generator reports function return columns as non-null, and `logo_url` /
  `portal_bg` are nullable on the table.
- The portal's deprecated `lib/database.types.ts` shim is deleted; its five importers now name
  `@dc-hub/database` directly.

⚠ **Left alone, with cause:** `get_client_portal` is executable by `anon` and returns six columns on
purpose, so the public portal page cannot read a client's renamed dimension labels. It defaults them.
Widening an unauthenticated surface for cosmetics is a security decision, not a refactor step — worth
raising separately if the labels matter on that page. `brandingService`'s `{ logo_url: string }` stays
hand-written: it is an edge-function HTTP response, not a row.

### Phase 4 — Observability & resilience (1 week)

- Route `reportError` (from Phase 0) to a real sink (Sentry or Supabase table) with breadcrumbs on pipeline stages.
- React **error boundaries** around portal routes and desktop views; user-facing error states instead of blank screens.
- **Guardrails on destructive ops**: dry-run + explicit confirm + summary before any mirror wipe / R2 delete (align with the "surface stale for confirmation" decision already made).
- _Exit criteria:_ a failed publish produces a diagnosable event and a clear user message; no destructive op runs without confirmation.

### Phase 5 — Hardening & polish (ongoing)

- Add **e2e** smoke (Playwright) for the portal's critical path: sign in → gallery → asset detail → rate/comment.
- **Bundle/dependency audit** (`npm audit`, unused deps), Rust `cargo clippy` in CI.
- **Coverage gate** (e.g. 70% on `domain` + `services`) enforced in CI.
- Document the **module boundaries** and the "prove-before-refactor" rule in `CONTRIBUTING`.

---

## 7b. Field-reported bugs

### F-7 — deleting a disconnected asset failed on a foreign key (fixed 2026-07-29)

Reported from dev while testing "delete disconnected assets":

```
update or delete on table "assets" violates foreign key constraint
"assets_variant_of_fkey" on table "assets"
```

**Cause: the two self-referencing keys on `public.assets` disagreed, by accident.**

| Constraint | Was | Effect |
| ---------- | --- | ------ |
| `assets_parent_id_fkey` | `ON DELETE CASCADE` | a gallery parent could be deleted; children cascaded |
| `assets_variant_of_fkey` | *no clause* | a primary could **never** be deleted while a variant referenced it |

`variant_of` simply never got an `ON DELETE` clause. Every affected row landed in the `blocked` list
the portal reports, with no way for an operator to clear it.

**Fixed with `ON DELETE SET NULL`, not `CASCADE`** — that choice is the substance of the fix.
Cascade would have deleted the variants along with the primary, and a variant is not derivative
filler: it is a full deliverable carrying its own ratings, comments, approvals and events. Crucially
a primary is just one FILE in a package folder, so it can vanish while its siblings remain — leaving
the primary `disconnected` while the variants are still live. Under cascade, purging that primary
would silently destroy live assets and their feedback, which is precisely what the sync's
soft-disconnect design exists to prevent.

With `SET NULL` the variant survives as a standalone asset and the grouping is recoverable: the next
pipeline run re-resolves identity from the `.dchub.json` manifest and rewrites `variant_of`
(`services/supabase/exportPlan.ts`).

`parent_id` keeps `CASCADE` deliberately, and that is not an inconsistency: a gallery CHILD is a
preview image inside a gallery folder, meaningless without its parent, and the two disconnect
together anyway because the folder either exists or it does not. The two relations genuinely
differ — which is the very distinction `exportPlan.ts` encodes when it chooses between them.

Migration `20260729130000_assets_variant_of_on_delete.sql`. Locked by a new pgTAP suite,
`supabase/tests/asset_relations.test.sql` (9 tests), which asserts both behaviours **and** the
`confdeltype` of each constraint, so a later migration cannot quietly flip either one. pgTAP total:
51 → 60.

---

### F-8 — CDN grant 401'd on a second pipeline run (fixed 2026-07-29)

Reported from dev, immediately after F-7:

```
✕ CDN steps disabled — Error: Storage grant refused (401): Not authenticated
```

The tell was **"worked, then failed on re-run"** — a first run inside the hour, a second outside it.

**Cause: the access token was read from a cache that nothing revalidated.** Three facts combined:

| | |
| - | - |
| `jwt_expiry = 3600` | a Supabase access token lives one hour |
| `makeHeaders()` read `currentAccessToken` | a module-level string, updated only when `onAuthStateChange` fired |
| `startAutoRefresh()` was **never called** | `stopAutoRefresh()` was called on teardown with no matching start, so nothing was running to stop |

supabase-js ties its automatic refresh ticker to browser visibility events, which a Tauri webview
does not deliver the same way. So the session quietly expired, the cached string stayed put, and
every request after that carried a dead token. The r2-grant edge function is simply the first thing a
run touches, which is why it surfaced there rather than as a generic sync failure.

**Fixed in three layers**, because each covers a different window:

1. **`getAccessToken()`** in `authService` — asks `client.auth.getSession()`, which checks the expiry
   and silently refreshes. `makeHeaders()` is now **async** and calls it, so headers always carry a
   token valid *at the moment of use* rather than at sign-in. (14 call sites updated.)
2. **`startAutoRefresh()` on mount** — so the ticker actually runs in the webview instead of relying
   on visibility events that never arrive.
3. **A single 401 retry in `sbFetch`** with a force-refreshed token. Headers are built once per
   operation while a pipeline run can take minutes, so a long run can cross the expiry *mid-flight* —
   layers 1 and 2 do not cover that. Bounded to one attempt, so a genuinely revoked session still
   surfaces as 401 instead of looping.

`getCurrentAccessToken()` was **deleted**: no production caller remained, and a synchronous read of
that cache is always potentially stale — exactly the footgun that caused this.

The pre-existing `supabaseSync.integration.test.ts` caught the contract change immediately (its
`authService` mock lacked the new export), which is the kind of signal a mocked boundary is for.

⚠ **Note for staging/prod:** this one is client-side, so unlike F-7 it needs a desktop release, not a
migration. Until then, the workaround is to restart the app before a run (a fresh sign-in mints a
fresh token).

### F-9 — `npm test` disconnected every asset in the local dev database (fixed 2026-07-30)

Reported from dev: the gallery showed two unfamiliar published assets and nothing else.

**Symptom.** All 17 real assets from the previous day's run sat at `status = 'disconnected'`, and two
fixture rows named `plyn` were published in their place.

**Cause.** `supabaseSync.integration.test.ts` runs against the real local stack whenever
`supabase start` is up — and it used **`CLIENT_ID = '…0001'`, the seeded dev client**. Stage 4 of the
sync is deliberately **client-wide**: it fetches every non-archived row for the client and marks
everything absent from the current run `disconnected` (see `exportDisconnect.ts`). Handed a
seven-asset fixture set, it therefore disconnected everything else the client owned — working as
designed, pointed at the wrong client. Every `npm test` did it again, and every run also left ~15
fixture rows behind, because each `wipe()` is a pre-clean and there was no `afterAll`.

Proof it was the tests and not a real disconnect: every affected row carried
`updated_at = 2026-07-30 09:34:16.693879+00` — the same transaction as the fixture writes at
`.689`/`.690`.

**Nothing was deleted.** Rows, ratings, comments and events survived; only `status` changed, which is
enough to hide an asset from the gallery.

**Fix.** The test now creates a **throwaway client of its own** in `beforeAll` and deletes it in
`afterAll`; the cascade on `assets_client_id_fkey` takes its rows with it. Verified: after a run,
zero fixture assets, zero fixture clients, and the dev client's rows untouched.

**Why this is worth a section.** The soft-disconnect design is exactly right — it exists so a
transient disk change cannot destroy an asset's history. The hazard is that an integration test which
shares a client inherits that client-wide authority. A test that writes to a real database must own
the tenant it writes to; sharing a seeded one makes `npm test` a destructive command.

---

## 8. Prioritized backlog (quick reference)

| #  | Item                                              | Impact              | Effort | Phase |
| -- | ------------------------------------------------- | ------------------- | ------ | ----- |
| 1  | ~~Cross-tenant RLS leak (F-1)~~ ✅                 | Critical (security) | S      | 0     |
| 2  | ~~ESLint + CI gate~~ ✅ (no Prettier pass)         | High                | S      | 0     |
| 3  | ~~`reportError` seam~~ ✅ CI-enforced              | Med                 | S      | 0     |
| 4  | ~~Pipeline characterization tests~~ ✅ 82          | Critical            | M      | 1     |
| 5  | ~~Domain unit tests~~ ✅ 84 (in `@dc-hub/domain`)  | High                | M      | 1     |
| 6  | ~~RLS integration tests~~ ✅ 51 pgTAP              | High                | M      | 1     |
| 4a | ~~F-4: scope `ratings` writes~~ ✅                 | High (security)     | S      | 1.5   |
| 4b | ~~F-5: key CDN maps by path~~ ✅                   | High (data)         | S      | 1.5   |
| 4c | ~~F-6: report name collisions~~ ✅                 | Med                 | S      | 1.5   |
| 4d | ~~Guest voting: one vote per asset~~ ✅ proven     | Med                 | S      | 1.5   |
| T1 | ~~Unify TypeScript + fix 4 real errors it hid~~ ✅ | High (correctness)  | S      | 2     |
| T2 | ~~Unify vite/vitest/node/react/supabase-js~~ ✅    | High                | S      | 2     |
| T3 | ~~`toolchain.mjs` drift gate (10 tools)~~ ✅       | High                | S      | 2     |
| 2a | ~~`@dc-hub/domain` + CI-enforced boundary~~ ✅     | High                | M      | 2     |
| 2b | ~~Split `pipelineService` 1894 → 92 + 12~~ ✅      | High                | L      | 2     |
| 2c | ~~Split `supabaseService` 1438 → 47 + 13~~ ✅       | High                | L      | 2     |
| 2d | ~~Split portal components~~ ⚠️ partial (AssetDetail) | Med               | M      | 2     |
| 2d-1 | ~~jsdom stack + AssetDetail's 6 hooks~~ ✅ 923→622  | Med               | M      | 2     |
| 2d-2 | Extract AssetDetail's JSX panels (622 → <400)     | Low                 | S      | 2     |
| 2c-1 | ~~Characterize + split `assetExport`~~ ✅ 489 → 156 | Med               | M      | 2     |
| A1 | ~~One workspace: desktop joined, 1 lockfile~~ ✅   | High (structural)   | M      | 2     |
| 7  | Rate-limit `asset_events` (F-2 partly done)       | Med                 | S      | 4     |
| 10 | ~~CI-generated DB types + one client projection~~ ✅ | High             | M      | 3     |
| 11 | Telemetry + error boundaries + op guardrails      | High                | M      | 4     |
| 12 | e2e smoke + clippy + coverage gate                | Med                 | M      | 5     |
| 13 | Docs: Nextra 2→4 (unblocks React 19 + workspace)  | Low                 | M      | 5     |

---

## 9. Notes & verification

- All metrics were measured directly against tracked files (git-tracked only), excluding build artifacts (`target/`, `node_modules/`, `.next/`).
- The RLS finding was confirmed by reading the full policy block in `20260711000000_baseline.sql`; the correct pattern already used by `version_history` is the recommended fix template.
- Secrets check confirmed `.env`/`*.env` under `scripts/environments/` and `supabase/functions/.env` are gitignored; only anon/publishable keys are tracked, and `environmentService.ts` actively rejects a pasted `service_role` key.
- Not reviewed (out of scope / no access): runtime behavior, production Supabase config, R2 bucket policies, GitHub Actions run history and secrets. GitHub access would let me verify CI history, open issues/PRs, and branch protection if useful.
