-- Storage config moves to environment-level edge function secrets (R2_BUCKET,
-- R2_PUBLIC_DOMAIN). Per-client bucket/domain columns are retired.

alter table public.clients
  drop column if exists r2_bucket,
  drop column if exists r2_public_domain;
