-- Always-latest CDN/R2 URL for an asset's original file. Despite being present in
-- database.types.ts and read by the portal's download button, this column was never
-- actually applied to the live DB (that types file was ahead of the real schema).
-- Run once in Supabase SQL editor.

alter table assets
  add column if not exists download_url text;
