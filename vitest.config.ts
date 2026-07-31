import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/**
 * Tests for the shared `packages/*` live beside the code they cover, not inside an app —
 * shared logic must be verifiable without booting desktop or web. Desktop keeps its own
 * runner (desktop/vitest.config.ts) for anything that needs the Tauri mocks.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@dc-hub/asset-library': fromHere('./packages/asset-library/src/index.ts'),
      '@dc-hub/domain': fromHere('./packages/domain/src/index.ts'),
    },
  },
  test: {
    // Shared packages, plus the portal's DOM-free logic. Component rendering is not covered —
    // that needs a jsdom + testing-library stack and is tracked as backlog item 12.
    // The CDN gate Worker is here too: its authorization and token modules are deliberately
    // I/O-free, so the security matrix runs in plain node with no workerd. Anything that needs a
    // real R2 binding or the Cache API is a `wrangler dev` job — see workers/cdn-gate/README.md.
    include: [
      'packages/*/src/**/*.test.ts',
      'web/apps/*/src/**/*.test.{ts,tsx}',
      'workers/*/src/**/*.test.ts',
    ],
    // Component tests opt into jsdom per file with `// @vitest-environment jsdom`, so the
    // pure-logic suites keep running in plain node (they are ~10x faster there).
    setupFiles: ['./vitest.setup.ts'],

    /**
     * A RATCHET, not an aspiration.
     *
     * The thresholds sit just below what the suite achieves today, so the gate's only job is to stop
     * coverage going DOWN. A threshold set above the current number fails on day one, and a gate that
     * is red on day one gets commented out within a week — at which point it protects nothing.
     *
     * Raise these deliberately, as a change with its own commit, when tests are added.
     *
     * `include` is explicit so untested files count as zero. Without it only files a test imported are
     * measured, and deleting the last test for a module would make coverage go *up*.
     */
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/mock.ts', 'packages/database/src/database.types.ts'],
      thresholds: {
        // The shared rules both apps depend on — identity, naming, grouping. Highest bar in the repo,
        // because every asset in every client passes through them.
        'packages/domain/src/**': { lines: 85, statements: 80, branches: 70 },
        // The one client projection: small, and the failure mode is silent, so it stays near-total.
        'packages/database/src/clients.ts': { lines: 95, statements: 95, branches: 95 },
      },
    },
  },
});
