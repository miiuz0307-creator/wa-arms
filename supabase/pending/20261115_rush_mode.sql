-- 15 Nov: rush mode. Besides its Friday / מוצ"ש hours, 055-441-5398 also takes over סיירת בעל עגולה whenever
-- the station is busy: 7 or more rides in the last 10 minutes turns it on; it goes off by itself when fewer than
-- 4 rides came in the last 10 minutes (and it is outside its Friday / מוצ"ש hours). While on, only it posts
-- there (1.29), so the other arms are free for the other groups. Additive: one new function; the scheduled
-- function keeps its name and signature (the cron job of 1.30 keeps calling it).
create or replace function public.apply_arm_schedule(p_arm uuid, p_groups text[], p_now timestamptz default now())
 returns boolean language plpgsql security definer set search_path to 'public' as $$
declare st uuid; cur text[]; n int; on_now boolean;
begin
  select station_id, only_groups into st, cur from public.arms where id = p_arm;
  if st is null then return null; end if;
  select count(*) into n from public.campaigns
  where station_id = st and created_at > p_now - interval '10 minutes' and created_at <= p_now;
  on_now := public.arm_schedule_on(p_now)
         or n >= 7                                  -- rush starts
         or (cur = p_groups and n >= 4);            -- rush goes on until it calms down
  update public.arms set only_groups = case when on_now then p_groups else array['schedule-off'] end
  where id = p_arm and only_groups is distinct from (case when on_now then p_groups else array['schedule-off'] end);
  return on_now;
end $$;
revoke all on function public.apply_arm_schedule(uuid, text[], timestamptz) from public, anon, authenticated;

create or replace function public.apply_arm_schedules(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
begin
  perform public.apply_arm_schedule('90225f8c-8042-46a1-ae82-c14cc8b2ad90', array['972539236511-1567164800@g.us'], p_now);
end $$;
revoke all on function public.apply_arm_schedules(timestamptz) from public, anon, authenticated;
