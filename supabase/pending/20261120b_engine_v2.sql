-- 20 Nov: distribution engine v2 – "one arm per ride, follow-up at once" (owner's option 1, improved).
--   * A new ride gets ONE handler: the free arm that can send the most of its groups within ~3 minutes
--     (its groups in the ride × its real speed). The handler sends all its groups of the ride and takes no other
--     ride until it is done (its own ride always comes first).
--   * The groups the handler is not in are a follow-up task: a free arm that is in them sends them at once,
--     without waiting for the handler to finish (disjoint groups – no group is ever sent twice).
--   * Free arms take new rides before follow-ups, but a follow-up that waits 60 seconds longer than a new ride
--     goes first (no task starves).
--   * A ride that started over 4 minutes ago is late: free arms then help with the handler's groups too, so it
--     is not cut by the 15-minute rule while arms stand idle.
--   * If the handler disconnects / stops / reaches its limit, the next free arm becomes the handler and sends only
--     what was not sent. A send with an unknown result is never retried (finalize marks it, as before).
--   * Fast start: every ride goes FIRST to the station's priority groups and its "fast start" groups (by default
--     the 10 biggest groups; the owner can change them). Any free or busy arm sends these single messages before
--     going on, oldest ride first – so even in rush every ride starts within seconds (a short break of a few
--     messages for the rides already in progress).
--   * Unchanged: the 15-minute rule and its report reason, stations / lists separation, priority groups first,
--     the limited arm (055-441-5398) and its reserved group, groups only admins may write to.
-- Additive: two columns (campaigns.handler_arm, arms.rate_per_min), two functions, claim_target keeps its
-- signature; the minute job (apply_arm_schedules) also refreshes each arm's measured speed.
alter table public.campaigns add column if not exists handler_arm uuid;
alter table public.arms add column if not exists rate_per_min numeric;
alter table public.app_settings add column if not exists fast_start_groups text[] not null default '{}';
-- default fast-start groups: each station's 10 biggest groups (no-op in the test DB groups without participants)
update public.app_settings s set fast_start_groups = x.gs
from (
  select station_id, array_agg(wa_group_id order by p desc) gs
  from (select g.station_id, g.wa_group_id, max(g.participants) p,
               row_number() over (partition by g.station_id order by max(g.participants) desc nulls last) rn
        from public.groups g join public.arms a on a.id = g.arm_id and cardinality(a.only_groups) = 0
        where g.participants is not null
        group by g.station_id, g.wa_group_id) z
  where rn <= 10 group by station_id
) x
where s.station_id = x.station_id and cardinality(s.fast_start_groups) = 0;
create index if not exists campaign_targets_arm_sent_idx on public.campaign_targets (arm_id, sent_at) where status = 'sent';

