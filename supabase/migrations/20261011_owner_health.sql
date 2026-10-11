-- Monitoring for the system owner: every station's disconnected numbers, failed sends in the last hour,
-- and whether the engine is alive (heartbeat every 30s). Owner only.
create or replace function public.owner_health()
 returns table(station_id uuid, station_name text, arm_id uuid, arm_name text, arm_status text, arm_error text,
               failed_hour int, engine_seen timestamptz)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  with eng as (select max(last_seen_at) seen from public.arms where is_active and status = 'online'),
  fails as (select t.station_id, count(*)::int n from public.campaign_targets t
            where t.status = 'failed' and t.claimed_at > now() - interval '1 hour' group by 1)
  select s.id, s.name, a.id, a.name, a.status, a.last_error, coalesce(f.n, 0), (select seen from eng)
  from public.stations s
  left join public.arms a on a.station_id = s.id and a.is_active and a.status <> 'online'
  left join fails f on f.station_id = s.id
  where s.status = 'active' and (a.id is not null or coalesce(f.n, 0) > 0)
  union all
  select null, null, null, null, null, null, 0, (select seen from eng)
  order by 2 nulls first;
end $function$;
revoke execute on function public.owner_health() from public, anon;
grant execute on function public.owner_health() to authenticated;
