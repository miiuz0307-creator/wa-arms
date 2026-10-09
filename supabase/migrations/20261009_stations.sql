-- Multi-station (multi-tenant) support.
-- Every tenant row gets station_id. Existing data belongs to the owner's "home" station.
-- Isolation is enforced by RESTRICTIVE row-level policies, on top of the existing role policies.

-- ---------- stations ----------
create table if not exists public.stations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  manager_name text,
  phone text,
  code_hash text unique,
  code_hint text,
  is_home boolean not null default false,
  status text not null default 'active' check (status in ('active', 'suspended')),
  joined_at date not null default current_date,
  sub_end date,
  price numeric(10, 2),
  max_arms integer,
  notes text,
  created_at timestamptz not null default now()
);
create unique index if not exists stations_one_home on public.stations (is_home) where is_home;

create table if not exists public.station_sessions (
  token_hash text primary key,
  station_id uuid not null references public.stations (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists station_sessions_station on public.station_sessions (station_id);

create table if not exists public.station_login_attempts (
  id bigserial primary key,
  ip text,
  ok boolean not null,
  created_at timestamptz not null default now()
);
create index if not exists station_login_attempts_ip on public.station_login_attempts (ip, created_at);

alter table public.stations enable row level security;
alter table public.station_sessions enable row level security;
alter table public.station_login_attempts enable row level security;

insert into public.stations (name, is_home, status)
select 'המערכת שלי', true, 'active'
where not exists (select 1 from public.stations where is_home);

-- ---------- identity helpers ----------
create or replace function public.home_station() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.stations where is_home limit 1
$$;

create or replace function public.req_header(p_name text) returns text
language plpgsql stable set search_path = public as $$
declare h text;
begin
  begin
    h := current_setting('request.headers', true)::json ->> p_name;
  exception when others then
    return null;
  end;
  return nullif(h, '');
end $$;

-- station of a valid station-code session token (null when invalid, suspended or expired)
create or replace function public.station_from_token() returns uuid
language plpgsql stable security definer set search_path = public, extensions as $$
declare tok text := public.req_header('x-station-token'); sid uuid;
begin
  if tok is null then return null; end if;
  select s.station_id into sid
  from public.station_sessions s join public.stations st on st.id = s.station_id
  where s.token_hash = encode(extensions.digest(tok, 'sha256'), 'hex')
    and s.revoked_at is null
    and st.status = 'active'
    and (st.sub_end is null or st.sub_end >= current_date)
    and not st.is_home;
  return sid;
end $$;

create or replace function public.is_super() returns boolean
language sql stable security definer set search_path = public as $$
  select public.req_header('x-station-token') is null
     and exists (select 1 from public.profiles where id = auth.uid() and is_active and role = 'owner')
$$;

-- the station the current request works in
create or replace function public.my_station() returns uuid
language plpgsql stable security definer set search_path = public as $$
declare r public.app_role; st uuid; act text;
begin
  if public.req_header('x-station-token') is not null then
    return public.station_from_token();
  end if;
  if auth.uid() is null then return null; end if;
  select role into r from public.profiles where id = auth.uid() and is_active;
  if r is null then return null; end if;
  act := public.req_header('x-act-station');
  if r = 'owner' and act is not null then
    begin
      return (select id from public.stations where id = act::uuid);
    exception when others then
      return public.home_station();
    end;
  end if;
  return public.home_station();
end $$;

-- station-code users are the managers of their station (rank 3)
create or replace function public.my_rank() returns integer
language plpgsql stable security definer set search_path = public as $$
begin
  if public.req_header('x-station-token') is not null then
    return case when public.station_from_token() is not null then 3 else 0 end;
  end if;
  return coalesce((select public.role_rank(role) from public.profiles where id = auth.uid() and is_active), 0);
end $$;

-- ---------- station_id on every tenant table ----------
do $$
declare t text;
begin
  foreach t in array array[
    'arms','groups','distribution_lists','list_groups','list_arms','source_groups','templates','triggers',
    'dispatchers','campaigns','campaign_arms','campaign_targets','processed_messages','app_settings',
    'activity_log','wa_operators','quote_sessions','arm_commands','arm_qr','arm_auth','profiles']
  loop
    execute format('alter table public.%I add column if not exists station_id uuid references public.stations(id) on delete cascade', t);
    execute format('update public.%I set station_id = public.home_station() where station_id is null', t);
    execute format('alter table public.%I alter column station_id set default coalesce(public.my_station(), public.home_station())', t);
    execute format('alter table public.%I alter column station_id set not null', t);
    execute format('create index if not exists %I on public.%I (station_id)', t || '_station_idx', t);
  end loop;
end $$;

-- child rows always take the station of their parent row
create or replace function public.inherit_station() returns trigger
language plpgsql security definer set search_path = public as $$
declare sid uuid; pid text := to_jsonb(new) ->> tg_argv[1];
begin
  if pid is null then return new; end if;
  execute format('select station_id from public.%I where id = $1', tg_argv[0]) into sid using pid::uuid;
  if sid is not null then new.station_id := sid; end if;
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
    ('groups','arms','arm_id'), ('arm_qr','arms','arm_id'), ('arm_auth','arms','arm_id'),
    ('arm_commands','arms','arm_id'), ('quote_sessions','arms','arm_id'),
    ('list_groups','distribution_lists','list_id'), ('list_arms','distribution_lists','list_id'),
    ('campaign_arms','campaigns','campaign_id'), ('campaign_targets','campaigns','campaign_id')
  ) v(tbl, parent, col)
  loop
    execute format('drop trigger if exists inherit_station on public.%I', r.tbl);
    execute format('create trigger inherit_station before insert or update of %I on public.%I for each row execute function public.inherit_station(%L, %L)',
      r.col, r.tbl, r.parent, r.col);
  end loop;
end $$;

-- references to an arm, list or template must stay inside the same station
create or replace function public.check_same_station() returns trigger
language plpgsql security definer set search_path = public as $$
declare i int := 0; tbl text; col text; ref text; sid uuid;
begin
  while i < tg_nargs loop
    tbl := tg_argv[i]; col := tg_argv[i + 1];
    ref := to_jsonb(new) ->> col;
    if ref is not null then
      execute format('select station_id from public.%I where id = $1', tbl) into sid using ref::uuid;
      if sid is distinct from new.station_id then
        raise exception 'שיוך לא חוקי בין תחנות (%)', col;
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end $$;

drop trigger if exists same_station on public.list_arms;
create trigger same_station before insert or update on public.list_arms
  for each row execute function public.check_same_station('arms', 'arm_id');
drop trigger if exists same_station on public.campaign_arms;
create trigger same_station before insert or update on public.campaign_arms
  for each row execute function public.check_same_station('arms', 'arm_id');
drop trigger if exists same_station on public.source_groups;
create trigger same_station before insert or update on public.source_groups
  for each row execute function public.check_same_station('arms', 'listen_arm_id');
drop trigger if exists same_station on public.triggers;
create trigger same_station before insert or update on public.triggers
  for each row execute function public.check_same_station('distribution_lists', 'list_id', 'templates', 'template_id');
drop trigger if exists same_station on public.campaigns;
create trigger same_station before insert or update on public.campaigns
  for each row execute function public.check_same_station('distribution_lists', 'list_id', 'arms', 'trigger_arm_id');
-- inherit runs first (alphabetical: inherit_station < same_station)

-- ---------- isolation policies ----------
do $$
declare t text;
begin
  foreach t in array array[
    'arms','groups','distribution_lists','list_groups','list_arms','source_groups','templates','triggers',
    'dispatchers','campaigns','campaign_arms','campaign_targets','processed_messages','app_settings',
    'activity_log','wa_operators','quote_sessions','arm_commands','arm_qr','arm_auth']
  loop
    execute format('drop policy if exists station_isolation on public.%I', t);
    execute format($p$create policy station_isolation on public.%I as restrictive for all to public
      using ((select public.is_engine()) or station_id = (select public.my_station()))
      with check ((select public.is_engine()) or station_id = (select public.my_station()))$p$, t);
  end loop;
end $$;

drop policy if exists station_isolation on public.profiles;
create policy station_isolation on public.profiles as restrictive for all to public
  using ((select public.is_engine()) or id = auth.uid() or station_id = (select public.my_station()))
  with check ((select public.is_engine()) or id = auth.uid() or station_id = (select public.my_station()));

-- ---------- per-station uniqueness ----------
alter table public.source_groups drop constraint if exists source_groups_wa_group_id_key;
create unique index if not exists source_groups_station_group on public.source_groups (station_id, wa_group_id);
alter table public.triggers drop constraint if exists triggers_keyword_key;
create unique index if not exists triggers_station_keyword on public.triggers (station_id, keyword);
alter table public.dispatchers drop constraint if exists dispatchers_wa_jid_key;
alter table public.dispatchers drop constraint if exists dispatchers_wa_lid_key;
create unique index if not exists dispatchers_station_jid on public.dispatchers (station_id, wa_jid);
create unique index if not exists dispatchers_station_lid on public.dispatchers (station_id, wa_lid);
alter table public.wa_operators drop constraint if exists wa_operators_wa_jid_key;
alter table public.wa_operators drop constraint if exists wa_operators_wa_lid_key;
create unique index if not exists wa_operators_station_jid on public.wa_operators (station_id, wa_jid);
create unique index if not exists wa_operators_station_lid on public.wa_operators (station_id, wa_lid);
alter table public.processed_messages drop constraint if exists processed_messages_pkey;
alter table public.processed_messages add primary key (station_id, source_group_id, message_id);

-- app_settings: one row per station (the home row keeps id 1)
create sequence if not exists public.app_settings_id_seq;
select setval('public.app_settings_id_seq', greatest(2, (select coalesce(max(id), 1) + 1 from public.app_settings)), false);
alter table public.app_settings alter column id set default nextval('public.app_settings_id_seq');
create unique index if not exists app_settings_station on public.app_settings (station_id);

-- ---------- maximum devices per station ----------
create or replace function public.check_max_arms() returns trigger
language plpgsql security definer set search_path = public as $$
declare lim int; n int;
begin
  select max_arms into lim from public.stations where id = new.station_id;
  if lim is null then return new; end if;
  select count(*) into n from public.arms where station_id = new.station_id;
  if n >= lim then
    raise exception 'הגעת למספר המכשירים המקסימלי לתחנה (%). פנה למנהל המערכת.', lim;
  end if;
  return new;
end $$;
drop trigger if exists max_arms on public.arms;
create trigger max_arms before insert on public.arms for each row execute function public.check_max_arms();

-- ---------- station-aware business functions ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare first_user boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, email, full_name, role, is_active, station_id)
  values (new.id, new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when first_user then 'owner'::public.app_role else 'viewer'::public.app_role end,
    first_user, public.home_station());
  return new;
