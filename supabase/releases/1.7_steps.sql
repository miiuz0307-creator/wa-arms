-- BotiX 1.7 in steps – run once in Supabase SQL Editor (takes ~1 second).
-- Why steps: reading the 140MB of old keys takes ~14s on this database, longer than one request may run.
-- A server job (pg_cron, every minute) handles ~1,500 old keys per step; each step is ONE transaction:
--   copy the batch to ops.arm_auth_stale_20261012 (rows locked while copied, so they cannot change) ->
--   remove only keys still identical to their copy (value and time) -> prove every removed key is in the copy ->
--   check no login row (creds / app-state) is missing and every connected arm still has creds.
--   Any failed check undoes that step and the job stops itself.
-- When no old key is left, the job removes its own schedule and marks update 1.7 live.
-- Never touched: 'creds', 'app-state-*' and any key written from 10 Oct. The copy is kept until the owner
-- approves removing it. Undo: 1.7_rollback.sql (safe restore from the copy).
begin;

create table if not exists ops.arm_auth_stale_20261012 as select * from public.arm_auth where false;
alter table ops.arm_auth_stale_20261012 enable row level security;
create unique index if not exists arm_auth_stale_20261012_key on ops.arm_auth_stale_20261012 (arm_id, key);
create table if not exists ops.arm_auth_cleanup_log (at timestamptz not null default now(), result jsonb not null);
alter table ops.arm_auth_cleanup_log enable row level security;

create or replace function ops.arm_auth_cleanup_step(p_batch int default 1500)
 returns jsonb language plpgsql volatile security definer set search_path to 'public'
as $function$
declare copied int; removed int; in_copy int; c0 int; c1 int; no_creds int; left_old int; res jsonb;
begin
  if not pg_try_advisory_xact_lock(hashtext('ops.arm_auth_cleanup_step')) then
    return jsonb_build_object('skipped', 'a step is already running');
  end if;
  perform set_config('lock_timeout', '5s', true);

  select count(*) into c0 from public.arm_auth where key = 'creds' or key like 'app-state-%';

  -- 1) copy the next batch of old keys (locked until this step ends, so the copy stays exact)
  with b as (
    select x.* from public.arm_auth x
    where x.key <> 'creds' and x.key not like 'app-state-%' and x.updated_at < '2026-10-10'
      and not exists (select 1 from ops.arm_auth_stale_20261012 s where s.arm_id = x.arm_id and s.key = x.key)
    order by x.arm_id, x.key
    limit p_batch
    for update of x
  )
  insert into ops.arm_auth_stale_20261012 select * from b;
  get diagnostics copied = row_count;

  -- 2) remove only keys still identical to their copy, and prove each removed key is in the copy
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
  if in_copy <> removed then raise exception '1.7: % removed keys are not in the copy – step undone', removed - in_copy; end if;

  -- 3) logins untouched, every connected arm still has creds
  select count(*) into c1 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  if c1 < c0 then raise exception '1.7: login rows went from % to % – step undone', c0, c1; end if;
  select count(*) into no_creds from public.arms a
  where a.is_active and a.status = 'online'
    and not exists (select 1 from public.arm_auth x where x.arm_id = a.id and x.key = 'creds');
  if no_creds > 0 then raise exception '1.7: % connected arm(s) without creds – step undone', no_creds; end if;

  select count(*) into left_old from public.arm_auth x
  where x.key <> 'creds' and x.key not like 'app-state-%' and x.updated_at < '2026-10-10'
    and not exists (select 1 from ops.arm_auth_stale_20261012 s where s.arm_id = x.arm_id and s.key = x.key);

  res := jsonb_build_object('copied', copied, 'removed', removed, 'kept_changed', copied - removed, 'old_left', left_old,
                            'copy_total', (select count(*) from ops.arm_auth_stale_20261012));
  insert into ops.arm_auth_cleanup_log (result) values (res);

  if left_old = 0 then
    perform cron.unschedule('arm-auth-cleanup');
    update public.releases set status = 'live', deployed_at = now(),
      log = coalesce(log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'msg',
            format('הושלם בשלבים: %s מפתחות ישנים בגיבוי, %s נמחקו, %s נשמרו כי השתנו',
                   (select count(*) from ops.arm_auth_stale_20261012),
                   (select count(*) from ops.arm_auth_stale_20261012 s where not exists (select 1 from public.arm_auth x where x.arm_id = s.arm_id and x.key = s.key)),
                   (select count(*) from ops.arm_auth_stale_20261012 s where exists (select 1 from public.arm_auth x where x.arm_id = s.arm_id and x.key = s.key)))))
    where id = 7;
  end if;
  return res;
exception when others then
  -- a failed check: everything this step did is undone (the block rolls back); the job stops itself
  perform cron.unschedule('arm-auth-cleanup');
  insert into ops.arm_auth_cleanup_log (result) values (jsonb_build_object('error', sqlerrm, 'stopped', true));
  return jsonb_build_object('error', sqlerrm, 'stopped', true);
end $function$;

revoke all on function ops.arm_auth_cleanup_step(int) from public;

update public.releases set
  log = coalesce(log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'msg',
        'מופעל בשלבים קטנים (משימת שרת כל דקה, כ־1,500 מפתחות לשלב) – מגבלת זמן בחיבור; אותן בדיקות בכל שלב'))
where id = 7;

select cron.schedule('arm-auth-cleanup', '* * * * *', $c$set statement_timeout = '50s'; select ops.arm_auth_cleanup_step(1500)$c$);

commit;

select (select count(*) from cron.job where jobname = 'arm-auth-cleanup') as job_scheduled,
       (select count(*) from public.arm_auth) as keys_now,
       (select count(*) from public.arm_auth where key = 'creds' or key like 'app-state-%') as login_rows;
