-- Gated delivery, Phase 1 — four access levels, and a level that accounts for lifecycle.
--
-- Two independent axes were already in the table and only one of them gated anything:
--
--   perm    who MAY see it            public | guest | client | internal
--   status  where it is in its life   draft | review | approved | published | archived | disconnected
--
-- RLS keyed on `perm` alone, so an asset marked `public` while still in `draft` was readable by
-- anonymous visitors — unapproved work, published. `effective_level` collapses the two axes into
-- the single value that decides access, and it is a STORED GENERATED column precisely so that
-- Postgres and the Cloudflare Worker in front of R2 cannot disagree: the same value drives row
-- discovery here and lands in the R2 object key at upload time.
--
--   effective_level = (status in ('approved','published')) ? perm : 'internal'
--
-- `guest` is the new level: anyone signed in, including a `role='public'` profile created by email
-- capture. Be clear-eyed about what it buys — it is friction, not protection.
--
-- Forward-only. No data change: every existing row's effective_level is derived, and the widened
-- CHECK only admits a value nothing writes yet.

-- ── perm gains a fourth level ────────────────────────────────────────────────
alter table public.assets drop constraint assets_perm_check;
alter table public.assets add constraint assets_perm_check
  check (perm in ('public', 'guest', 'client', 'internal'));

-- ── the value that actually gates ────────────────────────────────────────────
-- Generated rather than trigger-maintained: both inputs are plain columns on the same row, so
-- there is no window in which the column is stale and no second write path to keep in step.
alter table public.assets
  add column effective_level text
    generated always as (
      case when status in ('approved', 'published') then perm else 'internal' end
    ) stored;

comment on column public.assets.effective_level is
  'Access level that gates BOTH row discovery (RLS below) and byte delivery (the R2 object key). '
  'Derived: perm, downgraded to internal until the asset is approved or published. Never write it.';

create index assets_effective_level_idx on public.assets (effective_level);
create index assets_client_id_effective_level_idx on public.assets (client_id, effective_level);

-- ── discovery honours effective_level, not raw perm ──────────────────────────
-- Four policies, one per level, OR'd together as SELECT policies are. `assets: staff write`
-- (for all) already gives staff sight of everything, so none of these needs a staff escape
-- hatch except where a non-staff member of the owning client also qualifies.
drop policy if exists "assets: public perm is world-readable"     on public.assets;
drop policy if exists "assets: client perm for same-client users" on public.assets;
drop policy if exists "assets: internal perm for staff only"      on public.assets;

create policy "assets: public level is world-readable"
  on public.assets for select
  using (effective_level = 'public');

-- Signed in is the whole test. `auth.uid() is not null` rather than
-- `auth.role() = 'authenticated'`: it is true for exactly the sessions that carry a user, and it
-- does not quietly include the service role.
create policy "assets: guest level for any signed-in user"
  on public.assets for select
  using (effective_level = 'guest' and auth.uid() is not null);

create policy "assets: client level for same-client users"
  on public.assets for select
  using (effective_level = 'client' and (public.is_staff() or client_id = public.my_client_id()));

create policy "assets: internal level for staff only"
  on public.assets for select
  using (effective_level = 'internal' and public.is_staff());

-- ── child tables follow the parent's effective level ─────────────────────────
-- Tables hanging off an asset scoped reads to "you can see the parent asset", but spelled that
-- as `a.perm = 'public'`. Left alone, the version history, ratings and comments of a
-- draft-but-public asset stay readable to people whose view of the asset row itself has just
-- been correctly closed — the same leak, one table over.
--
-- `can_see_asset` already exists (20260729120000) and already carries the TODO(phase3) asking
-- for exactly this consolidation. Fixing it here fixes every caller at once, read and write:
-- the ratings insert/update policies use it too.
--
-- Its hand-written disjunction — `perm = 'public' or is_staff() or client_id = my_client_id()`
-- — GOES AWAY rather than gaining an `or effective_level = 'guest'` branch. That copy was only
-- ever a restatement of the assets policies, and a fourth level is exactly the kind of change
-- that makes a restatement wrong: as written it would deny a signed-in visitor the ratings and
-- version history of a guest-level asset whose row they can plainly see. `exists` against the
-- table, with nothing else, IS the question being asked, and it cannot drift from the policies
-- again no matter how many levels get added.
--
-- ⚠ `security INVOKER` (the default) was load-bearing before and is now the ENTIRE mechanism:
-- the subquery is evaluated as the CALLER, so the four effective_level policies above are what
-- filters it. As `security definer` this function returns true for every asset that exists,
-- handing every caller every other tenant's feedback. Never add it.
create or replace function public.can_see_asset(p_asset_id uuid)
returns boolean language sql stable as $$
  select exists (select 1 from public.assets a where a.id = p_asset_id);
$$;

comment on function public.can_see_asset(uuid) is
  'True when the CALLER can see this asset — it defers entirely to public.assets RLS rather '
  'than restating it, so it tracks every access level automatically. Deliberately security '
  'INVOKER; as security definer it would return true for everything. Never make it definer.';

-- version_history and ratings held inline copies of the predicate. Same rule, one definition.
drop policy if exists "version_history: readable with asset" on public.version_history;
create policy "version_history: readable with asset"
  on public.version_history for select
  using (public.can_see_asset(asset_id));

drop policy if exists "ratings: readable with asset" on public.ratings;
create policy "ratings: readable with asset"
  on public.ratings for select
  using (public.can_see_asset(asset_id));

-- comments keep the `auth.uid() is not null` guard from 20260724120004 — members read the
-- thread, anonymous visitors never do, even on a public asset. Dropping it here would have
-- opened comments to anon as a side effect of a permissions tightening.
drop policy if exists "comments: readable with asset" on public.comments;
create policy "comments: readable with asset"
  on public.comments for select
  using (auth.uid() is not null and public.can_see_asset(asset_id));

-- approvals are deliberately staff-only (20260724120003, "members can neither read nor write
-- them") and stay that way. `approvals: staff read` needs no change: is_staff() does not consult
-- perm or status at all, so the new level has no bearing on it. Recreating a
-- "readable with asset" policy here would quietly re-open them, since SELECT policies OR.

-- activity keeps its own shape: staff see all, everyone sees their own, and account-level rows
-- (asset_id is null) stay private to the acting user. Only the asset branch changes, to the same
-- shared predicate as the tables above — its inline copy would rot for the same reason.
drop policy if exists "activity: scoped read" on public.activity;
create policy "activity: scoped read"
  on public.activity for select
  using (
    public.is_staff()
    or user_id = auth.uid()
    or (asset_id is not null and public.can_see_asset(asset_id))
  );
