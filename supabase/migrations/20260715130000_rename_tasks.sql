-- Rename task queue for taxonomy-driven filesystem sync (Phase F).

create table public.rename_tasks (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references public.clients(id) on delete cascade,
  asset_id     uuid references public.assets(id) on delete cascade,
  task_type    text not null check (task_type in ('tag_rename', 'tag_delete', 'asset_retag')),
  payload      jsonb not null default '{}',
  status       text not null default 'pending'
                 check (status in ('pending', 'running', 'completed', 'failed')),
  created_by   uuid references auth.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index rename_tasks_client_status_idx on public.rename_tasks (client_id, status);

alter table public.assets
  add column if not exists rename_status text not null default 'synced'
    check (rename_status in ('pending', 'running', 'synced', 'failed'));

alter table public.rename_tasks enable row level security;

create policy "rename_tasks: staff read"
  on public.rename_tasks for select
  using (public.is_staff());

create policy "rename_tasks: staff write"
  on public.rename_tasks for all
  using (public.is_staff());

grant select, insert, update on public.rename_tasks to authenticated;
