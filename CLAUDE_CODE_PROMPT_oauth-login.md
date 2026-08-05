# Claude Code handoff — OAuth login (GitHub → Google → SharePoint)

Working file for wiring up and testing OAuth sign-in on the DC Hub web portal.
Order: **GitHub first, Google second, Microsoft/SharePoint last** (needs a test
tenant). Delete or archive this file once all three are live.

---

## Callback architecture (the important part)

The OAuth provider callback is **always the Supabase project's callback**, not the
portal domain. So it's fixed per environment and never varies per client.

| Environment | Provider redirect URI (register this) |
|---|---|
| Local | `http://127.0.0.1:54321/auth/v1/callback` |
| Staging | `https://<staging-ref>.supabase.co/auth/v1/callback` |
| Production | `https://<prod-ref>.supabase.co/auth/v1/callback` |

**Per environment, yes** — because local, staging, and prod are three separate
Supabase projects with three refs, hence three callbacks.

**Provider-app strategy:**
- **GitHub** OAuth Apps allow only one callback each → create **one GitHub OAuth
  App per environment** (3 apps: local, staging, prod).
- **Google** and **Azure** allow multiple redirect URIs → **one app each**, listing
  all three callbacks.

**Client-hosted portal domains never touch the provider apps.** After auth,
Supabase redirects the user back to wherever the portal runs (`redirectTo`). That
target only needs to be in **Supabase's redirect allowlist**:
- Local: `supabase/config.toml` → `auth.additional_redirect_urls`
  (already wildcarded: `http://localhost:5173/**`, `http://127.0.0.1:5173/**`).
- Staging/prod: the project's **Auth → URL Configuration → Redirect URLs**
  (dashboard), or keep them in `config.toml` and `supabase config push` per project
  so the list is version-controlled.

**Adding a new client domain** (e.g. `https://hub.acme.com`): add
`https://hub.acme.com/**` to that project's redirect allowlist. Nothing else —
no provider change, no new callback. If clients live on your subdomains, a single
`https://*.disruptcollective.com/**` covers them all.

---

## What's already implemented (verify, don't rebuild)

- `web/apps/client-hub/src/context/AuthContext.tsx` → `signInWithProvider('azure'|'google'|'github')`, redirectTo defaults to the current portal URL.
- `web/apps/client-hub/src/features/auth/SignInModal.tsx` → "Continue with Microsoft/Google/GitHub" buttons above the email fallback.
- `supabase/config.toml` → `[auth.external.github|google|azure]` enabled with `env(...)` secrets; `additional_redirect_urls` wildcarded for local.
- Docs: `docs/pages/auth.mdx` (OAuth provider setup) and `docs/pages/cloud-storage/microsoft-setup.mdx` (SharePoint delivery).

---

## TASK 1 — GitHub OAuth, end to end (do this first)

1. Verify `web/apps/client-hub/src/lib/supabase.ts` creates the client with PKCE
   and `detectSessionInUrl` so the post-redirect `?code=` exchange completes on
   load. Fix if missing. Add an explicit auth-callback route only if needed.
2. Confirm the flow: clicking **Continue with GitHub** →
   `signInWithProvider('github')` → provider → Supabase callback → back to the
   portal, signed in. The email magic-link fallback must keep working.
3. Add an **"Adding a client domain"** section to `docs/pages/auth.mdx` documenting
   the redirect-allowlist step above (local via config.toml, staging/prod via
   dashboard or `supabase config push`), with the wildcard convention.
4. Local test setup (I will do the GitHub registration): give me the exact
   click-path to create a **GitHub OAuth App** with callback
   `http://127.0.0.1:54321/auth/v1/callback`, then the commands:
   ```
   export SUPABASE_AUTH_EXTERNAL_GITHUB_CLIENT_ID=…
   export SUPABASE_AUTH_EXTERNAL_GITHUB_SECRET=…
   supabase stop && supabase start   # preserves data; picks up env(...)
   npm run dev:web
   ```
5. Verification checklist: after signing in with GitHub, a row appears in
   `public.profiles` (Studio → Table editor); a whitelisted email domain →
   `role = 'member'` + `client_id`; otherwise `role = 'public'` for an admin to
   assign.

Constraints: don't break email magic link; keep desktop on magic link; run
`npm --prefix web run typecheck` before finishing.

## TASK 2 — Google (after GitHub works)

Same flow. Extra: the OAuth consent screen must have your email as a **test user**
while it's in "Testing". `skip_nonce_check = true` is already set for local Google
in config.toml. Register redirect URI = the same per-env Supabase callbacks in a
single Google Web OAuth client.

## TASK 3 — Microsoft / SharePoint (last, needs a test tenant)

Blocked on a Microsoft 365 test tenant with a SharePoint site. Then: register the
multi-tenant Entra app (or reuse the SharePoint one — see
`docs/pages/cloud-storage/microsoft-setup.mdx`), add the per-env Supabase callbacks
as **Web** redirect URIs, enable the `azure` provider in Supabase with
`login.microsoftonline.com/common`. Test both portal login and the desktop
SharePoint upload path (device-code connect → resolve drive → pipeline run →
> 250 MB file to exercise the resumable upload session).

---

## Staging / production rollout (once local is green)

For each of staging and prod:
1. Add that project's `…supabase.co/auth/v1/callback` to the provider app(s) — a
   new GitHub app for GitHub; an added redirect URI for Google/Azure.
2. Set the provider secrets in the project (dashboard → Auth → Providers, or
   `supabase secrets`/config push).
3. Ensure the portal origin(s) and any client domains are in that project's
   redirect allowlist.
