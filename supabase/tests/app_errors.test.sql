-- The error sink (pgTAP). Run with `supabase test db`.
--
-- Two properties carry this table, and they pull against each other:
--
--   ANYONE MAY REPORT — including a visitor whose sign-in just failed, which is exactly the error
--     worth capturing. If reporting needed a session, the auth failures would be the ones lost.
--   ONLY STAFF MAY READ — messages quote asset names and folder paths, so the table is client data.
--
-- Plus: it must never make an error worse. An over-limit insert is dropped, not raised, because
-- reportError is called from `.catch()` handlers where a throw would replace the original failure.

-- Counts are scoped to this suite's own contexts. An earlier version counted the whole table and so
-- passed only against an empty database — the first real dev data broke it.

begin;
create extension if not exists pgtap;

select plan(17);

insert into public.clients (id, name) values ('99999999-0000-0000-0000-000000000001', 'Errors');
insert into auth.users (id, email) values
  ('99999999-0000-0000-0000-0000000000a1', 'staff@dc.test'),
  ('99999999-0000-0000-0000-0000000000b1', 'member@acme.test');
update public.profiles set role = 'super_admin' where id = '99999999-0000-0000-0000-0000000000a1';
insert into auth.users (id, email) values ('99999999-0000-0000-0000-0000000000c1', 'admin@dc.test');
update public.profiles set role = 'admin' where id = '99999999-0000-0000-0000-0000000000c1';
update public.profiles set role = 'member', client_id = '99999999-0000-0000-0000-000000000001'
  where id = '99999999-0000-0000-0000-0000000000b1';

/* ── Reporting works without a session ────────────────────────────────────── */

set local role anon;

select lives_ok(
  $$insert into public.app_errors (context, message, source)
    values ('auth.PgTap.signIn', 'Invalid login credentials', 'web')$$,
  'A signed-OUT visitor can report — otherwise every auth failure goes unrecorded');

-- Verified with the role reset, because `anon` deliberately cannot read back what it just wrote —
-- that is asserted a few lines below.
reset role;
select is(
  (select count(*) from public.app_errors where context = 'auth.PgTap.signIn'),
  1::bigint,
  'The anonymous report is stored');
set local role anon;

/* ── But a caller cannot attribute a report to somebody else ──────────────── */

select throws_ok(
  $$insert into public.app_errors (context, message, source, user_id)
    values ('auth.forged', 'x', 'web', '99999999-0000-0000-0000-0000000000a1')$$,
  '42501',
  null,
  'Attributing a report to another user is refused — same rule as asset_events');

/* ── Anonymous callers cannot READ. Messages quote client asset names ─────── */

select is(
  (select count(*) from public.app_errors), 0::bigint,
  'anon cannot read the table it just wrote to');

/* ── A member is not staff ───────────────────────────────────────────────── */

set local role authenticated;
set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-0000000000b1","role":"authenticated"}';

select is(
  (select count(*) from public.app_errors), 0::bigint,
  'A signed-in MEMBER cannot read errors — this is staff debugging data, not client-visible');

select lives_ok(
  $$insert into public.app_errors (context, message, source, user_id)
    values ('feedback.PgTap.saveRating', 'boom', 'web', '99999999-0000-0000-0000-0000000000b1')$$,
  'A member can report an error attributed to themselves');

/* ── A plain ADMIN is not a maintainer ───────────────────────────────────── */

set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-0000000000c1","role":"authenticated"}';

select is(
  (select count(*) from public.app_errors), 0::bigint,
  'An ADMIN cannot read errors — messages quote asset names and paths, and this is maintainer data');

/* ── Super admins can read everything ────────────────────────────────────── */

set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-0000000000a1","role":"authenticated"}';

select is(
  (select count(*) from public.app_errors
    where context in ('auth.PgTap.signIn', 'feedback.PgTap.saveRating')),
  2::bigint,
  'A super admin reads every report, from every user and from anonymous visitors');

/* ── Notification destinations are super-admin only ──────────────────────── */

select lives_ok(
  $$insert into public.error_notifications (label, webhook_url)
    values ('#dev-alerts', 'https://hooks.slack.com/services/T0/B0/xxx')$$,
  'A super admin can add a Slack destination');

select throws_ok(
  $$insert into public.error_notifications (label, webhook_url)
    values ('not slack', 'https://evil.test/collect')$$,
  '23514',
  null,
  'A non-Slack URL is refused — the column is a webhook, not an arbitrary exfiltration target');

set local request.jwt.claims = '{"sub":"99999999-0000-0000-0000-0000000000c1","role":"authenticated"}';

select is(
  (select count(*) from public.error_notifications), 0::bigint,
  'An ADMIN cannot even see the destinations — the webhook URL IS the credential');

/* ── The rate limit drops, and never raises ──────────────────────────────── */

-- As ANON, not as superuser. The first version of this test used `reset role`, which bypasses RLS —
-- so it proved the trigger works for the one caller who never inserts, and missed that the counter
-- saw nothing under a restricted read policy. Every report in production arrives as anon.
set local role anon;

insert into public.app_errors (context, message, source)
select 'ui.PgTap.render', 'render exploded', 'web' from generate_series(1, 20);

reset role;

select is(
  (select count(*) from public.app_errors where context = 'ui.PgTap.render'),
  20::bigint,
  '20 reports of one context in a minute are kept');

select lives_ok(
  $$insert into public.app_errors (context, message, source)
    values ('ui.PgTap.render', 'render exploded', 'web')$$,
  'The 21st does NOT raise — reportError runs inside catch handlers and must not throw');

select is(
  (select count(*) from public.app_errors where context = 'ui.PgTap.render'),
  20::bigint,
  'The over-limit report is dropped, so one looping screen cannot crowd out every other error');

/* ── The digest groups repeats ───────────────────────────────────────────── */

select is(
  (select occurrences from public.error_digest('24 hours')
    where context = 'ui.PgTap.render'),
  20::bigint,
  'error_digest collapses a repeated failure into one row with a count');

/* ── "New" means new, not merely present ─────────────────────────────────── */

select is(
  (select occurrences from public.new_error_signatures('24 hours')
    where context = 'ui.PgTap.render'),
  20::bigint,
  'A signature first seen inside the window counts as new');

-- Age one occurrence out of the window: the signature now has history, so it is no longer news.
update public.app_errors set created_at = now() - interval '3 days'
  where context = 'ui.PgTap.render'
    and id = (select id from public.app_errors where context = 'ui.PgTap.render' limit 1);

select is(
  (select count(*) from public.new_error_signatures('24 hours')
    where context = 'ui.PgTap.render'),
  0::bigint,
  'A signature seen BEFORE the window is not new — this is what stops a looping component alerting daily');

select * from finish();
rollback;
