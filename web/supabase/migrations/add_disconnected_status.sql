-- Add 'disconnected' as a valid asset status.
-- Run once in Supabase SQL editor (or via supabase db push).

alter table assets
  drop constraint if exists assets_status_check;

alter table assets
  add constraint assets_status_check
  check (status in ('draft', 'review', 'approved', 'published', 'archived', 'disconnected'));
