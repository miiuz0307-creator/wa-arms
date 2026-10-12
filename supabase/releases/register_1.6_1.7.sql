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
--    still pending/sending. Always whole rides: the ride is locked, its rows are locked and checked again,
--    then summarised and removed in one statement, and the ride is marked (campaigns.stats_summarised_at) so
--    it is counted only once, ever. Rows of a ride already counted (e.g. put back from a backup) are removed
--    but never counted again. Ride counters on campaigns (sent / failed / total) are not changed.
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
-- Statistics, two separate tables (no shared "empty" id):
--  * delivery_daily_station – one row per day / station / kind: rides, groups, sent, failed, skipped,
--    groups no arm took (unassigned), delivery time. Every group of every ride is here exactly once.
--  * delivery_daily – one row per day / station / REAL arm / kind: what that arm sent, failed, skipped,
--    delivery time, and the rides it took part in. Groups no arm took are not here (only in the station row).
--
-- Load: whole rides up to ~5,000 rows per batch, at most 10 batches and 60 seconds per run, once an hour.
-- A row lock held by someone else is waited for at most 2 seconds – then the run stops and nothing of it is
-- kept (one transaction), and it tries again next hour. Two runs never overlap (advisory lock).

select set_config('lock_timeout', '5s', true);

-- a ride whose group rows were summarised (counted once)
alter table public.campaigns add column if not exists stats_summarised_at timestamptz;

-- per-arm statistics hold real arms only (station totals have their own table)
alter table public.delivery_daily alter column arm_id drop default;
alter table public.delivery_daily drop constraint if exists delivery_daily_real_arm;
alter table public.delivery_daily add constraint delivery_daily_real_arm check (arm_id <> '00000000-0000-0000-0000-000000000000');

create table if not exists public.delivery_daily_station (
  day date not null,
  station_id uuid not null,
  kind text not null,
  rides int not null default 0,
  groups int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  skipped int not null default 0,
  unassigned int not null default 0,
  delay_sum_s bigint not null default 0,
  delay_n int not null default 0,
  primary key (day, station_id, kind)
);
alter table public.delivery_daily_station enable row level security;
drop policy if exists "members read" on public.delivery_daily_station;
create policy "members read" on public.delivery_daily_station for select using (public.my_rank() >= 1 or public.is_super());
drop policy if exists station_isolation on public.delivery_daily_station;
create policy station_isolation on public.delivery_daily_station as restrictive for all
  using ((select public.is_engine()) or public.is_super() or station_id = (select public.my_station()));
revoke insert, update, delete on public.delivery_daily_station from anon, authenticated;
grant select on public.delivery_daily_station to anon, authenticated;
grant all on public.delivery_daily_station to service_role;

create or replace function public.owner_delivery_daily_station(p_days int default 30)
 returns setof public.delivery_daily_station language sql stable security definer set search_path to 'public'
as $function$
  select * from public.delivery_daily_station
  where public.is_super() and day >= (now() at time zone 'Asia/Jerusalem')::date - p_days
  order by day desc, station_id, kind
$function$;
revoke execute on function public.owner_delivery_daily_station(int) from public, anon;
grant execute on function public.owner_delivery_daily_station(int) to authenticated;

