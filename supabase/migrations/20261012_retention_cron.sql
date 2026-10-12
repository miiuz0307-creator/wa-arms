-- Run the storage clean-up every hour at :17 (small batches; see 20261012_retention.sql).
select cron.schedule('retention', '17 * * * *', 'select public.retention_run()');
-- cron's own run history grows by ~1,500 rows a day: keep 7 days (once a day at 03:47 UTC).
select cron.schedule('cron-history-trim', '47 3 * * *', $$delete from cron.job_run_details where end_time < now() - interval '7 days'$$);
