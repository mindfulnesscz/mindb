-- Storage config becomes server-authoritative (authentication-plan Phase 3,
-- R2 half): the r2-grant edge function reads bucket/public domain from the
-- client row and issues short-lived scoped credentials — the desktop no
-- longer decides where files go or what URL serves them, which retires the
-- bucket/domain-mismatch failure mode along with the permanent local keys.

alter table public.clients
  add column r2_bucket        text,
  add column r2_public_domain text;

-- Production values, applied where they exist. ESS is the only client
-- publishing to the CDN today.
update public.clients set
  r2_bucket        = 'dc-hub-bucket',
  r2_public_domain = 'https://cdn.disruptcollective.com'
where name = 'ESS';
