-- Families whose access levels disagree — gallery parents vs their children, primaries vs variants.
--
-- A gallery is ONE deliverable rendered as a grid, and a variant set is ONE deliverable rendered as
-- a picker. Both are stored as several rows, and `perm` lives on each row independently. Nothing
-- keeps them in step, which produces two failure modes:
--
--   parent WIDER than children   the card is visible and the contents are not — a client sees a
--                                gallery of 60 photos as an empty grid, and complains
--   parent NARROWER than children  a leak: the children are reachable at a broader level than the
--                                thing that is supposed to be gating them
--
-- Both became likely on 2026-07-31, when the pipeline's create-time default changed from `public`
-- to `client` while `perm` became insert-only (so existing rows keep their old value). A pipeline
-- run after that change creates NEW child rows at `client` under EXISTING parents still at `public`.
-- That is exactly the first failure mode, and it is what "as a guest I only see the first item of a
-- gallery" looks like from the portal.
--
-- Read-only; it changes nothing.
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

-- ── 1. Summary: how many families disagree, and in which direction ───────────
with fam as (
  select
    p.effective_level as parent_level,
    c.effective_level as child_level,
    case when c.parent_id is not null then 'gallery' else 'variant' end as kind
  from public.assets c
  join public.assets p on p.id = coalesce(c.parent_id, c.variant_of)
)
select
  kind, parent_level, child_level, count(*) as rows,
  case
    when parent_level = child_level then 'consistent'
    when parent_level = 'public'                            then 'parent WIDER — empty grid for the client'
    when parent_level = 'guest' and child_level in ('client','internal') then 'parent WIDER — empty grid for the client'
    when parent_level = 'client' and child_level = 'internal'            then 'parent WIDER — empty grid for the client'
    else 'parent NARROWER — children reachable above their parent'
  end as diagnosis
from fam
group by kind, parent_level, child_level
order by kind, parent_level, child_level;

-- ── 2. The offending families, named ─────────────────────────────────────────
select
  cl.name                                as client,
  left(p.name, 40)                       as parent,
  p.perm || '/' || p.status              as parent_perm_status,
  p.effective_level                      as parent_level,
  c.effective_level                      as child_level,
  count(*)                               as children_at_that_level
from public.assets c
join public.assets p  on p.id = coalesce(c.parent_id, c.variant_of)
left join public.clients cl on cl.id = p.client_id
where c.effective_level <> p.effective_level
group by cl.name, p.id, p.name, p.perm, p.status, p.effective_level, c.effective_level
order by cl.name nulls first, p.name;

-- ── 3. Remedies ──────────────────────────────────────────────────────────────
-- Neither is run automatically. They move an access boundary, which is a decision, not a cleanup.
--
-- (a) NARROW the parents to match their children. Safe direction — it only ever removes access.
--     Prefer this when the children got the new `client` default and the parents are stale `public`.
--
--       update public.assets p set perm = sub.child_perm
--       from (
--         select coalesce(c.parent_id, c.variant_of) as parent_id, min(c.perm) as child_perm
--         from public.assets c
--         where coalesce(c.parent_id, c.variant_of) is not null
--         group by 1
--         having count(distinct c.perm) = 1
--       ) sub
--       where p.id = sub.parent_id and p.perm <> sub.child_perm;
--
-- (b) WIDEN the children to match their parent. GRANTS access — one statement can publish a whole
--     gallery. Only with a deliberate decision about those specific assets, never as a sweep.
--
--       update public.assets c set perm = p.perm
--       from public.assets p
--       where p.id = coalesce(c.parent_id, c.variant_of)
--         and p.id = '<the one parent you mean>'
--         and c.perm <> p.perm;
