-- 5 Nov: a group that several connected arms are in gets each ride from a different arm in turn
-- (the owner: "Ariel should send there too, not only Yechiel"). Until now the arm that reached the
-- group first always sent there. Now, during the first 45 seconds of a ride, each shared group has a
-- "turn" arm per ride (rendezvous hash of ride + group + arm, so it changes from ride to ride and
-- splits about evenly); only that arm takes it. After 45 seconds any arm may take it, so no ride waits.
-- Also: priority groups (app_settings.priority_groups, in order) – every ride goes to them first
-- (the owner: first סיירת VIP, then סיירת בעל עגולה, then the rest).
-- claim_target keeps its signature. Additive: one new column.
alter table public.app_settings add column if not exists priority_groups text[] not null default '{}';

create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid; fill boolean; v_mine int; c_young boolean;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  v_mine := case when a.sent_day = current_date then a.sent_today else 0 end;
  select * into s from public.app_settings where station_id = a.station_id;
  fill := coalesce(s.distribution_mode, 'fill') = 'fill';
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
    select coalesce(c.started_at, now()) > now() - interval '45 seconds' into c_young from public.campaigns c where c.id = c_id;
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
      -- turn: in a shared group, during the first 45 seconds only this ride's turn arm takes it
      -- (priority groups are exempt: they go to the first free arm at once, so they really come first)
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

-- the owner's priority groups for his station (8080*): סיירת VIP first, then סיירת בעל עגולה
update public.app_settings set priority_groups = array['120363420060606873@g.us', '972539236511-1567164800@g.us']
where station_id = 'b6b4d2f9-30fa-475a-86e2-de26002504de';
