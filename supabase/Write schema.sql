-- ============================================================
-- DC Hub — Supabase Schema  (RLS multi-tenant, single project)
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query)
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
create extension if not exists "uuid-ossp";


-- ── Schema grants ────────────────────────────────────────────
-- Required after `drop schema public cascade / create schema public`.
-- Restores the default Supabase permissions lost during a schema reset.
grant usage on schema public to anon, authenticated, service_role;
grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all routines  in schema public to anon, authenticated, service_role;


-- ── Clients ──────────────────────────────────────────────────
-- One row per agency client. name must be unique — used as the
-- lookup key when the Tauri pipeline syncs without a cached UUID.
create table public.clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null unique,
  slug             text unique,           -- URL-safe portal identifier, e.g. "meridian-labs"
  accent           text not null default '#161616',
  initials         text not null default '',
  logo_url         text,
  website          text,
  portal_bg        text,                  -- CSS colour or image URL for the portal welcome screen
  domain_whitelist text[] not null default '{}',
  created_at       timestamptz not null default now()
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
-- Per-client taxonomy. dimension = entity | format | angle
-- parent_id enables sub-types (e.g. Entity → Product / Customer)
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
-- shortcode is a display-only rendering of the filename (version suffix stripped) —
-- for clients migrated to folder-based stable identity (see
-- migrations/add_stable_identity.sql and CLAUDE_CODE_PROMPT_identity-migration.md),
-- `(stable_id, child_id)` is the real merge key instead, so a taxonomy/filename
-- rename no longer disconnects the row. Unmigrated clients still merge on shortcode.
-- UUID id is the immutable identity either way.
create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  shortcode     text not null,
  name          text not null default '',
  entities      text[] not null default '{}',
  formats       text[] not null default '{}',
  angles        text[] not null default '{}',
  tags          text[] not null default '{}',
  year_month    text,
  status        text not null default 'draft'
                  check (status in ('draft', 'review', 'approved', 'published', 'archived')),
  perm          text not null default 'client'
                  check (perm in ('public', 'client', 'internal')),
  version       text not null default '',
  latest        boolean not null default true,
  thumbnail_url text,
  download_urls jsonb not null default '[]',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, shortcode)
);

-- Auto-update updated_at
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger assets_updated_at
  before update on public.assets
  for each row execute function public.touch_updated_at();


-- ── Version History ──────────────────────────────────────────
-- One row per (asset, version). The pipeline upserts on
-- (asset_id, version) — creating new rows or updating status.
-- status: Active = current version on disk
--         History = older version still on disk
--         Disconnected = version file no longer found
--         Removed = entire asset gone from source
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


-- ── Ratings ──────────────────────────────────────────────────
create table public.ratings (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  value      integer not null check (value between 1 and 5),
  created_at timestamptz not null default now(),
  unique (asset_id, user_id)
);


-- ── Comments ─────────────────────────────────────────────────
create table public.comments (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references public.assets(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now()
);


-- ── Approvals ────────────────────────────────────────────────
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


-- ── Activity ─────────────────────────────────────────────────
create table public.activity (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid references public.assets(id) on delete set null,
  user_id    uuid references auth.users(id) on delete set null,
  action     text not null,
  created_at timestamptz not null default now()
);


-- ── Computed view: asset stats ────────────────────────────────
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


-- ── Indexes ───────────────────────────────────────────────────
create index on public.assets (client_id);
create index on public.assets (client_id, status);
create index on public.assets (client_id, latest);
create index on public.assets (status);
create index on public.assets (perm);
create index on public.assets (latest);
create index on public.assets using gin (entities);
create index on public.tags              (client_id, dimension);
create index on public.version_history   (asset_id);
create index on public.version_history   (status);
create index on public.ratings           (asset_id);
create index on public.comments          (asset_id);
create index on public.approvals         (asset_id, user_id);
create index on public.activity          (user_id, created_at desc);


-- ── Auto-create profile on signup ────────────────────────────
-- Reads name/company/country/industry from OTP metadata.
-- Auto-assigns client_id + role='client' if email domain is whitelisted.
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
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ── Email auth check (callable by anon, no session needed) ───
-- Returns: 'staff' | 'whitelisted' | 'returning' | 'unknown'
-- Used by the sign-in modal to decide whether to show extra fields.
create function public.check_email_auth(p_email text)
returns text language plpgsql security definer as $$
declare
  _domain text;
  _exists boolean;
begin
  _domain := lower(split_part(p_email, '@', 2));

  -- Known staff (editor or admin)
  perform 1
    from public.profiles p
    join auth.users u on u.id = p.id
    where lower(u.email) = lower(p_email)
      and p.role in ('editor', 'admin')
    limit 1;
  if found then return 'staff'; end if;

  -- Whitelisted domain
  perform 1 from public.clients
    where _domain = any(domain_whitelist)
    limit 1;
  if found then return 'whitelisted'; end if;

  -- Returning user (already signed up before)
  select exists(
    select 1 from auth.users where lower(email) = lower(p_email)
  ) into _exists;
  if _exists then return 'returning'; end if;

  return 'unknown';
end;
$$;

grant execute on function public.check_email_auth(text) to anon;


-- ── Public portal lookup (anon-safe, limited fields only) ─────
create function public.get_client_portal(p_slug text)
returns table (
  id        uuid,
  name      text,
  accent    text,
  initials  text,
  logo_url  text,
  portal_bg text
) language sql security definer as $$
  select id, name, accent, initials, logo_url, portal_bg
  from   public.clients
  where  slug = p_slug
  limit  1;
$$;

grant execute on function public.get_client_portal(text) to anon;


-- ============================================================
-- Row-Level Security
-- ============================================================
-- NOTE: The Tauri pipeline syncs using the service role key,
-- which bypasses RLS entirely. RLS only applies to portal users
-- (anon key / authenticated sessions).
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

-- Helper: is the current user an editor or admin?
create function public.is_staff()
returns boolean language sql security definer as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('editor', 'admin')
  );
