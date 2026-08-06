# 00a — Auth: a failed OAuth return silently signs you in as the previous user

> **Status 2026-08-06: A1 and A2 are LANDED in 3.2.2.** A3 is deferred and two manual production
> steps are still open. Details at the bottom, under [Landed](#landed-2026-08-06) — read that before
> re-running anything from this file.

Prepend the **SHARED CONTEXT block** from `DONE_01_security-hardening-S0-S7.md`.

**Priority: first in the 3.2.2 block.** This is the only open item that can present, to a live
client, as "I signed in and I'm looking at someone else's account." It is indistinguishable at the
UI from a real cross-tenant leak, which is exactly the class of failure the S0–S7 work exists to
make impossible.

_Filed 2026-08-06 after a prod GitHub sign-in resolved to `xvmucha@vutbr.cz`, an account created
minutes earlier while testing Google._

---

## What triggered this (and what turned out not to be the bug)

Signing in with **GitHub** on prod (`knbxyaplaoenrxrpgwcg`) landed on the Google test user
`xvmucha@vutbr.cz`. Ruled out by evidence, in order:

- **Not a provider misconfiguration.** Live GoTrue settings on prod report
  `"external": { "azure": true, "github": true, "google": true }`. GitHub is enabled and
  credentialed; the flow is not erroring at the provider.
- **Not an app-side identity bug.** `SignInModal` -> `AuthContext.signInWithProvider`
  (`AuthContext.tsx:140-148`) -> `@sotto/auth.signInWithProvider` (`packages/auth/src/index.ts:108-118`)
  is a clean pass-through to `signInWithOAuth`. Nothing in the repo chooses a user.

**Actual cause of the observed symptom (A2 below):** GoTrue (prod is on v2.193.1) automatically
links a new OAuth identity to an existing user when the provider returns a **verified email** that
already belongs to one. The Google test created the user; GitHub then reported the same verified
address (`read:user user:email` scope, `packages/auth/src/index.ts:99-103`) and GoTrue attached a
`github` identity to that existing user rather than creating a new one. Same `user.id` -> same
`profiles` row, role, and `client_id`. Intended GoTrue behaviour, no toggle on hosted Supabase
(`enable_manual_linking` is a different feature — the manual link API).

That part is working as designed. **What is not** is everything in A1: while chasing this, the
portal turned out to have no way to tell a failed sign-in from a successful one.

---

## A1. A failed auth return is invisible — the stale session takes its place

**The defect.** Three things compose into a silent wrong-user state:

1. `AuthContext` trusts whatever is in storage. `supabase.auth.getSession()` (`AuthContext.tsx:65`)
   resolves the persisted session and `fetchProfile` renders the app around it. Nothing
   distinguishes "restored a valid old session" from "just failed to establish a new one".
2. Nothing clears the current session before an OAuth redirect. `signInWithProvider`
   (`AuthContext.tsx:140-148`) calls straight through to `signInWithOAuth`; the previous user's
   token is still in `localStorage` under `sb-<ref>-auth-token` when the browser comes back.
3. The `?code=` exchange is delegated to `detectSessionInUrl: true` (`lib/supabase.ts:51`), and
   supabase-js swallows an exchange failure — no throw, no `onAuthStateChange`, no error anywhere
   the app can see it. A missing/mismatched PKCE verifier, a `redirectTo` outside the allow-list, or
   a provider-side denial all land here.

**Why the existing error handling doesn't catch it.** Both surfaces parse `error=` out of the URL
hash — `AdminSignIn.tsx:29-36` and `ClientPortalPage.tsx:221-234` — but **neither component renders
when a session was restored.** The signed-in tree mounts instead (`AdminLandingPage.tsx:226` prints
`You're signed in as {session.user.email}`), the hash is never read, and the error is dropped. The
handler only fires in the one case where the user was already signed out.

**Failure mode in front of a client:** an editor at client A, previously signed in, clicks *Continue
with Microsoft*, the return fails for any reason, and the portal shows them still signed in as
whoever last used that browser — with that user's tenant, assets, and role. No error, no signal.

**Do:**

- Handle the auth return **at app level, before any session is trusted** — not inside two leaf
  components. On mount, if the URL carries `error=` / `error_description` (hash **or** query, GoTrue
  uses both depending on the failure), treat it as an authentication failure:
  `signOut({ scope: 'local' })` to drop the stale token, clear the URL, render the sign-in surface
  with the message.
- Stop relying on `detectSessionInUrl`'s silent path for the success case. Detect `?code=`
  explicitly and `await exchangeCodeForSession(...)`, so a failed exchange is a value the app can
  branch on. Keep the flag or drop it, but the failure must be observable.
- Invalidate the old session **before** redirecting to a provider (`signInWithProvider`). A
  deliberate re-auth should never silently resolve backwards to the prior user.
- Surface a real error state in `AuthContext` (e.g. `authError`) so `AdminSignIn` and `SignInModal`
  render one message from one source, and delete the two duplicated hash-parsing effects. Preserve
  `ClientPortalPage`'s query-string-keeps/hash-strips behaviour — the comment at `:228-233` explains
  why the filtered URL must survive, and that reasoning still holds.

**Regression test (the point of the exercise).** `@testing-library/react` is already a dependency.
Mount the app with (a) a valid session in storage and (b) `#error=access_denied&error_description=...`
in the URL; assert the sign-in surface renders with the error and the signed-in tree does **not**.
Add the mirror case: stale session + `?code=` whose exchange rejects -> sign-in surface, not the old
user. Both are red today.

## A2. Identity linking is undocumented, and the docs say something subtly untrue

Not a code change — a doc fix and a rule, so the next person doesn't spend an afternoon on it.

`docs/pages/auth.mdx:7` says OAuth returns a verified email "so the domain-whitelist trigger below
still maps them to a client and role." True only on the sign-in that **creates** the user. Once a
user exists, a second provider with the same verified email links into it and inherits the original
`role` and `client_id`; `handle_new_user` never runs again. The provider someone signs in with does
not determine their tenant — the provider that first created them does.

**Do:**

- Document automatic identity linking in `docs/pages/auth.mdx`: same verified email = same user
  regardless of provider; the whitelist trigger is first-sign-in-only; there is no hosted toggle.
- Add the operational rule to the same page: **do not exercise providers against production.** Use
  staging (`tvrxnwbhzborkkkdeyuk`) with a distinct email per provider.
- Note for support: "signed in with the wrong provider" is usually one user with two identities, not
  two users.

## A3. Identities aren't visible anywhere in the product (optional, do if cheap)

Diagnosing A2 required the Supabase dashboard because the admin UI shows email only
(`UsersView.tsx:119`). Add linked-provider badges to the admin user row. Small, and it turns the
next instance of this from a dashboard expedition into a glance.

---

## Immediate unblock (before the code work — 2 minutes)

1. Prod dashboard -> Authentication -> Users -> `xvmucha@vutbr.cz` -> confirm it carries **both**
   `google` and `github` identities, then **delete the user**. The next GitHub sign-in provisions
   cleanly through `handle_new_user`.
2. Sanity-check the collision source: github.com/settings/emails — a `@vutbr.cz` address is very
   likely present and primary (the GitHub Student Developer Pack requires a verified university
   email). GoTrue takes the primary verified one.
3. Re-test providers on **staging**, one distinct email each.

---

## Definition of done

- A failed auth return renders the sign-in surface with the provider's error and **no** session —
  verified for provider denial, expired magic link, and a rejected `?code=` exchange, each with a
  valid stale session present in storage.
- The two duplicated hash-parsing effects are replaced by one app-level path; the portal's
  keep-query/strip-hash behaviour is preserved.
- Both regression tests land, red before the fix and green after.
- `docs/pages/auth.mdx` documents automatic identity linking, the first-sign-in-only whitelist
  trigger, and the no-testing-on-prod rule.
- The `xvmucha@vutbr.cz` test user is gone from production.
- `npm run check` green.

---

## Landed (2026-08-06)

### A1 — done

The auth return is resolved in one place, `web/apps/client-hub/src/lib/authReturn.ts`, called by
`AuthProvider` **before** the persisted session is read. Parsing and URL cleanup are pure functions
over an href; only `resolveAuthReturn` touches the client.

- `lib/supabase.ts` now builds the portal client with **`detectSessionInUrl: false`**. Keeping it on
  was not an option: it spends the `?code=` before any of our code runs, so the explicit exchange and
  the flag race and whichever loses reports an empty verifier. The two must stay in step — comments
  in both files say so.
- Failure of any kind → `signOut({ scope: 'local' })` + `AuthContext.authError`. Errors are read from
  **both** the query and the hash, error before code (a URL carrying both is a failure that happens
  to still have a code in it).
- `AuthContext` resolves the return, then `getSession()`, then subscribes. The ordering is the fix:
  `onAuthStateChange` replays the current session to every new subscriber as `INITIAL_SESSION`, so
  subscribing first would render the app around the previous user while the failed return was still
  unexamined.
- `signInWithProvider` drops the local token before redirecting.
- The two hash-parsing effects are gone. `AdminSignIn`, `SignInModal` and `ClientPortalPage` render
  `authError`; none reads `window.location`. The portal's keep-query/strip-hash behaviour moved into
  `cleanAuthUrl` — and note `type` is `FILTER_PARAMS.entityTypes`, **not** GoTrue's `type`, so it is
  deliberately not stripped.

Tests: `src/lib/authReturn.test.ts` (15 cases — parsing, cleanup, exchange outcomes) and
`src/context/AuthContext.authReturn.test.tsx`. The latter is the one the brief asked for: a stale
valid session plus `#error=access_denied…`, and a stale valid session plus a `?code=` whose exchange
is refused — each asserting the sign-in surface renders with the message and the previous user's
email does not appear. **Verified red before the fix** (both rendered "Staff access only … signed in
as `previous@other-tenant.test`") and green after. A third case is a control: an ordinary load still
restores the session, so a "fix" that merely stopped trusting storage cannot pass.

`lint`, `typecheck`, `test:packages` (729), `test:desktop` (455), `build:docs` all green.

### A2 — done

`docs/pages/auth.mdx` gained **One user, many identities** (same verified email = same user
regardless of provider; `handle_new_user` is first-sign-in-only; no hosted toggle; the support note;
the GitHub-primary-address trap) and **Returning from a redirect** (why `detectSessionInUrl` stays
false, why components must not parse the URL, the keep-query/strip-hash rule). The
"still maps them to a client and role" sentence now says *on the sign-in that creates the user*.
`docs/pages/web-portal/authentication.mdx` cross-links both. The no-testing-on-prod rule was already
in `planning/00_START_HERE.md`; it is now in the product docs too.

### A3 — deferred, deliberately

Not cheap. `auth.identities` is not reachable from the anon/authenticated client, so linked-provider
badges need `get_all_profiles` widened to aggregate it — a new migration, a `db:types` regen, and a
second migration in a hotfix whose changelog documents exactly one. It is not in this brief's
definition of done. Worth doing in a normal release; the docs now tell support where to look in the
dashboard in the meantime.

### Still open — manual, production

Neither is a code change and neither is done:

1. Delete the `xvmucha@vutbr.cz` test user in the **production** dashboard (confirm it carries both
   `google` and `github` identities first). The next GitHub sign-in then provisions cleanly through
   `handle_new_user`.
2. Re-test the three providers on **staging** (`tvrxnwbhzborkkkdeyuk`), one distinct email each.
