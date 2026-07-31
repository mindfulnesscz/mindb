-- What is currently exposed? — one-off audit, gated-delivery Phase 0.
--
-- Until 2026-07-31 every pipeline export path hardcoded `perm: 'public'`, overriding the
-- column's own `client` default on every write. Combined with R2 objects served from a public
-- bucket domain, that made the whole published library both DISCOVERABLE by anonymous portal
-- visitors and FETCHABLE by anyone holding the URL.
--
-- Phase 0 stopped new rows landing that way. This query answers what already did, so the
-- re-key in Phase 4 knows what it is dealing with. Read-only — it changes nothing.
--
-- HOW TO RUN THIS
--
-- Supabase dashboard -> your project -> SQL Editor. Paste the whole file, then SELECT the block
-- you want and press Run — the editor executes only the highlighted text, and shows one result
-- grid at a time. Running everything at once shows only the LAST block's result, which is why the
-- sections below are numbered and independent.
--
-- The SQL Editor connects as `postgres`, which bypasses RLS. That is required here: these queries
-- exist to count rows a normal session is not allowed to see.
--
-- (Prefer a terminal? `psql "$CONNECTION_STRING" -f <this file>` also works, but psql is not
-- installed on this machine by default.)

-- IMPORTANT, and worth saying out loud to whoever reads the numbers: a URL that has already
-- been published cannot be un-published. Anything counted below as having a CDN URL stays
-- reachable at that URL forever. Closing the hole means giving the object a NEW key and
-- treating everything published to date as permanently public.

-- ── 1. The headline: rows anonymous visitors can discover today ──────────────
select
  count(*)                                                     as rows_public,
  count(*) filter (where thumbnail_url is not null)             as with_thumbnail,
  count(*) filter (where download_url  is not null)             as with_original,
  count(*) filter (where jsonb_array_length(download_urls) > 0) as with_cloud_links
from public.assets
where perm = 'public';

-- ── 2. Every combination, per client ─────────────────────────────────────────
-- The grid the re-key works from: which client, which level, which lifecycle state.
select
  c.name                                        as client,
  a.perm,
  a.status,
  count(*)                                      as rows,
  count(*) filter (where a.thumbnail_url is not null) as thumbs,
  count(*) filter (where a.download_url  is not null) as originals
from public.assets a
left join public.clients c on c.id = a.client_id
group by c.name, a.perm, a.status
order by c.name nulls first, a.perm, a.status;

-- ── 3. Effective level — what SHOULD gate the bytes ──────────────────────────
-- `perm` says who may see it; `status` says where it is in its lifecycle. Both gate bytes:
-- an asset marked `public` while still in `draft` must serve to editors only. This is the
-- rule Phase 1 materialises as a generated column; here it is spelled out inline so the
-- numbers can be read before the migration exists.
select
  case when a.status in ('approved', 'published') then a.perm else 'internal' end as effective_level,
  count(*)                                                                        as rows,
  count(distinct a.client_id)                                                     as clients
from public.assets a
group by 1
order by 1;

-- ── 4. Assets whose perm and status DISAGREE ─────────────────────────────────
-- The interesting rows: marked world-readable but not signed off. Under the effective-level
-- rule these stop being public — expect these to move on re-key.
select
  c.name as client, a.status, count(*) as rows
from public.assets a
left join public.clients c on c.id = a.client_id
where a.perm = 'public'
  and a.status not in ('approved', 'published')
group by c.name, a.status
order by c.name nulls first, a.status;

-- ── 5. Distinct R2 objects already on the public domain ──────────────────────
-- Not "rows" but "objects": the permanently-public set. A thumbnail and an original are two
-- separate objects; `?v=<hash>` is cache-busting, not auth, so it is stripped here.
with urls as (
  select split_part(thumbnail_url, '?', 1) as url from public.assets where thumbnail_url is not null
  union all
  select split_part(download_url,  '?', 1) as url from public.assets where download_url  is not null
)
select
  split_part(replace(url, 'https://', ''), '/', 1) as host,
  count(distinct url)                              as distinct_objects
from urls
group by 1
order by 2 desc;
