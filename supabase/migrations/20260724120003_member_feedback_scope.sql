-- Narrow member feedback: members rate and see ratings only. Comments and
-- approvals become a staff-only workflow (editor/admin/super_admin) — members
-- can neither read nor write them. Ratings are unchanged (members rate + read).
-- Mirrors the frontend canComment/canApprove = isStaff change.

-- ── comments: staff only ─────────────────────────────────────────────────────
drop policy if exists "comments: readable with asset" on public.comments;
drop policy if exists "comments: authenticated can read" on public.comments;
create policy "comments: staff read"
  on public.comments for select using (public.is_staff());

drop policy if exists "comments: own insert" on public.comments;
create policy "comments: staff insert"
  on public.comments for insert
  with check (public.is_staff() and auth.uid() = user_id);

-- ── approvals: staff only ────────────────────────────────────────────────────
drop policy if exists "approvals: readable with asset" on public.approvals;
drop policy if exists "approvals: authenticated can read" on public.approvals;
create policy "approvals: staff read"
  on public.approvals for select using (public.is_staff());

drop policy if exists "approvals: own insert" on public.approvals;
create policy "approvals: staff insert"
  on public.approvals for insert
  with check (public.is_staff() and auth.uid() = user_id);

drop policy if exists "approvals: own update" on public.approvals;
create policy "approvals: staff update"
  on public.approvals for update using (public.is_staff());
