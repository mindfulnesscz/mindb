-- A tag must not be its own parent.
--
-- Found when a client's exported taxonomy was refused by the portal's own importer: three tag rows
-- carried parent_id = id, so the export wrote { "key": "format.document", "parent_key":
-- "format.document" } and validation failed with "cannot parent itself", then "cycle detected" for
-- every node beneath them. The file was faithful; the rows were wrong.
--
-- parent_id = id carries no information — it cannot be rendered in the filter tree, cannot be
-- expressed in the taxonomy import format, and makes any ancestor walk non-terminating. So the
-- repair is to null it, not to guess an intended parent.
--
-- WRITE-SIDE GUARDS EXIST TOO (desktop tagSync refuses to write it; the portal exporter refuses to
-- emit it). This is the constraint that makes those belt-and-braces rather than the only defence,
-- and it is the only one that also covers a manual SQL edit.

-- Repair first: adding the constraint to a table holding violations would fail.
update public.tags
   set parent_id = null
 where parent_id = id;

alter table public.tags
  add constraint tags_parent_id_not_self
  check (parent_id is null or parent_id <> id);

comment on constraint tags_parent_id_not_self on public.tags is
  'A tag cannot be its own parent. Deeper cycles (a -> b -> a) are NOT caught here — a CHECK sees '
  'only one row. They are prevented on the write paths and detected by the taxonomy validator; the '
  'tag tree is group -> leaf in practice, so a longer cycle needs a manual edit to create.';
