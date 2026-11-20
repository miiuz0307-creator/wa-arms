-- 20 Nov: in rush hours every ride gets at most 3 minutes. The owner asked: an arm takes a ride, sends it and moves
-- on – the ride does not stay open waiting for busy arms. While the station is in rush (7+ rides in the last 10
-- minutes; it calms down below 4 – the same rule as 055-441-5398's rush mode), a ride that started sending more
-- than 3 minutes ago is closed: the arms stop taking it and its groups not sent yet are skipped
-- ("דולג – עומס"). In quiet hours nothing changes: every ride goes to all its groups.
-- Additive: one column (app_settings.rush), two functions, one condition in claim_target; the cron job of 1.30
-- (apply_arm_schedules, every minute) now also updates the rush flag and closes the slow rides.
alter table public.app_settings add column if not exists rush boolean not null default false;

-- rush flag per station (hysteresis: on at 7+ rides in 10 minutes, off below 4)
create or replace function public.update_rush(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.app_settings s set rush = x.on_now
  from (
    select s2.station_id,
           (select count(*) from public.campaigns c
            where c.station_id = s2.station_id and c.created_at > p_now - interval '10 minutes' and c.created_at <= p_now) as n,
           s2.rush as cur
    from public.app_settings s2
  ) y,
  lateral (select (y.n >= 7 or (y.cur and y.n >= 4)) as on_now) x
  where s.station_id = y.station_id and s.rush is distinct from x.on_now;
end $$;
revoke all on function public.update_rush(timestamptz) from public, anon, authenticated;

-- in rush: rides that started sending over 3 minutes ago are closed (the groups not sent yet are skipped)
create or replace function public.close_slow_rides(p_now timestamptz default now())
 returns int language plpgsql security definer set search_path to 'public' as $$
declare k int;
begin
  update public.campaign_targets t set status = 'skipped', error = 'דולג – עומס: הנסיעה קיבלה 3 דקות הפצה'
  from public.campaigns c join public.app_settings s on s.station_id = c.station_id
  where c.id = t.campaign_id and t.status = 'pending' and s.rush
    and c.status in ('queued', 'running') and c.kind <> 'manual'
    and c.started_at is not null and c.started_at < p_now - interval '3 minutes';
  get diagnostics k = row_count;
  return k;
end $$;
revoke all on function public.close_slow_rides(timestamptz) from public, anon, authenticated;

create or replace function public.apply_arm_schedules(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.update_rush(p_now);
  perform public.close_slow_rides(p_now);
  perform public.apply_arm_schedule('90225f8c-8042-46a1-ae82-c14cc8b2ad90', array['972539236511-1567164800@g.us'], p_now);
end $$;
revoke all on function public.apply_arm_schedules(timestamptz) from public, anon, authenticated;

create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid; c_owner uuid; c_old boolean; fill boolean;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  select * into s from public.app_settings where station_id = a.station_id;
  fill := coalesce(s.distribution_mode, 'fill') = 'fill';
  for c_id, c_owner, c_old in
    select c.id, c.owner_arm, coalesce(c.started_at, now()) < now() - interval '60 seconds'
    from public.campaigns c
    join public.campaign_arms ca on ca.campaign_id = c.id and ca.arm_id = p_arm
    where c.status in ('queued', 'running') and c.final_text is not null and c.station_id = a.station_id
      -- rush: a ride gets at most 3 minutes from its first message, then the arms move on to the next rides
      and not (coalesce(s.rush, false) and c.started_at is not null and c.started_at < now() - interval '3 minutes')
      and (fill or (select count(*) from public.campaign_targets x
                    where x.campaign_id = c.id and x.arm_id = p_arm and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60))
    order by
      -- 1) my own rides, 2) rides nobody has taken yet, 3) completing other arms' rides
      -- (a limited arm: simply oldest first – it sends its groups in every ride at once)
      case when cardinality(a.only_groups) > 0 then 1 when c.owner_arm = p_arm then 0 when c.owner_arm is null then 1 else 2 end,
      c.created_at
  loop
    select t.id into t_id
    from public.campaign_targets t
    join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
    where t.campaign_id = c_id and t.status = 'pending' and not (p_arm = any (t.tried_arms))
      -- an arm limited to some groups sends only there
      and (cardinality(a.only_groups) = 0 or t.wa_group_id = any (a.only_groups))
      -- a group reserved for a limited arm (it is in it, connected and can still send): the others leave it
      -- to that arm, until the ride is 60 seconds old
      and (cardinality(a.only_groups) > 0 or c_old or not exists (
        select 1
        from public.arms r
        join public.groups gr on gr.arm_id = r.id and gr.wa_group_id = t.wa_group_id
        join public.campaign_arms rca on rca.campaign_id = c_id and rca.arm_id = r.id
        where r.id <> p_arm and r.station_id = a.station_id and t.wa_group_id = any (r.only_groups)
          and r.is_active and r.status = 'online' and not (r.id = any (t.tried_arms))
          and (case when r.sent_day = current_date then r.sent_today else 0 end) < r.daily_limit))
      -- another arm's ride: leave it the groups it is in and can still send to (until the ride is 60 seconds old)
      -- (a limited arm does not wait for the owner)
      and (cardinality(a.only_groups) > 0 or c_owner is null or c_owner = p_arm or c_old or not exists (
        select 1
        from public.groups go
        join public.arms o on o.id = go.arm_id
        where go.wa_group_id = t.wa_group_id and o.id = c_owner
          and o.is_active and o.status = 'online' and not (o.id = any (t.tried_arms))
          and (cardinality(o.only_groups) = 0 or t.wa_group_id = any (o.only_groups))
          and (case when o.sent_day = current_date then o.sent_today else 0 end) < o.daily_limit))
    order by coalesce(array_position(s.priority_groups, t.wa_group_id), 1000000), t.id
    for update of t skip locked
    limit 1;
    exit when t_id is not null;
  end loop;
  if t_id is null then return; end if;
  update public.campaign_targets set status = 'sending', arm_id = p_arm, attempts = attempts + 1, claimed_at = now()
  where id = t_id;
  update public.campaigns set last_claim_at = clock_timestamp(),
    status = case when status = 'queued' then 'running' else status end,
    started_at = coalesce(started_at, now()),
    -- a limited arm never becomes a ride's owner (it only posts its groups)
    owner_arm = case when cardinality(a.only_groups) > 0 then owner_arm else coalesce(owner_arm, p_arm) end
  where id = c_id;
  return query select t.id, t.campaign_id, t.wa_group_id, c.final_text
  from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id where t.id = t_id;
end $function$;

select public.update_rush();
