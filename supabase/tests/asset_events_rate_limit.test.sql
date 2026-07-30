-- asset_events rate limiting (pgTAP). Run with `supabase test db`.
--
-- The property under test is a pair, and both halves matter:
--
--   it must CAP    — otherwise a public share link plus a loop inflates a client's view count, and an
--                    inflated count is worse than a missing one because it is believed;
--   it must not FAIL — the client fires these off and ignores the result, so a busy minute must not
--                    surface as an error on a legitimate page view.
--
-- The cap is per ASSET, because RLS has no identifier for an anonymous caller. That makes "a different
-- asset is unaffected" the test that proves the limit is scoped rather than global.

begin;
create extension if not exists pgtap;

select plan(8);

insert into public.clients (id, name) values
  ('77777777-0000-0000-0000-000000000001', 'Events');

insert into public.assets (id, client_id, shortcode, stable_id, child_id, name, status) values
  ('77777777-0000-0000-0000-0000000000a1', '77777777-0000-0000-0000-000000000001', '(A)', 'ev000001', 'c1', 'Hot asset',  'published'),
  ('77777777-0000-0000-0000-0000000000b1', '77777777-0000-0000-0000-000000000001', '(B)', 'ev000002', 'c1', 'Cold asset', 'published');

/* ── The trigger exists and is wired BEFORE INSERT ────────────────────────── */

select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.asset_events'::regclass
      and tgname = 'asset_events_rate_limit' and not tgisinternal),
  1::bigint,
  'asset_events carries the rate-limit trigger');

/* ── Under the ceiling, everything is written ─────────────────────────────── */

insert into public.asset_events (asset_id, event_type)
select '77777777-0000-0000-0000-0000000000a1', 'view' from generate_series(1, 119);

select is(
  (select count(*) from public.asset_events where asset_id = '77777777-0000-0000-0000-0000000000a1'),
  119::bigint,
  '119 events in a minute are all recorded — the cap must not undercount real traffic');

/* ── The 120th is the last one in ─────────────────────────────────────────── */

select lives_ok(
  $$insert into public.asset_events (asset_id, event_type)
    values ('77777777-0000-0000-0000-0000000000a1', 'view')$$,
  'The event at the ceiling is accepted');

select is(
  (select count(*) from public.asset_events where asset_id = '77777777-0000-0000-0000-0000000000a1'),
  120::bigint,
  'The ceiling is inclusive — 120 events are kept');

/* ── Past the ceiling: dropped, but NOT an error ──────────────────────────── */

select lives_ok(
  $$insert into public.asset_events (asset_id, event_type)
    values ('77777777-0000-0000-0000-0000000000a1', 'download')$$,
  'An over-limit insert does NOT raise — a page view must never show an error');

select is(
  (select count(*) from public.asset_events where asset_id = '77777777-0000-0000-0000-0000000000a1'),
  120::bigint,
  'The over-limit event was silently dropped rather than stored');

/* ── The cap is per asset, not global ─────────────────────────────────────── */

insert into public.asset_events (asset_id, event_type)
  values ('77777777-0000-0000-0000-0000000000b1', 'view');

select is(
  (select count(*) from public.asset_events where asset_id = '77777777-0000-0000-0000-0000000000b1'),
  1::bigint,
  'A different asset is unaffected — one hammered link cannot silence the rest of a client');

/* ── The window slides: old events do not hold the door shut ──────────────── */

-- Age everything on the hot asset out of the window. A fixed budget would lock an asset out forever
-- once it had ever been busy.
update public.asset_events
  set created_at = now() - interval '2 minutes'
  where asset_id = '77777777-0000-0000-0000-0000000000a1';

insert into public.asset_events (asset_id, event_type)
  values ('77777777-0000-0000-0000-0000000000a1', 'view');

select is(
  (select count(*) from public.asset_events
    where asset_id = '77777777-0000-0000-0000-0000000000a1'
      and created_at > now() - interval '1 minute'),
  1::bigint,
  'Once the old events age out, counting resumes');

select * from finish();
rollback;