create or replace function public.retention_run(p_batch int default 5000, p_max_batches int default 10, p_dry_run boolean default false)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  ids uuid[]; n int; nr int; total_rows int := 0; total_rides int := 0; i int := 0; res jsonb;
  c_pm int := 0; c_camp int := 0; c_qs int := 0; c_log int := 0; c_otp int := 0; c_att int := 0; c_rst int := 0;
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
    -- (a) pick whole rides and lock them: nobody can add rows to a locked ride or reopen it until we finish
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
    -- (b) lock their rows too (waits at most 2s for e.g. a "resend failed" in progress), then check again:
    --     a ride that got reopened or has a group waiting meanwhile is left for a later run
    perform 1 from public.campaign_targets t where t.campaign_id = any (ids) for update;
    select coalesce(array_agg(c.id), '{}') into ids from public.campaigns c
    where c.id = any (ids) and c.status in ('completed', 'cancelled', 'failed')
      and not exists (select 1 from public.campaign_targets t where t.campaign_id = c.id and t.status in ('pending', 'sending'));
    i := i + 1;
    continue when cardinality(ids) = 0;

    with del as (
      delete from public.campaign_targets t where t.campaign_id = any (ids)
      returning t.campaign_id, t.arm_id, t.status, t.sent_at
    ), d as (
      -- only rows of rides not counted before (rows put back from a backup are removed, not counted again)
      select (c.created_at at time zone 'Asia/Jerusalem')::date as day, c.station_id, c.kind, c.created_at,
             x.campaign_id, x.arm_id, x.status, x.sent_at
      from del x join public.campaigns c on c.id = x.campaign_id
      where c.stats_summarised_at is null
    ), st as (
      insert into public.delivery_daily_station as s (day, station_id, kind, rides, groups, sent, failed, skipped, unassigned, delay_sum_s, delay_n)
      select day, station_id, kind,
             count(distinct campaign_id), count(*),
             count(*) filter (where status = 'sent'),
             count(*) filter (where status = 'failed'),
             count(*) filter (where status not in ('sent', 'failed')),
             count(*) filter (where arm_id is null),
             coalesce(sum(greatest(0, extract(epoch from sent_at - created_at))) filter (where status = 'sent'), 0)::bigint,
             count(*) filter (where status = 'sent' and sent_at is not null)
      from d group by 1, 2, 3
      on conflict (day, station_id, kind) do update set
        rides = s.rides + excluded.rides, groups = s.groups + excluded.groups, sent = s.sent + excluded.sent,
        failed = s.failed + excluded.failed, skipped = s.skipped + excluded.skipped,
        unassigned = s.unassigned + excluded.unassigned, delay_sum_s = s.delay_sum_s + excluded.delay_sum_s,
        delay_n = s.delay_n + excluded.delay_n
      returning 1
    ), ar as (
      insert into public.delivery_daily as dd (day, station_id, arm_id, kind, rides, sent, failed, skipped, delay_sum_s, delay_n)
      select day, station_id, arm_id, kind,
             count(distinct campaign_id),
             count(*) filter (where status = 'sent'),
             count(*) filter (where status = 'failed'),
             count(*) filter (where status not in ('sent', 'failed')),
             coalesce(sum(greatest(0, extract(epoch from sent_at - created_at))) filter (where status = 'sent'), 0)::bigint,
             count(*) filter (where status = 'sent' and sent_at is not null)
      from d where arm_id is not null group by 1, 2, 3, 4
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
$rel$, rollback_sql = $rel$-- Undo of 1.6: stop the clean-up. Rows already removed stay summarised in the statistics tables.
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
--  4. every removed key is checked against the copy (same value, same time) – any mismatch undoes everything;
--  5. after removal: no identity row is missing and every connected arm still has its creds row.
-- Undo: 1.7_rollback.sql – safe restore (see there).
select set_config('lock_timeout', '5s', true);

create table if not exists ops.arm_auth_stale_20261012 as
  select * from public.arm_auth
  where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';

do $chk$
declare a int; b int; c0 int; c1 int; removed int; in_copy int; online_without_creds int;
begin
  select count(*) into a from public.arm_auth where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';
  select count(*) into b from ops.arm_auth_stale_20261012;
  if b = 0 or a <> b then raise exception '1.7: copy incomplete (% in table, % copied) – nothing removed', a, b; end if;

  select count(*) into c0 from public.arm_auth where key = 'creds' or key like 'app-state-%';

  -- remove, and prove every removed key is in the copy, identical (value and time)
  with d as (
    delete from public.arm_auth x
    using ops.arm_auth_stale_20261012 s
    where x.arm_id = s.arm_id and x.key = s.key
      and x.key <> 'creds' and x.key not like 'app-state-%'
      and x.updated_at < '2026-10-10'
      and x.updated_at = s.updated_at
      and x.value = s.value
    returning x.arm_id, x.key, x.value, x.updated_at
  )
  select count(*), count(*) filter (where exists (
           select 1 from ops.arm_auth_stale_20261012 s
           where s.arm_id = d.arm_id and s.key = d.key and s.value = d.value and s.updated_at = d.updated_at))
  into removed, in_copy from d;
  if in_copy <> removed then raise exception '1.7: % removed keys are not in the copy – undone', removed - in_copy; end if;

  select count(*) into c1 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  if c1 < c0 then raise exception '1.7: identity rows went from % to % – undone', c0, c1; end if;
  select count(*) into online_without_creds from public.arms a
  where a.is_active and a.status = 'online'
    and not exists (select 1 from public.arm_auth x where x.arm_id = a.id and x.key = 'creds');
  if online_without_creds > 0 then raise exception '1.7: % connected arm(s) without creds – undone', online_without_creds; end if;

  raise notice '1.7: copied %, removed %, kept because they changed since the copy %', b, removed, b - removed;
end $chk$;
$rel$, rollback_sql = $rel$-- Undo of 1.7 – safe restore from ops.arm_auth_stale_20261012, key by key:
--   * key missing                                   -> put back from the copy
--   * key present, identical to the copy            -> nothing to do
--   * key present, different and NEWER than the copy -> a valid key the engine wrote since: kept as it is
--   * key present, different but NOT newer           -> wrong content: replaced by the copy
-- Afterwards it checks that every key of the copy is in the table, identical or newer; else everything is undone.
select set_config('lock_timeout', '5s', true);
do $undo$
declare missing int; wrong int; newer int; same int; bad int;
begin
  select count(*) filter (where x.arm_id is null),
         count(*) filter (where x.arm_id is not null and x.value is distinct from s.value and x.updated_at <= s.updated_at),
         count(*) filter (where x.arm_id is not null and x.value is distinct from s.value and x.updated_at > s.updated_at),
         count(*) filter (where x.arm_id is not null and x.value is not distinct from s.value)
  into missing, wrong, newer, same
  from ops.arm_auth_stale_20261012 s
  left join public.arm_auth x on x.arm_id = s.arm_id and x.key = s.key;

  insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;

  update public.arm_auth x set value = s.value, updated_at = s.updated_at, station_id = s.station_id
  from ops.arm_auth_stale_20261012 s
  where x.arm_id = s.arm_id and x.key = s.key
    and x.value is distinct from s.value and x.updated_at <= s.updated_at;

  select count(*) into bad from ops.arm_auth_stale_20261012 s
  where not exists (select 1 from public.arm_auth x where x.arm_id = s.arm_id and x.key = s.key
                    and ((x.value = s.value and x.updated_at = s.updated_at) or x.updated_at > s.updated_at));
  if bad > 0 then raise exception '1.7 undo: % keys could not be restored – undone', bad; end if;

  raise notice '1.7 undo: put back %, fixed wrong content %, kept newer %, already identical %', missing, wrong, newer, same;
end $undo$;
$rel$
where id = 7 and status = 'pending';

select id, version, status, components, length(migration_sql) as code_chars, length(rollback_sql) as undo_chars
from public.releases where id in (6, 7);
