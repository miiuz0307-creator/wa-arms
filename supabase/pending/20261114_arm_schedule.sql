-- 14 Nov: 055-441-5398 ("סיירת VIP 5398") posts in סיירת בעל עגולה only on Friday 12:00–17:00 and
-- מוצאי שבת 17:00 – Sunday 03:00 (Israel time). Outside those hours it stays connected (still answers "עזרה")
-- but sends nothing, and the other arms send to סיירת בעל עגולה as before. Done by switching its only_groups
-- between that group and a placeholder that matches no group. Additive: one function (+ a cron job, separate file).
create or replace function public.arm_schedule_on(p_now timestamptz default now())
 returns boolean language sql stable as $$
  select case extract(isodow from (p_now at time zone 'Asia/Jerusalem'))::int
    when 5 then (p_now at time zone 'Asia/Jerusalem')::time >= '12:00' and (p_now at time zone 'Asia/Jerusalem')::time < '17:00'
    when 6 then (p_now at time zone 'Asia/Jerusalem')::time >= '17:00'
    when 7 then (p_now at time zone 'Asia/Jerusalem')::time < '03:00'
    else false end
$$;

create or replace function public.apply_arm_schedules(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
declare want text[];
begin
  want := case when public.arm_schedule_on(p_now) then array['972539236511-1567164800@g.us'] else array['schedule-off'] end;
  update public.arms set only_groups = want
  where id = '90225f8c-8042-46a1-ae82-c14cc8b2ad90' and only_groups is distinct from want;
end $$;
revoke all on function public.apply_arm_schedules(timestamptz) from public, anon, authenticated;

select public.apply_arm_schedules();
