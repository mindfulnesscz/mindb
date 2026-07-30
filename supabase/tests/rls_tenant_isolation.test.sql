-- RLS tenant-isolation suite (pgTAP). Run with `supabase test db`.
--
-- Phase 0 fixed a cross-tenant READ leak (F-1): ratings, comments, approvals, activity and
-- clients were readable by ANY authenticated user, so a member of client A could enumerate
-- other clients and read feedback on assets they must never see. The fix shipped as
-- 20260724120000_phase0_rls_tenant_isolation.sql, refined by 120003/120004.
--
-- Table-level `grant all ... to anon, authenticated` means RLS is the ONLY thing standing
-- between one client's data and another's (finding F-3). This suite is what turns that
-- guarantee into a tested property rather than a careful reading of policy SQL.
--
-- This suite also FOUND a leak Phase 0 missed: the ratings INSERT/UPDATE policies checked
-- authorship but never asset visibility (F-4), letting one tenant inject invisible ratings
-- onto another's assets. Fixed by 20260729120000_ratings_asset_scoped_writes.sql and
-- asserted in the "writes" section below.
--
-- Read assertions come first and writes last, so the inserts below cannot skew the counts.
-- Everything runs in one transaction and is rolled back, so it is safe to run against a
-- database that already holds seed data.

begin;
create extension if not exists pgtap;

select plan(51);

/* ── Fixtures (created as superuser, which bypasses RLS) ───────────────────── */

-- Two unrelated tenants.
insert into public.clients (id, name) values
  ('11111111-0000-0000-0000-000000000001', 'Tenant A'),
  ('11111111-0000-0000-0000-000000000002', 'Tenant B');

insert into auth.users (id) values
  ('22222222-0000-0000-0000-00000000000a'),  -- member of A
  ('22222222-0000-0000-0000-00000000000b'),  -- member of B
  ('22222222-0000-0000-0000-00000000000e'),  -- staff (editor)
  ('22222222-0000-0000-0000-00000000000f');  -- signed in, attached to no client

-- A trigger on auth.users already inserts a default profile, so upsert onto it rather than
-- assuming the row is ours to create.
insert into public.profiles (id, role, client_id) values
  ('22222222-0000-0000-0000-00000000000a', 'member', '11111111-0000-0000-0000-000000000001'),
  ('22222222-0000-0000-0000-00000000000b', 'member', '11111111-0000-0000-0000-000000000002'),
  ('22222222-0000-0000-0000-00000000000e', 'editor', null),
  ('22222222-0000-0000-0000-00000000000f', 'public', null)
on conflict (id) do update
  set role = excluded.role, client_id = excluded.client_id;

-- One asset per permission level for A, plus a client-scoped asset for B.
insert into public.assets (id, client_id, shortcode, stable_id, child_id, perm, name) values
  ('33333333-0000-0000-0000-0000000000a1', '11111111-0000-0000-0000-000000000001', '(A)(PUB)', 'aaaa0001', 'c1', 'public',   'A public'),
  ('33333333-0000-0000-0000-0000000000a2', '11111111-0000-0000-0000-000000000001', '(A)(CLI)', 'aaaa0002', 'c1', 'client',   'A client-only'),
  ('33333333-0000-0000-0000-0000000000a3', '11111111-0000-0000-0000-000000000001', '(A)(INT)', 'aaaa0003', 'c1', 'internal', 'A internal'),
  ('33333333-0000-0000-0000-0000000000b1', '11111111-0000-0000-0000-000000000002', '(B)(CLI)', 'bbbb0001', 'c1', 'client',   'B client-only');

-- A comment on every asset (staff-authored — only staff may post).
insert into public.comments (asset_id, user_id, body) values
  ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000e', 'comment on A public'),
  ('33333333-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-00000000000e', 'comment on A client'),
  ('33333333-0000-0000-0000-0000000000a3', '22222222-0000-0000-0000-00000000000e', 'comment on A internal'),
  ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000e', 'comment on B client');

