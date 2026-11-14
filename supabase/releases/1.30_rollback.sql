-- rollback 1.30: stop the schedule; 055-441-5398 stays on סיירת בעל עגולה all the time (as in 1.29)
select cron.unschedule('arm-schedules') where exists (select 1 from cron.job where jobname = 'arm-schedules');
update public.arms set only_groups = array['972539236511-1567164800@g.us'] where id = '90225f8c-8042-46a1-ae82-c14cc8b2ad90';
