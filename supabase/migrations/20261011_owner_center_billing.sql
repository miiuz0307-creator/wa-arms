-- Owner control center (all stations on one screen) and payments. Everything here is for the system
-- owner only (is_super); stations cannot see or call any of it.

-- ---------- payments ----------
create table if not exists public.station_payments (
  id bigint generated always as identity primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  amount numeric not null check (amount >= 0),
  months int not null default 1 check (months between 0 and 36),
  paid_at date not null default current_date,
  method text,
  note text,
  created_by uuid,
  created_at timestamptz not null default now()
);
create index if not exists station_payments_station_idx on public.station_payments (station_id, paid_at desc);
alter table public.station_payments enable row level security;
revoke all on public.station_payments from anon, authenticated;

-- record a payment; months > 0 extends the subscription (and re-activates a suspended station)
create or replace function public.owner_payment_add(p_station uuid, p_amount numeric, p_months int default 1,
  p_method text default null, p_note text default null, p_paid_at date default null)
 returns json language plpgsql security definer set search_path to 'public'
as $function$
declare d date; pid bigint;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_amount is null or p_amount < 0 then raise exception 'סכום לא תקין'; end if;
  if not exists (select 1 from public.stations where id = p_station and not is_home) then raise exception 'תחנה לא נמצאה'; end if;
  insert into public.station_payments (station_id, amount, months, paid_at, method, note, created_by)
  values (p_station, p_amount, greatest(coalesce(p_months, 0), 0), coalesce(p_paid_at, current_date), nullif(trim(p_method), ''), nullif(trim(p_note), ''), auth.uid())
  returning id into pid;
  if coalesce(p_months, 0) > 0 then
    update public.stations
    set sub_end = (greatest(coalesce(sub_end, current_date), current_date) + make_interval(months => p_months))::date,
        status = 'active'
    where id = p_station
    returning sub_end into d;
  else
    select sub_end into d from public.stations where id = p_station;
  end if;
  return json_build_object('id', pid, 'sub_end', d);
end $function$;

create or replace function public.owner_payments(p_limit int default 200)
 returns table(id bigint, station_id uuid, station_name text, amount numeric, months int, paid_at date, method text, note text, created_at timestamptz)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select p.id, p.station_id, s.name, p.amount, p.months, p.paid_at, p.method, p.note, p.created_at
  from public.station_payments p join public.stations s on s.id = p.station_id
  order by p.paid_at desc, p.id desc limit least(greatest(p_limit, 1), 2000);
end $function$;

-- per station: price, subscription end, what was paid, and how much is owed for months already past
create or replace function public.owner_billing()
 returns table(station_id uuid, station_name text, status text, price numeric, sub_end date,
   last_paid_at date, last_amount numeric, paid_total numeric, paid_this_month numeric, months_overdue int, owed numeric)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.status, s.price, s.sub_end,
    lp.paid_at, lp.amount,
    coalesce((select sum(p.amount) from public.station_payments p where p.station_id = s.id), 0),
    coalesce((select sum(p.amount) from public.station_payments p where p.station_id = s.id
              and date_trunc('month', p.paid_at) = date_trunc('month', current_date)), 0),
    case when s.sub_end is not null and s.sub_end < current_date
         then (extract(year from age(current_date, s.sub_end)) * 12 + extract(month from age(current_date, s.sub_end)))::int + 1
         else 0 end,
    case when s.sub_end is not null and s.sub_end < current_date
         then coalesce(s.price, 0) * ((extract(year from age(current_date, s.sub_end)) * 12 + extract(month from age(current_date, s.sub_end)))::int + 1)
         else 0 end
  from public.stations s
  left join lateral (select p.paid_at, p.amount from public.station_payments p where p.station_id = s.id
                     order by p.paid_at desc, p.id desc limit 1) lp on true
  where not s.is_home
  order by s.name;
end $function$;

