// Flat ESLint config (ESLint 9+). Phase 0 of REFACTOR_PLAN.md.
//
// Wired into `npm run lint`, `npm run check`, and CI (.github/workflows/check.yml)
// with `--max-warnings 0`. The gate is a true zero: every remaining exemption is
// an explicit override block below with a reason, not an accumulating warning
// count. Formatting is Prettier's job (`npm run format`); eslint-config-prettier
// last disables every stylistic rule that would fight it.

import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    // Never lint build output, deps, generated types, or the stale compiled
    // .js sitting next to the .tsx sources (Vite builds from main.tsx).
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/out/**',
      '**/target/**',
      // Local tool scratch space. Both are gitignored, so they exist only on a machine that has run
      // `supabase start` or `wrangler dev` — which made `npm run lint` fail there with ~200 errors
      // in bundled vendor code while CI stayed green. A gate that is red only on developer machines
      // is a gate people learn to skip.
      '**/.temp/**',
      '**/.wrangler/**',
      // Same shape, same reason: bundled render engines fetched by `npm run deps:native`. The
      // extracted LibreOffice tree ships its own JavaScript, which produced 575 lint errors in
      // vendor code on any machine that had fetched it while CI stayed green.
      'desktop/src-tauri/resources/native/**',
      '**/*.d.ts',
      'packages/database/src/database.types.ts',
      'web/apps/client-hub/src/lib/database.types.ts',
      'web/apps/client-hub/src/**/*.js',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      // `_`-prefixed bindings are the codebase's "deliberately unused" marker —
      // honour it for args, vars, caught errors and array holes alike.
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // Error paths go through reportError(), never a bare console — see the
      // override below, which is what makes that seam enforceable.
      'no-console': ['warn', { allow: ['warn'] }],
    },
  },

  /* ── App code: browser globals, React hook correctness ────────────────── */
  {
    files: ['desktop/src/**/*.{ts,tsx}', 'web/apps/**/*.{ts,tsx}', 'packages/*/src/**/*.ts'],
    languageOptions: { globals: globals.browser },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // The correctness rule — a conditional hook call is always a bug.
      'react-hooks/rules-of-hooks': 'error',
      // Advisory and frequently intentional here (effects that must not re-run
      // on every store change). Revisit in Phase 2 when the views are split.
      'react-hooks/exhaustive-deps': 'off',
    },
  },

  /* ── @sotto/domain must stay platform-free ───────────────────────────────
     The whole value of this package is that the SAME rules run in the desktop pipeline,
     in the web portal, and (later) in a script or edge function with no shim. One
     `@tauri-apps/*` import would make it desktop-only; one React import would make it
     unusable outside a component tree. A comment cannot hold that line, so CI does.
     Shared UI belongs in @sotto/asset-library, which may depend on React. */
  /* Error contexts are sorted by CONCERN, not by file.
   *
   * `errors.log` is the only diagnostic once the app is a packaged binary, and the question it has to
   * answer is "where are the flaws — auth, syncing, display?". A context named after the function it
   * sits in cannot answer that, so every one carries a domain prefix and the location after it:
   *
   *     reportError('config.PipelineView.saveClients', e)
   *
   * which makes the log sortable:  cut -d'[' -f2 errors.log | cut -d. -f1 | sort | uniq -c
   *
   * Enforced here rather than documented, because a convention that only some call sites follow makes
   * the histogram lie. Add a domain to the list below when a genuinely new concern appears. */
  {
    files: ['desktop/src/**/*.{ts,tsx}', 'web/apps/*/src/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', {
        selector:
          "CallExpression[callee.name='reportError'] > Literal:first-child" +
          ":not([value=/^(auth|env|config|vocab|sync|os|feedback|asset|pipeline|cdn|ui)\\./])",
        message:
          'reportError context must start with a concern: auth. env. config. vocab. sync. os. ' +
          'feedback. asset. pipeline. cdn. ui. — e.g. reportError("config.PipelineView.saveClients", e). ' +
          'See eslint.config.js for why.',
      }],
    },
  },

  {
    files: ['packages/domain/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'react', message: '@sotto/domain must stay React-free — put shared UI in @sotto/asset-library.' },
        ],
        patterns: [
          { group: ['@tauri-apps/*'], message: '@sotto/domain must stay platform-free — pass the data in instead of reading it here.' },
          { group: ['@supabase/*'], message: '@sotto/domain must stay transport-free — the caller owns the client.' },
          { group: ['node:*', 'fs', 'path'], message: '@sotto/domain must not touch the filesystem — pass paths in as strings.' },
          { group: ['../../../*'], message: '@sotto/domain must not reach outside the package.' },
        ],
      }],
    },
  },

  /* ── reportError: the one place a raw console.error belongs ───────────── */
  {
    files: ['desktop/src/services/reportError.ts', 'web/apps/client-hub/src/lib/reportError.ts'],
    rules: { 'no-console': 'off' },
  },

  /* ── Node tooling: scripts and framework config files ─────────────────── */
  {
    files: [
      '**/*.mjs',
      '**/*.cjs',
      'scripts/**/*.js',
      '*.config.js',
      'docs/next.config.js',
      'desktop/vite.config.ts',
      'desktop/vitest.config.ts',
    ],
    languageOptions: { globals: globals.node },
    rules: {
      // These are CLIs — stdout IS the user interface.
      'no-console': 'off',
      // next.config.js is CommonJS by necessity.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  /* ── Supabase edge functions run on Deno, not Node ────────────────────── */
  {
    files: ['supabase/functions/**/*.ts'],
    languageOptions: { globals: { ...globals.deno, Deno: 'readonly' } },
    rules: { 'no-console': 'off' },
  },

  /* ── TODO(phase3): `(supabase as any)` casts ──────────────────────────────
     Every `any` in these files is a cast around the portal's untyped Supabase
     client. Phase 3 generates database.types.ts in CI and consumes it here;
     delete this block then — do not add files to it. */
  {
    files: [
      'web/apps/client-hub/src/features/portal/ClientPortalPage.tsx',
      'web/apps/client-hub/src/services/assetService.ts',
      'web/apps/client-hub/src/services/commentService.ts',
      'web/apps/client-hub/src/services/eventService.ts',
      'web/apps/client-hub/src/services/ratingService.ts',
    ],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },

  prettier,
)
