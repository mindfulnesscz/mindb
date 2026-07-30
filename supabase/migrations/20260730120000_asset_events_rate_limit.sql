-- Cap how fast events can accumulate on a single asset.
--
-- WHAT WAS STILL OPEN (backlog 7, the remainder of F-2)
--   The Phase 0 migration closed event IMPERSONATION: an insert must attribute itself to the caller
--   or to nobody (`user_id is null or user_id = auth.uid()`). The FK guarantees a real asset and the
--   CHECK bounds event_type. What stayed open was VOLUME: `anon` may insert, share links are public,
--   and a loop against one link can write rows without limit.
--
--   The damage is not a crashed database, it is a quietly false one. `asset_events` is what tells a
--   client how often their deliverable was viewed and downloaded. An inflated count is worse than a
--   missing one, because it is believed.
--
-- WHY A PER-ASSET CAP, AND NOT PER CALLER
--   RLS has no identifier for an anonymous caller. No IP, no session, nothing to count against — so a
--   per-caller limit is not expressible here at all. Postgres can only see what the row itself carries,
--   and for the abuse that matters (hammering one public link) the asset IS the shared identifier.
--
--   A unique index would not do it either: for anonymous events `user_id` is null, and null is distinct
--   from null in a unique index, so every forged row would be accepted as new.
--
-- WHY IT DROPS INSTEAD OF FAILING
--   The client fires these off and ignores the result — a view is counted as a side effect of opening a
--   page. Raising here would turn a rate limit into a visible error on a legitimate page view during a
--   busy minute. A BEFORE INSERT trigger returning null skips the row silently, which is exactly the
--   desired behaviour: past the ceiling, events are TELEMETRY WE CHOOSE TO LOSE, not an audit trail.
--   Nothing else references these rows by id.
--
-- THE CEILING
--   120 events per asset per minute — two per second, sustained. Comfortably above any real pattern
--   (an asset opened by every member of a client's team at once, a gallery of previews loading
--   together) and far below what a script achieves. Deliberately generous: undercounting real traffic
--   is the failure this must not cause.
--
-- Covered by supabase/tests/asset_events_rate_limit.test.sql.

-- The trigger counts a one-minute window per asset on every insert, so that lookup must be an index
-- scan and not a scan of the asset's whole history.
create index if not exists asset_events_asset_id_created_at_idx
  on public.asset_events (asset_id, created_at desc);

create or replace function public.asset_events_rate_limit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  recent bigint;
begin
  select count(*) into recent
  from public.asset_events
  where asset_id = new.asset_id
    and created_at > now() - interval '1 minute';

  -- Skip the row, do not raise: see the note above on why this is deliberately silent.
  if recent >= 120 then
    return null;
  end if;

  return new;
end;
$$;

comment on function public.asset_events_rate_limit() is
  'Caps asset_events at 120 rows per asset per minute, dropping excess silently. Anonymous inserts '
  'have no identifier to rate-limit against, so the asset is the shared key. See the migration for why '
  'dropping beats raising.';

drop trigger if exists asset_events_rate_limit on public.asset_events;
create trigger asset_events_rate_limit
  before insert on public.asset_events
  for each row execute function public.asset_events_rate_limit();
