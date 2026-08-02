-- Record which assets need their bytes moved, so nothing has to notice out of band.
--
-- An asset's access level lives in its R2 object key — that is what lets the cdn-gate Worker
-- authorize a request without a lookup. The cost is that changing `perm` or `status` has to MOVE
-- the object, and until now nothing did: the row changed and the bytes stayed, so the portal
-- offered a file the gate then refused.
--
-- The first attempt at closing that was a GitHub Actions cron. It worked and it was the wrong
-- shape: a core correctness property should not depend on a CI provider, a checked-out branch, and
-- secrets pasted into a settings page. This is the replacement, and it lives where the data is.
--
-- WHY A TRIGGER RATHER THAN A CALL FROM THE PORTAL
--   The portal is not the only writer, and the two it does not know about are the easy ones to
--   forget: the gallery-inheritance cascade (20260731130000) rewrites children's `perm` without
--   the portal involved at all, and the pipeline flips `status` when a file leaves or returns to
--   disk. Hand-run SQL is a third. A trigger sees every one of them.
--
-- WHY A QUEUE RATHER THAN A DIRECT CALL
--   Postgres could call the edge function itself through pg_net, the way the error digest does.
--   That needs the function's URL and a service token stored somewhere the database can read —
--   another secret at rest, for a job whose whole point is that it is routine. A queue needs no
--   credentials: the trigger writes a row, and whoever is already authenticated (the portal after
--   an edit, the desktop after a run) drains it. It is also durable, which pg_net is not — a
--   fire-and-forget request that fails is simply lost, while a queued row waits.

create table public.cdn_move_queue (
  asset_id    uuid primary key references public.assets(id) on delete cascade,
  -- What the level was when the row was queued. Purely diagnostic: the mover always recomputes
  -- from the row, because by the time it runs the level may have changed again.
  was_level   text,
  queued_at   timestamptz not null default now(),
  attempts    int         not null default 0,
  last_error  text
);

comment on table public.cdn_move_queue is
  'Assets whose R2 objects may no longer sit at the key their access level requires. Written by a '
  'trigger on any perm/status change; drained by the cdn-reconcile edge function. An empty table '
  'means bytes and levels agree.';

create index cdn_move_queue_queued_at_idx on public.cdn_move_queue (queued_at);

-- Staff-only, and only through the function in practice. Not exposed to members at all: the queue
-- names assets across every client, so reading it is a cross-tenant listing.
alter table public.cdn_move_queue enable row level security;
create policy "cdn_move_queue: staff only"
  on public.cdn_move_queue for all using (public.is_staff());

/* ── The trigger ──────────────────────────────────────────────────────────────
   Fires on the two columns that decide the level, and only when the level actually CHANGES —
   `perm` and `status` are written on most pipeline runs, and queueing every asset on every run
   would turn a queue into a full-table sweep. `effective_level` is generated, so comparing it
   compares exactly the thing the object key encodes. */
create or replace function public.queue_cdn_move()
returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' and old.effective_level is not distinct from new.effective_level then
    return null;
  end if;
  insert into public.cdn_move_queue (asset_id, was_level)
  values (new.id, case when tg_op = 'UPDATE' then old.effective_level else null end)
  on conflict (asset_id) do update
    set queued_at = now(), attempts = 0, last_error = null;
  return null;
end $$;

create trigger assets_queue_cdn_move
  after insert or update of perm, status on public.assets
  for each row execute function public.queue_cdn_move();

/* ── Seed it with anything already adrift ─────────────────────────────────────
   Nothing is queued today because nothing was watching. Rather than assume the current state is
   consistent, queue every asset that HAS an object: the mover skips whatever is already at the
   right key, so the cost of over-queueing is one no-op pass, and the cost of under-queueing is a
   file nobody can fetch. */
insert into public.cdn_move_queue (asset_id, was_level)
select id, effective_level from public.assets
where thumbnail_url is not null or download_url is not null
on conflict (asset_id) do nothing;
