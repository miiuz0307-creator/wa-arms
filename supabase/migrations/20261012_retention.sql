-- Storage: keep what the system needs, summarise the rest, never touch connections/groups/settings.
--  * per-group delivery rows (campaign_targets) of FINISHED rides: kept 48 hours, then folded into a daily
--    summary per station / arm / kind (delivery_daily) and removed. Rides still running are never touched.
--    Cancel, "completed" notices, retry and the history page all use these rows only while the ride is
--    running or within minutes after; duplicate-ride checks use quote_sessions + campaigns (kept 90 days);
--    campaign sent/failed/total counters live on campaigns and stay.
--  * dedupe of incoming messages (processed_messages): 24 hours.
--  * rides (campaigns, campaign_arms, quote_sessions): 90 days.  activity log: 180 days.
--  * login codes / attempts, reset codes: 7 days.  cron run history: 7 days.  release snapshots: 30 days.
-- Runs every hour in small batches (5,000 rows, at most 10 batches = 50,000 rows an hour) so the database never
-- gets a burst; waits at most 2s for a lock and 120s in total, else it stops and tries again next hour.

create table if not exists public.delivery_daily (
  day date not null,
  station_id uuid not null,
  arm_id uuid not null default '00000000-0000-0000-0000-000000000000',
  kind text not null,
  rides int not null default 0,
  sent int not null default 0,
  failed int not null default 0,
  skipped int not null default 0,
  delay_sum_s bigint not null default 0,
  delay_n int not null default 0,
  primary key (day, station_id, arm_id, kind)
);
alter table public.delivery_daily enable row level security;
drop policy if exists "members read" on public.delivery_daily;
create policy "members read" on public.delivery_daily for select using (public.my_rank() >= 1 or public.is_super());
drop policy if exists station_isolation on public.delivery_daily;
create policy station_isolation on public.delivery_daily as restrictive for all
  using ((select public.is_engine()) or public.is_super() or station_id = (select public.my_station()));
revoke insert, update, delete on public.delivery_daily from anon, authenticated;
grant select on public.delivery_daily to anon, authenticated;

create table if not exists public.retention_runs (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  result jsonb not null
);
alter table public.retention_runs enable row level security;
revoke all on public.retention_runs from anon, authenticated;

create or replace function public.retention_run(p_batch int default 5000, p_max_batches int default 10, p_dry_run boolean default false)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $function$
declare
  n int; total_targets int := 0; i int := 0; res jsonb;
  c_pm int := 0; c_camp int := 0; c_qs int := 0; c_ca int := 0; c_log int := 0; c_misc int := 0;
  t0 timestamptz := clock_timestamp();
