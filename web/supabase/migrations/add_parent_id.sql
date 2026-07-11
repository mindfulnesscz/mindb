-- Add parent_id for folder-based gallery assets (sub-assets grouped under a folder parent).
-- Run once in Supabase SQL editor.

alter table assets
  add column if not exists parent_id uuid references assets(id) on delete cascade;

create index if not exists assets_parent_id_idx on assets(parent_id);
