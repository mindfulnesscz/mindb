-- v3.0.0 — folder-based stable identity becomes the only identity.
--
-- Every asset package on disk already carries a ` __<hash>` folder suffix and a
-- .dchub.json manifest, so the shortcode-matching path the desktop kept for
-- unmigrated clients has no remaining input. This migration removes what only
-- that path needed, and normalizes the data it left behind. Apply it BEFORE
-- shipping the 3.0.0 desktop build — see step 2 for why the order matters.

-- ── 1. Purge rows that never got a stable identity ───────────────────────────
-- Only the DISRUPT COLLECTIVE client still had these (17 rows: 3 brand assets +
-- one M5 gallery, all created 2026-07-28). Their folders are already hashed with
-- manifests, so the next pipeline run recreates them with proper identity, tags,
-- variants and thumbnails. Nothing references them — no ratings, comments or
-- approvals exist against any of them.
delete from public.assets where stable_id is null or child_id is null;

-- ── 2. Shortcode goes back to being a display string ─────────────────────────
-- `unique (client_id, shortcode)` existed as the legacy upsert's ON CONFLICT
-- arbiter. Stable-identity writes never used it — they match on
-- (stable_id, child_id) and then PATCH by row id — but they had to keep
-- shortcodes artificially unique to satisfy it, by appending the identity key:
--   "(e-PEX)(Gll)|2604 P-EXP - 35 of 59 __51522e50:c30"
-- The suffix is a verbatim copy of the row's own stable_id and child_id columns.
-- Drop the constraint first, then strip the suffix — with the constraint still in
-- place, two variants of one asset would collide the moment their display text
-- matched. This is also why the migration must land before the 3.0.0 build: that
-- build stops appending the suffix, and inserting two same-named assets under the
-- old constraint would fail.
alter table public.assets drop constraint if exists assets_client_id_shortcode_key;

update public.assets
   set shortcode = regexp_replace(shortcode, ' __[0-9a-f]{8}:c[0-9]+$', '')
 where shortcode ~ ' __[0-9a-f]{8}:c[0-9]+$';

-- Identity is now structurally required. assets_stable_child_unique (created in
-- the baseline, excluding disconnected rows so a soft-disconnected asset can be
-- reclaimed) keeps enforcing uniqueness of the pair.
alter table public.assets alter column stable_id set not null;
alter table public.assets alter column child_id  set not null;

-- ── 3. Drop the migration flag ───────────────────────────────────────────────
-- clients.identity_migrated gated the two code paths against each other. With
-- one path left there is nothing to gate.
alter table public.clients drop column if exists identity_migrated;

-- ── 4. Normalize cloud_destinations to the current shape ─────────────────────
-- Destinations used to encode layout as an exclusive "packages" mode plus a
-- boolean flatExport; they now carry exportLayout + includePackages. The desktop
-- and portal both normalized this on read, which is the last config shim being
-- deleted — so the stored JSON has to be correct from here on.
-- Mirrors resolveExportShape() exactly: an exclusive "packages" mode collapses to
-- folders + includePackages; otherwise the layout is flat or folders and nothing
-- else, and includePackages only survives on folders. Booleans are compared as
-- text rather than cast, so a stray non-boolean value can't abort the migration.
update public.clients c
   set cloud_destinations = coalesce((
         select jsonb_agg(shaped order by ord)
           from (
             select ord,
                    (d - 'flatExport' - 'exportPackages')
                    || jsonb_build_object('exportLayout', layout,
                                          'includePackages',
                                          layout = 'folders'
                                            and (packages
                                                 or coalesce(d->>'includePackages', '') = 'true'))
                      as shaped
               from (
                 -- coalesce every comparison: a missing key yields NULL, and NULL leaking into
                 -- the includePackages conjunction would store JSON null instead of false.
                 select d, ord,
                        coalesce(d->>'exportLayout', '') = 'packages'
                          or coalesce(d->>'exportPackages', '') = 'true' as packages,
                        case
                          when coalesce(d->>'exportLayout', '') = 'packages'
                            or coalesce(d->>'exportPackages', '') = 'true' then 'folders'
                          when coalesce(d->>'exportLayout', '') = 'flat'
                            or coalesce(d->>'flatExport', '') = 'true'    then 'flat'
                          else 'folders'
                        end as layout
                   from jsonb_array_elements(c.cloud_destinations) with ordinality as t(d, ord)
               ) resolved
           ) shapes
       ), '[]'::jsonb)
 where jsonb_typeof(cloud_destinations) = 'array'
   and jsonb_array_length(cloud_destinations) > 0;
