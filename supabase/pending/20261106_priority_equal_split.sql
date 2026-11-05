-- 5 Nov (2): the priority groups (סיירת VIP, סיירת בעל עגולה) are split EQUALLY per day between the
-- arms that are in them: e.g. 500 rides a day -> 250 from each. Each ride, during its first 10 seconds,
-- the group goes only to the arm that sent the fewest rides to it today (ties: a different arm per ride);
-- after 10 seconds any free arm takes it, so the priority groups still get every ride first.
-- One index for that count (sent rides per group). claim_target keeps its signature. Additive.
create index if not exists campaign_targets_group_sent_idx on public.campaign_targets (wa_group_id, arm_id, sent_at) where status = 'sent';

create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid; fill boolean; v_mine int; c_young boolean; c_pyoung boolean; v_day timestamptz;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  v_mine := case when a.sent_day = current_date then a.sent_today else 0 end;
  select * into s from public.app_settings where station_id = a.station_id;
  fill := coalesce(s.distribution_mode, 'fill') = 'fill';
  -- start of today in Israel (the per-day equal split of the priority groups)
  v_day := date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
  for c_id in
    select c.id
    from public.campaigns c
    join public.campaign_arms ca on ca.campaign_id = c.id and ca.arm_id = p_arm
    where c.status in ('queued', 'running') and c.final_text is not null and c.station_id = a.station_id
      and (fill or (select count(*) from public.campaign_targets x
                    where x.campaign_id = c.id and x.arm_id = p_arm and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60))
    order by
      (exists (select 1 from public.campaign_targets m where m.campaign_id = c.id and m.arm_id = p_arm
               and coalesce(m.sent_at, m.claimed_at) > now() - interval '20 seconds')) desc,
      (exists (select 1 from public.campaign_targets o where o.campaign_id = c.id and o.arm_id <> p_arm
               and coalesce(o.sent_at, o.claimed_at) > now() - interval '20 seconds')) asc,
      c.created_at
  loop
    select coalesce(c.started_at, now()) > now() - interval '45 seconds', coalesce(c.started_at, now()) > now() - interval '10 seconds'
      into c_young, c_pyoung from public.campaigns c where c.id = c_id;
    select t.id into t_id
    from public.campaign_targets t
    join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
    where t.campaign_id = c_id and t.status = 'pending' and not (p_arm = any (t.tried_arms))
      and (v_mine < 1000 or not c_young or not exists (
        select 1
        from public.groups g2
        join public.arms b on b.id = g2.arm_id
        join public.campaign_arms cb on cb.campaign_id = c_id and cb.arm_id = b.id
        where g2.wa_group_id = t.wa_group_id and b.id <> p_arm and b.station_id = a.station_id
          and b.is_active and b.status = 'online' and not (b.id = any (t.tried_arms))
          and (case when b.sent_day = current_date then b.sent_today else 0 end) <= v_mine - 1000
          and (case when b.sent_day = current_date then b.sent_today else 0 end) < b.daily_limit))
      -- priority groups: split equally per day – during the ride's first 10 seconds only the arm that sent
      -- the fewest rides to this group today takes it (then any arm, so the group still gets the ride first)
      and (not (t.wa_group_id = any (coalesce(s.priority_groups, '{}'))) or not c_pyoung or p_arm = (
        select b.id
        from public.groups g5
        join public.arms b on b.id = g5.arm_id
        join public.campaign_arms cb on cb.campaign_id = c_id and cb.arm_id = b.id
        where g5.wa_group_id = t.wa_group_id and b.station_id = a.station_id
          and b.is_active and b.status = 'online' and not (b.id = any (t.tried_arms))
          and (case when b.sent_day = current_date then b.sent_today else 0 end) < b.daily_limit
        order by (select count(*) from public.campaign_targets x
                  where x.wa_group_id = t.wa_group_id and x.arm_id = b.id and x.status = 'sent' and x.sent_at >= v_day),
                 md5(c_id::text || t.wa_group_id || b.id::text)
        limit 1))
      -- turn: in any other shared group, during the first 45 seconds only this ride's turn arm takes it
      and (not c_young or t.wa_group_id = any (coalesce(s.priority_groups, '{}')) or p_arm = (
        select b.id
        from public.groups g3
        join public.arms b on b.id = g3.arm_id
        join public.campaign_arms cb on cb.campaign_id = c_id and cb.arm_id = b.id
        where g3.wa_group_id = t.wa_group_id and b.station_id = a.station_id
          and b.is_active and b.status = 'online' and not (b.id = any (t.tried_arms))
          and (case when b.sent_day = current_date then b.sent_today else 0 end) < b.daily_limit
          -- an arm 1,000+ sends busier than the least busy one leaves the group to the others (rule above)
          and (case when b.sent_day = current_date then b.sent_today else 0 end) < 1000 + (
            select min(case when b2.sent_day = current_date then b2.sent_today else 0 end)
            from public.groups g4
            join public.arms b2 on b2.id = g4.arm_id
            join public.campaign_arms cb2 on cb2.campaign_id = c_id and cb2.arm_id = b2.id
            where g4.wa_group_id = t.wa_group_id and b2.station_id = a.station_id
              and b2.is_active and b2.status = 'online' and not (b2.id = any (t.tried_arms))
              and (case when b2.sent_day = current_date then b2.sent_today else 0 end) < b2.daily_limit)
        order by md5(c_id::text || t.wa_group_id || b.id::text)
        limit 1))
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
    started_at = coalesce(started_at, now())
  where id = c_id;
  return query select t.id, t.campaign_id, t.wa_group_id, c.final_text
  from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id where t.id = t_id;
end $function$;
