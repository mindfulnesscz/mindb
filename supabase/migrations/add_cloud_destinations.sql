-- Cloud destination DEFINITIONS (Dropbox/OneDrive/Google Drive configs), shared across
-- the whole team via this client row. OAuth tokens are stripped before being written here
-- and stay local-only on whichever machine authorized them — see cloudDestinationSync in
-- clientService.ts. Run once in Supabase SQL editor.

alter table clients
  add column if not exists cloud_destinations jsonb not null default '[]';
