-- Team members with a login code (15 Oct).
-- The owner adds a person (name, phone, station) and the system makes a personal 9-character code.
-- The code signs in with STATION MANAGER rights for that station (including "המערכת שלי"), never owner
-- rights: owner screens (stations, billing, updates, users) stay e-mail + password only.
-- Turning a person off, or making a new code, signs them out at once. Only a hash of the code is stored.
create table if not exists public.station_members (
  id uuid primary key default gen_random_uuid(),
  station_id uuid not null references public.stations(id),
  name text not null,
  phone text,
  code_hash text not null unique,
  code_hint text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
alter table public.station_members enable row level security;
revoke all on public.station_members from anon, authenticated;
alter table public.station_sessions add column if not exists member_id uuid references public.station_members(id);
create index if not exists station_sessions_member on public.station_sessions (member_id) where member_id is not null;

-- 9 characters (station codes have 8), so the login screen knows which kind it is
create or replace function public.gen_member_code() returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; b bytea; i int;
begin
  loop
    b := extensions.gen_random_bytes(9); c := '';
    for i in 0..8 loop c := c || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.station_members where code_hash = encode(extensions.digest(c, 'sha256'), 'hex'));
  end loop;
  return c;
end $$;
revoke all on function public.gen_member_code() from public, anon, authenticated;

create or replace function public.member_login(p_code text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare m public.station_members; st public.stations; tok text; v_ip text; fails int;
begin
  v_ip := split_part(coalesce(public.req_header('x-forwarded-for'), public.req_header('x-real-ip'), '?'), ',', 1);
  select count(*) into fails from public.station_login_attempts a
  where a.ip = v_ip and not a.ok and a.created_at > now() - interval '15 minutes';
  if fails >= 10 then return json_build_object('error', 'יותר מדי ניסיונות שגויים. נסה שוב בעוד רבע שעה.'); end if;
  select * into m from public.station_members
  where code_hash = encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 'sha256'), 'hex')
    and is_active;
  if m.id is null then
    insert into public.station_login_attempts (ip, ok) values (v_ip, false);
    perform pg_sleep(0.5);
    return json_build_object('error', 'קוד שגוי');
  end if;
  select * into st from public.stations where id = m.station_id;
  if st.status <> 'active' then return json_build_object('error', 'הגישה לתחנה מושעית. פנה למנהל המערכת.'); end if;
  if st.sub_end is not null and st.sub_end < current_date then
    return json_build_object('error', 'המנוי של התחנה הסתיים. פנה למנהל המערכת לחידוש.');
  end if;
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.station_sessions (token_hash, station_id, member_id) values (encode(extensions.digest(tok, 'sha256'), 'hex'), st.id, m.id);
  update public.station_members set last_login_at = now() where id = m.id;
  insert into public.station_login_attempts (ip, ok) values (v_ip, true);
  return json_build_object('token', tok, 'station', st.name);
end $$;
grant execute on function public.member_login(text) to anon, authenticated;

-- a member's session may open the home system; a station-code session still may not.
-- Keeps the 30-day expiry only if the live version already has it (pending login hardening).
do $mig$
declare expiry text := case when pg_get_functiondef('public.station_from_token()'::regprocedure) like '%30 days%'
                            then 'and s.last_seen > now() - interval ''30 days''' else '' end;
begin
  execute format($f$
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
    %s
    and st.status = 'active'
    and (st.sub_end is null or st.sub_end >= current_date)
    and (not st.is_home or s.member_id is not null)
    and (s.member_id is null or exists (select 1 from public.station_members m where m.id = s.member_id and m.is_active));
  return sid;
end $function$;$f$, expiry);
end $mig$;

-- ---------- owner: manage team members ----------
create or replace function public.owner_members()
returns table(id uuid, station_id uuid, station_name text, is_home boolean, name text, phone text, code_hint text,
              is_active boolean, created_at timestamptz, last_login_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select m.id, m.station_id, s.name, s.is_home, m.name, m.phone, m.code_hint, m.is_active, m.created_at, m.last_login_at
  from public.station_members m join public.stations s on s.id = m.station_id
  order by s.is_home desc, s.name, m.created_at;
end $$;

-- returns the new code once (it is not stored)
create or replace function public.owner_member_add(p_station uuid, p_name text, p_phone text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare sid uuid; c text; mid uuid;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'חסר שם'; end if;
  sid := coalesce(p_station, (select id from public.stations where is_home));
  if not exists (select 1 from public.stations where id = sid) then raise exception 'תחנה לא נמצאה'; end if;
  c := public.gen_member_code();
  insert into public.station_members (station_id, name, phone, code_hash, code_hint)
  values (sid, trim(p_name), nullif(trim(coalesce(p_phone, '')), ''), encode(extensions.digest(c, 'sha256'), 'hex'), right(c, 2))
  returning station_members.id into mid;
  return json_build_object('id', mid, 'code', c);
end $$;

-- new code: the old one stops working and the person is signed out
create or replace function public.owner_member_new_code(p_id uuid) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare c text;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  c := public.gen_member_code();
  update public.station_members set code_hash = encode(extensions.digest(c, 'sha256'), 'hex'), code_hint = right(c, 2) where id = p_id;
  if not found then raise exception 'לא נמצא'; end if;
  update public.station_sessions set revoked_at = now() where member_id = p_id and revoked_at is null;
  return c;
end $$;

-- off = signed out at once and the code stops working; on = the same code works again
create or replace function public.owner_member_set_active(p_id uuid, p_active boolean) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.station_members set is_active = p_active where id = p_id;
  if not found then raise exception 'לא נמצא'; end if;
  if not p_active then
    update public.station_sessions set revoked_at = now() where member_id = p_id and revoked_at is null;
  end if;
end $$;

revoke all on function public.owner_members(), public.owner_member_add(uuid, text, text), public.owner_member_new_code(uuid),
  public.owner_member_set_active(uuid, boolean) from public, anon;
grant execute on function public.owner_members(), public.owner_member_add(uuid, text, text), public.owner_member_new_code(uuid),
  public.owner_member_set_active(uuid, boolean) to authenticated;
