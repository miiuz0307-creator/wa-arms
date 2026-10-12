-- Registers releases 1.6 and 1.7 in the update center (ניהול עדכונים). Nothing runs until the owner approves each one in the app.
-- 1.7 runs as one transaction: backup copy -> count check -> delete -> checks; any failed check undoes everything.
update public.releases set components='{db}', migration_sql=$mig$create or replace function public.retention_run(p_batch int default 5000, p_max_batches int default 10, p_dry_run boolean default false)
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


select cron.schedule('retention', '17 * * * *', 'select public.retention_run()');
select cron.schedule('cron-history-trim', '47 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
$mig$, rollback_sql=$mig$select cron.unschedule('retention');
$mig$ where id=6 and status='pending';
update public.releases set migration_sql=$mig$-- 1.7: old per-chat keys (written up to 9 Oct). creds and app-state keys are never touched.
create table if not exists ops.arm_auth_stale_20261012 as
  select * from public.arm_auth where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';
do $chk$
declare a int; b int; c0 int; c1 int;
begin
  select count(*) into a from public.arm_auth where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';
  select count(*) into b from ops.arm_auth_stale_20261012;
  if a <> b or b = 0 then raise exception 'copy incomplete (% vs %) - nothing removed', a, b; end if;
  select count(*) into c0 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  delete from public.arm_auth x using ops.arm_auth_stale_20261012 s
   where x.arm_id = s.arm_id and x.key = s.key and x.key <> 'creds' and x.key not like 'app-state-%';
  select count(*) into c1 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  if c1 <> c0 then raise exception 'identity rows changed (% vs %) - undone', c0, c1; end if;
  if exists (select 1 from public.arms a where a.is_active and a.status = 'online'
             and not exists (select 1 from public.arm_auth x where x.arm_id = a.id and x.key = 'creds'))
    then raise exception 'an online arm has no creds row - undone'; end if;
end $chk$;
$mig$, rollback_sql=$mig$insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;
$mig$ where id=7 and status='pending';
select id, components, length(migration_sql) ml, length(rollback_sql) rl from public.releases where id in (6,7);