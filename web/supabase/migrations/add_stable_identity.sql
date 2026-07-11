-- Folder-based stable asset identity — decouples asset identity from the filename-derived
-- shortcode, which breaks (disconnects the row) whenever taxonomy/naming changes.
-- Run once in Supabase SQL editor, per client project.

alter table assets add column if not exists stable_id text;
alter table assets add column if not exists child_id text;
alter table assets add column if not exists variant_of uuid references assets(id);

create unique index if not exists assets_stable_child_unique
  on assets (stable_id, child_id)
  where status != 'disconnected';
