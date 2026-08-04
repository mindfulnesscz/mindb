-- Actually send the digest, and make a destination verifiable in seconds.
--
-- WHAT WAS WRONG
--   The previous migration deliberately left scheduling out, on the grounds that a cron job needs a
--   webhook URL and a URL is a secret that does not belong in a migration replayed on every machine.
--
--   That reasoning was void the moment destinations moved into a TABLE. The job reads them from
--   `error_notifications`, so it contains no secret at all — it is the same job on every backend, and
--   adding a channel in the portal is the only thing that ever changes.
--
--   The cost of the omission was worse than the tidiness it bought: the portal offered an "add Slack
--   destination" form that stored a row and did nothing. A screen that looks like it enables
--   notifications, while no scheduler exists, is a monitoring system that reports its own health as
--   fine. Scheduling it here means a destination added in the portal works, with no second step
--   performed by hand on each backend.
--
-- WHY A TEST BUTTON IS PART OF THIS
--   The digest runs once a day. Without a way to send now, "did I paste the right URL?" takes 24 hours
--   to answer, and the answer is silence either way — indistinguishable from "no errors today". So a
--   super admin can post a test message immediately.

create extension if not exists pg_cron;
create extension if not exists pg_net;

/* ── Send now, for one destination ────────────────────────────────────────────
   pg_net is asynchronous: this queues the request and returns its id rather than a delivery result.
   Slack's own response arrives in net._http_response a moment later. The UI says "queued" rather than
   "sent", because claiming delivery we have not observed is how a test button becomes worthless.     */

create or replace function public.send_error_test(p_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $$
declare
  target public.error_notifications;
  req_id bigint;
begin
  -- Definer, so the function may read the webhook column — but the caller is checked explicitly,
  -- because definer rights would otherwise let anyone post to a channel they cannot see.
  if not public.is_super_admin() then
    raise exception 'Only a super admin may send a test message' using errcode = '42501';
  end if;

  select * into target from public.error_notifications where id = p_id;
  if not found then
    raise exception 'No such destination' using errcode = 'P0002';
  end if;

  select net.http_post(
    url     := target.webhook_url,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    body    := jsonb_build_object(
                 'text',
                 format('Sotto test message for *%s*. Error digests will arrive here daily at 08:00 UTC.',
                        target.label))
  ) into req_id;

  return req_id;
end;
$$;

revoke execute on function public.send_error_test(uuid) from anon;
grant execute on function public.send_error_test(uuid) to authenticated;

comment on function public.send_error_test(uuid) is
  'Posts a test message to one destination immediately. Super-admin only, checked inside the function '
  'because it runs with definer rights in order to read the webhook URL.';

/* ── The daily digest ─────────────────────────────────────────────────────────
   Reads its destinations from the table, so it never needs changing. Sends only signatures seen for
   the first time in the window, unless a destination asked for every occurrence — a component in a
   render loop would otherwise post until the channel is muted, and a muted alert channel still looks
   like monitoring while being none.

   Silent when there is nothing to report: a daily "no errors" message trains people to ignore it.    */

create or replace function public.send_error_digest(p_window interval default '24 hours')
returns integer
language plpgsql
security definer
set search_path = public, net, pg_catalog
as $$
declare
  target public.error_notifications;
  summary text;
  sent integer := 0;
begin
  for target in select * from public.error_notifications where enabled loop
    if target.notify_all then
      select string_agg(format('• *%s* — %s (×%s)', context, message, occurrences), E'\n')
        into summary from public.error_digest(p_window);
    else
      select string_agg(format('• *%s* — %s (×%s)', context, message, occurrences), E'\n')
        into summary from public.new_error_signatures(p_window);
    end if;

    continue when summary is null;

    perform net.http_post(
      url     := target.webhook_url,
      headers := '{"Content-Type": "application/json"}'::jsonb,
      body    := jsonb_build_object(
                   'text',
                   format('*Sotto — %s errors in the last %s*%s%s',
                          case when target.notify_all then 'all' else 'new' end,
                          p_window, E'\n', summary))
    );
    sent := sent + 1;
  end loop;

  return sent;
end;
$$;

revoke execute on function public.send_error_digest(interval) from anon, authenticated;

-- 08:00 UTC daily. Unscheduled first so re-applying the migration cannot stack duplicate jobs.
select cron.unschedule('error-digest') where exists (select 1 from cron.job where jobname = 'error-digest');
select cron.schedule('error-digest', '0 8 * * *', $$select public.send_error_digest('24 hours')$$);
