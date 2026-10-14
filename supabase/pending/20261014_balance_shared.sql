-- Even sharing of groups that several arms are in (14 Oct).
-- Before: a group that several arms of the station are in went to whichever arm grabbed it first,
-- so busy arms (in many groups) also took most shared groups: 23k vs 7.6k messages a day.
-- Now: for the first 45 seconds of a ride, an arm skips a shared group when another connected arm
-- in that group (same ride, not yet tried there, under its daily limit) has sent at least 1,000 fewer
-- messages today. That arm sends it instead. After 45 seconds anyone takes it, so no ride waits.
-- Groups only one arm is in are not affected. Speed setting unchanged.
create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql
 security definer
 set search_path to 'public'
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
    order by t.id
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