-- A rating on each asset, including the PUBLIC one (that case distinguishes the ratings
-- policy from the comments policy — see the anon section).
insert into public.ratings (asset_id, user_id, value) values
  ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000a', 5),
  ('33333333-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-00000000000a', 4),
  ('33333333-0000-0000-0000-0000000000a3', '22222222-0000-0000-0000-00000000000e', 3),
  ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000b', 2);

insert into public.approvals (asset_id, user_id, state) values
  ('33333333-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-00000000000e', 'approved'),
  ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000e', 'pending');

insert into public.activity (asset_id, user_id, action) values
  ('33333333-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-00000000000a', 'viewed A client'),
  ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000b', 'viewed B client'),
  (null,                                   '22222222-0000-0000-0000-00000000000a', 'signed in');

/* ── Actor helpers ────────────────────────────────────────────────────────── */

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims',
                     json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
end $$;

-- Counts scoped to this suite's fixtures, so pre-existing seed rows cannot skew a result.
create or replace function pg_temp.n_clients() returns bigint language sql as $$
  select count(*) from public.clients where id::text like '11111111-%'; $$;
create or replace function pg_temp.n_assets() returns bigint language sql as $$
  select count(*) from public.assets where id::text like '33333333-%'; $$;
create or replace function pg_temp.n_comments() returns bigint language sql as $$
  select count(*) from public.comments where asset_id::text like '33333333-%'; $$;
create or replace function pg_temp.n_ratings() returns bigint language sql as $$
  select count(*) from public.ratings where asset_id::text like '33333333-%'; $$;
create or replace function pg_temp.n_approvals() returns bigint language sql as $$
  select count(*) from public.approvals where asset_id::text like '33333333-%'; $$;
create or replace function pg_temp.n_activity() returns bigint language sql as $$
  select count(*) from public.activity
  where asset_id::text like '33333333-%' or user_id::text like '22222222-%'; $$;

/* ── Tenant A member (13) ─────────────────────────────────────────────────── */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000a');

select is(pg_temp.n_clients(), 1::bigint,
  'A member sees exactly one client row — cannot enumerate the client list (F-1)');
select is((select name from public.clients where id::text like '11111111-%'), 'Tenant A',
  'A member sees their OWN client, not another tenant''s');

select is(pg_temp.n_assets(), 2::bigint,
  'A member sees A''s public + client assets, not A''s internal one');
select is((select count(*) from public.assets where id = '33333333-0000-0000-0000-0000000000a3'), 0::bigint,
  'A member cannot read an internal asset even of their own client');
select is((select count(*) from public.assets where id = '33333333-0000-0000-0000-0000000000b1'), 0::bigint,
  'A member cannot read another tenant''s asset');

select is(pg_temp.n_comments(), 2::bigint,
  'A member reads comments only on the assets they can see');
select is((select count(*) from public.comments where asset_id = '33333333-0000-0000-0000-0000000000b1'), 0::bigint,
  'A member cannot read comments on another tenant''s asset (F-1)');
select is((select count(*) from public.comments where asset_id = '33333333-0000-0000-0000-0000000000a3'), 0::bigint,
  'A member cannot read comments on an internal asset (F-1)');

select is(pg_temp.n_ratings(), 2::bigint,
  'A member reads ratings only on the assets they can see');
select is((select count(*) from public.ratings where asset_id = '33333333-0000-0000-0000-0000000000b1'), 0::bigint,
  'A member cannot read another tenant''s ratings (F-1)');

select is(pg_temp.n_approvals(), 0::bigint,
  'A member reads no approvals at all — approvals are a staff-only workflow');

select is(pg_temp.n_activity(), 2::bigint,
  'A member sees their own activity, including the asset-less account event');
select is((select count(*) from public.activity where user_id = '22222222-0000-0000-0000-00000000000b'), 0::bigint,
  'A member cannot read another tenant member''s activity (F-1)');

/* ── Tenant B member — the mirror image (7) ───────────────────────────────── */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000b');

select is(pg_temp.n_clients(), 1::bigint,
  'B member also sees exactly one client row');
select is((select name from public.clients where id::text like '11111111-%'), 'Tenant B',
  'B member sees Tenant B — the scoping is per-user, not a fixed row');
select is(pg_temp.n_assets(), 2::bigint,
  'B member sees their own client asset plus A''s PUBLIC asset');
