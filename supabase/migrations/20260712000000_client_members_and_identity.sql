-- Client membership + DB-owned identity flag — groundwork for the desktop
-- login gate and DB-first client management (docs: desktop/authentication-plan).
--
-- 1. clients.identity_migrated moves the folder-identity flag out of the
--    desktop's local clients.json. A machine syncing without that local flag
--    would take the legacy path and hard-delete stable-identity rows; the
--    database is the only safe home for a fact about the client's data.
-- 2. client_members assigns users to the clients they may operate on. The
--    desktop shows only clients the signed-in user is a member of; admins
--    see and manage all. (RLS on other tables still uses the global staff
--    roles for now — single-agency setup; per-client policy tightening is a
--    later, deliberate step.)

alter table public.clients
  add column identity_migrated boolean not null default false;

create table public.client_members (
  user_id    uuid not null references auth.users(id) on delete cascade,
  client_id  uuid not null references public.clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, client_id)
);

create index client_members_client_id_idx on public.client_members (client_id);

alter table public.client_members enable row level security;

-- Users see their own memberships; staff see all; only admins change them.
create policy "client_members: own rows"
  on public.client_members for select
  using (auth.uid() = user_id);

create policy "client_members: staff read all"
  on public.client_members for select
  using (public.is_staff());

create policy "client_members: admins write"
  on public.client_members for all
  using (exists (select 1 from public.profiles where id = auth.uid() and role = 'admin'));

-- Helper for future per-client policies and the desktop client picker.
create function public.my_member_client_ids()
returns uuid[] language sql security definer as $$
  select coalesce(array_agg(client_id), '{}'::uuid[])
  from public.client_members where user_id = auth.uid();
$$;
