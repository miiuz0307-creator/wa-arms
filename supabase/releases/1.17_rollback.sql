-- rollback of 1.17: notices stop (no arm watch, no phone notifications); tables and history are kept
select cron.unschedule('watch-arms');
alter table public.notifications disable trigger notifications_push;
CREATE OR REPLACE FUNCTION public.owner_message_send(p_title text, p_body text, p_level text DEFAULT 'info'::text, p_station uuid DEFAULT NULL::uuid, p_days integer DEFAULT 7)
 RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare mid bigint;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if coalesce(trim(p_title), '') = '' then raise exception 'חסרה כותרת'; end if;
  insert into public.system_messages (title, body, level, station_id, ends_at)
  values (trim(p_title), nullif(trim(p_body), ''), coalesce(nullif(p_level, ''), 'info'), p_station,
          case when p_days is null or p_days <= 0 then null else now() + make_interval(days => p_days) end)
  returning id into mid;
  return mid;
end $function$;
