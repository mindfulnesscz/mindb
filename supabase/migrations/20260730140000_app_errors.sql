-- An error sink that lives in this project rather than in someone else's service.
--
-- WHY A TABLE AND NOT SENTRY
--   Sentry does two things that are hard to replicate — un-minifying stacks from uploaded source maps,
--   and telling you an error is NEW rather than merely present. Everything else it offers, this
--   project already has: a database, RLS, migrations, pg_cron and pg_net for a digest, and a team
--   fluent in all of them. Against that, a hosted sink means another vendor, another bill, and — once
--   the tool is deployed to another agency — becoming the processor of their error data, which is a
--   contractual question rather than a configuration one.
--
--   The objection usually raised against a table is that it lives inside the system it monitors. That
--   is narrower than it sounds: because `anon` may insert, a failed login, an RLS denial or a bad
--   permission all report fine — the insert is not the thing that is broken. Only a total outage is
--   lost, and that is the one failure nobody needs a log to notice.
--
--   Revisit when there is a second deployment, or when the grouping SQL gets written a third time.
--   Adding a hosted sink later is additive; `reportError` is a single function in each app.
--
-- WHAT GOES IN
--   Whatever the app knew at the moment it failed: the concern-prefixed context (`sync.*`, `auth.*` —
--   see eslint.config.js), the message, the stack when there is one, and the breadcrumb trail, which on
--   desktop is the pipeline stage the run had reached. Plus enough to tell reports apart: app version
--   and environment.
--
-- WHAT DOES NOT
--   No asset names, no file paths beyond what a message already carries, and `user_id` only when a
--   session exists. This table is read by staff for debugging; it is not an audit log and must not
--   quietly become one.

create table public.app_errors (
  id          uuid primary key default gen_random_uuid(),
  -- 'sync.App.pullCloudDestinations', 'feedback.AssetDetail.saveRating', …
  context     text not null,
  message     text not null,
  stack       text,
  -- Ordered oldest → newest, as reportError renders them.
  breadcrumbs text[] not null default '{}',
  -- 'desktop' | 'web', so one table serves both apps without guessing from the context.
  source      text not null check (source in ('desktop', 'web')),
  app_version text,
  -- The environment NAME as the app knows it ('Production', 'Staging', 'Local'), not a URL.
  environment text,
  user_id     uuid references auth.users(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.app_errors is
  'Caught application errors. Written by reportError in both apps; read by staff. Not an audit log — '
  'see the migration for what is deliberately not stored.';

-- The digest groups by context over a recent window, so that is the index it needs.
create index app_errors_created_at_idx on public.app_errors (created_at desc);
create index app_errors_context_created_at_idx on public.app_errors (context, created_at desc);

alter table public.app_errors enable row level security;

-- Anyone may report, including a signed-out visitor whose sign-in just failed — that is precisely the
-- error worth capturing. Attribution is still constrained: a caller may only attribute a report to
-- themselves, exactly as asset_events does.
create policy "app_errors: anyone can report"
  on public.app_errors for insert
  with check (user_id is null or user_id = auth.uid());

-- Reading is staff-only: messages can quote a client's asset names and folder paths.
create policy "app_errors: staff can read"
  on public.app_errors for select
  using (public.is_staff());

grant insert on public.app_errors to anon, authenticated;
grant select on public.app_errors to authenticated;

/* ── Rate limit ────────────────────────────────────────────────────────────────
   The same shape as asset_events, and for the same reason: an anon-writable table is a spam vector,
   and a client stuck in a render loop can call reportError hundreds of times a second without any
   malice at all. The cap is per CONTEXT, because that is what identifies "the same thing failing
   repeatedly" — and keeping one broken screen from crowding out every other report is the point.

   It DROPS rather than raises. reportError must never throw: nearly every caller is a `.catch()` on a
   fire-and-forget write, so a rejected insert would replace the error being reported with a worse one.
   Past the ceiling these are duplicates of a report already stored.                                  */

create or replace function public.app_errors_rate_limit()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  recent bigint;
begin
  select count(*) into recent
  from public.app_errors
  where context = new.context
    and created_at > now() - interval '1 minute';

  if recent >= 20 then
    return null;
  end if;

  return new;
end;
$$;

drop trigger if exists app_errors_rate_limit on public.app_errors;
create trigger app_errors_rate_limit
  before insert on public.app_errors
  for each row execute function public.app_errors_rate_limit();

/* ── Digest ────────────────────────────────────────────────────────────────────
   What a hosted sink would email you, as a query. Grouped by context and message so a repeated failure
   is one row with a count, and ordered by how often it happened.

   NOT SCHEDULED HERE, on purpose: a cron job needs a webhook URL, which is a secret and belongs in the
   deployment rather than in a migration replayed on every machine. To turn it on, once, per backend:

     create extension if not exists pg_cron;
     select cron.schedule('app-errors-digest', '0 8 * * *', $job$
       select net.http_post(
         url     := '<your Slack/webhook URL>',
         headers := '{"Content-Type": "application/json"}'::jsonb,
         body    := jsonb_build_object('text',
                      coalesce(string_agg(format('%s × %s — %s', occurrences, context, message), E'\n'),
                               'No errors in the last 24h'))
       ) from public.error_digest('24 hours');
     $job$);

   pg_net is already installed; pg_cron is available and needs enabling per project.                  */

create or replace function public.error_digest(p_window interval default '24 hours')
returns table (context text, message text, occurrences bigint, last_seen timestamptz)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select e.context,
         e.message,
         count(*)         as occurrences,
         max(e.created_at) as last_seen
  from public.app_errors e
  where e.created_at > now() - p_window
  group by e.context, e.message
  order by count(*) desc, max(e.created_at) desc;
$$;

comment on function public.error_digest(interval) is
  'Errors in a recent window, grouped by context and message. Intended for a scheduled webhook — see '
  'the migration for the pg_cron snippet.';

revoke execute on function public.error_digest(interval) from anon;