begin
  -- never wait on rows someone else is using, never run long: give up quietly and try next hour
  perform set_config('lock_timeout', '2s', true);
  perform set_config('statement_timeout', '120s', true);
  -- The whole run is one transaction: summary and removal are written together or not at all, so a
  -- failure half-way leaves nothing summarised twice and nothing removed unsummarised.
  if p_dry_run then
    return jsonb_build_object(
      'targets', (select count(*) from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id
                  where c.status in ('completed', 'cancelled', 'failed') and coalesce(c.finished_at, c.created_at) < now() - interval '48 hours'),
      'processed_messages', (select count(*) from public.processed_messages where processed_at < now() - interval '24 hours'),
      'campaigns', (select count(*) from public.campaigns where status in ('completed', 'cancelled', 'failed')
                    and coalesce(finished_at, created_at) < now() - interval '90 days'),
      'activity_log', (select count(*) from public.activity_log where created_at < now() - interval '180 days'));
  end if;

  -- 1) finished rides older than 48h: fold into the daily summary and remove, batch by batch
  loop
    exit when i >= p_max_batches;
    i := i + 1;
    with victims as (
      select t.id from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id
      where c.status in ('completed', 'cancelled', 'failed')
        and coalesce(c.finished_at, c.created_at) < now() - interval '48 hours'
      limit p_batch for update of t skip locked
    ), del as (
      delete from public.campaign_targets t using victims v where t.id = v.id
      returning t.campaign_id, t.arm_id, t.status, t.sent_at
    ), agg as (
      select (c.created_at at time zone 'Asia/Jerusalem')::date as day, c.station_id,
             coalesce(d.arm_id, '00000000-0000-0000-0000-000000000000') as arm_id, c.kind,
             count(distinct d.campaign_id) as rides,
             count(*) filter (where d.status = 'sent') as sent,
             count(*) filter (where d.status = 'failed') as failed,
             count(*) filter (where d.status not in ('sent', 'failed')) as skipped,
             coalesce(sum(greatest(0, extract(epoch from d.sent_at - c.created_at))) filter (where d.status = 'sent'), 0)::bigint as delay_sum_s,
             count(*) filter (where d.status = 'sent' and d.sent_at is not null) as delay_n
      from del d join public.campaigns c on c.id = d.campaign_id
      group by 1, 2, 3, 4
    )
    , ins as (
      insert into public.delivery_daily as dd (day, station_id, arm_id, kind, rides, sent, failed, skipped, delay_sum_s, delay_n)
      select day, station_id, arm_id, kind, rides, sent, failed, skipped, delay_sum_s, delay_n from agg
      on conflict (day, station_id, arm_id, kind) do update set
        rides = dd.rides + excluded.rides, sent = dd.sent + excluded.sent, failed = dd.failed + excluded.failed,
        skipped = dd.skipped + excluded.skipped, delay_sum_s = dd.delay_sum_s + excluded.delay_sum_s,
        delay_n = dd.delay_n + excluded.delay_n
      returning 1
    )
    select count(*) into n from del;
    total_targets := total_targets + n;
    exit when n < p_batch;
  end loop;

  -- 2) incoming-message dedupe: 24h is enough (a ride older than that is never processed again)
  with v as (select ctid from public.processed_messages where processed_at < now() - interval '24 hours' limit p_batch * 4)
  delete from public.processed_messages p using v where p.ctid = v.ctid;
  get diagnostics c_pm = row_count;

  -- 3) rides older than 90 days (their delivery rows are long gone); campaign_arms go with them (cascade)
  with old as (select id from public.campaigns where status in ('completed', 'cancelled', 'failed')
               and coalesce(finished_at, created_at) < now() - interval '90 days' limit 2000),
  qs as (delete from public.quote_sessions q using old where q.campaign_id = old.id returning 1),
  cp as (delete from public.campaigns c using old where c.id = old.id returning 1)
  select (select count(*) from cp), (select count(*) from qs) into c_camp, c_qs;

  -- 4) activity log: 180 days
  with v as (select id from public.activity_log where created_at < now() - interval '180 days' limit p_batch)
  delete from public.activity_log a using v where a.id = v.id;
  get diagnostics c_log = row_count;

  -- 5) short-lived records
  delete from public.login_otps where created_at < now() - interval '7 days';
  delete from public.station_login_attempts where created_at < now() - interval '7 days';
  delete from public.password_reset_codes where created_at < now() - interval '7 days';
  delete from ops.release_backups where created_at < now() - interval '30 days';
  get diagnostics c_misc = row_count;

  res := jsonb_build_object('delivery_rows_summarised', total_targets, 'batches', i, 'processed_messages', c_pm, 'campaigns', c_camp,
    'quote_sessions', c_qs, 'activity_log', c_log,
    'ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
  insert into public.retention_runs (result) values (res);
  return res;
end $function$;

revoke all on function public.retention_run(int, int, boolean) from public, anon, authenticated;
grant execute on function public.retention_run(int, int, boolean) to service_role;

-- owner: daily statistics (kept after the detail rows are summarised)
create or replace function public.owner_delivery_daily(p_days int default 30)
 returns setof public.delivery_daily language sql stable security definer set search_path to 'public'
as $function$
  select * from public.delivery_daily
  where public.is_super() and day >= (now() at time zone 'Asia/Jerusalem')::date - p_days
  order by day desc, station_id, arm_id, kind
$function$;
revoke execute on function public.owner_delivery_daily(int) from public, anon;
grant execute on function public.owner_delivery_daily(int) to authenticated;
