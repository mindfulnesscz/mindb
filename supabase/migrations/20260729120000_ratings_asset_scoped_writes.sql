-- F-4 — scope ratings WRITES to assets the rater can actually see.
--
-- The baseline's `ratings: own insert` checked only `auth.uid() = user_id`: it proved WHO was
-- rating, never WHAT. Any authenticated user could insert a rating against any asset id,
-- including another tenant's client-scoped and internal assets. The read policy
-- (20260724120000) is correctly scoped, so the author cannot see the row afterwards — which
-- is exactly what made this invisible. It is write-only pollution: it skews the average
-- rating the owning tenant's members and staff DO see, with nothing to show where it came
-- from.
--
-- Phase 0 closed the cross-tenant READ leak (F-1) on this table; this closes the matching
-- WRITE leak, found by the Phase 1 RLS suite. The rule is now symmetric with the read
-- policy: you may rate exactly what you may see.
--
-- Anonymous users stay blocked without needing a clause — `auth.uid()` is null and
-- `ratings.user_id` is NOT NULL, so the equality can never hold.
--
-- Forward-only; no schema or data change. Regression-locked by
-- supabase/tests/rls_tenant_isolation.test.sql.

-- ── Shared visibility predicate ──────────────────────────────────────────────
-- Mirrors the USING clause of "ratings: readable with asset" / "comments: readable with
-- asset" exactly, so the read and write rules cannot drift apart. Same spirit as
-- is_staff() / my_client_id().
--
-- ⚠ `security INVOKER` (the default) is load-bearing, NOT an oversight. The subquery on
-- public.assets is deliberately evaluated as the CALLER, so the assets RLS policies
-- ("internal perm for staff only") filter it. That nested filtering is the only reason a
-- member cannot reach their own client's INTERNAL assets: the disjunction below would
-- otherwise admit them via `a.client_id = my_client_id()`.
--
-- With `security definer` this function silently became more permissive than the read
-- policies it was meant to mirror — a member could rate their own client's internal assets.
-- The RLS suite caught it. Do not add `security definer` here.
--
-- `stable` lets the planner cache the result within a statement.
-- TODO(phase3): have the existing read policies on comments/ratings/approvals/activity call
-- this too, replacing four inline copies of the same EXISTS.
create or replace function public.can_see_asset(p_asset_id uuid)
returns boolean language sql stable as $$
  select exists (
    select 1 from public.assets a
    where a.id = p_asset_id
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())
  );
$$;

grant execute on function public.can_see_asset(uuid) to anon, authenticated, service_role;

-- ── ratings: insert only against a visible asset ─────────────────────────────
drop policy if exists "ratings: own insert" on public.ratings;
create policy "ratings: own insert for visible asset"
  on public.ratings for insert
  with check (auth.uid() = user_id and public.can_see_asset(asset_id));

-- ── ratings: update only your own row, and only onto a visible asset ─────────
-- Both halves are required. USING selects the rows you may change; WITH CHECK validates the
-- row you leave behind. Without WITH CHECK, an update could re-point an existing rating at
-- an asset the author cannot see — the same hole through the back door.
drop policy if exists "ratings: own update" on public.ratings;
create policy "ratings: own update for visible asset"
  on public.ratings for update
  using      (auth.uid() = user_id and public.can_see_asset(asset_id))
  with check (auth.uid() = user_id and public.can_see_asset(asset_id));
