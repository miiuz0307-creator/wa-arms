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

-- the clean-up function itself: 20261012_retention_v2.sql (release 1.6)

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
