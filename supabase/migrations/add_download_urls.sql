-- Multi-provider cloud sharing links (Dropbox/OneDrive/Google Drive) for client-role
-- destinations, as a JSON array. Distinct from download_url (singular), which is the
-- always-latest CDN/R2 URL for the original file. Run once in Supabase SQL editor.
-- Shape: [{ "provider": "dropbox"|"onedrive"|"gdrive", "name": "<destination name>", "url": "..." }, ...]

alter table assets
  add column if not exists download_urls jsonb not null default '[]';
