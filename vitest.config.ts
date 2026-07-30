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
    include: [
      'packages/*/src/**/*.test.ts',
      'web/apps/*/src/**/*.test.{ts,tsx}',
    ],
    // Component tests opt into jsdom per file with `// @vitest-environment jsdom`, so the
    // pure-logic suites keep running in plain node (they are ~10x faster there).
    setupFiles: ['./vitest.setup.ts'],
  },
});
