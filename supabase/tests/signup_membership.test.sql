-- Signup metadata is supplied by the caller and must never grant tenant membership.
-- The only automatic membership signal is an administrator-configured email-domain allow-list.

begin;
create extension if not exists pgtap;

select plan(5);

insert into public.clients (id, name, domain_whitelist) values
  ('99999999-0000-0000-0000-000000000001', 'Signup Tenant A', array['trusted.example']),
  ('99999999-0000-0000-0000-000000000002', 'Signup Tenant B', array['other.example']);

-- This reproduces the vulnerability: before the migration, the trigger trusted client_id and
-- created a Tenant A member even though the email had no verified relationship with Tenant A.
insert into auth.users (id, email, raw_user_meta_data) values (
  '99999999-1000-0000-0000-000000000001',
  'attacker@untrusted.example',
  '{"name":"Untrusted Signup","client_id":"99999999-0000-0000-0000-000000000001"}'::jsonb
);

select is(
  (select role from public.profiles where id = '99999999-1000-0000-0000-000000000001'),
  'public',
  'A self-asserted client_id does not grant the member role'
);

select is(
  (select client_id from public.profiles where id = '99999999-1000-0000-0000-000000000001'),
  null::uuid,
  'A self-asserted client_id leaves the profile with no tenant access'
);

select is(
  (select count(*) from public.client_members
    where user_id = '99999999-1000-0000-0000-000000000001'),
  0::bigint,
  'A self-asserted client_id creates no editor membership either'
);

-- A trusted domain remains the deliberate automatic-membership path. Supplying Tenant B in the
-- same untrusted metadata cannot override the server-controlled Tenant A domain match.
insert into auth.users (id, email, raw_user_meta_data) values (
  '99999999-1000-0000-0000-000000000002',
  'person@trusted.example',
  '{"name":"Trusted Signup","client_id":"99999999-0000-0000-0000-000000000002"}'::jsonb
);

select is(
  (select role from public.profiles where id = '99999999-1000-0000-0000-000000000002'),
  'member',
  'An allow-listed email domain still grants automatic member access'
);

select is(
  (select client_id from public.profiles where id = '99999999-1000-0000-0000-000000000002'),
  '99999999-0000-0000-0000-000000000001'::uuid,
  'The verified domain decides the tenant even when metadata asserts another client'
);

select * from finish();
rollback;
