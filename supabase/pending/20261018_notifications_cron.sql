-- pg_cron: watch the arms every minute (part of release with 20261018_notifications.sql; not run in the test DB)
select cron.schedule('watch-arms', '* * * * *', 'select public.watch_arms()');
