-- Production adopted the baseline via `migration repair` (marked applied, never
-- executed), so it kept its historically broken default privileges — and the
-- first new table since (client_members) came up with no API-role grants at
-- all: 403 for anon, authenticated, AND service_role. Same failure asset_events
-- hit in the pre-migration era. Grant explicitly, and fix default privileges so
-- every future migration-created object gets grants on production too.
-- (Idempotent on local/staging, which already have all of this from the baseline.)

grant all on public.client_members to anon, authenticated, service_role;
grant execute on function public.my_member_client_ids() to anon, authenticated, service_role;

alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;
