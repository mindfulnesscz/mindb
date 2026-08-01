-- Fix: the app_errors rate limit never fired for the callers it exists to limit.
--
-- SYMPTOM (found 2026-07-30, by generating sample reports through the real REST path)
--   25 reports of one context were posted as `anon` inside a minute. All 25 were stored, against a
--   ceiling of 20.
--
-- CAUSE
--   `app_errors_rate_limit()` was SECURITY INVOKER, so the `select count(*)` inside it ran under the
--   CALLER's row-level security. Reads on app_errors are super-admin-only — deliberately, because
--   messages quote asset names and paths — so for `anon` the count was always 0 and the ceiling was
--   never reached. The limit worked for exactly the callers who did not need limiting.
--
--   `asset_events_rate_limit()` has the same shape and is NOT affected: that table is world-readable
--   (`asset_events: anyone can read`), so its counter sees the rows. The bug is the combination of a
--   restricted read and an invoker-rights trigger, not the pattern itself.
--
-- WHY THE TEST MISSED IT
--   The pgTAP case ran with `reset role`, i.e. as superuser, which bypasses RLS entirely. It proved
--   the trigger works for the one caller who will never hit it. The test now runs as `anon`, which is
--   who actually inserts.
--
-- THE FIX, AND WHY DEFINER IS RIGHT HERE
--   SECURITY DEFINER, with search_path pinned. This function is a COUNTER, not a permission check: it
--   decides how many rows exist, never who may see them, and it returns only null-or-new to the
--   trigger. Nothing it reads escapes.
--
--   That distinction matters, because the opposite call was made deliberately in the F-4 migration:
--   `can_see_asset()` is a PREDICATE, and making it definer there would have made it strictly more
--   permissive than the read policies it mirrors. Definer is wrong for "may this caller see X" and
--   right for "how many rows are there" — the question here is the second kind.

create or replace function public.app_errors_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  recent bigint;
begin
  select count(*) into recent
  from public.app_errors
  where context = new.context
    and created_at > now() - interval '1 minute';

  -- Dropped, not raised: reportError runs inside catch handlers, so a rejected insert would replace
  -- the error being reported with a worse one.
  if recent >= 20 then
    return null;
  end if;

  return new;
end;
$$;

comment on function public.app_errors_rate_limit() is
  'Caps app_errors at 20 rows per context per minute, dropping excess silently. SECURITY DEFINER '
  'because reads on the table are super-admin-only and an invoker-rights counter sees nothing — see '
  'the migration for why that is safe for a counter but was not for can_see_asset().';
