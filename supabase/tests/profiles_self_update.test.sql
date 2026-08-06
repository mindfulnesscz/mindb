-- Profile self-service must never become an access-control write path.
-- `profiles: own update` deliberately permits ordinary account edits, but role,
-- tenant assignment, and delegated client-creation authority belong exclusively
-- to the security-definer admin RPCs.

begin;
create extension if not exists pgtap;

select plan(12);

/* ── Fixtures (created as superuser, which bypasses RLS) ─────────────────── */

insert into public.clients (id, name) values
  ('88888888-0000-0000-0000-000000000001', 'Profile Policy Tenant A'),
  ('88888888-0000-0000-0000-000000000002', 'Profile Policy Tenant B');

insert into auth.users (id) values
  ('88888888-1000-0000-0000-000000000001'), -- member under test
  ('88888888-1000-0000-0000-000000000002'), -- super admin exercising RPCs
  ('88888888-1000-0000-0000-000000000003'), -- update_user_role target
  ('88888888-1000-0000-0000-000000000004'); -- update_user_access target

-- handle_new_user already inserted the rows; set explicit test roles and scope.
insert into public.profiles (id, name, role, client_id, can_create_clients) values
  ('88888888-1000-0000-0000-000000000001', 'Member Before', 'member', '88888888-0000-0000-0000-000000000001', false),
  ('88888888-1000-0000-0000-000000000002', 'Super Admin', 'super_admin', null, false),
  ('88888888-1000-0000-0000-000000000003', 'Role Target', 'public', null, false),
  ('88888888-1000-0000-0000-000000000004', 'Access Target', 'public', null, false)
on conflict (id) do update set
  name = excluded.name,
  role = excluded.role,
  client_id = excluded.client_id,
  can_create_clients = excluded.can_create_clients;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', uid, 'role', 'authenticated')::text,
    true
  );
end $$;

/* ── Direct member updates: profile fields yes, authority fields no ──────── */

select pg_temp.act_as('88888888-1000-0000-0000-000000000001');

select throws_ok(
  $$update public.profiles
    set role = 'super_admin'
    where id = '88888888-1000-0000-0000-000000000001'$$,
  '42501', null,
  'A member cannot self-elevate to super_admin through the profiles table');

select throws_ok(
  $$update public.profiles
    set client_id = '88888888-0000-0000-0000-000000000002'
    where id = '88888888-1000-0000-0000-000000000001'$$,
  '42501', null,
  'A member cannot move their own profile into another tenant');

select throws_ok(
  $$update public.profiles
    set can_create_clients = true
    where id = '88888888-1000-0000-0000-000000000001'$$,
  '42501', null,
  'A member cannot grant themselves client-creation authority');

select lives_ok(
  $$update public.profiles
    set name = 'Member After', company = 'Benign Company'
    where id = '88888888-1000-0000-0000-000000000001'$$,
  'A member can still edit benign fields on their own profile');

select is(
  (select name from public.profiles where id = '88888888-1000-0000-0000-000000000001'),
  'Member After',
  'The benign self-edit is persisted');

select is(
  (select role from public.profiles where id = '88888888-1000-0000-0000-000000000001'),
  'member',
  'The failed elevation leaves the member role unchanged');

select is(
  (select client_id from public.profiles where id = '88888888-1000-0000-0000-000000000001'),
  '88888888-0000-0000-0000-000000000001'::uuid,
  'The failed reassignment leaves the member in their original tenant');

select is(
  (select can_create_clients from public.profiles where id = '88888888-1000-0000-0000-000000000001'),
  false,
  'The failed grant leaves client-creation authority disabled');

/* ── Admin RPCs remain the privileged write path ────────────────────────── */

select pg_temp.act_as('88888888-1000-0000-0000-000000000002');

select lives_ok(
  $$select public.update_user_role(
      '88888888-1000-0000-0000-000000000003', 'editor'
    )$$,
  'A super admin can still change roles through update_user_role');

select is(
  (select role from public.profiles where id = '88888888-1000-0000-0000-000000000003'),
  'editor',
  'update_user_role persists its privileged role change');

select lives_ok(
  $$select public.update_user_access(
      '88888888-1000-0000-0000-000000000004', 'admin', null, null, true
    )$$,
  'A super admin can still change privileged access through update_user_access');

select is(
  (select role = 'admin' and can_create_clients
     from public.profiles
    where id = '88888888-1000-0000-0000-000000000004'),
  true,
  'update_user_access persists role and delegated client-creation authority');

select * from finish();
rollback;
