-- Add the super_admin role (top tier) as an ADDITIVE superset of admin.
--
-- Role ladder: public → member → editor → admin → super_admin.
--   super_admin : creates admins, creates/deletes clients, delegates clients.
--   admin       : edits existing clients + manages member/editor users
--                 (can NO LONGER create or delete clients, and cannot grant
--                  admin/super_admin roles).
--   editor      : unchanged.
--
-- super_admin passes every admin check (is_admin/is_staff include it), so
-- nothing an admin could see or do server-side regresses except the two powers
-- explicitly reserved above. Forward-only.

-- ── 1. Widen the role check constraint ───────────────────────────────────────
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('public', 'member', 'editor', 'admin', 'super_admin'));

-- ── 2. Role predicates ───────────────────────────────────────────────────────
create or replace function public.is_staff()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('editor', 'admin', 'super_admin')
  );
$$;

create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('admin', 'super_admin')
  );
$$;

create or replace function public.is_super_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'super_admin'
  );
$$;

-- Staff sign-in path should recognise super_admin as staff.
create or replace function public.check_email_auth(p_email text)
returns text language plpgsql security definer as $$
declare
  _domain text;
  _exists boolean;
begin
  _domain := lower(split_part(p_email, '@', 2));
  perform 1 from public.profiles p join auth.users u on u.id = p.id
    where lower(u.email) = lower(p_email)
      and p.role in ('editor', 'admin', 'super_admin') limit 1;
  if found then return 'staff'; end if;
  perform 1 from public.clients where _domain = any(domain_whitelist) limit 1;
  if found then return 'whitelisted'; end if;
  select exists(select 1 from auth.users where lower(email) = lower(p_email)) into _exists;
  if _exists then return 'returning'; end if;
  return 'unknown';
end;
$$;

-- ── 3. Client writes: create/delete reserved for super_admin ─────────────────
drop policy if exists "clients: admins can write" on public.clients;
create policy "clients: super_admin insert"
  on public.clients for insert with check (public.is_super_admin());
create policy "clients: admin update"
  on public.clients for update using (public.is_admin()) with check (public.is_admin());
create policy "clients: super_admin delete"
  on public.clients for delete using (public.is_super_admin());

-- ── 4. Role assignment: only super_admin may grant admin/super_admin ─────────
create or replace function public.update_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_role not in ('public', 'member', 'editor', 'admin', 'super_admin') then
    raise exception 'invalid role %', p_role;
  end if;
  if p_role in ('admin', 'super_admin') and not public.is_super_admin() then
    raise exception 'only super_admin can grant admin roles';
  end if;
  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

create or replace function public.update_user_access(
  p_user_id              uuid,
  p_role                 text,
  p_client_id            uuid    default null,
  p_member_client_ids    uuid[]  default null
)
returns void language plpgsql security definer as $$
declare
  _cid uuid;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_role not in ('public', 'member', 'editor', 'admin', 'super_admin') then
    raise exception 'invalid role %', p_role;
  end if;
  if p_role in ('admin', 'super_admin') and not public.is_super_admin() then
    raise exception 'only super_admin can grant admin roles';
  end if;

  if p_role = 'member' then
    if p_client_id is null then
      raise exception 'member role requires p_client_id';
    end if;
    if not exists (select 1 from public.clients where id = p_client_id) then
      raise exception 'unknown client %', p_client_id;
    end if;
  end if;

  if p_role = 'editor' then
    if p_member_client_ids is null or cardinality(p_member_client_ids) = 0 then
      if p_client_id is null then
        raise exception 'editor role requires p_member_client_ids or p_client_id';
      end if;
      p_member_client_ids := array[p_client_id];
    end if;
  end if;

  update public.profiles
  set
    role      = p_role,
    client_id = case when p_role = 'member' then p_client_id else null end
  where id = p_user_id;

  delete from public.client_members where user_id = p_user_id;

  if p_role = 'editor' and p_member_client_ids is not null then
    foreach _cid in array p_member_client_ids loop
      if exists (select 1 from public.clients where id = _cid) then
        insert into public.client_members (user_id, client_id)
        values (p_user_id, _cid)
        on conflict do nothing;
      end if;
    end loop;
  end if;
end;
$$;

-- ── 5. Seed the initial super_admin ──────────────────────────────────────────
-- Idempotent: only promotes the profile if the account already exists.
update public.profiles p
set role = 'super_admin'
from auth.users u
where p.id = u.id
  and lower(u.email) = 'mind@disruptcollective.com';
