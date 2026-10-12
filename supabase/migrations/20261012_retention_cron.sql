-- Release 1.6: run the storage clean-up every hour at :17, at most 120 seconds (see 20261012_retention_v2.sql).
select cron.schedule('retention', '17 * * * *', $c$set statement_timeout = '120s'; select public.retention_run()$c$);
-- cron's own run history grows by ~1,500 rows a day: keep 7 days (once a day at 03:47 UTC).
-- This is pg_cron's log of its own runs (cron.job_run_details), not data of the system.
select cron.schedule('cron-history-trim', '47 3 * * *', $c$delete from cron.job_run_details where end_time < now() - interval '7 days'$c$);
