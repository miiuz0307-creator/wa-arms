-- Undo of 20261013_v2b_expired.sql: back to the live behaviour (expired → arms stop, login refused).
select set_config('lock_timeout', '5s', true);
create or replace function public.engine_station_states()
 returns table(id uuid, allowed boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return query select s.id, (s.is_home or (s.status = 'active' and (s.sub_end is null or s.sub_end >= current_date))) from public.stations s;
end $function$;
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
