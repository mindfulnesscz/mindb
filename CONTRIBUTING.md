# Contributing to Sotto

This repo holds four things that ship together: a Tauri 2 desktop app, a React portal, a Nextra docs
site, and the Supabase schema they share. The rules below are the ones that are expensive to
rediscover — most were learned by getting them wrong first, and the incidents are written up in
`REFACTOR_PLAN.md` §7b.

---

## The rule that matters most

**Prove behaviour before changing structure.**

Every large change in this codebase followed the same order: write tests that pin what the code does
*today* — bugs included — then move the code, then check that no test needed editing. A test that had
to be adjusted to accommodate a refactor was not a characterization test; it was a description of the
new code written after the fact.

This is why `pipelineService` could go from 1,894 lines to 92 without a regression, and why splitting
`damService` was safe only *after* 17 tests existed for it. If you are about to restructure something
with no tests, the first commit is the tests.

---

## Layout, and which layer owns what

```
packages/domain          platform-free product rules — identity, filename grammar, grouping
packages/database        generated Supabase types + the one clients-row projection
packages/auth            the shared Supabase auth client
packages/asset-library   shared presentational types and components
desktop/                 the Tauri app: pipeline, DAM builder, cloud export
web/apps/client-hub      the portal
supabase/                migrations, seed, pgTAP tests
docs/                    Nextra site (outside the npm workspace — see below)
```

**`packages/domain` must stay platform-free.** No `react`, no `@tauri-apps/*`, no `@supabase/*`, no
`node:*`, no reaching outside the package. This is enforced by `no-restricted-imports` in
`eslint.config.js`, not by convention — CI fails on a violation. The reason is directional: the portal
is meant to become a slightly limited desktop, and anything that already works on both sides belongs
where both can reach it.

**Anything derived from a database row belongs in `packages/database`.** Desktop and the portal both
read the `clients` row; when each projected it separately they drifted — different column lists,
different defaults, and the same column called `accent` on one side and `brandColor` on the other. One
projection, `toClientIdentity`, is now the only one.

**Do not hand-write a row type.** `database.types.ts` is generated (`npm run db:types`) and a CI job
fails if it drifts from a schema replayed from the migrations. A hand-written row interface cannot
drift *loudly*: a missing type is not a type error, so the code just silently stops being checked.

---

## Working with the database

```bash
supabase start          # the local stack
npm run db:types        # regenerate types after a migration
npm run test:rls        # pgTAP: tenant isolation, role gates, relation constraints
```

- **Migrations are forward-only.** Write a new one; never edit an applied migration.
- **Never run `supabase db reset` on a machine you share with your own dev data.** It reseeds, which
  means everything you had is gone. `supabase migration up` applies what is new without touching your
  rows. (This has cost real data here more than once.)
- **RLS changes need pgTAP tests.** The suite caught a `security definer` function that was strictly
  more permissive than the read policies it mirrored — a review would not have.

### Tests that touch a real database must own their tenant

A test that writes to the local stack **creates its own client and deletes it afterwards**. It never
uses the seeded dev client.

This is not tidiness. The asset sync's disconnect stage is client-wide by design: everything absent
from the current run is marked stale. Pointed at the client a developer is working in, a single
`npm test` marks every one of their assets `disconnected`. That happened (F-9). `assets_client_id_fkey`
cascades, so deleting the fixture client is all the cleanup needed.

---

## Tests

```bash
npm test                # shared packages + portal, then desktop
npm run test:coverage   # the same, with the coverage ratchet applied
npm run test:rust       # SigV4 date maths, URI encoding, OAuth authority resolution
npm run test:rls        # pgTAP
npm run test:e2e        # Playwright smoke against the local stack
```

