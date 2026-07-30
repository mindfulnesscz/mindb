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
     * ⚠ CALIBRATED WITHOUT A LOCAL SUPABASE STACK, which is the only baseline CI can reproduce.
     * `supabaseSync.integration.test.ts` skips when the stack is down, and it covers a lot of
     * `services/supabase/**` — so a developer with `supabase start` running measures several points
     * HIGHER than CI does. Thresholds taken from that richer local run fail the moment they reach CI,
     * which is exactly what happened on the first push (supabase/** measured 52% locally, 49% in CI).
     *
     * To reproduce the baseline before changing any number here:
     *
     *   npx vitest run --coverage --exclude='**\/supabaseSync.integration.test.ts'
     *
     * These numbers are LOW on purpose, and stating them honestly is the point: the services average
     * ~40% of lines, because the characterization work went where a silent failure costs a client's
     * deliverable (the pipeline stages, the Supabase sync, the cloud uploads) rather than everywhere.
     * `dam/` is ~16% and `services/` root ~14%; the plan's aspiration of 70% is real work still to do,
     * not a config value.
     *
     * What this gate buys today is that the number cannot fall. Raise it when tests are added.
     */
    coverage: {
      provider: 'v8',
      include: ['src/services/**/*.ts', 'src/features/**/*.ts'],
      exclude: ['**/*.test.ts', 'src/test/**'],
      thresholds: {
        'src/services/**': { lines: 39, statements: 39, branches: 31 },
        // Where a silent failure costs a published deliverable, so these carry a real bar.
        'src/services/pipeline/**': { lines: 57, statements: 56, branches: 44 },
        // Lower than the others look, because the integration test that covers much of this does not
        // run in CI. With a local stack up it measures ~52%.
        'src/services/supabase/**': { lines: 47, statements: 47, branches: 41 },
      },
    },
  },
});
