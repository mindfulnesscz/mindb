import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const fromHere = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  // Mirrors the aliases in vite.config.ts: shared packages are consumed as raw TS, so the
  // test runner has to resolve them the same way the bundler does.
  resolve: {
    alias: {
      '@dc-hub/auth': fromHere('../packages/auth/src/index.ts'),
      '@dc-hub/database': fromHere('../packages/database/src/index.ts'),
      '@dc-hub/domain': fromHere('../packages/domain/src/index.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
