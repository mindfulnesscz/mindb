-- A gallery's children inherit its access level. Enforced here, so nothing can drift.
--
-- A gallery is ONE deliverable rendered as a grid, but it is stored as a parent row plus a row per
-- image, and `perm` lived on each row independently. Nothing kept them in step, and the result was
-- a card a client could see over a grid they could not: parent `public`, twelve children `client`,
-- so the gallery opened empty. (Made likely on 2026-07-31, when the pipeline default moved from
-- `public` to `client` while `perm` became insert-only — a run then created new children at the new
-- default under parents still holding the old one.)
--
-- WHY A TRIGGER, and not the two write paths. "A gallery child's level is its parent's level" is an
-- invariant, and an invariant asserted in application code is an invariant that holds until the
-- second caller. Here it costs the pipeline no changes at all — whatever `perm` an export sends for
-- a gallery child is simply replaced by the parent's — and a hand-run UPDATE cannot break it either.
--
-- VARIANTS ARE DELIBERATELY NOT COVERED. `variant_of` is a rendition set (one deliverable in several
-- formats) and separating a variant's visibility is a real, if rare, need — a print-resolution master
-- kept internal while the web version is public. That is a soft default rather than an invariant, it
-- depends on an explicit choice at the moment of the edit, and a trigger cannot see that choice. It
-- lives in the portal write path instead, checked by default.
--
-- CONSEQUENCE FOR THE UI: setting `perm` on a gallery child now silently has no effect. The portal
-- shows the level read-only on children, with the reason, rather than offering a control that snaps
-- back.

-- ── 1. On write: a child takes its parent's level ────────────────────────────
create or replace function public.assets_inherit_gallery_perm()
returns trigger language plpgsql as $$
declare _parent_perm text;
begin
  if new.parent_id is not null then
    select a.perm into _parent_perm from public.assets a where a.id = new.parent_id;
    -- Only when actually found. A null would violate the NOT NULL and turn an invisible
    -- inheritance rule into a failed insert, which is a much worse way to learn about it.
    if _parent_perm is not null then
      new.perm := _parent_perm;
    end if;
  end if;
  return new;
end $$;

create trigger assets_inherit_gallery_perm
  before insert or update of perm, parent_id on public.assets
  for each row execute function public.assets_inherit_gallery_perm();

-- ── 2. On a parent's change: push it down ────────────────────────────────────
create or replace function public.assets_cascade_gallery_perm()
returns trigger language plpgsql as $$
begin
  -- `is distinct from` is what terminates the recursion: this UPDATE re-fires the pair of triggers
  -- on each child, and without the guard a child whose value already matches would keep restating
  -- it. With it, the second pass matches nothing and stops.
  update public.assets
     set perm = new.perm
   where parent_id = new.id
     and perm is distinct from new.perm;
  return null;
end $$;

create trigger assets_cascade_gallery_perm
  after update of perm on public.assets
  for each row
  when (old.perm is distinct from new.perm)
  execute function public.assets_cascade_gallery_perm();

-- ── 3. Reconcile the families that already disagree ──────────────────────────
-- The parent is the authority from now on, so the literal reading would be "push every parent's
-- level down onto its children". That is the WIDENING direction: for the rows that exist today it
-- would publish twelve client photos to the whole internet, as a side effect of a schema migration.
-- A migration must not be able to do that.
--
-- So the reconciliation runs the other way: each parent is narrowed to its strictest child. That
-- direction only ever REMOVES access, it makes every family consistent, and it is one deliberate
-- click to reverse — set the parent to `public` in the portal and the cascade above widens the whole
-- gallery, because someone chose to.
-- It is still a one-way data change, so it says what it did. Every altered row is RAISEd as a
-- NOTICE, which lands in the `supabase db push` output — the CI log for the deploy is then the
-- record of the previous values, and reversing a wrong call is reading that log rather than
-- guessing. A migration that silently rewrites an access boundary on a shared environment is not
-- one anybody can undo.
do $$
declare _r record;
        _n int := 0;
begin
  for _r in
    with strictest as (
      select
        c.parent_id,
        max(case c.perm when 'public' then 0 when 'guest' then 1 when 'client' then 2 else 3 end) as rank
      from public.assets c
      where c.parent_id is not null
      group by c.parent_id
    )
    select
      p.id, p.name, p.perm as was,
      case s.rank when 0 then 'public' when 1 then 'guest' when 2 then 'client' else 'internal' end as becomes
    from public.assets p
    join strictest s on s.parent_id = p.id
    where p.perm <> case s.rank when 0 then 'public' when 1 then 'guest' when 2 then 'client' else 'internal' end
  loop
    -- The cascade trigger fires from this UPDATE and levels the family's children in the same
    -- pass, so no separate child fix-up is needed.
    update public.assets set perm = _r.becomes where id = _r.id;
    raise notice 'gallery perm reconciled: % (%) % -> % (children follow)',
      _r.name, _r.id, _r.was, _r.becomes;
    _n := _n + 1;
  end loop;
  raise notice 'gallery perm reconciliation: % parent(s) narrowed to their strictest child', _n;
end $$;
