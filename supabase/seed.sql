-- Local development seed — applied by `supabase db reset` after migrations.
-- Fresh staging/production environments get real data from the desktop
-- pipeline instead; this file exists so a local portal has something to show.
--
-- Sign-in for local testing: create a user in Studio (http://localhost:54323 →
-- Authentication). An @acme.test address is auto-assigned to the demo client
-- with role 'client' via handle_new_user(); promote yourself to admin with:
--   update public.profiles set role = 'admin' where id = '<your-user-uuid>';

insert into public.clients (id, name, slug, accent, initials, domain_whitelist) values
  ('00000000-0000-0000-0000-000000000001', 'Acme Studio', 'acme', '#1d4ed8', 'AS', '{acme.test}');

insert into public.tags (client_id, name, dimension, sort_order) values
  ('00000000-0000-0000-0000-000000000001', 'Product',   'entity', 1),
  ('00000000-0000-0000-0000-000000000001', 'Corporate', 'entity', 2),
  ('00000000-0000-0000-0000-000000000001', 'Slides',    'format', 1),
  ('00000000-0000-0000-0000-000000000001', 'Banner',    'format', 2),
  ('00000000-0000-0000-0000-000000000001', 'Handout',   'format', 3),
  ('00000000-0000-0000-0000-000000000001', 'Sales',     'angle',  1),
  ('00000000-0000-0000-0000-000000000001', 'Overview',  'angle',  2);

insert into public.assets
  (id, client_id, shortcode, name, entities, formats, angles, tags, version, status, perm, stable_id, child_id) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-000000000001',
   '(PRD)(SAL)(SlD) Pitch Deck', 'Product Pitch Deck', '{Product}', '{Slides}', '{Sales}',
   '{Product,Slides,Sales}', 'v1-2-0', 'published', 'public',   'aaaa1111', 'c1'),
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-000000000001',
   '(CRP)(OVR)(Hnd) Company Handout', 'Company Handout', '{Corporate}', '{Handout}', '{Overview}',
   '{Corporate,Handout,Overview}', 'v2-0-0', 'published', 'client', 'bbbb2222', 'c1'),
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-000000000001',
   '(PRD)(OVR)(Bnn) Launch Banner', 'Launch Banner', '{Product}', '{Banner}', '{Overview}',
   '{Product,Banner,Overview}', 'v1-0-0', 'review', 'internal', 'cccc3333', 'c1'),
  ('00000000-0000-0000-0000-00000000a004', '00000000-0000-0000-0000-000000000001',
   '(PRD)(SAL)(SlD) Pitch Deck (PDF)', 'Product Pitch Deck — PDF', '{Product}', '{Slides}', '{Sales}',
   '{Product,Slides,Sales}', 'v1-2-0', 'published', 'public',   'aaaa1111', 'c2');

-- The PDF rendition is a variant of the deck
update public.assets
  set variant_of = '00000000-0000-0000-0000-00000000a001'
  where id = '00000000-0000-0000-0000-00000000a004';

insert into public.version_history (asset_id, version, status, date) values
  ('00000000-0000-0000-0000-00000000a001', 'v1-2-0', 'Active',  current_date),
  ('00000000-0000-0000-0000-00000000a001', 'v1-1-0', 'History', current_date - 30),
  ('00000000-0000-0000-0000-00000000a002', 'v2-0-0', 'Active',  current_date);

insert into public.asset_events (asset_id, event_type, role) values
  ('00000000-0000-0000-0000-00000000a001', 'view', 'public'),
  ('00000000-0000-0000-0000-00000000a001', 'view', 'public'),
  ('00000000-0000-0000-0000-00000000a001', 'download', 'client');
