-- rollback 1.31: back to the 1.30 schedule only (no rush mode); apply_arm_schedule stays, unused
create or replace function public.apply_arm_schedules(p_now timestamptz default now())
 returns void language plpgsql security definer set search_path to 'public' as $$
declare want text[];
begin
  want := case when public.arm_schedule_on(p_now) then array['972539236511-1567164800@g.us'] else array['schedule-off'] end;
  update public.arms set only_groups = want
  where id = '90225f8c-8042-46a1-ae82-c14cc8b2ad90' and only_groups is distinct from want;
end $$;
revoke all on function public.apply_arm_schedules(timestamptz) from public, anon, authenticated;

