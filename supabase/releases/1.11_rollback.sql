-- rollback of 1.11: person codes stop working and their sessions end; station codes work as before.
-- The people list (station_members) is kept – nothing is removed.
create or replace function public.member_login(p_code text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('error', 'כניסה עם קוד אישי לא זמינה כרגע')
$$;
create or replace function public.station_from_token()
 returns uuid language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare tok text := public.req_header('x-station-token'); sid uuid;
begin
  if tok is null then return null; end if;
  select s.station_id into sid
  from public.station_sessions s join public.stations st on st.id = s.station_id
  where s.token_hash = encode(extensions.digest(tok, 'sha256'), 'hex')
    and s.revoked_at is null
    and st.status = 'active'
    and (st.sub_end is null or st.sub_end >= current_date)
    and not st.is_home
    and s.member_id is null;
  return sid;
end $function$;
