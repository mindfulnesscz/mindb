-- Track R2 object key for the original file so CDN state lives in DB, not in R2 listings.
-- Run once in Supabase SQL editor.

alter table assets
  add column if not exists download_key text;
