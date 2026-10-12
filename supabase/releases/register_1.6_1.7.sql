-- Registers releases 1.6 and 1.7 in the update center ("ניהול עדכונים") as WAITING FOR APPROVAL.
-- Running this file changes two rows of public.releases and nothing else. The text between $rel$ ... $rel$ is
-- stored, not run. It runs only after the owner approves the release in the app (one at a time, by the
-- release-runner, inside one transaction, after a data snapshot).
-- Sources: supabase/migrations/20261012_retention_v2.sql + 20261012_retention_cron.sql (1.6),
--          supabase/releases/1.7_arm_auth_cleanup.sql + 1.7_rollback.sql (1.7).

update public.releases set components = '{db}', migration_sql = $rel$-- Release 1.6 – storage clean-up (the update center applies it after the owner approves).
--
-- What is removed, and why nothing the system needs goes with it:
--  * campaign_targets (one row per group per ride) of rides that FINISHED over 48 hours ago and have no group
--    still pending/sending. Always whole rides: all of a ride's rows are summarised into delivery_daily and
--    removed in the same statement, and the ride is marked (campaigns.stats_summarised_at) so it is counted
--    only once, ever (rows of an already counted ride – e.g. put back from a backup – are never counted again). Ride counters on campaigns (sent / failed / total) are not changed.
--  * processed_messages older than 24 hours – "this message was already handled". The engine ignores any
--    message older than 10 minutes, so an older mark is never consulted.
--  * rides (campaigns + their quote_sessions) older than 90 days whose group rows were already summarised.
--    The duplicate-ride check looks back minutes (station setting, default 10).
--  * activity_log older than 180 days (the app shows the latest 8 / 200 entries).
--  * login_otps, station_login_attempts, password_reset_codes older than 7 days. They are read only for
--    the last 5–60 minutes (code expiry and rate limits).
-- Never touched: WhatsApp connections (arm_auth), arms, groups, lists, settings, users, stations,
-- release backups (ops.release_backups) and anything of a ride that is still running.
--
-- Load: whole rides up to ~5,000 rows per batch, at most 10 batches and 60 seconds per run, once an hour.
-- A row lock held by someone else is waited for at most 2 seconds – then the run stops and nothing of it is
-- kept (one transaction), and it tries again next hour. Two runs never overlap (advisory lock).

-- a ride whose group rows were summarised (counted once in delivery_daily.rides)
select set_config('lock_timeout', '5s', true);
alter table public.campaigns add column if not exists stats_summarised_at timestamptz;

create or replace function public.retention_run(p_batch int default 5000, p_max_batches int default 10, p_dry_run boolean default false)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  ids uuid[]; n int; nr int; total_rows int := 0; total_rides int := 0; i int := 0; res jsonb;
  c_pm int := 0; c_camp int := 0; c_qs int := 0; c_log int := 0; c_otp int := 0; c_att int := 0; c_rst int := 0;
  zero constant uuid := '00000000-0000-0000-0000-000000000000';
  t0 timestamptz := clock_timestamp();
