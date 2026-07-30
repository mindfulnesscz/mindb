-- Asset relation constraints (pgTAP). Run with `supabase test db`.
--
-- The two self-referencing keys on public.assets behave DIFFERENTLY on delete, on purpose:
--
--   parent_id   ON DELETE CASCADE   a gallery child is a preview image inside its parent folder and
--                                   is meaningless without it; the two disconnect together anyway
--   variant_of  ON DELETE SET NULL  a variant is a full deliverable with its own ratings and
--                                   comments, and can outlive its primary — the primary is only one
--                                   FILE in the package, so it can vanish while siblings remain
--
-- That asymmetry used to be an accident (`variant_of` had no ON DELETE clause at all), which made
-- "delete disconnected assets" fail outright with a foreign-key violation. These tests keep the
-- difference deliberate.

begin;
create extension if not exists pgtap;

select plan(9);

insert into public.clients (id, name) values ('88888888-0000-0000-0000-000000000001', 'Relations');

insert into public.assets (id, client_id, shortcode, stable_id, child_id, name, status) values
  ('88888888-0000-0000-0000-000000000fa1', '88888888-0000-0000-0000-000000000001', '(P)', 'rel00001', 'c1', 'primary',  'disconnected'),
  ('88888888-0000-0000-0000-000000000fb1', '88888888-0000-0000-0000-000000000001', '(V)', 'rel00001', 'c2', 'variant',  'published'),
  ('88888888-0000-0000-0000-000000000fc1', '88888888-0000-0000-0000-000000000001', '(G)', 'rel00002', 'c1', 'gallery',  'disconnected'),
  ('88888888-0000-0000-0000-000000000fd1', '88888888-0000-0000-0000-000000000001', '(K)', 'rel00002', 'c2', 'kid',      'published');

update public.assets set variant_of = '88888888-0000-0000-0000-000000000fa1'
  where id = '88888888-0000-0000-0000-000000000fb1';
update public.assets set parent_id = '88888888-0000-0000-0000-000000000fc1'
  where id = '88888888-0000-0000-0000-000000000fd1';

/* ── The reported bug: deleting a primary that still has a variant ─────────── */

select lives_ok(
  $$delete from public.assets where id = '88888888-0000-0000-0000-000000000fa1'$$,
  'A disconnected primary CAN be deleted while a variant points at it (was a FK violation)');

select is((select count(*) from public.assets where id = '88888888-0000-0000-0000-000000000fb1'), 1::bigint,
  'The variant SURVIVES — it is a real deliverable, not derivative filler');

select is((select variant_of from public.assets where id = '88888888-0000-0000-0000-000000000fb1'), null,
  'The variant is orphaned to standalone, and the next pipeline run re-links it from the manifest');

select is((select status from public.assets where id = '88888888-0000-0000-0000-000000000fb1'), 'published',
  'A LIVE variant keeps its status — purging a disconnected primary must not disconnect it');

/* ── The deliberate contrast: a gallery parent cascades ────────────────────── */

select lives_ok(
  $$delete from public.assets where id = '88888888-0000-0000-0000-000000000fc1'$$,
  'A gallery parent can be deleted');

select is((select count(*) from public.assets where id = '88888888-0000-0000-0000-000000000fd1'), 0::bigint,
  'Its children CASCADE away — a preview image has no meaning without its gallery');

/* ── The constraints themselves, so a future migration cannot quietly flip them ── */

select is(
  (select confdeltype from pg_constraint where conname = 'assets_variant_of_fkey'), 'n'::"char",
  'assets_variant_of_fkey is ON DELETE SET NULL');

select is(
  (select confdeltype from pg_constraint where conname = 'assets_parent_id_fkey'), 'c'::"char",
  'assets_parent_id_fkey is ON DELETE CASCADE');

/* ── Feedback still follows the row it belongs to ──────────────────────────── */

-- A variant's own ratings must not be collateral damage of its primary being purged. (The rating
-- below is attached AFTER the primary is gone, proving the surviving row is still fully usable.)
insert into auth.users (id) values ('88888888-0000-0000-0000-000000000fe1');
insert into public.ratings (asset_id, user_id, value)
  values ('88888888-0000-0000-0000-000000000fb1', '88888888-0000-0000-0000-000000000fe1', 5);
select is((select count(*) from public.ratings where asset_id = '88888888-0000-0000-0000-000000000fb1'), 1::bigint,
  'The surviving variant still accepts and keeps feedback');

select * from finish();
rollback;
