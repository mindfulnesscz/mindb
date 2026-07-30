-- Fix: deleting a disconnected asset failed when a variant still pointed at it.
--
-- SYMPTOM (reported from dev, 2026-07-29)
--   Admin → delete disconnected assets:
--   "update or delete on table \"assets\" violates foreign key constraint
--    \"assets_variant_of_fkey\" on table \"assets\""
--
-- CAUSE
--   The two self-referencing foreign keys on public.assets disagreed, by accident rather than by
--   design — `variant_of` simply never got an ON DELETE clause:
--
--     assets_parent_id_fkey    REFERENCES assets(id) ON DELETE CASCADE
--     assets_variant_of_fkey   REFERENCES assets(id)            ← no action ⇒ blocks the delete
--
--   So a gallery parent could be deleted (its children cascaded away) while a variant *primary*
--   could not be deleted at all as long as any variant referenced it. Every such row landed in the
--   `blocked` list the portal reports, with no way for the operator to clear it.
--
-- WHY SET NULL AND NOT CASCADE
--   Cascade would delete the variants along with the primary — and a variant is not derivative
--   filler. `variant_of` links renditions of one deliverable (a deck as .pptx and .pdf), each a
--   real asset carrying its own ratings, comments, approvals and view/download events.
--
--   Critically, a primary is just one FILE inside a package folder, so it can vanish while its
--   siblings remain: the primary is then `disconnected` while the variants are still live. Under
--   CASCADE, purging that disconnected primary would silently destroy live assets and their
--   feedback. That is exactly what the sync's soft-disconnect design exists to prevent — see
--   supabase/tests/rls_tenant_isolation.test.sql and services/supabase/exportDisconnect.ts.
--
--   With SET NULL the variant survives as a standalone asset. Nothing is lost, and the grouping is
--   recoverable: the next pipeline run re-resolves identity from the `.dchub.json` manifest and
--   rewrites `variant_of` (see services/supabase/exportPlan.ts).
--
-- WHY parent_id KEEPS CASCADE
--   Not an inconsistency. A gallery CHILD is a preview image inside a gallery folder and is
--   meaningless without its parent; parent and children also disconnect together in practice,
--   because the folder either exists or it does not. A variant can outlive its primary. The two
--   relations genuinely differ — which is the distinction exportPlan.ts encodes when it chooses
--   `parent_id` vs `variant_of` in the first place.
--
-- Forward-only. No data change: no existing `variant_of` value is modified, only the behaviour of a
-- future delete. Covered by supabase/tests/asset_relations.test.sql.

alter table public.assets
  drop constraint if exists assets_variant_of_fkey;

alter table public.assets
  add constraint assets_variant_of_fkey
  foreign key (variant_of) references public.assets(id) on delete set null;
