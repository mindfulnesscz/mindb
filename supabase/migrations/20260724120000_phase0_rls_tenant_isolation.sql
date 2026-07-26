-- Phase 0 — close cross-tenant read leaks.
--
-- The baseline granted read on feedback/metadata tables to ANY authenticated
-- user (`auth.role() = 'authenticated'`), so a member of client A could read
-- comments/ratings/approvals/activity on client B's assets — including
-- `internal` assets — and enumerate the full client list. This migration
-- re-scopes every read to "you can see the parent asset", mirroring the
-- version_history policy that was already correct. Forward-only; no data
-- change, no schema change. A correctly-behaving portal is unaffected.

-- ── comments: readable only with the parent asset ────────────────────────────
drop policy if exists "comments: authenticated can read" on public.comments;
create policy "comments: readable with asset"
  on public.comments for select
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())
  ));

-- ── ratings: readable only with the parent asset ─────────────────────────────
drop policy if exists "ratings: authenticated can read" on public.ratings;
create policy "ratings: readable with asset"
  on public.ratings for select
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())
  ));

-- ── approvals: readable only with the parent asset ───────────────────────────
drop policy if exists "approvals: authenticated can read" on public.approvals;
create policy "approvals: readable with asset"
  on public.approvals for select
  using (exists (
    select 1 from public.assets a
    where a.id = asset_id
      and (a.perm = 'public' or public.is_staff() or a.client_id = public.my_client_id())
  ));

-- ── activity: staff see all; users see their own + activity on visible assets ─
-- (asset_id is nullable — account-level actions with no asset are visible only
-- to the acting user and to staff.)
drop policy if exists "activity: authenticated can read" on public.activity;
create policy "activity: scoped read"
  on public.activity for select
  using (
    public.is_staff()
    or user_id = auth.uid()
    or (asset_id is not null and exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (a.perm = 'public' or a.client_id = public.my_client_id())
    ))
  );

-- ── clients: staff see all; members see only their own client ────────────────
drop policy if exists "clients: authenticated can read" on public.clients;
create policy "clients: own or staff"
  on public.clients for select
  using (public.is_staff() or id = public.my_client_id());

-- ── asset_events: keep anonymous view/download counting, block impersonation ──
-- FK already guarantees a real asset and the CHECK already bounds event_type.
-- The one gap was that an authenticated user could forge events attributed to
-- another user_id. Require the attributed user to be the caller (or anonymous).
drop policy if exists "asset_events: anyone can insert" on public.asset_events;
create policy "asset_events: self or anonymous insert"
  on public.asset_events for insert
  with check (user_id is null or user_id = auth.uid());
