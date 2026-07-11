-- Primary tags drive filename/folder rendering for the asset creation flow (Task 6 of
-- CLAUDE_CODE_PROMPT_identity-migration.md) — exactly one per dimension, required.
-- Secondary tags remain the existing entities/formats/angles/tags text[] columns.
-- Run once in Supabase SQL editor, per client project that has already run
-- add_stable_identity.sql.

alter table assets add column if not exists primary_entity_id uuid references tags(id);
alter table assets add column if not exists primary_angle_id  uuid references tags(id);
alter table assets add column if not exists primary_format_id uuid references tags(id);
