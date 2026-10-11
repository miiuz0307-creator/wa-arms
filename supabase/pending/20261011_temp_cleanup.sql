-- Temporary working data is removed once it is no longer needed (history is NOT touched):
--  processed_messages: duplicate guard for incoming WhatsApp messages – only messages from the last
--    10 minutes are ever acted on, so rows older than 3 days serve no purpose;
--  arm_commands: finished button presses (connect / new QR / refresh) older than 7 days.
-- Distributions, groups, lists, activity log and WhatsApp login data are never deleted here.
create or replace function public.engine_cleanup()
 returns json language plpgsql security definer set search_path to 'public'
as $function$
declare a int; b int;
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  delete from public.processed_messages where processed_at < now() - interval '3 days';
  get diagnostics a = row_count;
  delete from public.arm_commands where status <> 'pending' and created_at < now() - interval '7 days';
  get diagnostics b = row_count;
  return json_build_object('processed_messages', a, 'arm_commands', b);
end $function$;
revoke execute on function public.engine_cleanup() from public, authenticated;
grant execute on function public.engine_cleanup() to anon;
create index if not exists processed_messages_time_idx on public.processed_messages (processed_at);
