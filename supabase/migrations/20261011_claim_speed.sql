-- Load test (100 stations): taking the next group cost ~9-25 ms because the "who is working on which ride"
-- checks ran once per candidate group instead of once per ride. Same order and rules, decided per ride first.
create index if not exists campaign_arms_arm_idx on public.campaign_arms (arm_id, campaign_id);
create index if not exists campaign_targets_campaign_arm_idx on public.campaign_targets (campaign_id, arm_id);

create or replace function public.claim_target(p_arm uuid)
 returns table(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 language plpgsql security definer set search_path to 'public'
as $function$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid; fill boolean;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  select * into s from public.app_settings where station_id = a.station_id;
  fill := coalesce(s.distribution_mode, 'fill') = 'fill';

  -- "ladder": an arm keeps working on its own ride; a ride nobody else is working on comes next;
  -- only when every open ride already has an arm on it does this arm help with one of them.
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
    select t.id into t_id
    from public.campaign_targets t
    join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
    where t.campaign_id = c_id and t.status = 'pending' and not (p_arm = any (t.tried_arms))
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
revoke execute on function public.claim_target(uuid) from public, anon, authenticated;
