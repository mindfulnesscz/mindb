# Versioning

Sotto has **one application release version**. The root `package.json` is the canonical source for
the release-bearing manifests managed by `scripts/version.mjs`; do not edit those npm, Cargo, Tauri,
lockfile, or changelog versions by hand. Internal packages not listed below keep their own package
versions and are not rewritten by this command.

```bash
npm run version:patch       # X.Y.Z -> X.Y.(Z+1)
npm run version:minor       # X.Y.Z -> X.(Y+1).0
npm run version:major       # X.Y.Z -> (X+1).0.0
npm run version:set -- 2.5.0
npm run version:check
```

A bump updates, in one pass:

- npm manifests: `package.json` (canonical), `desktop/package.json`,
  `web/apps/client-hub/package.json`, `packages/asset-library/package.json`, `docs/package.json`, and
  `workers/cdn-gate/package.json`;
- the matching version entries in the two lockfiles: `package-lock.json` and
  `docs/package-lock.json`;
- `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml`, and the `sotto-app` package in
  `desktop/src-tauri/Cargo.lock`;
- `CHANGELOG.md` — a new section is inserted when one doesn't exist yet; replace the generated placeholder before committing

Version commands do not commit, tag, or push. The release path (branch-protected: `main` only accepts merges from `staging`): commit the bump on a branch → PR to `staging` → verify on staging → PR `staging → main` → merge → create the matching `vX.Y.Z` tag on the merge commit and push it. CI (`.github/workflows/version.yml`) rejects mismatched manifests and release tags.

The contributor-facing release checklist and drift recovery procedure are also available in the documentation site at `/reference/versioning`.
