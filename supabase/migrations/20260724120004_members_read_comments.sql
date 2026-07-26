-- Refine member feedback (supersedes part of 20260724120003):
-- Members may READ the comment thread (see the conversation) but still cannot
-- WRITE comments, and cannot give approvals at all. Guests (anon) see neither.
-- Ratings and approvals policies are unchanged (approvals remain staff-only).

-- comments: any authenticated user who can see the asset may read; write stays staff-only.
drop policy if exists "comments: staff read" on public.comments;
create policy "comments: readable with asset"
  on public.comments for select
  using (
    auth.uid() is not null
    and exists (
      select 1 from public.assets a
      where a.id = asset_id
        and (public.is_staff() or a.perm = 'public' or a.client_id = public.my_client_id())
    )
  );
-- "comments: staff insert" from 20260724120003 stays — only staff post.
