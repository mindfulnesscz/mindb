import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke for the portal, against the LOCAL stack only.
 *
 * The URL and key below are the standard local Supabase demo values, and they are the only backend
 * this suite can reach — the same containment the sync integration test has. An e2e suite that could
 * be pointed at staging or production by an environment variable is one mistake away from writing test
 * data into a client's portal.
 *
 * `webServer` starts the portal's own dev server. Vite reads `.env.local`, which already points at the
 * local stack, so there is no second copy of the configuration to keep in step.
 */
export default defineConfig({
  testDir: './e2e',
  // A smoke suite that needs retries to be green is not telling the truth about the app.
  retries: 0,
  // Serial: the specs share one seeded tenant and one signed-in session.
  workers: 1,
  reporter: [['list']],
  timeout: 30_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL: 'http://localhost:5173',
    // Kept only for a failure — a passing smoke run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  webServer: {
    command: 'npm run dev --workspace=web/apps/client-hub',
    url: 'http://localhost:5173',
    // Reuse a dev server that is already running locally; always start a fresh one in CI.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
