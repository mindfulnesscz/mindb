/* The tenant this suite runs in, and the session it runs as.
 *
 * TWO RULES, both learned the hard way (see F-9 in REFACTOR_PLAN.md):
 *
 *   1. OWN YOUR TENANT. The suite creates its own client and its own assets and deletes them
 *      afterwards. It never touches the seeded dev client, because a developer's local database is
 *      their working state, and a test that shares a tenant destroys it eventually.
 *   2. LOCAL ONLY. The URL and service key here are the standard local Supabase demo values, written
 *      literally rather than read from the environment. A suite that signs in and writes rows must not
 *      be pointable at a real backend by setting a variable.
 *
 * Sign-in is done through the API rather than the UI. The portal's sign-in is a magic link, so driving
 * it would mean polling Mailpit for an email — a worthwhile test of the *email flow*, and the wrong
 * dependency for a smoke test of the gallery. The session is injected exactly as the app stores it, so
 * everything after that point is the real application.
 */

import type { Page } from '@playwright/test';

export const API = 'http://127.0.0.1:54321';

/** Local demo keys. Not secrets — they are printed by `supabase start` on every machine. */
export const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
export const SERVICE_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

/** From seed.sql. The password exists only on the local stack, by design. */
export const ADMIN_EMAIL = 'admin@acme.test';
export const ADMIN_PASSWORD = 'dchub-local';

export const FIXTURE_CLIENT_ID = 'eeeeeeee-1111-4eee-8eee-e00000000001';
export const FIXTURE_SLUG = 'e2e-smoke';
export const FIXTURE_ASSET_NAME = 'Smoke Test Deck';

const svc = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

/** True when the local stack answers. Everything here is skipped otherwise. */
export async function stackIsUp(): Promise<boolean> {
  try {
    const res = await fetch(`${API}/rest/v1/`, { headers: { apikey: ANON_KEY } });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export async function createFixtureTenant(): Promise<{ assetId: string }> {
  await destroyFixtureTenant();

  const client = await fetch(`${API}/rest/v1/clients`, {
    method: 'POST',
    headers: { ...svc, Prefer: 'return=minimal' },
    body: JSON.stringify({
      id: FIXTURE_CLIENT_ID,
      name: 'E2E Smoke (safe to delete)',
      slug: FIXTURE_SLUG,
      accent: '#2E6E4E',
      initials: 'ES',
    }),
  });
  if (!client.ok) throw new Error(`fixture client: ${await client.text()}`);

  // Published and client-visible, so it appears in the gallery for a signed-in member.
  const asset = await fetch(`${API}/rest/v1/assets`, {
    method: 'POST',
    headers: { ...svc, Prefer: 'return=representation' },
    body: JSON.stringify({
      client_id: FIXTURE_CLIENT_ID,
      shortcode: '(PRD)(SlD) Smoke',
      name: FIXTURE_ASSET_NAME,
      stable_id: 'ee000001',
      child_id: 'c1',
      status: 'published',
      perm: 'client',
      latest: true,
    }),
  });
  if (!asset.ok) throw new Error(`fixture asset: ${await asset.text()}`);
  const [row] = (await asset.json()) as Array<{ id: string }>;

  // The seeded admin must be a member of this client to see it in the gallery.
  await fetch(`${API}/rest/v1/client_members`, {
    method: 'POST',
    headers: { ...svc, Prefer: 'return=minimal' },
    body: JSON.stringify({
      user_id: '00000000-0000-0000-0000-0000000000ad',
      client_id: FIXTURE_CLIENT_ID,
    }),
  });

  return { assetId: row.id };
}

/** Deleting the client cascades its assets, memberships and feedback away. */
export async function destroyFixtureTenant(): Promise<void> {
  await fetch(`${API}/rest/v1/clients?id=eq.${FIXTURE_CLIENT_ID}`, {
    method: 'DELETE',
    headers: svc,
  });
}

/**
 * Sign in through the auth API and plant the session where the app looks for it.
 *
 * supabase-js stores under `sb-<project-ref>-auth-token`, deriving the ref from the URL's hostname. The
 * portal is configured with `localhost` while this file talks to `127.0.0.1`, and the exact derivation
 * is library-internal. Rather than depend on it, BOTH plausible keys are planted — an unused
 * localStorage entry costs nothing, and a wrong key would surface as "the app thinks it is signed out",
 * which reads like an application bug when it is a harness detail.
 *
 * `expectSignedIn` exists so that if this ever does break, it fails saying so.
 */
export async function signIn(page: Page): Promise<void> {
  const res = await fetch(`${API}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: ANON_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${await res.text()}`);
  const session = JSON.stringify(await res.json());

  await page.addInitScript(value => {
    for (const ref of ['localhost', '127']) {
      window.localStorage.setItem(`sb-${ref}-auth-token`, value as string);
    }
  }, session);
}
