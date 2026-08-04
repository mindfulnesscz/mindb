# cdn-gate — byte-level access control for the asset library

`perm` on `public.assets` decides who can **discover** an asset and its URL. It has never decided
who can **fetch the bytes** — R2 objects served from a public bucket domain are bearer links, and
`?v=<hash>` is cache-busting, not authorization. This Worker is the missing half.

## Two tiers, two buckets

| Tier | Bucket | Hostname | Served by |
|---|---|---|---|
| public | `dc-hub-bucket` | `cdn.disruptcollective.com` | R2 custom domain, directly |
| gated | `dc-hub-gated` | `files.disruptcollective.com` | this Worker, the bucket's only door |

Two buckets rather than one bucket with a path exclusion, so the failure mode is **closed**: if
the route breaks or the binding is missing, gated objects 404. With a single bucket behind a public
custom domain, the same mistake publishes the whole library.

`dc-hub-bucket` keeps its existing keys and URLs untouched. Everything gated gets a **new key in a
new bucket on a new hostname** — which is the only real remedy anyway, because a URL that has
already been published cannot be un-published.

## The key IS the authorization

```text
files.disruptcollective.com/{level}/{client_id}/thumbnails/{stable_id}/{child_id}.webp
                            ^^^^^^^ ^^^^^^^^^^^
```

`{level}` is the **effective** level from `assets.effective_level`, not raw `perm`:

```text
effective_level = (status in ('approved','published')) ? perm : 'internal'
```

so an asset marked `public` while still in `draft` is written under `internal/` and serves to staff
only. Postgres computes the same value in a generated column, so discovery and delivery cannot
disagree. The price is that a `perm` or `status` change **moves the object** — bought deliberately,
because it is what keeps the read path free of lookups.

| Level | Who |
|---|---|
| `public` | anyone (should not appear in this bucket) |
| `guest` | anyone signed in — the level behind magic-link sign-in |
| `client` | members of that `client_id`, plus staff |
| `internal` | staff only (`editor` / `admin` / `super_admin`) |

## Routes

**`POST /auth`** — exchange a Supabase session for the CDN cookie. Send the user's access token as
`Authorization: Bearer …`; the Worker validates it against `/auth/v1/user`, reads the caller's own
profile row (RLS scopes it), and returns `Set-Cookie`. The token is **never** in the response body.
Body carries `{ level, client_id, expires_at }` so the portal can refresh before expiry.

**`DELETE /auth`** — clear the cookie on sign-out.

**`GET|HEAD /{level}/{client_id}/…`** — the hot path. Zero I/O beyond the R2 body.

The mint endpoint lives here rather than on a Supabase edge function for one hard reason: a cookie's
`Domain` must be a parent of the host that **sets** it. A response from `*.supabase.co` cannot set a
cookie for `.disruptcollective.com`, so the portal's `<img>` requests would never carry it. This
Worker is already on a sibling subdomain of the portal, so it can.

## Setup

```bash
npm ci --prefix workers/cdn-gate

wrangler secret put CDN_COOKIE_SECRET  --env production   # openssl rand -base64 48
wrangler secret put SUPABASE_URL       --env production
wrangler secret put SUPABASE_ANON_KEY  --env production

wrangler deploy --env production
```

Manual platform steps Wrangler cannot do:

1. Create the `dc-hub-gated` bucket (and `dc-hub-gated-staging`). **Do not** enable a public domain
   or `r2.dev` access on it — that is the whole point.
2. Add `files.disruptcollective.com` as a **custom domain** on the Worker (not a plain route), so
   Cloudflare provisions the certificate and the Cache API actually works.
3. Leave Smart Placement **off**. It moves a Worker toward its origin, which helps DB-bound
   Workers; this one makes no database call on the read path and belongs at the edge nearest the
   user.

## Development

```bash
npx vitest run workers/cdn-gate              # from the repo root
cp workers/cdn-gate/.dev.vars.example workers/cdn-gate/.dev.vars
npm --prefix workers/cdn-gate run dev        # wrangler dev on :8623, R2 simulated locally
```

`authz.ts` and `token.ts` are I/O-free by design, so the security matrix — every level against every
kind of caller, plus expired, absent, forged and cross-tenant tokens — runs in plain Node with no
workerd. That matters: a suite that needs a container is a suite that stops being run.

### The whole chain, locally

`wrangler dev` needs **no bucket** — the R2 binding is simulated. With `.dev.vars` pointing
`SUPABASE_URL` at the local stack, the full auth path works against real local sessions:

```bash
# a real session from the seeded local admin
TOKEN=$(curl -s -X POST "http://127.0.0.1:54321/auth/v1/token?grant_type=password" \
  -H "apikey: $LOCAL_ANON_KEY" -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.test","password":"sotto-local"}' | jq -r .access_token)

# seed a local object (note --local, not --remote)
npx wrangler r2 object put \
  dc-hub-gated-dev/internal/00000000-0000-0000-0000-000000000001/probe.txt \
  --file ./probe.txt --content-type text/plain --local

curl -i localhost:8623/internal/00000000-0000-0000-0000-000000000001/probe.txt   # 403
curl -i -X POST localhost:8623/auth -H "Authorization: Bearer $TOKEN"            # 200 + Set-Cookie
```