-- ---------- control center ----------
create or replace function public.owner_arms()
 returns table(arm_id uuid, arm_name text, station_id uuid, station_name text, is_home boolean, phone text, status text,
   is_active boolean, last_error text, last_seen_at timestamptz, sent_today int, daily_limit int, linked_at timestamptz, groups_count int)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select a.id, a.name, s.id, s.name, s.is_home, a.phone, a.status, a.is_active, a.last_error, a.last_seen_at,
    case when a.sent_day = current_date then a.sent_today else 0 end, a.daily_limit, a.linked_at,
    (select count(*)::int from public.groups g where g.arm_id = a.id)
  from public.arms a join public.stations s on s.id = a.station_id
  order by s.is_home desc, s.name, a.created_at;
end $function$;

create or replace function public.owner_active_campaigns()
 returns table(campaign_id uuid, station_id uuid, station_name text, kind text, status text, text_preview text,
   sent int, failed int, total int, created_at timestamptz, source_group_name text)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select c.id, s.id, s.name, c.kind, c.status, left(coalesce(c.final_text, c.message_text, ''), 120),
    (select count(*)::int from public.campaign_targets t where t.campaign_id = c.id and t.status = 'sent'),
    (select count(*)::int from public.campaign_targets t where t.campaign_id = c.id and t.status in ('failed', 'skipped')),
    (select count(*)::int from public.campaign_targets t where t.campaign_id = c.id),
    c.created_at, c.source_group_name
  from public.campaigns c join public.stations s on s.id = c.station_id
  where c.status in ('queued', 'running', 'paused', 'pending_phone')
  order by c.created_at desc limit 100;
end $function$;

-- today per station: rides, groups reached, failures, refused requests
create or replace function public.owner_today()
 returns table(station_id uuid, station_name text, rides int, sent int, failed int, refused int)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem';
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name,
    (select count(*)::int from public.campaigns c where c.station_id = s.id and c.created_at >= day_start),
    (select count(*)::int from public.campaign_targets t where t.station_id = s.id and t.status = 'sent' and t.sent_at >= day_start),
    (select count(*)::int from public.campaign_targets t where t.station_id = s.id and t.status = 'failed' and t.claimed_at >= day_start),
    (select count(*)::int from public.activity_log l where l.station_id = s.id and l.created_at >= day_start
       and l.action in ('quote_blocked', 'quote_cancel_denied', 'quote_operator_pending'))
  from public.stations s
  where s.status = 'active'
  order by s.is_home desc, s.name;
end $function$;

-- buttons on an arm of any station: connect / refresh groups / new QR
create or replace function public.owner_arm_command(p_arm uuid, p_command text)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
declare sid uuid;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_command not in ('connect', 'refresh_groups', 'reset') then raise exception 'unknown command'; end if;
  select station_id into sid from public.arms where id = p_arm;
  if sid is null then raise exception 'זרוע לא נמצאה'; end if;
  insert into public.arm_commands (arm_id, command, created_by, station_id) values (p_arm, p_command, auth.uid(), sid);
end $function$;

-- stop / resume sending from one arm without disconnecting it (daily limit 0 = connected, sends nothing)
create or replace function public.owner_arm_limit(p_arm uuid, p_limit int)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.arms set daily_limit = greatest(coalesce(p_limit, 0), 0), sent_day = coalesce(sent_day, current_date) where id = p_arm;
end $function$;

-- cancel a running distribution of any station (what was sent stays)
create or replace function public.owner_cancel_campaign(p_id uuid)
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.campaigns set status = 'cancelled', finished_at = now()
  where id = p_id and status in ('queued', 'running', 'paused', 'pending_phone');
  update public.campaign_targets set status = 'skipped', error = 'ההפצה בוטלה'
  where campaign_id = p_id and status = 'pending';
end $function$;

do $$ declare f text; begin
  foreach f in array array['owner_payment_add(uuid,numeric,integer,text,text,date)', 'owner_payments(integer)',
    'owner_billing()', 'owner_arms()', 'owner_active_campaigns()', 'owner_today()', 'owner_arm_command(uuid,text)',
    'owner_arm_limit(uuid,integer)', 'owner_cancel_campaign(uuid)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
