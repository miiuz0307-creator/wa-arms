-- every minute: switch 055-441-5398 on/off by its schedule
select cron.schedule('arm-schedules', '* * * * *', $$select public.apply_arm_schedules()$$);
