-- BotiX v2: daily subscription alerts (07:07 UTC ≈ 10:07 Israel). Apply after 20261013_v2.sql.
select cron.unschedule('subscription-alerts') where exists (select 1 from cron.job where jobname = 'subscription-alerts');
select cron.schedule('subscription-alerts', '7 7 * * *', $$select public.subscription_alerts()$$);