$$;

-- Helper: which client does the current user belong to?
create function public.my_client_id()
returns uuid language sql security definer as $$
  select client_id from public.profiles where id = auth.uid();
$$;


-- Clients ─ authenticated users can read; only admins can write
create policy "clients: authenticated can read"
  on public.clients for select
  using (auth.role() = 'authenticated');

create policy "clients: admins can write"
  on public.clients for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));


-- Profiles ─ own row always readable; staff can read all
create policy "profiles: own row"
  on public.profiles for select
  using (auth.uid() = id);

create policy "profiles: staff read all"
  on public.profiles for select
  using (public.is_staff());

create policy "profiles: own update"
  on public.profiles for update
  using (auth.uid() = id);


-- Tags ─ same-client users + staff can read; staff can write
create policy "tags: same client or staff"
  on public.tags for select
  using (
    public.is_staff()
    or client_id = public.my_client_id()
  );

create policy "tags: staff write"
  on public.tags for all
  using (public.is_staff());


-- Assets ─ visibility gated on the perm column
create policy "assets: public perm is world-readable"
  on public.assets for select
  using (perm = 'public');

create policy "assets: client perm for same-client users"
  on public.assets for select
  using (
    perm = 'client'
    and (
      public.is_staff()
      or client_id = public.my_client_id()
    )
  );

create policy "assets: internal perm for staff only"
  on public.assets for select
  using (perm = 'internal' and public.is_staff());

create policy "assets: staff write"
  on public.assets for all
  using (public.is_staff());


-- Version History ─ readable if the linked asset is readable
create policy "version_history: readable with asset"
  on public.version_history for select
  using (
    exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (
          a.perm = 'public'
          or public.is_staff()
          or a.client_id = public.my_client_id()
        )
    )
  );

create policy "version_history: staff write"
  on public.version_history for all
  using (public.is_staff());


-- Ratings ─ authenticated users can read and rate
create policy "ratings: authenticated can read"
  on public.ratings for select using (auth.role() = 'authenticated');

create policy "ratings: own insert"
  on public.ratings for insert with check (auth.uid() = user_id);

create policy "ratings: own update"
  on public.ratings for update using (auth.uid() = user_id);


-- Comments
create policy "comments: authenticated can read"
  on public.comments for select using (auth.role() = 'authenticated');

create policy "comments: own insert"
  on public.comments for insert with check (auth.uid() = user_id);


-- Approvals
create policy "approvals: authenticated can read"
  on public.approvals for select using (auth.role() = 'authenticated');

create policy "approvals: own insert"
  on public.approvals for insert with check (auth.uid() = user_id);

create policy "approvals: own update"
  on public.approvals for update using (auth.uid() = user_id);


-- Activity
create policy "activity: authenticated can read"
  on public.activity for select using (auth.role() = 'authenticated');

create policy "activity: staff write"
  on public.activity for all using (public.is_staff());


-- ============================================================
-- Migrations (run these against an existing database)
-- ============================================================
alter table public.clients  add column if not exists logo_url   text;
alter table public.clients  add column if not exists website    text;
alter table public.clients  add column if not exists slug       text unique;
alter table public.clients  add column if not exists portal_bg  text;
alter table public.profiles add column if not exists company   text not null default '';
alter table public.profiles add column if not exists country   text not null default '';
alter table public.profiles add column if not exists industry  text not null default '';

-- Update trigger to new version (replace in place)
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

-- Add check_email_auth if not exists
create or replace function public.check_email_auth(p_email text)
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

create or replace function public.get_client_portal(p_slug text)
returns table (
  id        uuid,
  name      text,
  accent    text,
  initials  text,
  logo_url  text,
  portal_bg text
) language sql security definer as $$
  select id, name, accent, initials, logo_url, portal_bg
  from   public.clients
  where  slug = p_slug
  limit  1;
$$;
grant execute on function public.get_client_portal(text) to anon;
