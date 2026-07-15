-- Per-client taxonomy display labels + tag shortcodes in DB.

alter table public.clients
  add column if not exists dimension_labels jsonb not null default '{"entity":"Entity","angle":"Angle","format":"Format"}'::jsonb;

alter table public.tags
  add column if not exists shortcode text;

create index if not exists tags_client_shortcode_idx
  on public.tags (client_id, shortcode)
  where shortcode is not null;
