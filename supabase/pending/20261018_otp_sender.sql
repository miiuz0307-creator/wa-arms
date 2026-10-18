-- 18 Oct: the number that sends WhatsApp login codes (the owner chose 053-230-6885). The engine sends from the
-- arm with this number when it is connected, otherwise from a connected arm of the home system.
alter table public.owner_settings add column if not exists otp_sender_phone text;
update public.owner_settings set otp_sender_phone = '0532306885' where id = 1 and otp_sender_phone is null;
create or replace function public.engine_otp_sender() returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return (select otp_sender_phone from public.owner_settings where id = 1);
end $$;
revoke all on function public.engine_otp_sender() from public, authenticated;
grant execute on function public.engine_otp_sender() to anon;
