-- ============================================================
-- Baseline — the production schema as of 2026-07-11 (v2.3.0)
-- ============================================================
-- Consolidates the retired web/supabase/schema.sql, "Write schema.sql",
-- and ten loose migration files into one authoritative starting point,
-- verified against live production via PostgREST introspection.
--
-- Two deliberate oddities preserved here because they ARE production:
--   1. assets.entities is TEXT holding a JSON-encoded array ('["ESS"]')
--      while formats/angles/tags are real text[] — fixed by the next
--      migration (20260711000001_entities_to_text_array.sql).
--   2. get_all_profiles / update_user_role existed only in production
--      (created via the SQL editor, never in any schema file). Their
--      bodies below are reconstructed from the portal's usage — verify
--      with `supabase db pull` after linking and repair if they differ.
--
-- Production adoption: DO NOT push this to the live project. Link and run
--   supabase migration repair --status applied 20260711000000
-- so history starts from here; only later migrations get pushed.
-- Fresh environments (local, staging) simply run everything in order.
-- ============================================================

create extension if not exists "uuid-ossp";

-- ── Role grants ──────────────────────────────────────────────
-- Tables created via raw SQL don't get API-role grants automatically
-- (production learned this with asset_events returning 403). RLS still
-- gates every row — these grants only let PostgREST reach the tables.
-- The `alter default privileges` lines cover objects from future migrations.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on routines  to anon, authenticated, service_role;

-- ── Clients ──────────────────────────────────────────────────
create table public.clients (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null unique,
  slug               text unique,
  accent             text not null default '#161616',
  initials           text not null default '',
  logo_url           text,
  website            text,
  portal_bg          text,
  domain_whitelist   text[] not null default '{}',
  cloud_destinations jsonb not null default '[]',
  created_at         timestamptz not null default now()
);

-- ── Profiles (extends auth.users) ────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  initials   text not null default '',
  role       text not null default 'public'
               check (role in ('public', 'client', 'editor', 'admin')),
  client_id  uuid references public.clients(id) on delete set null,
  company    text not null default '',
  country    text not null default '',
  industry   text not null default '',
  created_at timestamptz not null default now()
);

