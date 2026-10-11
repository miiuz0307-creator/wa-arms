-- ח4: station code login – limit by the edge address (not the forgeable x-forwarded-for),
-- a system-wide brake against guessing from many addresses, and logins unused for 30 days expire.
create or replace function public.station_login(p_code text)
 returns json language plpgsql security definer set search_path to 'public', 'extensions'
as $function$
declare st public.stations; tok text; v_ip text; fails int; all_fails int;
begin
  v_ip := coalesce(public.req_header('cf-connecting-ip'), public.req_header('x-real-ip'),
                   split_part(coalesce(public.req_header('x-forwarded-for'), '?'), ',', 1));
  select count(*) into fails from public.station_login_attempts a
  where a.ip = v_ip and not a.ok and a.created_at > now() - interval '15 minutes';
  if fails >= 10 then return json_build_object('error', 'יותר מדי ניסיונות שגויים. נסה שוב בעוד רבע שעה.'); end if;
  select count(*) into all_fails from public.station_login_attempts a
  where not a.ok and a.created_at > now() - interval '10 minutes';
  if all_fails >= 60 then return json_build_object('error', 'יותר מדי ניסיונות שגויים במערכת. נסה שוב בעוד כמה דקות.'); end if;

  select * into st from public.stations
  where code_hash = encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 'sha256'), 'hex')
    and not is_home;
  if st.id is null then
    insert into public.station_login_attempts (ip, ok) values (v_ip, false);
    delete from public.station_login_attempts where created_at < now() - interval '7 days';
    perform pg_sleep(1);
    return json_build_object('error', 'קוד שגוי');
  end if;
  if st.status <> 'active' then return json_build_object('error', 'הגישה לתחנה מושעית. פנה למנהל המערכת.'); end if;
  if st.sub_end is not null and st.sub_end < current_date then
    return json_build_object('error', 'המנוי של התחנה הסתיים. פנה למנהל המערכת לחידוש.');
  end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.station_sessions (token_hash, station_id) values (encode(extensions.digest(tok, 'sha256'), 'hex'), st.id);
  insert into public.station_login_attempts (ip, ok) values (v_ip, true);
  return json_build_object('token', tok, 'station', st.name);
end $function$;

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
    and s.last_seen > now() - interval '30 days'
    and st.status = 'active'
    and (st.sub_end is null or st.sub_end >= current_date)
    and not st.is_home;
  return sid;
end $function$;
