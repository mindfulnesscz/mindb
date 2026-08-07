-- Keep the "a previous attempt failed" marker across a re-queue.
--
-- `cdn-reconcile` used to probe every access level for every page of every queued asset, whether or
-- not the level had actually moved — three round trips per page that cannot succeed. It now skips
-- that sweep when `was_level` still equals the row's current effective level, which is only sound
-- while two things hold:
--
--   `was_level` is NOT overwritten on conflict (it already is not) — it means "the level the bytes
--   were last known to be entirely at", so the first queueing is the one that knows;
--
--   and a FAILED attempt stays visible. A partial pass moves some pages and deletes their sources
--   while others stay put, so the pages can be split across two levels even though `was_level`
--   matches the current one. The mover records that as `attempts = 1`, and the sweep rule treats any
--   non-zero attempts as "sweep anyway".
--
-- The conflict clause reset `attempts` and `last_error` to zero on every re-queue, which erased
-- exactly that marker: a partial pass followed by a level change back to where it started would look
-- like an asset that had never been touched, and the page left at the wider level would never be
-- swept. Nothing reads `attempts` as a retry budget, so preserving it costs nothing — and the marker
-- is cleared the only way that is truthful, by the row being DELETED when the asset reconciles
-- cleanly.

create or replace function public.queue_cdn_move()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.effective_level is not distinct from new.effective_level then
    return null;
  end if;
  insert into public.cdn_move_queue (asset_id, was_level)
  values (new.id, case when tg_op = 'UPDATE' then old.effective_level else null end)
  on conflict (asset_id) do update
    -- Only the timestamp. `was_level` keeps the first known position of the bytes, and
    -- attempts/last_error keep any evidence that a pass left them half-moved.
    set queued_at = now();
  return null;
end $$;

comment on column public.cdn_move_queue.was_level is
  'The level the bytes were last known to be entirely at — set when first queued and never '
  'overwritten. cdn-reconcile skips the per-page level sweep when this still matches the row''s '
  'effective level AND attempts = 0.';

comment on column public.cdn_move_queue.attempts is
  'Non-zero once a reconcile pass on this row has failed. Survives a re-queue: a partial pass can '
  'leave an asset''s pages split across two levels, which is the one case where was_level matching '
  'is not enough to skip the sweep. Cleared only by the row being deleted on a clean reconcile.';
