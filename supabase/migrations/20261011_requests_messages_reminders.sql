-- Owner tools: fixed monthly payment per station, requests for more arms, system messages to stations,
-- and payment reminders shown inside each station's app.

-- ---------- owner settings (one row) ----------
create table if not exists public.owner_settings (
  id int primary key default 1 check (id = 1),
  payment_note text,                 -- how to pay, shown to stations in the reminder (e.g. "ביט ל-050...")
  extra_arm_price numeric default 50, -- suggested monthly price for each extra arm
  reminder_days int default 5,       -- remind this many days before the subscription ends
  updated_at timestamptz default now()
);
insert into public.owner_settings (id) values (1) on conflict do nothing;
alter table public.owner_settings enable row level security;
revoke all on public.owner_settings from anon, authenticated;

-- ---------- requests for more arms ----------
create table if not exists public.arm_requests (
  id bigint generated always as identity primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  count int not null default 1 check (count between 1 and 10),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  price_before numeric,
  price_after numeric,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create index if not exists arm_requests_status_idx on public.arm_requests (status, created_at desc);
alter table public.arm_requests enable row level security;
revoke all on public.arm_requests from anon, authenticated;

-- ---------- system messages (owner → all stations or one) ----------
create table if not exists public.system_messages (
  id bigint generated always as identity primary key,
  title text not null,
  body text,
  level text not null default 'info' check (level in ('info', 'warning', 'urgent')),
  station_id uuid references public.stations(id) on delete cascade, -- null = every station
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists system_messages_time_idx on public.system_messages (starts_at desc);
alter table public.system_messages enable row level security;
revoke all on public.system_messages from anon, authenticated;

-- ===== station side =====

-- a station asks for more arms (one open request per station; asking again updates it)
create or replace function public.station_request_arms(p_count int default 1, p_note text default null)
 returns json language plpgsql security definer set search_path to 'public'
as $function$
declare sid uuid := public.my_station(); rid bigint;
begin
  if sid is null or public.my_rank() < 3 then raise exception 'אין הרשאה'; end if;
  if exists (select 1 from public.stations where id = sid and is_home) then raise exception 'לא נדרש בחשבון הראשי'; end if;
  update public.arm_requests set count = least(greatest(coalesce(p_count, 1), 1), 10), note = nullif(trim(p_note), ''), created_at = now()
  where station_id = sid and status = 'pending' returning id into rid;
  if rid is null then
    insert into public.arm_requests (station_id, count, note, price_before)
    values (sid, least(greatest(coalesce(p_count, 1), 1), 10), nullif(trim(p_note), ''), (select price from public.stations where id = sid))
    returning id into rid;
  end if;
  return json_build_object('id', rid);
end $function$;

-- everything a station's app shows from the owner: messages, payment reminder, open arm request
create or replace function public.station_inbox()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
declare sid uuid := public.my_station(); st public.stations; os public.owner_settings; dl int; overdue int := 0;
begin
  if sid is null then return null; end if;
  select * into st from public.stations where id = sid;
  select * into os from public.owner_settings where id = 1;
  dl := case when st.sub_end is null then null else st.sub_end - current_date end;
  if st.sub_end is not null and st.sub_end < current_date then
    overdue := (extract(year from age(current_date, st.sub_end)) * 12 + extract(month from age(current_date, st.sub_end)))::int + 1;
  end if;
  return json_build_object(
    'messages', coalesce((select json_agg(json_build_object('id', m.id, 'title', m.title, 'body', m.body, 'level', m.level, 'at', m.starts_at) order by m.starts_at desc)
                 from public.system_messages m
                 where (m.station_id is null or m.station_id = sid) and m.starts_at <= now() and (m.ends_at is null or m.ends_at > now())), '[]'::json),
    'billing', case when st.is_home then null else json_build_object(
                 'price', st.price, 'sub_end', st.sub_end, 'days_left', dl, 'months_overdue', overdue,
                 'owed', coalesce(st.price, 0) * overdue, 'payment_note', os.payment_note,
                 'remind', dl is not null and dl <= coalesce(os.reminder_days, 5)) end,
    'arms', json_build_object('max', st.max_arms, 'count', (select count(*) from public.arms a where a.station_id = sid)),
    'arm_request', (select json_build_object('id', r.id, 'count', r.count, 'status', r.status, 'at', r.created_at)
                    from public.arm_requests r where r.station_id = sid and r.status = 'pending' order by r.id desc limit 1)
  );
end $function$;

-- ===== owner side =====
create or replace function public.owner_settings_get()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return (select row_to_json(s) from public.owner_settings s where id = 1);
end $function$;

create or replace function public.owner_settings_save(p_payment_note text, p_extra_arm_price numeric, p_reminder_days int)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.owner_settings set payment_note = nullif(trim(p_payment_note), ''),
    extra_arm_price = greatest(coalesce(p_extra_arm_price, 0), 0),
    reminder_days = least(greatest(coalesce(p_reminder_days, 5), 0), 30), updated_at = now()
  where id = 1;
end $function$;

-- the fixed monthly payment of a station
create or replace function public.owner_set_price(p_station uuid, p_price numeric)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_price is not null and p_price < 0 then raise exception 'מחיר לא תקין'; end if;
  update public.stations set price = p_price where id = p_station and not is_home;
end $function$;

create or replace function public.owner_arm_requests()
 returns table(id bigint, station_id uuid, station_name text, count int, note text, status text, price_before numeric,
   price_after numeric, max_arms int, arms_count int, created_at timestamptz, decided_at timestamptz)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select r.id, s.id, s.name, r.count, r.note, r.status, coalesce(r.price_before, s.price), r.price_after, s.max_arms,
    (select count(*)::int from public.arms a where a.station_id = s.id), r.created_at, r.decided_at
  from public.arm_requests r join public.stations s on s.id = r.station_id
  where r.status = 'pending' or r.decided_at > now() - interval '30 days'
  order by (r.status = 'pending') desc, r.created_at desc limit 100;
end $function$;

-- approve (raises the station's arm limit, optionally sets its new monthly price) or decline; the station is told
create or replace function public.owner_decide_arm_request(p_id bigint, p_approve boolean, p_new_price numeric default null)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare r public.arm_requests; n int;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  select * into r from public.arm_requests where id = p_id and status = 'pending' for update;
  if r.id is null then raise exception 'הבקשה כבר טופלה'; end if;
  if p_approve then
    select count(*) into n from public.arms where station_id = r.station_id;
    update public.stations set max_arms = greatest(coalesce(max_arms, 0), n) + r.count,
      price = coalesce(p_new_price, price)
    where id = r.station_id;
    update public.arm_requests set status = 'approved', decided_at = now(), price_after = coalesce(p_new_price, price_before) where id = p_id;
    insert into public.system_messages (title, body, level, station_id, ends_at)
    values ('הבקשה לזרוע נוספת אושרה',
            'אפשר להוסיף עכשיו ' || r.count || case when r.count = 1 then ' זרוע' else ' זרועות' end || ' במסך "חיבור זרועות".'
              || case when p_new_price is not null then ' התשלום החודשי החדש: ' || round(p_new_price) || ' ₪.' else '' end,
            'info', r.station_id, now() + interval '7 days');
  else
    update public.arm_requests set status = 'declined', decided_at = now() where id = p_id;
    insert into public.system_messages (title, body, level, station_id, ends_at)
    values ('הבקשה לזרוע נוספת לא אושרה', 'לפרטים פנה למנהל המערכת.', 'warning', r.station_id, now() + interval '3 days');
  end if;
end $function$;

-- send a system message to every station (p_station null) or one station, for p_days days (null = until ended)
create or replace function public.owner_message_send(p_title text, p_body text, p_level text default 'info', p_station uuid default null, p_days int default 7)
 returns bigint language plpgsql security definer set search_path to 'public'
as $function$
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

create or replace function public.owner_messages()
 returns table(id bigint, title text, body text, level text, station_id uuid, station_name text, starts_at timestamptz, ends_at timestamptz, active boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select m.id, m.title, m.body, m.level, m.station_id, s.name, m.starts_at, m.ends_at, (m.ends_at is null or m.ends_at > now())
  from public.system_messages m left join public.stations s on s.id = m.station_id
  order by m.starts_at desc limit 50;
end $function$;

-- stop showing a message (kept in the list)
create or replace function public.owner_message_end(p_id bigint)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.system_messages set ends_at = now() where id = p_id and (ends_at is null or ends_at > now());
end $function$;

do $$ declare f text; begin
  foreach f in array array['owner_settings_get()', 'owner_settings_save(text,numeric,integer)', 'owner_set_price(uuid,numeric)',
    'owner_arm_requests()', 'owner_decide_arm_request(bigint,boolean,numeric)', 'owner_message_send(text,text,text,uuid,integer)',
    'owner_messages()', 'owner_message_end(bigint)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  foreach f in array array['station_request_arms(integer,text)', 'station_inbox()'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;
