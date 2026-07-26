-- Delegable client creation.
--
-- Client creation is no longer super_admin-only. A super_admin may grant an
-- individual admin the ability to create clients (later bounded by plan). The
-- grant is a per-admin boolean; super_admins can always create clients.
-- Environment management remains super_admin-only (enforced in the desktop UI;
-- environments are client-side connection configs, RLS is the data boundary).

alter table public.profiles
  add column if not exists can_create_clients boolean not null default false;

-- Who may INSERT a client: super_admin always, or an admin holding the grant.
create or replace function public.can_create_clients()
returns boolean language sql security definer as $$
  select public.is_super_admin()
      or (public.is_admin() and exists (
            select 1 from public.profiles
            where id = auth.uid() and can_create_clients
          ));
$$;

-- Replace the super_admin-only insert policy from 20260724120001.
drop policy if exists "clients: super_admin insert" on public.clients;
create policy "clients: create when permitted"
  on public.clients for insert with check (public.can_create_clients());

-- Extend update_user_access with the grant flag. Only a super_admin may change
-- it, and only admins/super_admins may hold it. Single 5-arg definition (the
-- 4-arg default keeps the edge function's existing call working).
drop function if exists public.update_user_access(uuid, text, uuid, uuid[]);
create or replace function public.update_user_access(
  p_user_id              uuid,
  p_role                 text,
  p_client_id            uuid    default null,
  p_member_client_ids    uuid[]  default null,
  p_can_create_clients   boolean default null
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
  if p_can_create_clients is not null and not public.is_super_admin() then
    raise exception 'only super_admin can grant client creation';
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
    client_id = case when p_role = 'member' then p_client_id else null end,
    can_create_clients = case
      when p_role in ('admin', 'super_admin')
        then coalesce(p_can_create_clients, can_create_clients)
      else false
    end
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

grant execute on function public.update_user_access(uuid, text, uuid, uuid[], boolean) to authenticated;

-- Surface the grant in the admin users list.
drop function if exists public.get_all_profiles();
create function public.get_all_profiles()
returns table (
  id uuid, name text, initials text, role text,
  client_id uuid, client_name text, email text, created_at timestamptz,
  can_create_clients boolean
) language sql security definer as $$
  select p.id, p.name, p.initials, p.role,
         p.client_id, c.name as client_name, u.email::text, p.created_at,
         p.can_create_clients
  from public.profiles p
  left join public.clients c on c.id = p.client_id
  join auth.users u on u.id = p.id
  where public.is_staff()
  order by p.created_at desc;
$$;
grant execute on function public.get_all_profiles() to authenticated;
