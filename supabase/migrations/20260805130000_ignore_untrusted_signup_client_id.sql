-- A portal client_id is caller-controlled signup metadata, not proof of tenant membership.
-- Only a server-side email-domain allow-list match may auto-assign a new user; everyone else lands
-- as public with no client_id until an admin assigns access through update_user_access.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  _name      text;
  _initials  text;
  _domain    text;
  _client_id uuid;
  _role      text := 'public';
begin
  _name     := coalesce(new.raw_user_meta_data->>'name', new.email, '');
  _initials := upper(left(regexp_replace(_name, '[^A-Za-z ]', '', 'g'), 2));
  _domain   := lower(split_part(new.email, '@', 2));

  -- The domain allow-list is stored by an administrator. Never use raw_user_meta_data.client_id
  -- here: an unauthenticated signup request can set that value to any tenant UUID.
  select id into _client_id from public.clients
    where _domain = any(domain_whitelist)
    limit 1;

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
