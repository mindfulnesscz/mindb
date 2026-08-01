-- asset_stats bypassed RLS. Found while investigating a report of an internal asset staying
-- visible; that turned out to be something else, but this was underneath it.
--
-- A Postgres view runs with the privileges of its OWNER unless `security_invoker` is set, and RLS
-- on the underlying table is evaluated for whoever that is. `public.asset_stats` selects from
-- `public.assets` and is owned by the migration role, so every policy on `assets` was simply not
-- applied to it: any caller, anonymous included, could enumerate `id` plus rating and comment
-- counts for EVERY asset in EVERY client — including `internal` ones and unapproved drafts.
--
-- Proven before the fix, as a signed-in user with no client:
--   select count(*) from public.assets     where id in (…two internal assets…)  -> 0
--   select count(*) from public.asset_stats where id in (…the same two…)        -> 2
--
-- Not a bytes leak and not a names leak — but it is an existence-and-activity leak across the
-- tenant boundary, which is the same class as the four read policies closed by 20260724120000.
-- Rating counts on a client's unreleased work say how much review it is getting.
--
-- `security_invoker = on` makes the view evaluate as the CALLER, so `assets` RLS applies inside it
-- and the view returns exactly the rows that caller can already see. Nothing else changes: both
-- readers (the portal's grid enrichment and the desktop readme generator) only ever ask for stats
-- of assets they have just listed from `assets`, so a row they cannot see is a row they were never
-- going to join to.
--
-- Deliberately preserved: anonymous visitors still read ratings on PUBLIC assets, which is an
-- explicit product decision (the public gallery shows a score). That works because the assets
-- policies admit `effective_level = 'public'` to everyone — the view now inherits exactly that
-- boundary instead of ignoring it.

alter view public.asset_stats set (security_invoker = on);

comment on view public.asset_stats is
  'Per-asset rating/comment aggregates. security_invoker=on is load-bearing: without it the view '
  'runs as its owner and hands every caller stats for every tenant''s assets, internal included.';
