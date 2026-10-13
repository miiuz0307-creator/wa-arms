-- Undo of 20261013_v2.sql: removes ONLY the objects that release added (its functions, its tables and its
-- columns). Existing data, WhatsApp connections, groups, lists, payments and messages are not touched.
-- Note: the new tables' own rows (group flags, payment requests, support tickets, alert log) and the new
-- columns (station logo / plan, payment links) are removed with them.
select set_config('lock_timeout', '5s', true);
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'subscription-alerts';
  end if;
end $$;

drop function if exists public.owner_footers();
drop function if exists public.owner_footer_set(uuid[], text, boolean);
drop function if exists public.station_footer();
drop function if exists public.engine_station_footer(uuid);
drop table if exists public.message_footers;
drop function if exists public.station_set_logo(uuid, text);
drop function if exists public.station_brand();
drop function if exists public.owner_station_logos();
drop function if exists public.group_flag_set(text[], boolean, boolean, text);
drop function if exists public.engine_group_flags(uuid);
drop function if exists public.group_problems(integer);
drop function if exists public.owner_pay_settings_get();
drop function if exists public.owner_pay_settings_save(text, text, text, text, text);
drop function if exists public.station_active(uuid);
drop function if exists public.engine_station_active(uuid);
drop function if exists public.station_billing();
drop function if exists public.station_payment_submit(numeric, integer, text, text, text);
drop function if exists public.station_payment_cancel(bigint);
drop function if exists public.owner_payment_requests(text);
drop function if exists public.owner_payment_request_get(bigint, uuid);
drop function if exists public.owner_payment_decide(bigint, boolean, text);
drop function if exists public.subscription_alerts();
drop function if exists public.billing_station();
drop function if exists public.pay_method_label(text);
drop function if exists public.support_ticket_create(text, text, text, uuid, text);
drop function if exists public.support_reply(bigint, text, text);
drop function if exists public.support_tickets(text);
drop function if exists public.support_ticket_get(bigint);
drop function if exists public.support_ticket_status(bigint, text);
drop function if exists public.support_category_label(text);
drop function if exists public.support_check_image(text);

drop table if exists public.support_messages;
drop table if exists public.support_tickets;
drop table if exists public.sub_alerts;
drop table if exists public.payment_requests;
drop table if exists public.group_flags;

alter table public.owner_settings drop column if exists app_url;
alter table public.owner_settings drop column if exists support_phone;
alter table public.owner_settings drop column if exists approvals_phone;
alter table public.owner_settings drop column if exists paybox_link;
alter table public.owner_settings drop column if exists bit_link;
alter table public.stations drop column if exists plan;
alter table public.stations drop column if exists logo_data;
