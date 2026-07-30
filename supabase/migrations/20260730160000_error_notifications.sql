-- Where error digests get sent, and who may look at errors at all.
--
-- TIGHTENING THE READ ON app_errors
--   It shipped as staff-readable. That was too wide. Error messages quote asset names, folder paths
--   and occasionally a user's email, and they are read to maintain the tool rather than to run a
--   client's work — so they belong to whoever maintains the app, not to every admin. `super_admin` is
--   that role here. Reporting stays open to everyone, including signed-out visitors: a failed sign-in
--   is exactly the error worth capturing.
--
-- WHY A WEBHOOK URL AND NOT A CHANNEL ID
--   A Slack channel id alone cannot receive anything — posting to one needs a bot token and a Slack
--   app. An incoming webhook URL already encodes its channel and needs no app, no token and no scopes.
--   One row per channel; the trade is that the URL IS the credential.
--
--   So the URL is a secret sitting in a table. That is acceptable only because the table is
--   super-admin-only, and a super admin is a maintainer who would hold that URL anyway. It is not
--   acceptable to widen this later without moving the secret somewhere else. The UI never displays a
--   stored URL in full.
--
-- WHY "NEW SIGNATURES ONLY" IS THE DEFAULT
--   A component stuck in a render loop produces the same error hundreds of times. Notified on every
--   occurrence, the channel gets muted within a day — and a muted alert channel is worse than none,
--   because it looks like monitoring. Being told once, when something starts happening, is the whole
--   value; the table is there for the detail.
--
-- NOT SCHEDULED HERE. The cron job needs to exist once per backend, not once per migration replay.
-- See the snippet at the bottom.

/* ── Read is super-admin only ─────────────────────────────────────────────── */

drop policy if exists "app_errors: staff can read" on public.app_errors;

create policy "app_errors: super admins can read"
  on public.app_errors for select
  using (public.is_super_admin());

/* ── Destinations ─────────────────────────────────────────────────────────── */

create table public.error_notifications (
  id           uuid primary key default gen_random_uuid(),
  -- What a human calls it: "#dev-alerts", "On-call".
  label        text not null,
  -- A Slack incoming webhook. The channel is part of the URL.
  webhook_url  text not null check (webhook_url like 'https://hooks.slack.com/%'),
  enabled      boolean not null default true,
  -- false = every occurrence. Off by default for the reason in the header.
  notify_all   boolean not null default false,
  created_at   timestamptz not null default now(),
  created_by   uuid references auth.users(id) on delete set null
);

comment on table public.error_notifications is
  'Slack incoming webhooks for the error digest. Super-admin only: the URL is the credential.';

alter table public.error_notifications enable row level security;

create policy "error_notifications: super admins only"
  on public.error_notifications for all
  using (public.is_super_admin())
  with check (public.is_super_admin());

grant select, insert, update, delete on public.error_notifications to authenticated;

/* ── What counts as new ───────────────────────────────────────────────────── */

-- A signature is (context, message). "New" means it was seen inside the window and never before it,
-- which is what makes one alert per problem rather than one per occurrence.
create or replace function public.new_error_signatures(p_window interval default '24 hours')
returns table (context text, message text, occurrences bigint, first_seen timestamptz)
language sql
stable
security invoker
set search_path = public, pg_catalog
as $$
  select e.context,
         e.message,
         count(*)          as occurrences,
         min(e.created_at) as first_seen
  from public.app_errors e
  where e.created_at > now() - p_window
  group by e.context, e.message
  having not exists (
    select 1 from public.app_errors older
    where older.context = e.context
      and older.message = e.message
      and older.created_at <= now() - p_window
  )
  order by count(*) desc;
$$;

comment on function public.new_error_signatures(interval) is
  'Errors whose (context, message) appeared for the first time inside the window. The digest sends '
  'these so a looping component cannot drown the channel.';

revoke execute on function public.new_error_signatures(interval) from anon;

/* ── Scheduling, once per backend ─────────────────────────────────────────────
   The job reads its destinations from the table above, so adding a channel in the portal is enough —
   the schedule itself never changes.

     create extension if not exists pg_cron;
     select cron.schedule('error-digest', '0 8 * * *', $job$
       select net.http_post(
                url     := n.webhook_url,
                headers := '{"Content-Type": "application/json"}'::jsonb,
                body    := jsonb_build_object('text', d.summary)
              )
       from public.error_notifications n
       cross join lateral (
         select string_agg(format('• *%s* — %s (×%s)', context, message, occurrences), E'\n')
                  as summary
         from public.new_error_signatures('24 hours')
       ) d
       where n.enabled and d.summary is not null;
     $job$);

   For every-occurrence destinations, swap new_error_signatures for error_digest and filter on
   n.notify_all.                                                                                    */