- **Unit tests are hermetic.** Desktop has three in-memory harnesses in `desktop/src/test/`: `vfs`
  (Tauri FS with a mutation log), `invokeStub` (the Rust bridge), and `fetchStub` (the cloud
  providers' `fetch`). Use them rather than reaching for the network or the disk.
- **Coverage is a ratchet, not a target.** The thresholds in `vitest.config.ts` sit just under today's
  numbers so they can only be raised. They are honest about where the repo is: desktop services average
  ~40% of lines. Raise a threshold in its own commit when you add tests.
- **Calibrate thresholds WITHOUT a local Supabase stack.** `supabaseSync.integration.test.ts` skips
  when the stack is down and covers a lot of `services/supabase/**`, so a machine running
  `supabase start` measures several points higher than CI ever will. Numbers taken from that richer run
  fail on push. Reproduce the CI baseline with `npm run test:coverage:ci` before changing any threshold.
- **The e2e suite is deliberately shallow.** It is the only place the browser, the bundle, RLS and
  Postgres are all real at once, which makes it the slowest and most fragile thing here. It answers
  "does the portal work at all". Filtering rules and rating arithmetic belong in unit tests, where a
  failure names a function.
- **Explain *why* in test names and comments.** A test called "handles empty input" is worth less than
  one that says what breaks for a user if it regresses. Most tests here name the consequence.

---

## Toolchain

One npm workspace, one lockfile, exact versions everywhere:

```bash
npm run toolchain:check                 # fails on any range or disagreement
npm run toolchain:set typescript 5.9.4  # bump one tool across every manifest, then reinstall
```

Ranges (`^`, `~`) are how two installs drift apart while both look correctly configured. That is not
hypothetical: two TypeScript versions once disagreed about real code, and four genuine type errors were
invisible under one of them.

`docs/` is **outside** the workspace on purpose. Nextra 2's loose `next >= 9.5.3` peer resolves a second
copy of Next, and `next-seo` then imports `next/head` across the split. Joining it is blocked on the
Nextra 2 → 4 upgrade.

---

## Before you push

```bash
npm run check   # versions, toolchain, DB types, lint, builds, clippy
npm test
```

Both are what CI runs. `npm run check` skips the database-type gate when the local stack is down, so
run `supabase start` if you touched the schema.

### Errors

Never write a bare `console.error`. Use `reportError(context, err)` — `no-console` is disabled *only*
in those two files, which is what makes a stray one fail CI instead of quietly swallowing a failure.

**Contexts are prefixed by concern**, enforced by a lint rule: `auth.` `env.` `config.` `vocab.`
`sync.` `os.` `feedback.` `asset.` `pipeline.` `cdn.` `ui.` — e.g.
`reportError('config.PipelineView.saveClients', e)`. The prefix is what makes the log answer "where are
the flaws" rather than "which function threw".

Where reports go:

- **`public.app_errors`** in whichever backend the app is pointed at, so a staging failure lands in
  staging. Anyone may report (a failed sign-in is exactly the error worth capturing); only
  **super admins** may read, because messages quote asset names and paths and this is maintainer data
  rather than client data. Rate-limited per context like `asset_events`.
- **Portal → Admin → Errors** (super admin only) groups them by concern, flags first-time signatures,
  and manages the Slack destinations.
- **`errors.log`** on desktop as well, under the app data directory, reachable from Settings →
  Diagnostics. A packaged binary has no console for an operator to open, and the file works offline.
- Query with `select * from error_digest('24 hours')`; the migration has a `pg_cron` snippet for a
  scheduled webhook.

Reporting never throws and is never awaited — nearly every caller is a `.catch()` on a fire-and-forget
write, so a failure to report must not replace the error being reported.

### Destructive operations

Bulk deletion goes through `assessDestruction` (`desktop/src/services/guardrail.ts`). The invariant is
that **a run must not destroy more than it wrote**. Every bulk-destructive stage here is driven by a
diff, and a diff is only as good as the set it diffs against — when that set is wrong the diff is not
slightly wrong, it is inverted. If you add a stage that deletes in bulk, gate it the same way.

---

## Commits and branches

`dev` → `staging` → `main`. Migrations deploy from `staging` and `main` via `db.yml`; the portal follows
the same branches through Vercel; desktop releases ride `v*` tags.

Pull requests run the browser smoke suite against an isolated local Supabase stack in GitHub Actions.
The merge push to `dev` does not repeat that database-backed job, and no workflow links `dev` to a
remote Supabase project. Pushes to `staging` and `main` rerun the smoke alongside their separate
deployment workflows. CI pins the Supabase CLI version so checks do not depend on resolving the
latest GitHub release.

Write commit messages that explain **why**, including what you considered and rejected. The git log here
is used as an engineering record — several decisions in this codebase are only recoverable from it.