begin
  -- one clean-up at a time: a second call while one runs returns at once
  if not pg_try_advisory_xact_lock(hashtext('public.retention_run')) then
    return jsonb_build_object('skipped', 'another clean-up is running');
  end if;
  -- never wait long for a row someone else is using: stop, keep nothing, try next hour
  perform set_config('lock_timeout', '2s', true);

  if p_dry_run then
    return jsonb_build_object(
      'targets', (select count(*) from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id
                  where c.status in ('completed', 'cancelled', 'failed') and coalesce(c.finished_at, c.created_at) < now() - interval '48 hours'
                    and not exists (select 1 from public.campaign_targets p where p.campaign_id = c.id and p.status in ('pending', 'sending'))),
      'processed_messages', (select count(*) from public.processed_messages where processed_at < now() - interval '24 hours'),
      'campaigns', (select count(*) from public.campaigns c where c.status in ('completed', 'cancelled', 'failed')
                    and coalesce(c.finished_at, c.created_at) < now() - interval '90 days'
                    and not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id)),
      'activity_log', (select count(*) from public.activity_log where created_at < now() - interval '180 days'));
  end if;

  -- 1) finished rides older than 48h – whole rides only, summarised and removed together
  loop
    exit when i >= p_max_batches or clock_timestamp() - t0 > interval '60 seconds';
    select coalesce(array_agg(x.id), '{}') into ids from (
      select r.id, r.n, sum(r.n) over (order by r.created_at, r.id) as upto
      from (select c.id, c.created_at,
                   (select count(*) from public.campaign_targets t where t.campaign_id = c.id) as n
            from public.campaigns c
            where c.status in ('completed', 'cancelled', 'failed')
              and coalesce(c.finished_at, c.created_at) < now() - interval '48 hours'
              and exists (select 1 from public.campaign_targets t where t.campaign_id = c.id)
              and not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id and t.status in ('pending', 'sending'))
            order by c.created_at, c.id
            limit p_batch
            for update of c skip locked) r
    ) x
    where x.upto - x.n < p_batch;   -- whole rides up to ~p_batch rows (at least one ride)
    exit when cardinality(ids) = 0;
    i := i + 1;

    with del as (
      delete from public.campaign_targets t where t.campaign_id = any (ids)
      returning t.campaign_id, t.arm_id, t.status, t.sent_at
    ), d as (
      select (c.created_at at time zone 'Asia/Jerusalem')::date as day, c.station_id, c.kind, c.created_at,
             c.stats_summarised_at is null as first_time, x.campaign_id, x.arm_id, x.status, x.sent_at
      from del x join public.campaigns c on c.id = x.campaign_id
    ), per_arm as (
      -- per number: groups sent / failed / skipped, delivery time, rides it took part in.
      -- Rows of a ride that was already summarised (e.g. put back from a backup) are removed but never
      -- counted again.
      select day, station_id, coalesce(arm_id, zero) as arm_id, kind,
             count(distinct campaign_id) filter (where arm_id is not null) as rides,
             count(*) filter (where status = 'sent') as sent,
             count(*) filter (where status = 'failed') as failed,
             count(*) filter (where status not in ('sent', 'failed')) as skipped,
             coalesce(sum(greatest(0, extract(epoch from sent_at - created_at))) filter (where status = 'sent'), 0)::bigint as delay_sum_s,
             count(*) filter (where status = 'sent' and sent_at is not null) as delay_n
      from d where first_time group by 1, 2, 3, 4
    ), per_station as (
      -- the station row (arm_id = zero): number of rides, each ride once
      select day, station_id, zero as arm_id, kind, count(distinct campaign_id) as rides,
             0::bigint as sent, 0::bigint as failed, 0::bigint as skipped, 0::bigint as delay_sum_s, 0::bigint as delay_n
      from d where first_time group by 1, 2, 4
    ), agg as (
      select day, station_id, arm_id, kind, sum(rides)::int as rides, sum(sent)::int as sent, sum(failed)::int as failed,
             sum(skipped)::int as skipped, sum(delay_sum_s)::bigint as delay_sum_s, sum(delay_n)::int as delay_n
      from (select * from per_arm union all select * from per_station) u
      group by 1, 2, 3, 4
    ), ins as (
      insert into public.delivery_daily as dd (day, station_id, arm_id, kind, rides, sent, failed, skipped, delay_sum_s, delay_n)
      select day, station_id, arm_id, kind, rides, sent, failed, skipped, delay_sum_s, delay_n from agg
      on conflict (day, station_id, arm_id, kind) do update set
        rides = dd.rides + excluded.rides, sent = dd.sent + excluded.sent, failed = dd.failed + excluded.failed,
        skipped = dd.skipped + excluded.skipped, delay_sum_s = dd.delay_sum_s + excluded.delay_sum_s,
        delay_n = dd.delay_n + excluded.delay_n
      returning 1
    ), mark as (
      update public.campaigns c set stats_summarised_at = now()
      where c.id = any (ids) and c.stats_summarised_at is null
      returning 1
    )
    select (select count(*) from del), (select count(*) from mark) into n, nr;
    total_rows := total_rows + n;
    total_rides := total_rides + nr;
  end loop;

  -- 2) "message already handled" marks: 24 hours (the engine ignores messages older than 10 minutes)
  with v as (select ctid from public.processed_messages where processed_at < now() - interval '24 hours' limit p_batch * 4)
  delete from public.processed_messages p using v where p.ctid = v.ctid;
  get diagnostics c_pm = row_count;

  -- 3) rides older than 90 days whose group rows are already summarised (none left)
  with old as (select c.id from public.campaigns c where c.status in ('completed', 'cancelled', 'failed')
               and coalesce(c.finished_at, c.created_at) < now() - interval '90 days'
               and not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id)
               limit 2000 for update of c skip locked),
  qs as (delete from public.quote_sessions q using old where q.campaign_id = old.id returning 1),
  cp as (delete from public.campaigns c using old where c.id = old.id returning 1)
  select (select count(*) from cp), (select count(*) from qs) into c_camp, c_qs;

  -- 4) activity log: 180 days
  with v as (select id from public.activity_log where created_at < now() - interval '180 days' limit p_batch)
  delete from public.activity_log a using v where a.id = v.id;
  get diagnostics c_log = row_count;

  -- 5) login codes, login attempts, password-reset codes: 7 days (read only for the last 5–60 minutes)
  with v as (select ctid from public.login_otps where created_at < now() - interval '7 days' limit p_batch)
  delete from public.login_otps x using v where x.ctid = v.ctid;
  get diagnostics c_otp = row_count;
  with v as (select ctid from public.station_login_attempts where created_at < now() - interval '7 days' limit p_batch)
  delete from public.station_login_attempts x using v where x.ctid = v.ctid;
  get diagnostics c_att = row_count;
  with v as (select ctid from public.password_reset_codes where created_at < now() - interval '7 days' limit p_batch)
  delete from public.password_reset_codes x using v where x.ctid = v.ctid;
  get diagnostics c_rst = row_count;

  res := jsonb_build_object('delivery_rows_summarised', total_rows, 'rides_summarised', total_rides, 'batches', i,
    'processed_messages', c_pm, 'campaigns', c_camp, 'quote_sessions', c_qs, 'activity_log', c_log,
    'login_otps', c_otp, 'login_attempts', c_att, 'reset_codes', c_rst,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
  insert into public.retention_runs (result) values (res);
  return res;
end $function$;

revoke all on function public.retention_run(int, int, boolean) from public, anon, authenticated;
grant execute on function public.retention_run(int, int, boolean) to service_role;

-- Release 1.6: run the storage clean-up every hour at :17, at most 120 seconds (see 20261012_retention_v2.sql).
select cron.schedule('retention', '17 * * * *', $c$set statement_timeout = '120s'; select public.retention_run()$c$);
-- cron's own run history grows by ~1,500 rows a day: keep 7 days (once a day at 03:47 UTC).
-- This is pg_cron's log of its own runs (cron.job_run_details), not data of the system.
select cron.schedule('cron-history-trim', '47 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
$rel$, rollback_sql = $rel$-- Undo of 1.6: stop the clean-up. Rows already removed stay summarised in delivery_daily.
select cron.unschedule('retention');
select cron.unschedule('cron-history-trim');
$rel$
where id = 6 and status = 'pending';

update public.releases set components = '{db}', migration_sql = $rel$-- Release 1.7 – old per-chat WhatsApp keys in the database (arm_auth). One transaction (the update center
-- runs it as one): if any check fails, everything is undone and nothing is removed.
--
-- Removed: rows written before 10 Oct 2026 that are not the login identity. Since 9 Oct the engine keeps
-- per-chat keys on its disk (/data/auth – the working copy, newer than these rows); the database keeps only
-- the login identity. Never touched: 'creds' and 'app-state-*' rows (what reconnecting without a QR needs).
--
-- Safety:
--  1. a full copy goes to ops.arm_auth_stale_20261012 first; it is kept until the owner approves removing it
--     (nothing removes it automatically);
--  2. the copy is counted against the table;
--  3. a row is removed only if it is STILL exactly what was copied (same value, same updated_at) and still
--     older than 10 Oct. A key the engine wrote in the meantime – even with the same arm and key name – stays.
--     If the engine is writing that row at this very moment, the removal waits for it (at most 5 seconds,
--     else everything is undone) and then checks the new version, which no longer matches;
--  4. after removal: no identity row is missing and every connected arm still has its creds row.
-- Undo: 1.7_rollback.sql puts every removed row back (a key re-created since then is kept as it is).
select set_config('lock_timeout', '5s', true);

create table if not exists ops.arm_auth_stale_20261012 as
  select * from public.arm_auth
  where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';

do $chk$
declare a int; b int; c0 int; c1 int; removed int; online_without_creds int;
begin
  select count(*) into a from public.arm_auth where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';
  select count(*) into b from ops.arm_auth_stale_20261012;
  if b = 0 or a <> b then raise exception '1.7: copy incomplete (% in table, % copied) – nothing removed', a, b; end if;

  select count(*) into c0 from public.arm_auth where key = 'creds' or key like 'app-state-%';

  delete from public.arm_auth x
  using ops.arm_auth_stale_20261012 s
  where x.arm_id = s.arm_id and x.key = s.key
    and x.key <> 'creds' and x.key not like 'app-state-%'
    and x.updated_at < '2026-10-10'
    and x.updated_at = s.updated_at
    and x.value = s.value;
  get diagnostics removed = row_count;

  select count(*) into c1 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  if c1 < c0 then raise exception '1.7: identity rows went from % to % – undone', c0, c1; end if;
  select count(*) into online_without_creds from public.arms a
  where a.is_active and a.status = 'online'
    and not exists (select 1 from public.arm_auth x where x.arm_id = a.id and x.key = 'creds');
  if online_without_creds > 0 then raise exception '1.7: % connected arm(s) without creds – undone', online_without_creds; end if;

  raise notice '1.7: copied %, removed %, kept because they changed since the copy %', b, removed, b - removed;
end $chk$;
$rel$, rollback_sql = $rel$-- Undo of 1.7: every removed key back from the copy. A key the engine re-created since then is kept as it is.
insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;
$rel$
where id = 7 and status = 'pending';

select id, version, status, components, length(migration_sql) as code_chars, length(rollback_sql) as undo_chars
from public.releases where id in (6, 7);
