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

/* Addressable views — the one thing that cannot be verified anywhere but here.
 *
 * The unit suites drive a MemoryRouter, which has no address bar, no reload and no browser history. So
 * `page.url()`, `page.reload()` and `goBack()` are exactly what these five add: they answer "is the URL
 * really the state", which is a property of the browser, not of the component.
 *
 * Filters here are STATUS and LATEST, not tags. Both are always present in the rail — the status keys
 * are a fixed list and the toggle is unconditional — whereas the tag sections only render when the
 * client has a vocabulary, which would make the test depend on fixture data it does not own.
 *
 * The URL is asserted against `page.url()`, never a router value: navigating to an empty query can
 * leave a `"?"` in router state while the address bar shows a clean path, and the address bar is the
 * thing that gets copied into an email.
 */
test.describe('views are addressable', () => {
  /** A status checkbox in the filters rail, by its visible label. */
  const statusBox = (page: Page, label: string) =>
    page.locator('aside').first().locator('label', { hasText: label }).getByRole('checkbox');

  /** Status + latest applied, and the URL that resulted. */
  async function applyTwoFilters(page: Page) {
    await signIn(page);
    await page.goto(`/${FIXTURE_SLUG}`);
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('combobox', { name: 'Switch client' })
      .selectOption({ label: 'E2E Smoke (safe to delete)' });
    await expect(page.getByText(FIXTURE_ASSET_NAME).first()).toBeVisible({ timeout: 15_000 });

    await statusBox(page, 'Published').check();
    await expect(page).toHaveURL(/status=published/);
    await page.getByRole('switch', { name: 'Latest version only' }).click();
    await expect(page).toHaveURL(/latest=1/);

    return page.url();
  }

  test('a filtered view survives a reload', async ({ page }) => {
    const filtered = await applyTwoFilters(page);
    expect(filtered).toContain('status=published');
    expect(filtered).toContain('latest=1');

    await page.reload();

    await expect(page.getByText(FIXTURE_ASSET_NAME).first()).toBeVisible({ timeout: 15_000 });
    await expect(statusBox(page, 'Published')).toBeChecked();
    expect(page.url()).toBe(filtered);
  });

  test('opening an asset keeps the filters, and the drawer survives a reload', async ({ page }) => {
    await applyTwoFilters(page);

    await page.getByText(FIXTURE_ASSET_NAME).first().click();

    await expect(page).toHaveURL(/\/a\//);
    expect(page.url()).toContain('status=published');
    expect(page.url()).toContain('latest=1');

    // The whole point of the route: the drawer comes back on a cold load of the same address.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible({ timeout: 15_000 });
  });

  test('Back closes the drawer and leaves the filtered grid', async ({ page }) => {
    await applyTwoFilters(page);
    await page.getByText(FIXTURE_ASSET_NAME).first().click();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

    await page.goBack();

    await expect(page.getByRole('button', { name: 'Close' })).toBeHidden();
    expect(page.url()).toContain('status=published');
    await expect(statusBox(page, 'Published')).toBeChecked();
  });

  test('Back closes the lightbox and leaves the drawer open', async ({ page }) => {
    await applyTwoFilters(page);
    await page.getByText(FIXTURE_ASSET_NAME).first().click();
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();

    // The asset has no children, so the preview is its own thumbnail — one click into the lightbox.
    await page.locator('button.cursor-zoom-in').first().click();
    await expect(page).toHaveURL(/lb=1/);

    await page.goBack();

    await expect(page).not.toHaveURL(/lb=1/);
    // Back closed the lightbox, not the asset.
    await expect(page.getByRole('button', { name: 'Close' })).toBeVisible();
  });

  test('an asset URL sent to someone with no session hits the sign-in gate', async ({ page, browser }) => {
    await applyTwoFilters(page);
    await page.getByText(FIXTURE_ASSET_NAME).first().click();
    await expect(page).toHaveURL(/\/a\//);
    const shared = page.url();

    // A genuinely fresh context: no session, no storage, nothing warm.
    const other = await browser.newContext();
    const stranger = await other.newPage();
    await stranger.goto(shared);

    await expect(stranger.getByRole('button', { name: /Sign in/ })).toBeVisible({ timeout: 15_000 });
    // Not a crash and not a blank page — the branded welcome, as on the bare portal path.
    await expect(stranger.getByText('E2E Smoke', { exact: false })).toBeVisible();
    await other.close();
  });
});
