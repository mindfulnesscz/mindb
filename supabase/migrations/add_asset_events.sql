-- Tracks view/download events per asset for the portal's view/download counters
-- (eventService.ts: trackEvent, fetchEventCounts). Distinct from the draft `activity`
-- table in Write schema.sql — that one restricts writes to staff only, but view/download
-- events are recorded for any portal visitor, including anonymous ones (user_id can be
-- null). Run once in Supabase SQL editor.

create table if not exists asset_events (
  id         uuid primary key default gen_random_uuid(),
  asset_id   uuid not null references assets(id) on delete cascade,
  event_type text not null check (event_type in ('view', 'download')),
  user_id    uuid references auth.users(id) on delete set null,
  role       text not null default 'public',
  created_at timestamptz not null default now()
);

create index if not exists asset_events_asset_id_idx on asset_events(asset_id);

alter table asset_events enable row level security;

-- Any visitor (including unauthenticated) can record a view/download — matches
-- trackEvent() being called for anonymous portal browsing, not just logged-in users.
create policy "asset_events: anyone can insert"
  on asset_events for insert
  with check (true);

-- View/download counts are shown on the asset detail page regardless of auth state
-- (public-perm assets are already world-readable), so counts must be readable too.
create policy "asset_events: anyone can read"
  on asset_events for select
  using (true);
