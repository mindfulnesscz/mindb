-- ============================================================
-- DC Hub — Supabase Schema
-- Run this in the Supabase SQL Editor (Project → SQL Editor → New query)
-- ============================================================

-- ── Extensions ───────────────────────────────────────────────
create extension if not exists "uuid-ossp";


-- ── Clients ──────────────────────────────────────────────────
create table public.clients (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  accent           text not null default '#161616',
  initials         text not null default '',
  domain_whitelist text[] not null default '{}',
  created_at       timestamptz not null default now()
);


-- ── Profiles (extends auth.users) ────────────────────────────
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  name       text not null default '',
  initials   text not null default '',
  role       text not null default 'client'
               check (role in ('public', 'client', 'editor', 'admin')),
  client_id  uuid references public.clients(id) on delete set null,
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
create table public.assets (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references public.clients(id) on delete cascade,
  name          text not null,
  entity_type   text not null check (entity_type in ('product', 'customer', 'partner', 'event')),
  entity        text not null default '',
  formats       text[] not null default '{}',
  angle         text not null default '',
  status        text not null default 'draft'
                  check (status in ('draft', 'review', 'approved', 'published', 'archived')),
  perm          text not null default 'client'
                  check (perm in ('public', 'client', 'internal')),
  version       text not null default 'v1-0-0',
  latest        boolean not null default true,
  thumbnail_url text,
  download_url  text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Auto-update updated_at
create function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger assets_updated_at
  before update on public.assets
  for each row execute function public.touch_updated_at();


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
  action     text not null,   -- 'approved' | 'commented' | 'uploaded' | 'requested_changes' etc.
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
create index on public.assets (status);
create index on public.assets (perm);
create index on public.assets (latest);
create index on public.assets (client_id, status);
create index on public.assets (client_id, latest);
create index on public.tags   (client_id, dimension);
create index on public.ratings  (asset_id);
create index on public.comments (asset_id);
create index on public.approvals (asset_id, user_id);
create index on public.activity (user_id, created_at desc);


-- ── Auto-create profile on signup ────────────────────────────
create function public.handle_new_user()
returns trigger language plpgsql security definer as $$
declare
  _name text;
  _initials text;
begin
  _name     := coalesce(new.raw_user_meta_data->>'name', new.email, '');
  _initials := upper(left(regexp_replace(_name, '[^A-Za-z ]', '', 'g'), 2));
  insert into public.profiles (id, name, initials, role)
  values (new.id, _name, _initials, 'client')
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ============================================================
-- Row-Level Security
-- ============================================================

alter table public.clients   enable row level security;
alter table public.profiles  enable row level security;
alter table public.tags      enable row level security;
alter table public.assets    enable row level security;
alter table public.ratings   enable row level security;
alter table public.comments  enable row level security;
alter table public.approvals enable row level security;
alter table public.activity  enable row level security;

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


-- Clients ─ all authenticated users can read; only admins can write
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


-- Assets ─ visibility depends on perm field
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


-- Ratings ─ authenticated users can rate assets they can see
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
