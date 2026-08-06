# Sotto

Sotto is a monorepo for a local-to-cloud digital asset workflow with four applications:

- `desktop/` — Tauri 2 + React application that scans, transforms, distributes, and publishes assets;
- `web/` — React/Vite client portal backed by Supabase;
- `docs/` — Nextra documentation site;
- `workers/cdn-gate/` — Cloudflare Worker for authorized delivery of gated assets.

Shared TypeScript lives in `packages/`; database migrations, edge functions, pgTAP tests, seed data,
and local-stack config live in `supabase/`.

The repository shares one release version. Start with the [developer routine](docs/pages/getting-started/development.mdx) and browse the full documentation with `npm run dev:docs`.

## Quick start

Prerequisites: Node.js 24, npm, Rust stable, and the platform dependencies required by Tauri 2. Thumbnail
rendering needs no separately installed tools: `npm run setup` fetches the bundled engines (PDFium and
LibreOffice — `npm run deps:native` on its own). That download is ~290MB and ~800MB on disk; see
[Third-party engines](docs/pages/reference/third-party-engines.mdx).

```bash
git clone <repository-url> dc-hub
cd dc-hub
npm run setup
cp web/apps/client-hub/.env.local.example web/apps/client-hub/.env.local
npm run dev
```

`npm run dev` starts all four applications and prefixes their logs:

| Process | Development address |
|---|---|
| Desktop frontend/Tauri | `http://localhost:1420` plus the native window |
| Web portal | Vite's printed address, normally `http://localhost:5173` |
| Documentation | `http://localhost:3001` |
| CDN gate Worker | `http://localhost:8623` when Cloudflare remote bindings are available |

Press **Ctrl+C** once to stop the group. Start one application with `npm run dev:desktop`,
`npm run dev:web`, `npm run dev:docs`, or `npm run dev:gate`. The gate is optional during local
development because its remote R2 binding requires a Cloudflare login; the other three keep running
if it cannot start.

The web app runs with mock data when Supabase is not configured. To use real data, put the project URL and **anon key only** in `.env.local`. Desktop service-role, R2, and provider credentials are entered in the desktop Settings UI and must never be committed.

## Before opening a pull request

```bash
npm run check
npm test
npm run test:rust
```

`npm run check` is the zero-warning version, toolchain, generated-type, lint, TypeScript/build, docs,
and Rust-clippy gate. The automated suite is split by runtime: Vitest covers shared packages, portal,
desktop, edge policy, and the CDN Worker; Cargo runs Rust unit tests; Playwright exercises the portal
against a full local Supabase stack; and pgTAP tests database policies and constraints.

For changes to the portal, edge functions, or schema, start the full stack with `supabase start` and
run the relevant integration gates before opening the PR:

```bash
npm run smoke:functions
npm run test:e2e
npm run test:rls
```

CI runs `npm run check`, the Vitest coverage ratchet, Rust tests, and the full-stack edge/Playwright
smoke. Supabase-changing PRs additionally replay migrations and run pgTAP. A missing local stack is a
hard failure for the smoke commands, not a skipped success.

## Common commands

| Command | Purpose |
|---|---|
| `npm run setup` | Install the root-workspace and docs lockfiles, then fetch pinned native engines |
| `npm run dev` | Start desktop, web, docs, and the optional CDN gate together |
| `npm run build` | Build the three JavaScript applications/sites |
| `npm run check` | Run version, toolchain, types, lint, builds, Worker types, and Rust lint |
| `npm test` | Run the Vitest shared/package/portal/Worker suites and desktop suite |
| `npm run test:rust` | Run Rust unit tests |
| `npm run test:e2e` | Run the Playwright portal smoke against the full local stack |
| `npm run test:rls` | Run pgTAP database tests against the local stack |
| `npm run version:patch` | Increment the managed application-release patch version |
| `npm run version:minor` | Increment the managed application-release minor version |
| `npm run version:major` | Increment the managed application-release major version |
| `npm run version:check` | Fail when any manifest/changelog version drifts |

Release details are in [VERSIONING.md](VERSIONING.md). Product behavior and operating procedures live under [docs/pages](docs/pages).
