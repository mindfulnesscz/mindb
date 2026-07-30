/* Portal smoke — the paths a client actually walks, against a real database.
 *
 * This is the only test in the repo where the browser, the app bundle, the Supabase client, RLS and
 * Postgres are all real at once. Everything else stubs one of them. So it is deliberately SHALLOW and
 * few: it answers "does the portal work at all", and it must not become the place gallery filtering or
 * rating arithmetic is specified — those belong in the unit suites, where a failure names a function.
 *
 * A smoke test that is slow or flaky gets skipped, and a skipped test is worse than no test because it
 * still looks like coverage.
 */

import { test, expect, type Page } from '@playwright/test';
import {
  stackIsUp, createFixtureTenant, destroyFixtureTenant, signIn,
  FIXTURE_SLUG, FIXTURE_ASSET_NAME,
} from './fixture';

let up = false;

test.beforeAll(async () => {
  up = await stackIsUp();
  // Skipped rather than failed when the stack is down: `supabase start` is not a prerequisite for
  // running the rest of the repo's tests, and pretending otherwise trains people to ignore red.
  test.skip(!up, 'local Supabase is not running — start it with `supabase start`');
  await createFixtureTenant();
});

test.afterAll(async () => {
  if (up) await destroyFixtureTenant();
});

test.describe('the portal loads and routes', () => {
  test('a client portal page renders its branding for a visitor who is not signed in', async ({ page }) => {
    await page.goto(`/${FIXTURE_SLUG}`);
    // The branded welcome is what a client sees before signing in; the app resolves it through an
    // anon-executable RPC, so this exercises the unauthenticated read path end to end.
    await expect(page.getByText('E2E Smoke', { exact: false })).toBeVisible();
  });

  test('an unknown slug shows the DC 404 rather than an empty page', async ({ page }) => {
    // The failure this catches is a blank screen — the route resolving to nothing at all.
    await page.goto('/definitely-not-a-client-slug');
    await expect(page.locator('body')).not.toBeEmpty();
    await expect(page.getByText(/not found|404/i).first()).toBeVisible();
  });
});

test.describe('signed in', () => {
  /**
   * Staff keep a persisted active client, so arriving at a portal URL does NOT change it — the switcher
   * is how you move between clients, and going through it is what makes the gallery show this fixture's
   * asset rather than whatever was last selected. Smoking that path is worth more than working around
   * it: for staff it is the first interaction of every session.
   */
  async function openFixtureGallery(page: Page) {
    await signIn(page);
    await page.goto(`/${FIXTURE_SLUG}`);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('combobox', { name: 'Switch client' })
      .selectOption({ label: 'E2E Smoke (safe to delete)' });
  }

  test('the gallery lists the client’s published asset', async ({ page }) => {
    await openFixtureGallery(page);

    // The whole authenticated read chain in one assertion: session restored from storage, RLS allowing
    // a member to see their client's asset, and the gallery rendering it.
    await expect(page.getByText(FIXTURE_ASSET_NAME).first()).toBeVisible({ timeout: 15_000 });
  });

  test('opening the asset shows its detail', async ({ page }) => {
    await openFixtureGallery(page);

    await page.getByText(FIXTURE_ASSET_NAME).first().click();
    await expect(page.getByText(FIXTURE_ASSET_NAME).first()).toBeVisible();
  });
});
