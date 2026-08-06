-- Keep profile self-service without letting it become an access-control path.
-- The baseline policy had only USING (auth.uid() = id), so an authenticated
-- user could replace any value on their own row, including role and tenant.

-- Read the caller's pre-update authority fields as the table owner. Keeping
-- this lookup behind a fixed-search-path security-definer function avoids a
-- recursive profiles RLS subquery while exposing only an equality result.
create function public.profile_privileged_fields_unchanged(
  p_id                 uuid,
  p_role               text,
  p_client_id          uuid,
  p_can_create_clients boolean
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles as current_profile
    where current_profile.id = auth.uid()
      and current_profile.id = p_id
      and current_profile.role is not distinct from p_role
      and current_profile.client_id is not distinct from p_client_id
      and current_profile.can_create_clients is not distinct from p_can_create_clients
  );
$$;

revoke all on function public.profile_privileged_fields_unchanged(uuid, text, uuid, boolean)
  from public;
grant execute on function public.profile_privileged_fields_unchanged(uuid, text, uuid, boolean)
  to authenticated;

drop policy if exists "profiles: own update" on public.profiles;
create policy "profiles: own update"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (
    auth.uid() = id
    and public.profile_privileged_fields_unchanged(
      id,
      role,
      client_id,
      can_create_clients
    )
  );

comment on function public.profile_privileged_fields_unchanged(uuid, text, uuid, boolean) is
  'RLS helper: authenticated profile self-edits must preserve role, client_id, and can_create_clients.';
