# DC Hub

DC Hub is a monorepo for a local-to-cloud digital asset workflow:

- `desktop/` — Tauri 2 + React application that scans, transforms, distributes, and publishes assets;
- `web/` — React/Vite client portal backed by Supabase;
- `docs/` — Nextra documentation site;
- `supabase/` — database migrations, seed, and local-stack config (Supabase CLI).

The repository shares one release version. Start with the [developer routine](docs/pages/getting-started/development.mdx) and browse the full documentation with `npm run dev:docs`.

## Quick start

Prerequisites: Node.js 22, npm, Rust stable, and the platform dependencies required by Tauri 2. Thumbnail development additionally needs LibreOffice, Poppler (`pdftoppm`), and WebP (`cwebp`).

```bash
git clone <repository-url> dc-hub
cd dc-hub
npm run setup
cp web/apps/client-hub/.env.local.example web/apps/client-hub/.env.local
npm run dev
```

`npm run dev` starts all three applications and prefixes their logs:

| Process | Development address |
|---|---|
| Desktop frontend/Tauri | `http://localhost:1420` plus the native window |
| Web portal | Vite's printed address, normally `http://localhost:5173` |
| Documentation | `http://localhost:3001` |

Press **Ctrl+C** once to stop the group. Start one application with `npm run dev:desktop`, `npm run dev:web`, or `npm run dev:docs`.

The web app runs with mock data when Supabase is not configured. To use real data, put the project URL and **anon key only** in `.env.local`. Desktop service-role, R2, and provider credentials are entered in the desktop Settings UI and must never be committed.

## Before opening a pull request

```bash
npm run version:check
npm run build:desktop
npm run check:web
npm run build:docs
npm run check:rust
```

`npm run check` runs the same commands in sequence. There is currently no automated unit/integration test suite, so changes also need focused manual verification. See [Daily developer routine](docs/pages/getting-started/development.mdx#before-opening-a-pull-request) for the appropriate smoke tests.

The current `2.3.0` web typecheck has five known pre-existing errors documented in the developer routine. Until those are resolved, compare your branch against that baseline rather than assuming `npm run check` is green on an untouched checkout.

## Common commands

| Command | Purpose |
|---|---|
| `npm run setup` | Reproducibly install all three lockfiles |
| `npm run dev` | Start desktop, web, and docs together |
| `npm run build` | Build the three JavaScript applications/sites |
| `npm run check` | Version, TypeScript/build, docs, and Rust checks |
| `npm run version:patch` | Increment the shared patch version everywhere |
| `npm run version:minor` | Increment the shared minor version everywhere |
| `npm run version:major` | Increment the shared major version everywhere |
| `npm run version:check` | Fail when any manifest/changelog version drifts |

Release details are in [VERSIONING.md](VERSIONING.md). Product behavior and operating procedures live under [docs/pages](docs/pages).