end $$;

create or replace function public.log_activity(p_action text, p_entity text, p_entity_id text, p_details jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare sid uuid := public.my_station(); nm text;
begin
  if public.my_rank() < 1 or sid is null then raise exception 'not allowed'; end if;
  if public.req_header('x-station-token') is not null then
    nm := 'מנהל התחנה';
  else
    select coalesce(full_name, email) into nm from public.profiles where id = auth.uid();
  end if;
  insert into public.activity_log (actor_id, actor_name, action, entity, entity_id, details, station_id)
  values (auth.uid(), nm, p_action, p_entity, p_entity_id, p_details, sid);
end $$;

create or replace function public.create_manual_campaign(p_message text, p_arm_ids uuid[], p_group_ids text[], p_list_id uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare cid uuid; sid uuid := public.my_station(); arms uuid[] := p_arm_ids; grps text[] := p_group_ids;
begin
  if public.my_rank() < 2 or sid is null then raise exception 'אין הרשאה'; end if;
  if coalesce(trim(p_message), '') = '' then raise exception 'ההודעה ריקה'; end if;
  if p_list_id is not null and not exists (select 1 from public.distribution_lists where id = p_list_id and station_id = sid) then
    raise exception 'רשימה לא נמצאה';
  end if;

  if p_list_id is not null then
    select coalesce(array_agg(wa_group_id), '{}') into grps from public.list_groups where list_id = p_list_id;
    if arms is null or cardinality(arms) = 0 then
      select coalesce(array_agg(arm_id), '{}') into arms from public.list_arms where list_id = p_list_id;
    end if;
  end if;
  if arms is null or cardinality(arms) = 0 then
    select coalesce(array_agg(id), '{}') into arms from public.arms where is_active and station_id = sid;
  end if;
  -- only arms of this station
  select coalesce(array_agg(id), '{}') into arms from public.arms where id = any (arms) and station_id = sid;
  if cardinality(arms) = 0 then raise exception 'לא נבחרו זרועות'; end if;
  if grps is null or cardinality(grps) = 0 then raise exception 'לא נבחרו קבוצות'; end if;

  insert into public.campaigns (kind, status, message_text, final_text, list_id, created_by, station_id)
  values ('manual', 'queued', p_message, p_message, p_list_id, auth.uid(), sid)
  returning id into cid;

  insert into public.campaign_arms (campaign_id, arm_id, station_id) select cid, unnest(arms), sid on conflict do nothing;

  insert into public.campaign_targets (campaign_id, wa_group_id, group_name, station_id)
  select cid, g, (select name from public.groups where wa_group_id = g and station_id = sid order by updated_at desc limit 1), sid
  from (select distinct unnest(grps) g) s
  on conflict do nothing;

  update public.campaigns set total = (select count(*) from public.campaign_targets where campaign_id = cid) where id = cid;
  perform public.log_activity('campaign_created', 'campaign', cid::text,
    jsonb_build_object('arms', cardinality(arms), 'groups', cardinality(grps)));
  return cid;
end $$;

create or replace function public.retry_failed(p_campaign uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if public.my_rank() < 2 then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.campaigns where id = p_campaign and station_id = public.my_station()) then
    raise exception 'not allowed';
  end if;
  update public.campaign_targets set status = 'pending', attempts = 0, tried_arms = '{}', error = null
  where campaign_id = p_campaign and status = 'failed';
  get diagnostics n = row_count;
  if n > 0 then
    update public.campaigns set status = 'running', finished_at = null where id = p_campaign;
    perform public.log_activity('campaign_retry', 'campaign', p_campaign::text, jsonb_build_object('targets', n));
  end if;
  return n;
end $$;

create or replace function public.claim_target(p_arm uuid)
returns table (target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
language plpgsql security definer set search_path = public as $$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  select * into s from public.app_settings where station_id = a.station_id;

  select t.id, c.id into t_id, c_id
  from public.campaign_targets t
  join public.campaigns c on c.id = t.campaign_id
  join public.campaign_arms ca on ca.campaign_id = c.id and ca.arm_id = p_arm
  join public.groups g on g.arm_id = p_arm and g.wa_group_id = t.wa_group_id
  where t.status = 'pending' and c.status in ('queued', 'running') and c.final_text is not null
    and c.station_id = a.station_id
    and not (p_arm = any (t.tried_arms))
    and (coalesce(s.distribution_mode, 'fill') = 'fill' or
         (select count(*) from public.campaign_targets x
           where x.campaign_id = c.id and x.arm_id = p_arm and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60))
  order by c.last_claim_at asc nulls first, c.created_at, t.id
  for update of t skip locked
  limit 1;

  if t_id is null then return; end if;

  update public.campaign_targets set status = 'sending', arm_id = p_arm, attempts = attempts + 1, claimed_at = now()
  where id = t_id;
  update public.campaigns set last_claim_at = clock_timestamp(),
    status = case when status = 'queued' then 'running' else status end,
    started_at = coalesce(started_at, now())
  where id = c_id;

  return query select t.id, t.campaign_id, t.wa_group_id, c.final_text
  from public.campaign_targets t join public.campaigns c on c.id = t.campaign_id where t.id = t_id;
end $$;

create or replace function public.finalize_campaigns() returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.campaign_targets set status = 'pending'
  where status = 'sending' and claimed_at < now() - interval '5 minutes';

  update public.campaign_targets t
  set status = 'failed', error = coalesce(t.error, 'אין זרוע פנויה: הזרועות שנבחרו לא בקבוצה, נכשלו או הגיעו למגבלה')
  where t.status = 'pending'
    and exists (select 1 from public.campaigns c where c.id = t.campaign_id
                and c.status in ('queued', 'running') and c.final_text is not null)
    and not exists (
      select 1 from public.campaign_arms ca
      join public.arms a on a.id = ca.arm_id
      join public.groups g on g.arm_id = ca.arm_id and g.wa_group_id = t.wa_group_id
      left join public.app_settings s on s.station_id = a.station_id
      where ca.campaign_id = t.campaign_id and a.is_active
        and not (ca.arm_id = any (t.tried_arms))
        and (coalesce(s.distribution_mode, 'fill') = 'fill' or
             (select count(*) from public.campaign_targets x
               where x.campaign_id = t.campaign_id and x.arm_id = ca.arm_id and x.status in ('sent', 'sending')) < coalesce(s.per_arm_group_limit, 60)));

  update public.campaigns c set status = 'completed', finished_at = now()
  where c.status in ('queued', 'running') and c.final_text is not null
    and not exists (select 1 from public.campaign_targets t
                    where t.campaign_id = c.id and t.status in ('pending', 'sending'));
end $$;

-- internal functions are for the engine wrappers only
revoke execute on function public.claim_target(uuid) from public, anon, authenticated;
revoke execute on function public.target_result(bigint, uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.finalize_campaigns() from public, anon, authenticated;

-- ---------- station login (code) ----------
create or replace function public.station_login(p_code text) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare st public.stations; tok text; v_ip text; fails int;
begin
  v_ip := split_part(coalesce(public.req_header('x-forwarded-for'), public.req_header('x-real-ip'), '?'), ',', 1);
  select count(*) into fails from public.station_login_attempts a
  where a.ip = v_ip and not a.ok and a.created_at > now() - interval '15 minutes';
  if fails >= 10 then return json_build_object('error', 'יותר מדי ניסיונות שגויים. נסה שוב בעוד רבע שעה.'); end if;

  select * into st from public.stations
  where code_hash = encode(extensions.digest(upper(regexp_replace(coalesce(p_code, ''), '\s', '', 'g')), 'sha256'), 'hex')
    and not is_home;
  if st.id is null then
    insert into public.station_login_attempts (ip, ok) values (v_ip, false);
    perform pg_sleep(0.5);
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
end $$;

create or replace function public.station_logout() returns void
language plpgsql security definer set search_path = public, extensions as $$
declare tok text := public.req_header('x-station-token');
begin
  if tok is null then return; end if;
  update public.station_sessions set revoked_at = now()
  where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex');
end $$;

-- who am I (station side)
create or replace function public.station_me() returns json
language sql stable security definer set search_path = public as $$
  select json_build_object(
    'id', s.id, 'name', s.name, 'is_home', s.is_home, 'status', s.status, 'sub_end', s.sub_end,
    'max_arms', s.max_arms, 'via_code', public.req_header('x-station-token') is not null,
    'acting', public.req_header('x-act-station') is not null and public.req_header('x-station-token') is null)
  from public.stations s where s.id = public.my_station()
$$;

-- ---------- owner: manage stations ----------
create or replace function public.gen_station_code() returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; b bytea; i int;
begin
  loop
    b := extensions.gen_random_bytes(8); c := '';
    for i in 0..7 loop c := c || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.stations where code_hash = encode(extensions.digest(c, 'sha256'), 'hex'));
  end loop;
  return c;
end $$;

create or replace function public.stations_overview() returns table (
  id uuid, name text, manager_name text, phone text, code_hint text, status text, joined_at date, sub_end date,
  price numeric, max_arms int, notes text, created_at timestamptz,
  arms_total int, arms_online int, groups_count int, campaigns_count int, last_campaign timestamptz, last_login timestamptz)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.manager_name, s.phone, s.code_hint, s.status, s.joined_at, s.sub_end, s.price, s.max_arms, s.notes, s.created_at,
    (select count(*)::int from public.arms a where a.station_id = s.id),
    (select count(*)::int from public.arms a where a.station_id = s.id and a.status = 'online'),
    (select count(distinct g.wa_group_id)::int from public.groups g where g.station_id = s.id),
    (select count(*)::int from public.campaigns c where c.station_id = s.id),
    (select max(c.created_at) from public.campaigns c where c.station_id = s.id),
    (select max(ss.last_seen) from public.station_sessions ss where ss.station_id = s.id)
  from public.stations s where not s.is_home
  order by s.created_at desc;
end $$;

create or replace function public.station_save(p jsonb) returns json
language plpgsql volatile security definer set search_path = public, extensions as $$
declare sid uuid := nullif(p ->> 'id', '')::uuid; code text; is_new boolean := sid is null;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if coalesce(trim(p ->> 'name'), '') = '' then raise exception 'חסר שם תחנה'; end if;
  if is_new then
    code := upper(regexp_replace(coalesce(nullif(p ->> 'code', ''), public.gen_station_code()), '\s', '', 'g'));
    if length(code) < 6 then raise exception 'קוד כניסה חייב להיות לפחות 6 תווים'; end if;
    if exists (select 1 from public.stations where code_hash = encode(extensions.digest(code, 'sha256'), 'hex')) then
      raise exception 'הקוד כבר בשימוש. בחר קוד אחר.';
    end if;
    insert into public.stations (name, manager_name, phone, code_hash, code_hint, status, joined_at, sub_end, price, max_arms, notes)
    values (trim(p ->> 'name'), p ->> 'manager_name', p ->> 'phone', encode(extensions.digest(code, 'sha256'), 'hex'),
      right(code, 2), coalesce(nullif(p ->> 'status', ''), 'active'),
      coalesce(nullif(p ->> 'joined_at', '')::date, current_date), nullif(p ->> 'sub_end', '')::date,
      nullif(p ->> 'price', '')::numeric, coalesce(nullif(p ->> 'max_arms', '')::int, 2), p ->> 'notes')
    returning id into sid;
    -- a ready-to-use empty system: default settings, the default template and the "עזרה" trigger
    insert into public.app_settings (station_id, min_delay_sec, max_delay_sec, per_arm_group_limit, distribution_mode, auto_distribution_enabled, rate_per_minute)
    values (sid, 8, 20, 60, 'fill', false, 20);
    with t as (
      insert into public.templates (name, prefix, suffix, station_id) values ('ברירת מחדל', '', '📞 לבקשה במספר: {PHONE}', sid) returning id
    )
    insert into public.triggers (keyword, action, template_id, strip_keyword, is_active, station_id)
    select 'עזרה', 'distribute', t.id, true, true, sid from t;
  else
    update public.stations set
      name = trim(p ->> 'name'), manager_name = p ->> 'manager_name', phone = p ->> 'phone',
      status = coalesce(nullif(p ->> 'status', ''), status),
      joined_at = coalesce(nullif(p ->> 'joined_at', '')::date, joined_at),
      sub_end = nullif(p ->> 'sub_end', '')::date,
      price = nullif(p ->> 'price', '')::numeric,
      max_arms = coalesce(nullif(p ->> 'max_arms', '')::int, max_arms),
      notes = p ->> 'notes'
    where id = sid and not is_home;
  end if;
  return json_build_object('id', sid, 'code', code);
end $$;

create or replace function public.station_set_code(p_id uuid, p_code text default null) returns text
language plpgsql volatile security definer set search_path = public, extensions as $$
declare code text;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  code := upper(regexp_replace(coalesce(nullif(p_code, ''), public.gen_station_code()), '\s', '', 'g'));
  if length(code) < 6 then raise exception 'קוד כניסה חייב להיות לפחות 6 תווים'; end if;
  if exists (select 1 from public.stations where code_hash = encode(extensions.digest(code, 'sha256'), 'hex') and id <> p_id) then
    raise exception 'הקוד כבר בשימוש. בחר קוד אחר.';
  end if;
  update public.stations set code_hash = encode(extensions.digest(code, 'sha256'), 'hex'), code_hint = right(code, 2)
  where id = p_id and not is_home;
  -- everyone logged in with the old code is logged out
  update public.station_sessions set revoked_at = now() where station_id = p_id and revoked_at is null;
  return code;
end $$;

create or replace function public.station_logout_all(p_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.station_sessions set revoked_at = now() where station_id = p_id and revoked_at is null;
end $$;

create or replace function public.station_extend(p_id uuid, p_months int) returns date
language plpgsql volatile security definer set search_path = public as $$
declare d date;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.stations
  set sub_end = (greatest(coalesce(sub_end, current_date), current_date) + make_interval(months => p_months))::date,
      status = 'active'
  where id = p_id and not is_home
  returning sub_end into d;
  return d;
end $$;

create or replace function public.station_delete(p_id uuid) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  delete from public.stations where id = p_id and not is_home;
end $$;

grant execute on function public.station_login(text) to anon, authenticated;
grant execute on function public.station_logout() to anon, authenticated;
grant execute on function public.station_me() to anon, authenticated;
grant execute on function public.stations_overview() to authenticated;
grant execute on function public.station_save(jsonb) to authenticated;
grant execute on function public.station_set_code(uuid, text) to authenticated;
grant execute on function public.station_logout_all(uuid) to authenticated;
grant execute on function public.station_extend(uuid, int) to authenticated;
grant execute on function public.station_delete(uuid) to authenticated;
revoke execute on function public.gen_station_code() from public, anon, authenticated;

grant execute on function public.create_manual_campaign(text, uuid[], text[], uuid) to anon;
grant execute on function public.retry_failed(uuid) to anon;
grant execute on function public.log_activity(text, text, text, jsonb) to anon;
-- the station tables themselves are only reachable through the functions above
revoke all on public.stations, public.station_sessions, public.station_login_attempts, public.engine_keys from anon, authenticated;

-- keep the session "last seen" fresh (cheap: at most once a minute per session)
create or replace function public.station_ping() returns void
language plpgsql volatile security definer set search_path = public, extensions as $$
declare tok text := public.req_header('x-station-token');
begin
  if tok is null then return; end if;
  update public.station_sessions set last_seen = now()
  where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex') and last_seen < now() - interval '1 minute';
end $$;
grant execute on function public.station_ping() to anon, authenticated;
