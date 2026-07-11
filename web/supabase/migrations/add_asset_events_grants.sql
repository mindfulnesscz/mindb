-- Fixes 403 Forbidden on asset_events: RLS policies alone aren't sufficient — PostgREST
-- also requires the anon/authenticated Postgres roles to have base table grants,
-- independent of any RLS policy. Tables created via raw SQL (not the Supabase dashboard's
-- table editor) don't get these automatically. Run once in Supabase SQL editor.

grant select, insert on asset_events to anon, authenticated;
