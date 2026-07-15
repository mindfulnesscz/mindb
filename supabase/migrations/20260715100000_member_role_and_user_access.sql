-- Rename portal role 'client' → 'member'; fix signup client assignment;
-- add admin-only update_user_access RPC with client_members management.

-- ── 1. Data migration ───────────────────────────────────────────────────────
update public.profiles set role = 'member' where role = 'client';

-- ── 2. Role check constraint ──────────────────────────────────────────────────
alter table public.profiles drop constraint if exists profiles_role_check;
alter table public.profiles
  add constraint profiles_role_check
  check (role in ('public', 'member', 'editor', 'admin'));

-- ── 3. handle_new_user — member role + portal client_id metadata ─────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  _name      text;
  _initials  text;
  _domain    text;
  _client_id uuid;
  _meta_id   text;
  _role      text := 'public';
begin
  _name     := coalesce(new.raw_user_meta_data->>'name', new.email, '');
  _initials := upper(left(regexp_replace(_name, '[^A-Za-z ]', '', 'g'), 2));
  _domain   := lower(split_part(new.email, '@', 2));

  -- Whitelist match takes precedence
  select id into _client_id from public.clients
    where _domain = any(domain_whitelist)
    limit 1;

  -- Portal /:slug sign-in passes client_id in OTP metadata
  if _client_id is null then
    _meta_id := new.raw_user_meta_data->>'client_id';
    if _meta_id is not null and _meta_id ~* '^[0-9a-f-]{36}$' then
      select id into _client_id from public.clients
        where id = _meta_id::uuid
        limit 1;
    end if;
  end if;

  if _client_id is not null then
    _role := 'member';
  end if;

  insert into public.profiles (id, name, initials, role, client_id, company, country, industry)
  values (
    new.id, _name, _initials, _role, _client_id,
    coalesce(new.raw_user_meta_data->>'company',  ''),
    coalesce(new.raw_user_meta_data->>'country',  ''),
    coalesce(new.raw_user_meta_data->>'industry', '')
  )
  on conflict (id) do update set
    company  = excluded.company,
    country  = excluded.country,
    industry = excluded.industry;
  return new;
end;
$$;

-- ── 4. Admin helper ─────────────────────────────────────────────────────────
create or replace function public.is_admin()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin'
  );
$$;

-- ── 5. update_user_role — admin-only, member role ───────────────────────────
create or replace function public.update_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_role not in ('public', 'member', 'editor', 'admin') then
    raise exception 'invalid role %', p_role;
  end if;
  update public.profiles set role = p_role where id = p_user_id;
end;
$$;

-- ── 6. update_user_access — role + client + client_members ───────────────────
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
  if p_role not in ('public', 'member', 'editor', 'admin') then
    raise exception 'invalid role %', p_role;
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

grant execute on function public.update_user_access(uuid, text, uuid, uuid[]) to authenticated;

-- Return assigned client IDs for the users tab
create or replace function public.get_user_client_members(p_user_id uuid)
returns uuid[] language sql security definer as $$
  select coalesce(array_agg(client_id order by client_id), '{}')
  from public.client_members
  where user_id = p_user_id
    and public.is_admin();
$$;

grant execute on function public.get_user_client_members(uuid) to authenticated;