select is((select count(*) from public.assets where id = '33333333-0000-0000-0000-0000000000a2'), 0::bigint,
  'B member cannot read A''s client-scoped asset');
select is((select count(*) from public.comments where asset_id = '33333333-0000-0000-0000-0000000000a2'), 0::bigint,
  'B member cannot read comments on A''s client-scoped asset (F-1)');
select is((select count(*) from public.ratings where asset_id = '33333333-0000-0000-0000-0000000000a2'), 0::bigint,
  'B member cannot read ratings on A''s client-scoped asset (F-1)');
select is((select count(*) from public.activity where user_id = '22222222-0000-0000-0000-00000000000a'), 0::bigint,
  'B member cannot read A member''s activity (F-1)');

/* ── Staff / editor (6) ───────────────────────────────────────────────────── */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000e');

select is(pg_temp.n_clients(),   2::bigint, 'Staff see every client — the admin console needs it');
select is(pg_temp.n_assets(),    4::bigint, 'Staff see all assets, internal included');
select is(pg_temp.n_comments(),  4::bigint, 'Staff read every comment');
select is(pg_temp.n_ratings(),   4::bigint, 'Staff read every rating');
select is(pg_temp.n_approvals(), 2::bigint, 'Staff read every approval');
select is(pg_temp.n_activity(),  3::bigint, 'Staff read all activity');

/* ── Signed in, attached to no client (3) ─────────────────────────────────── */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000f');

select is(pg_temp.n_clients(),  0::bigint, 'A user with no client sees no client rows');
select is(pg_temp.n_assets(),   1::bigint, 'A user with no client sees only public assets');
select is(pg_temp.n_comments(), 1::bigint, 'A user with no client reads only public-asset comments');

/* ── Anonymous — the portal''s public gallery (4) ─────────────────────────── */

select pg_temp.act_as_anon();

select is(pg_temp.n_assets(),   1::bigint, 'Anon sees public assets only');
select is(pg_temp.n_clients(),  0::bigint, 'Anon cannot enumerate clients');
select is(pg_temp.n_comments(), 0::bigint,
  'Anon reads NO comments, even on a public asset — the thread requires a session');
-- INTENTIONAL (confirmed 2026-07-29): the public gallery shows a score to everyone. Ratings
-- deliberately carry no auth.uid() guard, unlike the comment thread, which requires a session.
select is(pg_temp.n_ratings(),  1::bigint,
  'Anon reads ratings on a public asset — by design, so the public gallery can show a score');

/* ── Writes, including cross-tenant (11) ───────────────────────────────────── */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000a');

select throws_ok(
  $$insert into public.comments (asset_id, user_id, body)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000a', 'nope')$$,
  '42501', null, 'A member may NOT post a comment — comment writes are staff-only');

select throws_ok(
  $$insert into public.approvals (asset_id, user_id, state)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000a', 'approved')$$,
  '42501', null, 'A member may NOT record an approval');

-- F-4 (fixed by 20260729120000_ratings_asset_scoped_writes.sql): rating writes are scoped to
-- assets the rater can see, so the read and write rules are symmetric. Before that migration
-- both inserts below succeeded, producing ratings their own author could not read back —
-- invisible pollution of another tenant's average score.
select throws_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000a', 1)$$,
  '42501', null, 'F-4: a member may NOT rate another tenant''s asset');
select throws_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a3', '22222222-0000-0000-0000-00000000000a', 1)$$,
  '42501', null, 'F-4: a member may NOT rate an INTERNAL asset, even of their own client');
select throws_ok(
  $$update public.ratings set asset_id = '33333333-0000-0000-0000-0000000000b1'
    where asset_id = '33333333-0000-0000-0000-0000000000a2'
      and user_id = '22222222-0000-0000-0000-00000000000a'$$,
  '42501', null, 'F-4: a member may NOT re-point their own rating at an invisible asset');
select lives_ok(
  $$update public.ratings set value = 2
    where asset_id = '33333333-0000-0000-0000-0000000000a2'
      and user_id = '22222222-0000-0000-0000-00000000000a'$$,
  'F-4: …but may still update their own rating on an asset they can see');