`COOKIE_DOMAIN` is `localhost` locally, and `localhost:5173` (portal) and `localhost:8623` (this
Worker) are **same-site** — ports do not affect SameSite — so the cookie really is sent on `<img>`
requests in a local browser. Set `VITE_CDN_GATE_URL=http://localhost:8623` in
`web/apps/client-hub/.env.local` to exercise the portal against it.

### What local dev cannot tell you

**The edge cache.** The Cache API does nothing in `wrangler dev`, and is a silent no-op on
`workers.dev` too — so `X-Cdn-Gate` reports `miss` forever locally. Cache behaviour is only real on
a custom domain, which means staging.

**The cross-subdomain cookie.** `hub.…` → `files.…` with `Domain=.disruptcollective.com` is a
different case from `localhost` → `localhost`, and it is the assumption the whole design rests on.
Confirm it on `staging.hub.disruptcollective.com`.

A *dev* custom domain does not close either gap for the browser path: `localhost:5173` and
`files-dev.disruptcollective.com` are cross-site, so the cookie would not be sent at all and you
would be pushed to `SameSite=None` and third-party blocking. Reproducing the real topology locally
would mean serving the portal from a `*.disruptcollective.com` hostname (a hosts entry plus a local
certificate) — possible, but staging gives it for free, and this project's convention is already
that day-to-day backend testing happens on shared staging.

## Bump `CACHE_EPOCH` when response headers change

Cached entries are stored `immutable, max-age=31536000` — a year — so they **survive a deploy**. A
Worker that starts emitting different headers keeps serving the old ones from the edge until they
age out, which is how the first staging deploy kept answering `Content-Range: bytes NaN-NaN/1500`
from cache after the bug that produced it was fixed.

`CACHE_EPOCH` is a segment of the cache key. Bump it in `wrangler.jsonc` for any change to response
shape and every entry is retired at once — no dashboard purge, no cache-purge API token.

Byte changes need no epoch bump: the cache key includes the query string, and the pipeline stamps
every URL with `?v=<content-hash>`. That is load-bearing, not incidental — the pipeline writes one
object per logical asset under a version-stable key, so a version bump **overwrites** that key and
the stamp is the only thing distinguishing new bytes from old. A cache key that dropped the query
would serve superseded bytes for a year.

## Measuring it

Anything about **caching or Range** must be measured on a real custom domain.

- The Cache API is a **silent no-op on `workers.dev`** — code that looks correct reports 100 % miss.
- `r2.dev` supports no caching at all, which is what staging uses today.

Both produce misleadingly slow numbers that then get "optimised" against.

| Path | Target added latency |
|---|---|
| public tier (no Worker) | 0 — unchanged |
| gated, browser cache hit | 0 — no network |
| gated, edge cache hit | ≤ 1 ms auth |
| gated, cache miss → R2 | ≤ 1 ms + normal R2 fetch |
| any per-request Supabase call on the read path | **forbidden** — 50–200 ms |

`X-Cdn-Gate: hit|miss` is on every object response for exactly this.

Numbers, once measured, go in `CLAUDE_CODE_PROMPT_gated-delivery-and-video.md`.

## Things that look like improvements and are not

**A token in the query string.** Gives every user a distinct cache key, fragmenting the edge cache
to near-zero hit rate and defeating the `?v=` immutable scheme. One cookie, identical URLs, one
cached copy shared by every authorized viewer.

**`Vary: Cookie` on object responses.** The bytes are identical for everyone the check let through,
so one entry serves all of them. Varying by cookie fragments per-user and silently destroys the hit
rate — silently, because everything still *works*.

**Caching the 403.** A refusal stored under an object's URL is later served to someone who *is*
authorized. Only bytes are cached, only keyed by path.

**A database or KV lookup on the read path.** A 50-tile grid must cost 50 signature verifications,
not 50 lookups. This is the single easiest thing to add by accident when a new requirement arrives,
and the single most damaging.

**Proxying video segments.** HLS playback is 100–300 segment requests per view. Cloudflare Stream
serves those from its own CDN with adaptive bitrate; routing them through here adds latency and cost
for no gain. Stream's signed URLs are the correct seam.

## Known limitation

Ephemeral `*.vercel.app` preview deployments **cannot** load gated objects. A cookie scoped to
`.disruptcollective.com` is never sent to `vercel.app`, and `SameSite=None` would walk straight into
third-party-cookie blocking. Gated content is testable on `staging.hub.disruptcollective.com`, which
shares the registrable domain. This is a property of the cookie design, not a bug to chase.
