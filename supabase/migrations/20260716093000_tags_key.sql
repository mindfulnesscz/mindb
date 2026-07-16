-- Stable taxonomy key per tag (import identity + Obsidian tag on desktop export).

alter table public.tags
  add column if not exists key text;

create unique index if not exists tags_client_key_uidx
  on public.tags (client_id, key)
  where key is not null;
