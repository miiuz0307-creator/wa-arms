-- Login with the station manager's phone: a one-time code is sent on WhatsApp by one of the system's own
-- numbers (the home station's arms). Code: 6 digits, valid 5 minutes, 5 tries; requests are rate-limited.

create table if not exists public.login_otps (
  id bigint generated always as identity primary key,
  phone text not null,
  station_id uuid references public.stations(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists login_otps_phone_idx on public.login_otps (phone, created_at desc);
alter table public.login_otps enable row level security;
revoke all on public.login_otps from anon, authenticated;

-- messages the system sends on WhatsApp to a private number (login codes); sent by the engine
create table if not exists public.wa_outbox (
  id bigint generated always as identity primary key,
  to_phone text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed')),
  error text,
  arm_id uuid,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists wa_outbox_pending_idx on public.wa_outbox (status, created_at);
alter table public.wa_outbox enable row level security;
revoke all on public.wa_outbox from anon, authenticated;

-- 050-123-4567 / +972 50 123 4567 / 972501234567 → 972501234567
create or replace function public.norm_phone(p text)
 returns text language sql immutable set search_path to 'public'
as $function$
  select case
    when d is null or d = '' then null
    when d like '972%' then d
    when d like '0%' then '972' || substr(d, 2)
    else d end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) x
$function$;

create or replace function public.otp_request(p_phone text)
 returns json language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $function$
declare ph text := public.norm_phone(p_phone); v_ip text; st public.stations; code text; recent int; ip_recent int;
begin
  v_ip := coalesce(public.req_header('cf-connecting-ip'), public.req_header('x-real-ip'),
                   split_part(coalesce(public.req_header('x-forwarded-for'), '?'), ',', 1));
  if ph is null or length(ph) < 11 then return json_build_object('error', 'מספר טלפון לא תקין'); end if;
  select count(*) into recent from public.login_otps where phone = ph and created_at > now() - interval '10 minutes';
  select count(*) into ip_recent from public.login_otps where ip = v_ip and created_at > now() - interval '1 hour';
  if recent >= 3 or ip_recent >= 10 then
    return json_build_object('error', 'נשלחו כבר כמה קודים. נסה שוב בעוד כמה דקות.');
  end if;
  select * into st from public.stations s
  where public.norm_phone(s.phone) = ph and not s.is_home and s.status = 'active'
    and (s.sub_end is null or s.sub_end >= current_date)
  order by s.created_at limit 1;
  if st.id is not null then
    code := lpad((('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint % 1000000)::text, 6, '0');
    insert into public.login_otps (phone, station_id, code_hash, expires_at, ip)
    values (ph, st.id, encode(extensions.digest(ph || ':' || code, 'sha256'), 'hex'), now() + interval '5 minutes', v_ip);
    insert into public.wa_outbox (to_phone, body, expires_at)
    values (ph, 'קוד הכניסה שלך למערכת הזרועות: *' || code || '*' || chr(10) || 'הקוד תקף ל-5 דקות. אם לא ביקשת, התעלם מההודעה.', now() + interval '5 minutes');
  else
    -- same answer whether or not the number is registered (no way to probe which numbers exist)
    insert into public.login_otps (phone, code_hash, expires_at, ip) values (ph, 'none', now(), v_ip);
  end if;
  return json_build_object('ok', true);
end $function$;

create or replace function public.otp_verify(p_phone text, p_code text)
 returns json language plpgsql volatile security definer set search_path to 'public', 'extensions'
as $function$
declare ph text := public.norm_phone(p_phone); o public.login_otps; st public.stations; tok text;
begin
  select * into o from public.login_otps
  where phone = ph and used_at is null and station_id is not null and expires_at > now()
  order by created_at desc limit 1 for update;
  if o.id is null then return json_build_object('error', 'הקוד פג תוקף או שלא נשלח. בקש קוד חדש.'); end if;
  if o.attempts >= 5 then return json_build_object('error', 'יותר מדי ניסיונות. בקש קוד חדש.'); end if;
  update public.login_otps set attempts = attempts + 1 where id = o.id;
  if o.code_hash <> encode(extensions.digest(ph || ':' || regexp_replace(coalesce(p_code, ''), '\D', '', 'g'), 'sha256'), 'hex') then
    return json_build_object('error', 'קוד שגוי');
  end if;
  update public.login_otps set used_at = now() where id = o.id;
  select * into st from public.stations where id = o.station_id;
  if st.status <> 'active' then return json_build_object('error', 'הגישה לתחנה מושעית. פנה למנהל המערכת.'); end if;
  if st.sub_end is not null and st.sub_end < current_date then return json_build_object('error', 'המנוי של התחנה הסתיים. פנה למנהל המערכת לחידוש.'); end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.station_sessions (token_hash, station_id) values (encode(extensions.digest(tok, 'sha256'), 'hex'), st.id);
  return json_build_object('token', tok, 'station', st.name);
end $function$;

-- engine: take the next messages to send (marks them so no two engines send the same one)
create or replace function public.engine_outbox_take(p_limit int default 5)
 returns table(id bigint, to_phone text, body text)
 language plpgsql volatile security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  update public.wa_outbox set status = 'failed', error = 'פג תוקף לפני שליחה'
  where status = 'pending' and expires_at is not null and expires_at < now();
  return query
  update public.wa_outbox w set status = 'sending'
  where w.id in (select x.id from public.wa_outbox x where x.status = 'pending' order by x.created_at limit greatest(p_limit, 1) for update skip locked)
  returning w.id, w.to_phone, w.body;
end $function$;

create or replace function public.engine_outbox_done(p_id bigint, p_ok boolean, p_error text default null, p_arm uuid default null)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  update public.wa_outbox set status = case when p_ok then 'sent' else 'failed' end, error = p_error, arm_id = p_arm,
    sent_at = case when p_ok then now() else null end
  where id = p_id;
end $function$;

revoke execute on function public.otp_request(text) from public;
revoke execute on function public.otp_verify(text, text) from public;
grant execute on function public.otp_request(text) to anon, authenticated;
grant execute on function public.otp_verify(text, text) to anon, authenticated;
revoke execute on function public.engine_outbox_take(integer) from public, authenticated;
revoke execute on function public.engine_outbox_done(bigint, boolean, text, uuid) from public, authenticated;
grant execute on function public.engine_outbox_take(integer) to anon;
grant execute on function public.engine_outbox_done(bigint, boolean, text, uuid) to anon;

create or replace function public.engine_home_station()
 returns uuid language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return public.home_station();
end $function$;
revoke execute on function public.engine_home_station() from public, authenticated;
grant execute on function public.engine_home_station() to anon;