-- can arm p_arm still send something in ride p_c (connected, active, under its limit, a pending group it is in)?
create or replace function public.arm_can_send_in(p_c uuid, p_arm uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $$
  select exists (
    select 1
    from public.arms a
    join public.campaign_targets t on t.campaign_id = p_c and t.status = 'pending' and not (a.id = any (t.tried_arms))
    join public.groups g on g.arm_id = a.id and g.wa_group_id = t.wa_group_id
    where a.id = p_arm and a.is_active and a.status = 'online'
      and (case when a.sent_day = current_date then a.sent_today else 0 end) < a.daily_limit
      and (cardinality(a.only_groups) = 0 or t.wa_group_id = any (a.only_groups)))
$$;

-- each arm's real speed: messages it sent in its busy minutes of the last 10 minutes (refreshed every minute)
create or replace function public.update_arm_rates(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  update public.arms a set rate_per_min = x.r
  from (
    select arm_id, round(avg(n), 1) r
    from (select arm_id, date_trunc('minute', sent_at) m, count(*) n
          from public.campaign_targets
          where status = 'sent' and sent_at > p_now - interval '10 minutes' and sent_at <= p_now and arm_id is not null
          group by 1, 2) z
    group by arm_id
  ) x
  where a.id = x.arm_id and a.rate_per_min is distinct from x.r;
end $$;
revoke all on function public.update_arm_rates(timestamptz) from public, anon, authenticated;

create or replace function public.apply_arm_schedules(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.update_arm_rates(p_now);
  perform public.apply_arm_schedule('90225f8c-8042-46a1-ae82-c14cc8b2ad90', array['972539236511-1567164800@g.us'], p_now);
end $$;
revoke all on function public.apply_arm_schedules(timestamptz) from public, anon, authenticated;

create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare
  s public.app_settings; a public.arms; t_id bigint; c_id uuid; c_kind int; c_handler uuid; c_late boolean;
  c_reserved_ok boolean; fill boolean; limited boolean; mine int; locked uuid;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  select * into s from public.app_settings where station_id = a.station_id;
  fill := coalesce(s.distribution_mode, 'fill') = 'fill';
  limited := cardinality(a.only_groups) > 0;

  -- fast start: the priority / fast-start groups of every ride first (oldest ride first), by any arm in them
  if not limited and cardinality(coalesce(s.fast_start_groups, '{}') || coalesce(s.priority_groups, '{}')) > 0 then
    select t.id, t.campaign_id into t_id, c_id
    from public.campaign_targets t
    join public.campaigns c on c.id = t.campaign_id
    join public.campaign_arms ca on ca.campaign_id = c.id and ca.arm_id = p_arm
    join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
    where c.status in ('queued', 'running') and c.final_text is not null and c.station_id = a.station_id
      and t.status = 'pending' and not (p_arm = any (t.tried_arms))
      and t.wa_group_id = any (coalesce(s.fast_start_groups, '{}') || coalesce(s.priority_groups, '{}'))
      and (coalesce(c.started_at, now()) < now() - interval '60 seconds' or not exists (
        select 1 from public.arms r
        join public.groups gr on gr.arm_id = r.id and gr.wa_group_id = t.wa_group_id
        join public.campaign_arms rca on rca.campaign_id = c.id and rca.arm_id = r.id
        where r.id <> p_arm and r.station_id = a.station_id and t.wa_group_id = any (r.only_groups)
          and r.is_active and r.status = 'online' and not (r.id = any (t.tried_arms))
          and (case when r.sent_day = current_date then r.sent_today else 0 end) < r.daily_limit))
    order by c.created_at, coalesce(array_position(s.priority_groups, t.wa_group_id), 1000000), t.id
    for update of t skip locked
    limit 1;
  end if;

  if t_id is null then

  for c_id, c_kind, c_handler, c_late, c_reserved_ok in
    select c.id,
      -- 0 = my ride (I am its handler), 1 = needs a handler, 2 = follow-up (another arm handles it)
      case when limited then 2
           when c.handler_arm = p_arm then 0
           when c.handler_arm is null or not public.arm_can_send_in(c.id, c.handler_arm) then 1
           else 2 end,
      c.handler_arm,
      coalesce(c.started_at, now()) < now() - interval '4 minutes',
      coalesce(c.started_at, now()) < now() - interval '60 seconds'
    from public.campaigns c
    join public.campaign_arms ca on ca.campaign_id = c.id and ca.arm_id = p_arm
    where c.status in ('queued', 'running') and c.final_text is not null and c.station_id = a.station_id
      and (fill or (select count(*) from public.campaign_targets x
                    where x.campaign_id = c.id and x.arm_id = p_arm and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60))
    order by
      case when not limited and c.handler_arm = p_arm then 0 else 1 end,   -- my own ride first, always
      -- then new rides before follow-ups, with aging: a follow-up 60 s older than a new ride goes first
      c.created_at - case when not limited and (c.handler_arm is null or not public.arm_can_send_in(c.id, c.handler_arm))
                          then interval '60 seconds' else interval '0' end,
      c.id
  loop
    -- a new ride: leave it for a moment to a free arm that would do clearly more of it (its groups × its speed)
    if c_kind = 1 then
      select count(*) into mine
      from public.campaign_targets t join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
      where t.campaign_id = c_id and t.status = 'pending' and not (p_arm = any (t.tried_arms));
      continue when mine = 0;
      continue when exists (
        select 1
        from public.campaigns c2 where c2.id = c_id and c2.created_at > now() - interval '3 seconds'
          and exists (
            select 1 from public.arms b
            join public.campaign_arms cb on cb.campaign_id = c_id and cb.arm_id = b.id
            where b.id <> p_arm and b.station_id = a.station_id and b.is_active and b.status = 'online'
              and cardinality(b.only_groups) = 0
              and (case when b.sent_day = current_date then b.sent_today else 0 end) < b.daily_limit
              -- b is free: it handles no ride where it can still send
              and not exists (select 1 from public.campaigns hb
                              where hb.handler_arm = b.id and hb.status in ('queued', 'running') and hb.station_id = a.station_id
                                and public.arm_can_send_in(hb.id, b.id))
              and least((select count(*) from public.campaign_targets t join public.groups g on g.arm_id = b.id and g.wa_group_id = t.wa_group_id
                         where t.campaign_id = c_id and t.status = 'pending' and not (b.id = any (t.tried_arms))),
                        coalesce(b.rate_per_min, 60) * 3)
                > least(mine, coalesce(a.rate_per_min, 60) * 3) * 1.2));
      -- take the ride (one arm only): lock it, check again that it still needs a handler
      select c3.id into locked from public.campaigns c3 where c3.id = c_id for update skip locked;
      continue when locked is null;
      continue when exists (select 1 from public.campaigns c4 where c4.id = c_id and c4.handler_arm is not null
                            and c4.handler_arm <> p_arm and public.arm_can_send_in(c_id, c4.handler_arm));
      update public.campaigns set handler_arm = p_arm where id = c_id;
      c_handler := p_arm;
    end if;

    select t.id into t_id
    from public.campaign_targets t
    join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
    where t.campaign_id = c_id and t.status = 'pending' and not (p_arm = any (t.tried_arms))
      -- an arm limited to some groups sends only there
      and (not limited or t.wa_group_id = any (a.only_groups))
      -- a group reserved for a limited arm (it is in it, connected and can still send): the others leave it
      -- to that arm, until the ride is 60 seconds old
      and (limited or c_reserved_ok or not exists (
        select 1
        from public.arms r
        join public.groups gr on gr.arm_id = r.id and gr.wa_group_id = t.wa_group_id
        join public.campaign_arms rca on rca.campaign_id = c_id and rca.arm_id = r.id
        where r.id <> p_arm and r.station_id = a.station_id and t.wa_group_id = any (r.only_groups)
          and r.is_active and r.status = 'online' and not (r.id = any (t.tried_arms))
          and (case when r.sent_day = current_date then r.sent_today else 0 end) < r.daily_limit))
      -- follow-up: only the groups the handler is not in (they are its job) – unless the ride is late
      and (c_kind <> 2 or limited or c_late or c_handler is null or not exists (
        select 1 from public.groups gh where gh.arm_id = c_handler and gh.wa_group_id = t.wa_group_id))
    order by coalesce(array_position(s.priority_groups, t.wa_group_id), 1000000), t.id
    for update of t skip locked
    limit 1;
    exit when t_id is not null;
  end loop;
  end if;
  if t_id is null then return; end if;
  update public.campaign_targets set status = 'sending', arm_id = p_arm, attempts = attempts + 1, claimed_at = now()
  where id = t_id;
  update public.campaigns set last_claim_at = clock_timestamp(),
    status = case when status = 'queued' then 'running' else status end,
    started_at = coalesce(started_at, now()),
    owner_arm = case when limited then owner_arm else coalesce(owner_arm, p_arm) end
  where id = c_id;
  return query select t.id, t.campaign_id, t.wa_group_id, c.final_text
  from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id where t.id = t_id;
end $function$;
