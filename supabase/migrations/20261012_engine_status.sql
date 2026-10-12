-- Engine health, reported every 30s with the heartbeat: when the arms sync last finished, how long it took,
-- how many times a stuck pass was replaced, how many arms run / are online / are still closing, memory.
create table if not exists public.engine_status (
  id int primary key default 1 check (id = 1),
  sync_ok_at timestamptz,
  sync_ms int,
  sync_stuck_count int not null default 0,
  arms_running int,
  arms_online int,
  arms_stopping int,
  rss_mb int,
  reported_at timestamptz not null default now()
);
alter table public.engine_status enable row level security;
revoke all on public.engine_status from anon, authenticated;
insert into public.engine_status (id) values (1) on conflict do nothing;

create or replace function public.engine_status_report(p json)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  update public.engine_status set
    sync_ok_at = (p->>'sync_ok_at')::timestamptz, sync_ms = (p->>'sync_ms')::int,
    sync_stuck_count = coalesce((p->>'sync_stuck_count')::int, 0), arms_running = (p->>'arms_running')::int,
    arms_online = (p->>'arms_online')::int, arms_stopping = (p->>'arms_stopping')::int,
    rss_mb = (p->>'rss_mb')::int, reported_at = now()
  where id = 1;
end $function$;
revoke execute on function public.engine_status_report(json) from public, authenticated;
grant execute on function public.engine_status_report(json) to anon;

-- owner: engine health; "sync_age_s" over ~30 means the arms sync is not finishing
create or replace function public.owner_engine_status()
 returns json language sql stable security definer set search_path to 'public'
as $function$
  select case when public.is_super() then
    json_build_object('sync_ok_at', sync_ok_at, 'sync_age_s', round(extract(epoch from now() - sync_ok_at)),
      'sync_ms', sync_ms, 'sync_stuck_count', sync_stuck_count, 'arms_running', arms_running,
      'arms_online', arms_online, 'arms_stopping', arms_stopping, 'rss_mb', rss_mb,
      'reported_age_s', round(extract(epoch from now() - reported_at)))
  end from public.engine_status where id = 1
$function$;
revoke execute on function public.owner_engine_status() from public, anon;
grant execute on function public.owner_engine_status() to authenticated;
grant all on public.engine_status to service_role;