-- ── Tags ─────────────────────────────────────────────────────
create table public.tags (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references public.clients(id) on delete cascade,
  name       text not null,
  dimension  text not null check (dimension in ('entity', 'format', 'angle')),
  parent_id  uuid references public.tags(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- ── Assets ───────────────────────────────────────────────────
-- Identity: legacy clients merge on (client_id, shortcode); migrated
-- clients merge on (stable_id, child_id) — see the partial unique index.
create table public.assets (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references public.clients(id) on delete cascade,
  shortcode         text not null,
  name              text not null default '',
  -- production quirk: JSON string, not text[] — see next migration
  entities          text not null default '[]',
  formats           text[] not null default '{}',
  angles            text[] not null default '{}',
  tags              text[] not null default '{}',
  year_month        text,
  status            text not null default 'draft'
                      check (status in ('draft', 'review', 'approved', 'published', 'archived', 'disconnected')),
  perm              text not null default 'client'
                      check (perm in ('public', 'client', 'internal')),
  version           text not null default '',
  latest            boolean not null default true,
  thumbnail_url     text,
  download_url      text,
  download_urls     jsonb not null default '[]',
  download_key      text,
  parent_id         uuid references public.assets(id) on delete cascade,
  stable_id         text,
  child_id          text,
  variant_of        uuid references public.assets(id),
  primary_entity_id uuid references public.tags(id),
  primary_angle_id  uuid references public.tags(id),
  primary_format_id uuid references public.tags(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (client_id, shortcode)
);

create unique index assets_stable_child_unique
  on public.assets (stable_id, child_id)
  where status != 'disconnected';

create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger assets_updated_at
  before update on public.assets
  for each row execute function public.touch_updated_at();

-- ── Version history ──────────────────────────────────────────
create table public.version_history (
  id            uuid primary key default gen_random_uuid(),
  asset_id      uuid not null references public.assets(id) on delete cascade,
  version_label text not null default '',
  version       text not null,
  status        text not null default 'Active'
                  check (status in ('Active', 'History', 'Disconnected', 'Removed')),
  file_url      text,
  date          date,
  created_at    timestamptz not null default now(),
  unique (asset_id, version)
);

-- ── Feedback tables ──────────────────────────────────────────
create table public.ratings (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  value      integer not null check (value between 1 and 5),
  created_at timestamptz not null default now(),
  unique (asset_id, user_id)
);

create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);

create table public.approvals (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  state      text not null default 'pending'
               check (state in ('approved', 'pending', 'changes', 'none')),
  note       text,
  created_at timestamptz not null default now(),
  unique (asset_id, user_id)
);

create table public.activity (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid references public.assets(id) on delete set null,
  user_id    uuid references auth.users(id) on delete set null,
  action     text not null,
  created_at timestamptz not null default now()
);

-- View/download counters; anonymous visitors may write (user_id nullable)
create table public.asset_events (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  event_type text not null check (event_type in ('view', 'download')),
  user_id    uuid references auth.users(id) on delete set null,
  role       text not null default 'public',
  created_at timestamptz not null default now()
);

-- ── Views ────────────────────────────────────────────────────
create view public.asset_stats as
  select
    a.id,
    round(coalesce(avg(r.value), 0)::numeric, 1) as avg_rating,
    count(distinct r.id)::int                     as rating_count,
    count(distinct c.id)::int                     as comment_count
  from public.assets a
  left join public.ratings  r on r.asset_id = a.id
  left join public.comments c on c.asset_id = a.id
  group by a.id;

-- ── Indexes ──────────────────────────────────────────────────
create index on public.assets (client_id);
create index on public.assets (client_id, status);
create index on public.assets (client_id, latest);
create index on public.assets (status);
create index on public.assets (perm);
create index on public.assets (latest);
create index assets_parent_id_idx on public.assets (parent_id);
create index on public.tags (client_id, dimension);
create index on public.version_history (asset_id);
create index on public.version_history (status);
create index on public.ratings (asset_id);
create index on public.comments (asset_id);
create index on public.approvals (asset_id, user_id);
create index on public.activity (user_id, created_at desc);
create index asset_events_asset_id_idx on public.asset_events (asset_id);

-- ── Functions ────────────────────────────────────────────────
create function public.handle_new_user()
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

  select id into _client_id from public.clients
    where _domain = any(domain_whitelist)
    limit 1;

  if _client_id is not null then
    _role := 'client';
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 'staff' | 'whitelisted' | 'returning' | 'unknown' — sign-in modal pre-check
create function public.check_email_auth(p_email text)
returns text language plpgsql security definer as $$
declare
  _domain text;
  _exists boolean;
begin
  _domain := lower(split_part(p_email, '@', 2));
  perform 1 from public.profiles p join auth.users u on u.id = p.id
    where lower(u.email) = lower(p_email) and p.role in ('editor', 'admin') limit 1;
  if found then return 'staff'; end if;
  perform 1 from public.clients where _domain = any(domain_whitelist) limit 1;
  if found then return 'whitelisted'; end if;
  select exists(select 1 from auth.users where lower(email) = lower(p_email)) into _exists;
  if _exists then return 'returning'; end if;
  return 'unknown';
end;
$$;
grant execute on function public.check_email_auth(text) to anon;

create function public.get_client_portal(p_slug text)
returns table (id uuid, name text, accent text, initials text, logo_url text, portal_bg text)
language sql security definer as $$
  select id, name, accent, initials, logo_url, portal_bg
  from public.clients where slug = p_slug limit 1;
$$;
grant execute on function public.get_client_portal(text) to anon;

create function public.is_staff()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('editor', 'admin')
  );
$$;

create function public.my_client_id()
returns uuid language sql security definer as $$
  select client_id from public.profiles where id = auth.uid();
$$;

-- RECONSTRUCTED (existed only in production, no schema file) — admin user list.
-- Verify against `supabase db pull` output after linking.
create function public.get_all_profiles()
returns table (
  id uuid, name text, initials text, role text,
  client_id uuid, client_name text, email text, created_at timestamptz
) language sql security definer as $$
  select p.id, p.name, p.initials, p.role,
         p.client_id, c.name as client_name, u.email::text, p.created_at
  from public.profiles p
  left join public.clients c on c.id = p.client_id
  join auth.users u on u.id = p.id
  where public.is_staff()
  order by p.created_at desc;
$$;
grant execute on function public.get_all_profiles() to authenticated;

-- RECONSTRUCTED (existed only in production, no schema file) — admin role change.
-- Verify against `supabase db pull` output after linking.
create function public.update_user_role(p_user_id uuid, p_role text)
returns void language plpgsql security definer as $$
begin
  if not public.is_staff() then
    raise exception 'not authorized';
  end if;
  if p_role not in ('public', 'client', 'editor', 'admin') then
    raise exception 'invalid role %', p_role;
  end if;
  update public.profiles set role = p_role where id = p_user_id;
end;
$$;
grant execute on function public.update_user_role(uuid, text) to authenticated;

-- ============================================================
-- Row-Level Security
-- (The desktop pipeline uses the service-role key and bypasses all of this;
--  RLS governs portal sessions only.)
-- ============================================================
alter table public.clients         enable row level security;
alter table public.profiles        enable row level security;
alter table public.tags            enable row level security;
alter table public.assets          enable row level security;
alter table public.version_history enable row level security;
alter table public.ratings         enable row level security;
alter table public.comments        enable row level security;
alter table public.approvals       enable row level security;
alter table public.activity        enable row level security;
alter table public.asset_events    enable row level security;

create policy "clients: authenticated can read"
  on public.clients for select using (auth.role() = 'authenticated');
create policy "clients: admins can write"
  on public.clients for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

create policy "profiles: own row"
  on public.profiles for select using (auth.uid() = id);
create policy "profiles: staff read all"
  on public.profiles for select using (public.is_staff());
create policy "profiles: own update"
  on public.profiles for update using (auth.uid() = id);

create policy "tags: same client or staff"
  on public.tags for select
  using (public.is_staff() or client_id = public.my_client_id());
create policy "tags: staff write"
  on public.tags for all using (public.is_staff());

create policy "assets: public perm is world-readable"
  on public.assets for select using (perm = 'public');
create policy "assets: client perm for same-client users"
  on public.assets for select
  using (perm = 'client' and (public.is_staff() or client_id = public.my_client_id()));
create policy "assets: internal perm for staff only"
  on public.assets for select using (perm = 'internal' and public.is_staff());
create policy "assets: staff write"
  on public.assets for all using (public.is_staff());

create policy "version_history: readable with asset"
  on public.version_history for select
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())
  ));
