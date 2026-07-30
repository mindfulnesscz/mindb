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

    /**
     * A RATCHET at today's level — see the longer note in the root vitest.config.ts.
     *
     * These numbers are LOW on purpose, and stating them honestly is the point: the services average
     * ~42% of lines, because the characterization work went where a silent failure costs a client's
     * deliverable (the pipeline stages, the Supabase sync, the cloud uploads) rather than everywhere.
     * `dam/` is ~16% and `services/` root ~13%; the plan's aspiration of 70% is real work still to do,
     * not a config value.
     *
     * What this gate buys today is that the number cannot fall. Raise it when tests are added.
     */
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts', 'src/features/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/test/**'],
      thresholds: {
        'src/services/**': { lines: 40, statements: 39, branches: 31 },
        // Where a silent failure costs a published deliverable, so it carries a real bar.
        'src/services/pipeline/**': { lines: 55, statements: 55, branches: 43 },
        'src/services/supabase/**': { lines: 52, statements: 52, branches: 46 },
      },
    },
  },
});