-- The positive path across a tenant boundary: a PUBLIC asset is visible to everyone, so any
-- member may rate it. The fix must not over-tighten into "own client only".
select pg_temp.act_as('22222222-0000-0000-0000-00000000000b');
select lives_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000b', 4)$$,
  'A member of another tenant MAY rate a public asset');

select pg_temp.act_as('22222222-0000-0000-0000-00000000000e');

select lives_ok(
  $$insert into public.comments (asset_id, user_id, body)
    values ('33333333-0000-0000-0000-0000000000b1', '22222222-0000-0000-0000-00000000000e', 'staff note')$$,
  'Staff may comment on any client''s asset');
select throws_ok(
  $$insert into public.comments (asset_id, user_id, body)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000a', 'forged')$$,
  '42501', null, 'Even staff may not post a comment attributed to another user');

/* ── Guest voting: one vote per person per asset (7) ──────────────────────────
   A "guest" is a signed-in user with role 'public' and no client — they completed sign-in,
   so their email is known, but they belong to no tenant. Guests are MEANT to vote on public
   assets. What must never happen is one person voting twice on the same asset. That is held
   by `unique (asset_id, user_id)` plus the portal's upsert; these tests pin both, and that a
   guest cannot reach a tenant's assets.

   Cohort reporting ("how many guests vs clients vs staff voted") needs no schema change:
   join ratings.user_id → profiles.role. */

select pg_temp.act_as('22222222-0000-0000-0000-00000000000f');

select lives_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000f', 5)$$,
  'A guest MAY rate a public asset');
select is((select value from public.ratings
           where asset_id = '33333333-0000-0000-0000-0000000000a1'
             and user_id = '22222222-0000-0000-0000-00000000000f'), 5,
  'A guest can read back their own vote');

select throws_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a1', '22222222-0000-0000-0000-00000000000f', 1)$$,
  '23505', null, 'A guest may NOT vote twice on the same asset — unique (asset_id, user_id)');

select lives_ok(
  $$update public.ratings set value = 3
    where asset_id = '33333333-0000-0000-0000-0000000000a1'
      and user_id = '22222222-0000-0000-0000-00000000000f'$$,
  'A guest MAY change their existing vote (what the portal upsert does on conflict)');
select is((select count(*) from public.ratings
           where asset_id = '33333333-0000-0000-0000-0000000000a1'
             and user_id = '22222222-0000-0000-0000-00000000000f'), 1::bigint,
  'Changing a vote updates the single row rather than adding a second');

select throws_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a2', '22222222-0000-0000-0000-00000000000f', 5)$$,
  '42501', null, 'A guest may NOT rate a client-scoped asset they cannot see');

-- Truly anonymous (never signed in) cannot vote. Two independent guards agree: `auth.uid()`
-- is null so the policy's `auth.uid() = user_id` can never hold, and `user_id` is NOT NULL so
-- there is no anonymous row to author. RLS rejects first (42501), before the column
-- constraint is reached — so the policy alone is sufficient, and the NOT NULL is belt-and-
-- braces. Together they are what makes every vote attributable to a known email.
select pg_temp.act_as_anon();
select throws_ok(
  $$insert into public.ratings (asset_id, user_id, value)
    values ('33333333-0000-0000-0000-0000000000a1', null, 5)$$,
  '42501', null, 'A never-signed-in visitor may NOT vote — every vote has a real account');

-- asset_events stays anonymously insertable (view/download counters) but must not accept a
-- forged user_id — the one real gap Phase 0 closed on that table (F-2).
select pg_temp.act_as_anon();

select lives_ok(
  $$insert into public.asset_events (asset_id, event_type, user_id)
    values ('33333333-0000-0000-0000-0000000000a1', 'view', null)$$,
  'Anon may record an anonymous view event');
select throws_ok(
  $$insert into public.asset_events (asset_id, event_type, user_id)
    values ('33333333-0000-0000-0000-0000000000a1', 'view', '22222222-0000-0000-0000-00000000000e')$$,
  '42501', null, 'Anon may NOT attribute an event to a real user (F-2)');

select * from finish();
rollback;