create policy "version_history: staff write"
  on public.version_history for all using (public.is_staff());

create policy "ratings: authenticated can read"
  on public.ratings for select using (auth.role() = 'authenticated');
create policy "ratings: own insert"
  on public.ratings for insert with check (auth.uid() = user_id);
create policy "ratings: own update"
  on public.ratings for update using (auth.uid() = user_id);

create policy "comments: authenticated can read"
  on public.comments for select using (auth.role() = 'authenticated');
create policy "comments: own insert"
  on public.comments for insert with check (auth.uid() = user_id);

create policy "approvals: authenticated can read"
  on public.approvals for select using (auth.role() = 'authenticated');
create policy "approvals: own insert"
  on public.approvals for insert with check (auth.uid() = user_id);
create policy "approvals: own update"
  on public.approvals for update using (auth.uid() = user_id);

create policy "activity: authenticated can read"
  on public.activity for select using (auth.role() = 'authenticated');
create policy "activity: staff write"
  on public.activity for all using (public.is_staff());

-- Anonymous portal visitors may record and read view/download counters
create policy "asset_events: anyone can insert"
  on public.asset_events for insert with check (true);
create policy "asset_events: anyone can read"
  on public.asset_events for select using (true);
grant select, insert on public.asset_events to anon, authenticated;
