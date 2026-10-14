-- BotiX 2.0 – registers 3 updates in "ניהול עדכונים" as WAITING FOR APPROVAL (nothing runs now).
-- Order matters and the runner keeps it (lowest number first): 2.0.1 database, 2.0.2 WhatsApp server, 2.0.3 website.
-- Code: branch botix-v2, commit fe2a5513a1445f6733067b14e5da3c1b9385bc5d
-- Tests: database 232/232 (local), engine 36/36, demo 400+ screen visits without errors.
insert into public.releases (version, title, changes, components, affects_arms, disconnect_risk, restart_engine, risk_notes, commit_sha, migration_sql, rollback_sql, status)
values ('2.0.1', 'BotiX 2 – מסד נתונים (תוספות בלבד)', array['לוגו ומסלול לכל תחנה', 'סטטוס קבוצות: השבתה זמנית ו"כלול בכל זאת", זיהוי סיבת אי-זמינות', 'בקשות תשלום עם אסמכתה ואישור/דחייה מקישור בוואטסאפ (מניעת אישור כפול)', 'הגדרות ביט/פייבוקס ומספר לאישורים', 'פניות תמיכה', 'התראות על מנוי שמסתיים (לבעל המערכת ולתחנה) – כל יום ב-10:07', 'חתימה בהודעות שבעל המערכת שולט בה (לכל התחנות או לתחנה)'], '{db}', false, 'none', false,
  'רק טבלאות, עמודות ופונקציות חדשות – שום נתון קיים לא משתנה או נמחק. לא נוגע בזרועות. הביטול מסיר רק את מה שנוסף.', 'fe2a5513a1445f6733067b14e5da3c1b9385bc5d',
  $r2$-- BotiX v2 (DB side): station logo, group status flags, subscription payments with owner approval,
-- support tickets, subscription alerts and engine helpers.
--
-- Additive only: new tables / columns / functions. No existing function, row, WhatsApp connection,
-- group or list is changed. Safe to run more than once (if not exists / create or replace).
-- Fast on a big database: new columns are nullable or have constant defaults (no table rewrite),
-- no index on an existing table. Runs inside the release runner's single transaction.
select set_config('lock_timeout', '5s', true);

-- =====================================================================================
-- 1. Branding
-- =====================================================================================
alter table public.stations add column if not exists logo_data text
  constraint stations_logo_data_check check (logo_data is null or (length(logo_data) <= 400000 and logo_data like 'data:image/%'));
alter table public.stations add column if not exists plan text default 'basic';

-- the logo of a station: the owner sets any station, a station manager only his own; null / '' clears it
create or replace function public.station_set_logo(p_station uuid, p_data text)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
declare d text := nullif(trim(coalesce(p_data, '')), '');
begin
  if not public.is_super() then
    if public.my_rank() < 3 or p_station is null or p_station is distinct from public.my_station() then
      raise exception 'אין הרשאה';
    end if;
  end if;
  if d is not null then
    if d !~ '^data:image/(png|jpeg|jpg|webp|gif);base64,' then raise exception 'פורמט תמונה לא נתמך (PNG / JPG / WEBP)'; end if;
    if length(d) > 400000 then raise exception 'התמונה גדולה מדי (עד כ-300KB)'; end if;
  end if;
  update public.stations set logo_data = d where id = p_station;
  if not found then raise exception 'תחנה לא נמצאה'; end if;
end $function$;

-- name / logo / plan of the station the caller works in (station_me() is kept as is)
create or replace function public.station_brand()
 returns table(station_id uuid, name text, logo_data text, plan text, status text, sub_end date, price numeric)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  return query
  select s.id, s.name, s.logo_data, s.plan, s.status, s.sub_end, s.price::numeric
  from public.stations s where s.id = public.my_station();
end $function$;

create or replace function public.owner_station_logos()
 returns table(station_id uuid, logo_data text)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query select s.id, s.logo_data from public.stations s where s.logo_data is not null;
end $function$;

-- =====================================================================================
-- 2. Group status (per station, per WhatsApp group)
-- =====================================================================================
create table if not exists public.group_flags (
  station_id uuid not null default coalesce(public.my_station(), public.home_station()) references public.stations(id) on delete cascade,
  wa_group_id text not null,
  include_anyway boolean not null default false,  -- send to it even if it looks unavailable
  disabled boolean not null default false,        -- never send to it
  note text,
  updated_at timestamptz default now(),
  updated_by uuid,
  primary key (station_id, wa_group_id)
);
alter table public.group_flags enable row level security;
revoke all on public.group_flags from public, anon, authenticated;
grant select, insert, update, delete on public.group_flags to anon, authenticated;

drop policy if exists station_isolation on public.group_flags;
create policy station_isolation on public.group_flags as restrictive for all to public
  using ((select public.is_engine()) or station_id = (select public.my_station()))
  with check ((select public.is_engine()) or station_id = (select public.my_station()));
drop policy if exists "members read" on public.group_flags;
create policy "members read" on public.group_flags as permissive for select to anon, authenticated using (public.my_rank() >= 1);
drop policy if exists "operators insert" on public.group_flags;
create policy "operators insert" on public.group_flags as permissive for insert to anon, authenticated with check (public.my_rank() >= 2);
drop policy if exists "operators update" on public.group_flags;
create policy "operators update" on public.group_flags as permissive for update to anon, authenticated using (public.my_rank() >= 2) with check (public.my_rank() >= 2);
drop policy if exists "operators delete" on public.group_flags;
create policy "operators delete" on public.group_flags as permissive for delete to anon, authenticated using (public.my_rank() >= 2);
drop policy if exists "engine full access" on public.group_flags;
create policy "engine full access" on public.group_flags as permissive for all to anon
  using ((select public.is_engine())) with check ((select public.is_engine()));

-- set flags for many groups at once in the caller's station; a null parameter keeps the current value
create or replace function public.group_flag_set(p_groups text[], p_include_anyway boolean default null,
  p_disabled boolean default null, p_note text default null)
 returns int language plpgsql volatile security definer set search_path to 'public'
as $function$
declare sid uuid := public.my_station(); n int;
begin
  if sid is null or public.my_rank() < 2 then raise exception 'אין הרשאה'; end if;
  insert into public.group_flags as f (station_id, wa_group_id, include_anyway, disabled, note, updated_at, updated_by)
  select sid, g, coalesce(p_include_anyway, false), coalesce(p_disabled, false), nullif(trim(p_note), ''), now(), auth.uid()
  from (select distinct trim(x) g from unnest(coalesce(p_groups, '{}'::text[])) x where coalesce(trim(x), '') <> '') z
  on conflict (station_id, wa_group_id) do update set
    include_anyway = coalesce(p_include_anyway, f.include_anyway),
    disabled = coalesce(p_disabled, f.disabled),
    note = case when p_note is null then f.note else nullif(trim(p_note), '') end,
    updated_at = now(), updated_by = auth.uid();
  get diagnostics n = row_count;
  return n;
end $function$;

create or replace function public.engine_group_flags(p_station uuid)
 returns table(wa_group_id text, include_anyway boolean, disabled boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return query select f.wa_group_id, f.include_anyway, f.disabled from public.group_flags f where f.station_id = p_station;
end $function$;

-- groups whose recent sends ended with a problem (and nothing was sent there by that arm since)
create or replace function public.group_problems(p_hours int default 48)
 returns table(wa_group_id text, arm_id uuid, reason text, last_at timestamptz, n int)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare sid uuid := public.my_station(); h int := least(greatest(coalesce(p_hours, 48), 1), 168);
begin
  if sid is null or public.my_rank() < 1 then raise exception 'אין הרשאה'; end if;
  return query
  with recent as materialized (
    select t.wa_group_id, t.arm_id, t.status, t.error, coalesce(t.sent_at, t.claimed_at, c.created_at) as at
    from public.campaigns c
    join public.campaign_targets t on t.campaign_id = c.id
    where c.station_id = sid and c.created_at > now() - make_interval(hours => h)
      and t.status in ('sent', 'failed', 'skipped')
  ), probs as (
    select r.wa_group_id, r.arm_id, r.at,
      case
        when r.error like '%הרשאה%' then 'no_permission'
        when r.error like 'אין זרוע פנויה%' then 'no_arm'
        when r.error like '%הזרוע לא מחוברת%' then 'arm_offline'
        when r.status = 'failed' then 'send_error'
      end as reason
    from recent r
    where r.status in ('failed', 'skipped') and r.error is not null
      and r.error not like 'ההפצה בוטלה%' and r.error not like '%עברו 15 דקות%'
  ), agg as (
    select p.wa_group_id, p.arm_id, p.reason, max(p.at) as last_at, count(*)::int as n
    from probs p where p.reason is not null
    group by p.wa_group_id, p.arm_id, p.reason
  )
  select a.wa_group_id, a.arm_id, a.reason, a.last_at, a.n
  from agg a
  where not exists (select 1 from recent s where s.status = 'sent' and s.wa_group_id = a.wa_group_id
                      and (a.arm_id is null or s.arm_id = a.arm_id) and s.at > a.last_at)
  order by a.last_at desc;
end $function$;

-- =====================================================================================
-- 3. Subscription & payments
-- =====================================================================================
alter table public.owner_settings add column if not exists bit_link text;
alter table public.owner_settings add column if not exists paybox_link text;
alter table public.owner_settings add column if not exists approvals_phone text default '0532306885';
alter table public.owner_settings add column if not exists support_phone text;
alter table public.owner_settings add column if not exists app_url text default 'https://web-production-e5de3.up.railway.app';

create or replace function public.owner_pay_settings_get()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return (select json_build_object('bit_link', s.bit_link, 'paybox_link', s.paybox_link, 'approvals_phone', s.approvals_phone,
            'support_phone', s.support_phone, 'app_url', s.app_url, 'payment_note', s.payment_note, 'reminder_days', s.reminder_days)
          from public.owner_settings s where s.id = 1);
end $function$;

create or replace function public.owner_pay_settings_save(p_bit text, p_paybox text, p_approvals_phone text,
  p_support_phone text, p_app_url text)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
declare b text := nullif(trim(p_bit), ''); pb text := nullif(trim(p_paybox), ''); u text := rtrim(nullif(trim(p_app_url), ''), '/');
  ap text := nullif(trim(p_approvals_phone), ''); sp text := nullif(trim(p_support_phone), '');
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if b is not null and b !~* '^https://' then raise exception 'קישור ביט חייב להתחיל ב-https://'; end if;
  if pb is not null and pb !~* '^https://' then raise exception 'קישור פייבוקס חייב להתחיל ב-https://'; end if;
  if u is not null and u !~* '^https?://' then raise exception 'כתובת האפליקציה חייבת להתחיל ב-https://'; end if;
  if ap is not null and length(public.norm_phone(ap)) < 11 then raise exception 'מספר טלפון לאישורים לא תקין'; end if;
  if sp is not null and length(public.norm_phone(sp)) < 11 then raise exception 'מספר טלפון לתמיכה לא תקין'; end if;
  insert into public.owner_settings (id) values (1) on conflict do nothing;
  update public.owner_settings set bit_link = b, paybox_link = pb, approvals_phone = ap, support_phone = sp,
    app_url = coalesce(u, 'https://web-production-e5de3.up.railway.app'), updated_at = now()
  where id = 1;
end $function$;

create table if not exists public.payment_requests (
  id bigint generated always as identity primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  amount numeric not null check (amount > 0),
  months int not null default 1 check (months between 1 and 24),
  method text not null check (method in ('bit', 'paybox', 'other')),
  proof_data text check (proof_data is null or (length(proof_data) <= 1500000
                         and (proof_data like 'data:image/%' or proof_data like 'data:application/pdf%'))),
  note text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  reject_reason text,
  decided_by uuid,
  decided_at timestamptz,
  payment_id bigint references public.station_payments(id) on delete set null,
  token uuid not null default gen_random_uuid() unique,
  created_at timestamptz default now()
);
create index if not exists payment_requests_station_idx on public.payment_requests (station_id, created_at desc);
create index if not exists payment_requests_status_idx on public.payment_requests (status, created_at desc);
-- at most one waiting request per station (also under concurrent submits)
create unique index if not exists payment_requests_one_pending on public.payment_requests (station_id) where status = 'pending';
alter table public.payment_requests enable row level security;
revoke all on public.payment_requests from public, anon, authenticated;

-- true if the station may work: the home station, or active with a subscription that has not ended (Israel date)
create or replace function public.station_active(p_station uuid)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$
  select coalesce((select s.is_home or (s.status = 'active' and (s.sub_end is null or s.sub_end >= (now() at time zone 'Asia/Jerusalem')::date))
                   from public.stations s where s.id = p_station), false)
$function$;

create or replace function public.engine_station_active(p_station uuid)
 returns boolean language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return public.station_active(p_station);
end $function$;

-- the station whose billing the caller may handle: the manager of my_station() (rank 3+, or the owner acting),
-- or a still-valid station-code login of a station whose subscription ENDED (so it can pay and renew).
-- Never the home station's billing (handled in the callers).
create or replace function public.billing_station()
 returns uuid language plpgsql stable security definer set search_path to 'public', 'extensions'
as $function$
declare sid uuid := public.my_station(); tok text := public.req_header('x-station-token');
begin
  if sid is not null then
    return case when public.my_rank() >= 3 then sid else null end;
  end if;
  if tok is null then return null; end if;
  select s.station_id into sid
  from public.station_sessions s join public.stations st on st.id = s.station_id
  where s.token_hash = encode(extensions.digest(tok, 'sha256'), 'hex')
    and s.revoked_at is null and s.last_seen > now() - interval '30 days'
    and st.status = 'active' and not st.is_home;
  return sid;
end $function$;

create or replace function public.pay_method_label(p text)
 returns text language sql immutable set search_path to 'public'
as $function$ select case p when 'bit' then 'ביט' when 'paybox' then 'פייבוקס' else 'אחר' end $function$;

-- what the station's billing screen shows
create or replace function public.station_billing()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
declare sid uuid := public.billing_station(); st public.stations; os public.owner_settings;
  today date := (now() at time zone 'Asia/Jerusalem')::date;
begin
  if sid is null then raise exception 'אין הרשאה'; end if;
  select * into st from public.stations where id = sid;
  if st.is_home then return null; end if;
  select * into os from public.owner_settings where id = 1;
  return json_build_object(
    'station_id', st.id, 'name', st.name, 'plan', st.plan, 'price', st.price, 'sub_end', st.sub_end, 'status', st.status,
    'days_left', case when st.sub_end is null then null else st.sub_end - today end,
    'bit_link', os.bit_link, 'paybox_link', os.paybox_link, 'payment_note', os.payment_note,
    'payments', coalesce((select json_agg(json_build_object('id', p.id, 'amount', p.amount, 'months', p.months, 'paid_at', p.paid_at, 'method', p.method)
                                         order by p.paid_at desc, p.id desc)
                          from (select * from public.station_payments where station_id = sid order by paid_at desc, id desc limit 50) p), '[]'::json),
    'requests', coalesce((select json_agg(json_build_object('id', r.id, 'amount', r.amount, 'months', r.months, 'method', r.method, 'status', r.status,
                                           'reject_reason', r.reject_reason, 'created_at', r.created_at, 'decided_at', r.decided_at) order by r.id desc)
                          from (select * from public.payment_requests where station_id = sid order by id desc limit 50) r), '[]'::json));
end $function$;

-- the station sends a payment proof; the owner gets a WhatsApp with a link to approve / reject
create or replace function public.station_payment_submit(p_amount numeric, p_months int, p_method text, p_proof text, p_note text default null)
 returns json language plpgsql volatile security definer set search_path to 'public'
as $function$
declare sid uuid := public.billing_station(); st public.stations; os public.owner_settings; rid bigint; tok uuid;
  pr text := nullif(trim(coalesce(p_proof, '')), ''); ph text; url text;
begin
  if sid is null then raise exception 'אין הרשאה'; end if;
  select * into st from public.stations where id = sid;
  if st.id is null or st.is_home then raise exception 'לא נדרש בחשבון הראשי'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'סכום לא תקין'; end if;
  if p_months is null or p_months < 1 or p_months > 24 then raise exception 'מספר חודשים לא תקין (1–24)'; end if;
  if p_method is null or p_method not in ('bit', 'paybox', 'other') then raise exception 'אמצעי תשלום לא תקין'; end if;
  if pr is not null then
    if pr !~ '^data:(image/(png|jpeg|jpg|webp|gif)|application/pdf);base64,' then raise exception 'האסמכתה חייבת להיות תמונה או PDF'; end if;
    if length(pr) > 1500000 then raise exception 'האסמכתה גדולה מדי (עד כ-1MB)'; end if;
  end if;
  perform 1 from public.stations where id = sid for update;  -- one submit at a time per station
  if exists (select 1 from public.payment_requests where station_id = sid and status = 'pending') then
    raise exception 'כבר קיימת בקשה ממתינה';
  end if;
  insert into public.payment_requests (station_id, amount, months, method, proof_data, note)
  values (sid, p_amount, p_months, p_method, pr, nullif(trim(p_note), ''))
  returning id, token into rid, tok;

  select * into os from public.owner_settings where id = 1;
  ph := public.norm_phone(os.approvals_phone);
  url := rtrim(coalesce(nullif(trim(os.app_url), ''), 'https://web-production-e5de3.up.railway.app'), '/');
  if ph is not null then
    insert into public.wa_outbox (to_phone, body, expires_at)
    values (ph, 'בקשת תשלום חדשה #' || rid || chr(10)
      || 'תחנה: ' || st.name || chr(10)
      || 'סכום: ' || trim_scale(p_amount)::text || ' ₪ (' || public.pay_method_label(p_method) || ')' || chr(10)
      || 'חודשים: ' || p_months || chr(10)
      || case when nullif(trim(p_note), '') is not null then 'הערה: ' || trim(p_note) || chr(10) else '' end
      || 'לאישור או דחייה: ' || url || '/pay?r=' || tok,
      now() + interval '1 day');
  end if;
  insert into public.activity_log (actor_id, actor_name, action, entity, entity_id, details, station_id)
  values (auth.uid(), case when public.req_header('x-station-token') is not null then 'מנהל התחנה'
                           else (select coalesce(full_name, email) from public.profiles where id = auth.uid()) end,
          'payment_request', 'payment_request', rid::text,
          jsonb_build_object('amount', p_amount, 'months', p_months, 'method', p_method), sid);
  return json_build_object('id', rid, 'token', tok);
end $function$;

create or replace function public.station_payment_cancel(p_id bigint)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
declare sid uuid := public.billing_station();
begin
  if sid is null then raise exception 'אין הרשאה'; end if;
  update public.payment_requests set status = 'cancelled', decided_at = now()
  where id = p_id and station_id = sid and status = 'pending';
  if not found then raise exception 'הבקשה לא נמצאה או שכבר טופלה'; end if;
end $function$;

create or replace function public.owner_payment_requests(p_status text default null)
 returns table(id bigint, station_id uuid, station_name text, amount numeric, months int, method text, status text, note text,
   reject_reason text, created_at timestamptz, decided_at timestamptz, decided_by_name text, has_proof boolean, token uuid)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select r.id, r.station_id, s.name, r.amount, r.months, r.method, r.status, r.note, r.reject_reason, r.created_at, r.decided_at,
    (select coalesce(p.full_name, p.email) from public.profiles p where p.id = r.decided_by), r.proof_data is not null, r.token
  from public.payment_requests r join public.stations s on s.id = r.station_id
  where p_status is null or r.status = p_status
  order by (r.status = 'pending') desc, r.created_at desc limit 300;
end $function$;

create or replace function public.owner_payment_request_get(p_id bigint default null, p_token uuid default null)
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_id is null and p_token is null then return null; end if;
  return (select json_build_object('id', r.id, 'station_id', r.station_id, 'station_name', s.name, 'station_phone', s.phone,
            'price', s.price, 'sub_end', s.sub_end, 'station_status', s.status, 'amount', r.amount, 'months', r.months,
            'method', r.method, 'status', r.status, 'note', r.note, 'reject_reason', r.reject_reason, 'proof_data', r.proof_data,
            'created_at', r.created_at, 'decided_at', r.decided_at,
            'decided_by_name', (select coalesce(p.full_name, p.email) from public.profiles p where p.id = r.decided_by),
            'payment_id', r.payment_id, 'token', r.token)
          from public.payment_requests r join public.stations s on s.id = r.station_id
          where (p_id is null or r.id = p_id) and (p_token is null or r.token = p_token)
          limit 1);
end $function$;

-- approve (records the payment and extends the subscription) or reject (needs a reason); only once per request
create or replace function public.owner_payment_decide(p_id bigint, p_approve boolean, p_reason text default null)
 returns json language plpgsql volatile security definer set search_path to 'public'
as $function$
declare r public.payment_requests; st public.stations; pid bigint; d date; ph text;
  today date := (now() at time zone 'Asia/Jerusalem')::date; reason text := nullif(trim(p_reason), '');
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_approve is null then raise exception 'חסרה החלטה'; end if;
  select * into r from public.payment_requests where id = p_id for update;
  if r.id is null then raise exception 'הבקשה לא נמצאה'; end if;
  if r.status <> 'pending' then raise exception 'הבקשה כבר טופלה'; end if;
  select * into st from public.stations where id = r.station_id for update;
  ph := public.norm_phone(st.phone);
  if p_approve then
    insert into public.station_payments (station_id, amount, months, paid_at, method, note, created_by)
    values (r.station_id, r.amount, r.months, today, public.pay_method_label(r.method), 'בקשת תשלום #' || r.id, auth.uid())
    returning id into pid;
    update public.stations
    set sub_end = (greatest(coalesce(sub_end, today), today) + make_interval(months => r.months))::date, status = 'active'
    where id = r.station_id returning sub_end into d;
    update public.payment_requests set status = 'approved', payment_id = pid, decided_by = auth.uid(), decided_at = now() where id = r.id;
    insert into public.system_messages (title, body, level, station_id, ends_at)
    values ('התשלום אושר', 'התשלום על סך ' || trim_scale(r.amount)::text || ' ₪ התקבל. המנוי בתוקף עד ' || to_char(d, 'DD/MM/YYYY') || '. תודה!',
            'info', r.station_id, now() + interval '7 days');
    if ph is not null then
      insert into public.wa_outbox (to_phone, body, expires_at)
      values (ph, 'התשלום של ' || st.name || ' על סך ' || trim_scale(r.amount)::text || ' ₪ אושר.' || chr(10)
                  || 'המנוי בתוקף עד ' || to_char(d, 'DD/MM/YYYY') || '. תודה!', now() + interval '1 day');
    end if;
    return json_build_object('status', 'approved', 'sub_end', d);
  else
    if reason is null then raise exception 'יש לכתוב סיבת דחייה'; end if;
    update public.payment_requests set status = 'rejected', reject_reason = reason, decided_by = auth.uid(), decided_at = now() where id = r.id;
    insert into public.system_messages (title, body, level, station_id, ends_at)
    values ('התשלום לא אושר', 'הסיבה: ' || reason || '. אפשר להגיש אסמכתה מחדש במסך "מנוי ותשלום".', 'warning', r.station_id, now() + interval '7 days');
    if ph is not null then
      insert into public.wa_outbox (to_phone, body, expires_at)
      values (ph, 'בקשת התשלום #' || r.id || ' של ' || st.name || ' לא אושרה.' || chr(10) || 'הסיבה: ' || reason || chr(10)
                  || 'אפשר להגיש אסמכתה מחדש באפליקציה.', now() + interval '1 day');
    end if;
    return json_build_object('status', 'rejected', 'sub_end', st.sub_end);
  end if;
end $function$;

-- ---------- subscription alerts (daily, by pg_cron) ----------
create table if not exists public.sub_alerts (
  station_id uuid not null references public.stations(id) on delete cascade,
  sub_end date not null,
  kind text not null check (kind in ('before', 'expired')),
  sent_at timestamptz default now(),
  primary key (station_id, sub_end, kind)
);
alter table public.sub_alerts enable row level security;
revoke all on public.sub_alerts from public, anon, authenticated;

-- once per (station, subscription end): a reminder N days before, and a notice when it ended.
-- Stations that ended more than 7 days ago are not messaged (old trials). Returns WhatsApp messages queued.
create or replace function public.subscription_alerts()
 returns int language plpgsql volatile security definer set search_path to 'public'
as $function$
declare os public.owner_settings; today date := (now() at time zone 'Asia/Jerusalem')::date; s record;
  owner_ph text; st_ph text; url text; n int := 0; k text; ins int; days int;
begin
  select * into os from public.owner_settings where id = 1;
  owner_ph := public.norm_phone(os.approvals_phone);
  url := rtrim(coalesce(nullif(trim(os.app_url), ''), 'https://web-production-e5de3.up.railway.app'), '/');
  for s in
    select st.* from public.stations st
    where not st.is_home and st.status = 'active' and st.sub_end is not null
      and st.sub_end between today - 7 and today + coalesce(os.reminder_days, 3)
    order by st.sub_end
  loop
    k := case when s.sub_end < today then 'expired' else 'before' end;
    insert into public.sub_alerts (station_id, sub_end, kind) values (s.id, s.sub_end, k) on conflict do nothing;
    get diagnostics ins = row_count;
    continue when ins = 0;
    st_ph := public.norm_phone(s.phone);
    days := s.sub_end - today;
    if k = 'before' then
      insert into public.system_messages (title, body, level, station_id, ends_at)
      values ('המנוי מסתיים בקרוב', 'המנוי מסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY') || '. כדי שהבוט ימשיך לעבוד בלי הפסקה, אפשר לשלם במסך "מנוי ותשלום".',
              'warning', s.id, s.sub_end + interval '1 day');
      if st_ph is not null then
        insert into public.wa_outbox (to_phone, body, expires_at)
        values (st_ph, 'תזכורת: המנוי של ' || s.name || ' מסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY')
                  || case when days = 0 then ' (היום)' else ' (בעוד ' || days || ' ימים)' end || '.' || chr(10)
                  || 'לחידוש ותשלום: ' || url, now() + interval '1 day');
        n := n + 1;
      end if;
      if owner_ph is not null then
        insert into public.wa_outbox (to_phone, body, expires_at)
        values (owner_ph, 'תזכורת: המנוי של ' || s.name || ' מסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY')
                  || case when days = 0 then ' (היום)' else ' (בעוד ' || days || ' ימים)' end || '.'
                  || coalesce(chr(10) || 'טלפון התחנה: ' || s.phone, ''), now() + interval '1 day');
        n := n + 1;
      end if;
    else
      insert into public.system_messages (title, body, level, station_id, ends_at)
      values ('המנוי הסתיים', 'המנוי הסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY') || '. הבוט הפסיק לטפל בהודעות התחנה עד לחידוש. '
                || 'הזרועות נשארות מחוברות – אין צורך לסרוק QR מחדש.', 'urgent', s.id, now() + interval '30 days');
      if st_ph is not null then
        insert into public.wa_outbox (to_phone, body, expires_at)
        values (st_ph, 'המנוי של ' || s.name || ' הסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY') || '.' || chr(10)
                  || 'הבוט הפסיק לטפל בהודעות התחנה עד לחידוש. הזרועות נשארות מחוברות – אין צורך לסרוק QR מחדש.' || chr(10)
                  || 'לחידוש ותשלום: ' || url, now() + interval '1 day');
        n := n + 1;
      end if;
      if owner_ph is not null then
        insert into public.wa_outbox (to_phone, body, expires_at)
        values (owner_ph, 'המנוי של ' || s.name || ' הסתיים ב-' || to_char(s.sub_end, 'DD/MM/YYYY')
                  || '. הבוט הפסיק לטפל בהודעות התחנה עד לחידוש (הזרועות נשארות מחוברות).'
                  || coalesce(chr(10) || 'טלפון התחנה: ' || s.phone, ''), now() + interval '1 day');
        n := n + 1;
      end if;
    end if;
  end loop;
  return n;
end $function$;

-- =====================================================================================
-- 4. Support
-- =====================================================================================
create table if not exists public.support_tickets (
  id bigint generated always as identity primary key,
  station_id uuid not null references public.stations(id) on delete cascade,
  arm_id uuid references public.arms(id) on delete set null,
  category text not null check (category in ('arm', 'distribution', 'groups', 'billing', 'account', 'other')),
  subject text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'waiting', 'closed')),
  created_by_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_reply_by text check (last_reply_by in ('station', 'owner'))
);
create index if not exists support_tickets_station_idx on public.support_tickets (station_id, updated_at desc);
create index if not exists support_tickets_status_idx on public.support_tickets (status, updated_at desc);
alter table public.support_tickets enable row level security;
revoke all on public.support_tickets from public, anon, authenticated;

create table if not exists public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id bigint not null references public.support_tickets(id) on delete cascade,
  station_id uuid,
  author text not null check (author in ('station', 'owner')),
  author_name text,
  body text,
  image_data text check (image_data is null or (length(image_data) <= 1500000 and image_data like 'data:image/%')),
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on public.support_messages (ticket_id, id);
alter table public.support_messages enable row level security;
revoke all on public.support_messages from public, anon, authenticated;

create or replace function public.support_category_label(p text)
 returns text language sql immutable set search_path to 'public'
as $function$
  select case p when 'arm' then 'זרוע' when 'distribution' then 'הפצה' when 'groups' then 'קבוצות'
                when 'billing' then 'תשלום' when 'account' then 'חשבון' else 'אחר' end
$function$;

create or replace function public.support_check_image(p text)
 returns text language plpgsql immutable set search_path to 'public'
as $function$
declare d text := nullif(trim(coalesce(p, '')), '');
begin
  if d is null then return null; end if;
  if d !~ '^data:image/(png|jpeg|jpg|webp|gif);base64,' then raise exception 'פורמט תמונה לא נתמך (PNG / JPG / WEBP)'; end if;
  if length(d) > 1500000 then raise exception 'התמונה גדולה מדי (עד כ-1MB)'; end if;
  return d;
end $function$;

create or replace function public.support_ticket_create(p_category text, p_subject text, p_body text, p_arm uuid default null, p_image text default null)
 returns bigint language plpgsql volatile security definer set search_path to 'public'
as $function$
declare sid uuid := public.my_station(); st public.stations; os public.owner_settings; tid bigint; nm text; img text; ph text; url text;
begin
  if sid is null or public.my_rank() < 2 then raise exception 'אין הרשאה'; end if;
  select * into st from public.stations where id = sid;
  if st.is_home then raise exception 'לא נדרש בחשבון הראשי'; end if;
  if p_category is null or p_category not in ('arm', 'distribution', 'groups', 'billing', 'account', 'other') then raise exception 'נושא לא תקין'; end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'חסרה כותרת לפנייה'; end if;
  if coalesce(trim(p_body), '') = '' and nullif(trim(coalesce(p_image, '')), '') is null then raise exception 'חסר תיאור הבעיה'; end if;
  if p_arm is not null and not exists (select 1 from public.arms where id = p_arm and station_id = sid) then raise exception 'הזרוע לא שייכת לתחנה'; end if;
  img := public.support_check_image(p_image);
  nm := case when public.req_header('x-station-token') is not null then 'מנהל התחנה'
             else (select coalesce(full_name, email) from public.profiles where id = auth.uid()) end;
  insert into public.support_tickets (station_id, arm_id, category, subject, created_by_name, last_reply_by)
  values (sid, p_arm, p_category, left(trim(p_subject), 200), nm, 'station') returning id into tid;
  insert into public.support_messages (ticket_id, station_id, author, author_name, body, image_data)
  values (tid, sid, 'station', nm, nullif(trim(p_body), ''), img);
  select * into os from public.owner_settings where id = 1;
  ph := public.norm_phone(coalesce(nullif(trim(os.support_phone), ''), os.approvals_phone));
  url := rtrim(coalesce(nullif(trim(os.app_url), ''), 'https://web-production-e5de3.up.railway.app'), '/');
  if ph is not null then
    insert into public.wa_outbox (to_phone, body, expires_at)
    values (ph, 'פנייה חדשה #' || tid || ' מתחנה ' || st.name || ': ' || left(trim(p_subject), 200)
                || ' (' || public.support_category_label(p_category) || ')' || chr(10) || url || '/support?t=' || tid, now() + interval '1 day');
  end if;
  return tid;
end $function$;

-- a reply: by the station (members of the ticket's station) or by the owner (not acting as a station)
create or replace function public.support_reply(p_ticket bigint, p_body text, p_image text default null)
 returns bigint language plpgsql volatile security definer set search_path to 'public'
as $function$
declare t public.support_tickets; is_owner boolean := public.is_super() and public.req_header('x-act-station') is null;
  who text; nm text; img text; mid bigint; ph text; url text;
begin
  select * into t from public.support_tickets where id = p_ticket for update;
  if t.id is null then raise exception 'הפנייה לא נמצאה'; end if;
  if is_owner then
    who := 'owner';
    nm := (select coalesce(full_name, email) from public.profiles where id = auth.uid());
  elsif public.my_rank() >= 1 and t.station_id = public.my_station() then
    who := 'station';
    nm := case when public.req_header('x-station-token') is not null then 'מנהל התחנה'
               else (select coalesce(full_name, email) from public.profiles where id = auth.uid()) end;
  else
    raise exception 'הפנייה לא נמצאה';
  end if;
  if coalesce(trim(p_body), '') = '' and nullif(trim(coalesce(p_image, '')), '') is null then raise exception 'ההודעה ריקה'; end if;
  img := public.support_check_image(p_image);
  insert into public.support_messages (ticket_id, station_id, author, author_name, body, image_data)
  values (t.id, t.station_id, who, nm, nullif(trim(p_body), ''), img) returning id into mid;
  update public.support_tickets set updated_at = now(), last_reply_by = who,
    status = case when who = 'owner' then (case when status = 'closed' then status else 'waiting' end)
                  else (case when status in ('waiting', 'closed') then 'open' else status end) end
  where id = t.id;
  if who = 'owner' then
    select public.norm_phone(phone) into ph from public.stations where id = t.station_id;
    select rtrim(coalesce(nullif(trim(app_url), ''), 'https://web-production-e5de3.up.railway.app'), '/') into url from public.owner_settings where id = 1;
    if ph is not null then
      insert into public.wa_outbox (to_phone, body, expires_at)
      values (ph, 'התקבלה תשובה לפנייה #' || t.id || ': ' || t.subject || chr(10)
                  || coalesce(url, 'https://web-production-e5de3.up.railway.app') || '/support?t=' || t.id, now() + interval '1 day');
    end if;
  end if;
  return mid;
end $function$;

create or replace function public.support_tickets(p_status text default null)
 returns table(id bigint, station_id uuid, station_name text, arm_id uuid, arm_name text, category text, subject text, status text,
   created_at timestamptz, updated_at timestamptz, last_reply_by text, messages int)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare all_st boolean := public.is_super() and public.req_header('x-act-station') is null; sid uuid := public.my_station();
begin
  if not all_st and (sid is null or public.my_rank() < 1) then raise exception 'אין הרשאה'; end if;
  return query
  select t.id, t.station_id, s.name, t.arm_id, a.name, t.category, t.subject, t.status, t.created_at, t.updated_at, t.last_reply_by,
    (select count(*)::int from public.support_messages m where m.ticket_id = t.id)
  from public.support_tickets t
  join public.stations s on s.id = t.station_id
  left join public.arms a on a.id = t.arm_id
  where (all_st or t.station_id = sid) and (p_status is null or t.status = p_status)
  order by (t.status = 'closed'), t.updated_at desc limit 500;
end $function$;

create or replace function public.support_ticket_get(p_id bigint)
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
declare all_st boolean := public.is_super() and public.req_header('x-act-station') is null; sid uuid := public.my_station();
begin
  if not all_st and (sid is null or public.my_rank() < 1) then raise exception 'אין הרשאה'; end if;
  return (select json_build_object('id', t.id, 'station_id', t.station_id, 'station_name', s.name, 'station_phone', case when all_st then s.phone end,
            'arm_id', t.arm_id, 'arm_name', a.name, 'category', t.category, 'subject', t.subject, 'status', t.status,
            'created_by_name', t.created_by_name, 'created_at', t.created_at, 'updated_at', t.updated_at, 'last_reply_by', t.last_reply_by,
            'messages', coalesce((select json_agg(json_build_object('id', m.id, 'author', m.author, 'author_name', m.author_name, 'body', m.body,
                                                   'image_data', m.image_data, 'created_at', m.created_at) order by m.id)
                                  from public.support_messages m where m.ticket_id = t.id), '[]'::json))
          from public.support_tickets t
          join public.stations s on s.id = t.station_id
          left join public.arms a on a.id = t.arm_id
          where t.id = p_id and (all_st or t.station_id = sid));
end $function$;

create or replace function public.support_ticket_status(p_id bigint, p_status text)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if p_status is null or p_status not in ('open', 'in_progress', 'waiting', 'closed') then raise exception 'סטטוס לא תקין'; end if;
  update public.support_tickets set status = p_status, updated_at = now() where id = p_id;
  if not found then raise exception 'הפנייה לא נמצאה'; end if;
end $function$;

-- =====================================================================================
-- 6. Message footer ("חתימה בהודעות"): a line the OWNER controls that is added under every message the
--    engine sends for a station (rides, help, manual sends). Set per station or for all stations at once.
--    Stations can read their own footer (to preview it) but cannot change it.
-- =====================================================================================
create table if not exists public.message_footers (
  station_id uuid primary key references public.stations(id) on delete cascade,
  footer_text text not null default '' check (char_length(footer_text) <= 500),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid
);
alter table public.message_footers enable row level security;
revoke all on public.message_footers from public, anon, authenticated;

-- all stations with their footer (owner screen)
create or replace function public.owner_footers()
 returns table(station_id uuid, station_name text, is_home boolean, status text, footer_text text, enabled boolean, updated_at timestamptz)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select s.id, s.name, s.is_home, s.status, coalesce(f.footer_text, ''), coalesce(f.enabled, false), f.updated_at
  from public.stations s left join public.message_footers f on f.station_id = s.id
  order by s.is_home desc, s.name;
end $function$;

-- set the footer for the given stations (null/empty array = ALL stations) in one action; returns rows changed
create or replace function public.owner_footer_set(p_stations uuid[], p_text text, p_enabled boolean default true)
 returns integer language plpgsql volatile security definer set search_path to 'public'
as $function$
declare n int; t text := coalesce(btrim(p_text), '');
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  if char_length(t) > 500 then raise exception 'החתימה ארוכה מדי (עד 500 תווים)'; end if;
  insert into public.message_footers (station_id, footer_text, enabled, updated_at, updated_by)
  select s.id, t, coalesce(p_enabled, true) and t <> '', now(), auth.uid()
  from public.stations s
  where p_stations is null or cardinality(p_stations) = 0 or s.id = any(p_stations)
  on conflict (station_id) do update
    set footer_text = excluded.footer_text, enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
  get diagnostics n = row_count;
  return n;
end $function$;

-- the footer of the station I am in (read-only preview for station users)
create or replace function public.station_footer()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
declare sid uuid := public.my_station(); r record;
begin
  if sid is null or public.my_rank() < 1 then return null; end if;
  select footer_text, enabled into r from public.message_footers where station_id = sid;
  if not found or not r.enabled or r.footer_text = '' then return json_build_object('enabled', false, 'footer_text', ''); end if;
  return json_build_object('enabled', true, 'footer_text', r.footer_text);
end $function$;

-- engine: the footer text to add for a station, or null when none
create or replace function public.engine_station_footer(p_station uuid)
 returns text language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return (select nullif(footer_text, '') from public.message_footers where station_id = p_station and enabled);
end $function$;

do $$ declare f text; begin
  foreach f in array array['owner_footers()', 'owner_footer_set(uuid[],text,boolean)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  execute 'revoke execute on function public.station_footer() from public';
  execute 'grant execute on function public.station_footer() to anon, authenticated';
  execute 'revoke execute on function public.engine_station_footer(uuid) from public, authenticated';
  execute 'grant execute on function public.engine_station_footer(uuid) to anon';
end $$;

-- =====================================================================================
-- Function permissions (Supabase grants new functions to everyone by default: revoke, then grant)
-- =====================================================================================
do $$ declare f text; begin
  -- app users (station code = anon + header, profiles = authenticated); each function checks the caller itself
  foreach f in array array['station_set_logo(uuid,text)', 'station_brand()', 'group_flag_set(text[],boolean,boolean,text)',
    'group_problems(integer)', 'station_billing()', 'station_payment_submit(numeric,integer,text,text,text)',
    'station_payment_cancel(bigint)', 'station_active(uuid)', 'support_ticket_create(text,text,text,uuid,text)',
    'support_reply(bigint,text,text)', 'support_tickets(text)', 'support_ticket_get(bigint)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
  -- owner only (a logged-in profile)
  foreach f in array array['owner_station_logos()', 'owner_pay_settings_get()', 'owner_pay_settings_save(text,text,text,text,text)',
    'owner_payment_requests(text)', 'owner_payment_request_get(bigint,uuid)', 'owner_payment_decide(bigint,boolean,text)',
    'support_ticket_status(bigint,text)'] loop
    execute format('revoke execute on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
  -- engine (anon + engine key)
  foreach f in array array['engine_group_flags(uuid)', 'engine_station_active(uuid)'] loop
    execute format('revoke execute on function public.%s from public, authenticated', f);
    execute format('grant execute on function public.%s to anon', f);
  end loop;
  -- internal helpers and the daily job: server only
  foreach f in array array['subscription_alerts()', 'billing_station()', 'pay_method_label(text)', 'support_category_label(text)',
    'support_check_image(text)'] loop
    execute format('revoke execute on function public.%s from public, anon, authenticated', f);
  end loop;
end $$;


-- daily subscription alerts (10:07 Israel)
-- BotiX v2: daily subscription alerts (07:07 UTC ≈ 10:07 Israel). Apply after 20261013_v2.sql.
select cron.unschedule('subscription-alerts') where exists (select 1 from cron.job where jobname = 'subscription-alerts');
select cron.schedule('subscription-alerts', '7 7 * * *', $$select public.subscription_alerts()$$);
$r2$, $r2$-- Undo of 20261013_v2.sql: removes ONLY the objects that release added (its functions, its tables and its
-- columns). Existing data, WhatsApp connections, groups, lists, payments and messages are not touched.
-- Note: the new tables' own rows (group flags, payment requests, support tickets, alert log) and the new
-- columns (station logo / plan, payment links) are removed with them.
select set_config('lock_timeout', '5s', true);
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'subscription-alerts';
  end if;
end $$;

drop function if exists public.owner_footers();
drop function if exists public.owner_footer_set(uuid[], text, boolean);
drop function if exists public.station_footer();
drop function if exists public.engine_station_footer(uuid);
drop table if exists public.message_footers;
drop function if exists public.station_set_logo(uuid, text);
drop function if exists public.station_brand();
drop function if exists public.owner_station_logos();
drop function if exists public.group_flag_set(text[], boolean, boolean, text);
drop function if exists public.engine_group_flags(uuid);
drop function if exists public.group_problems(integer);
drop function if exists public.owner_pay_settings_get();
drop function if exists public.owner_pay_settings_save(text, text, text, text, text);
drop function if exists public.station_active(uuid);
drop function if exists public.engine_station_active(uuid);
drop function if exists public.station_billing();
drop function if exists public.station_payment_submit(numeric, integer, text, text, text);
drop function if exists public.station_payment_cancel(bigint);
drop function if exists public.owner_payment_requests(text);
drop function if exists public.owner_payment_request_get(bigint, uuid);
drop function if exists public.owner_payment_decide(bigint, boolean, text);
drop function if exists public.subscription_alerts();
drop function if exists public.billing_station();
drop function if exists public.pay_method_label(text);
drop function if exists public.support_ticket_create(text, text, text, uuid, text);
drop function if exists public.support_reply(bigint, text, text);
drop function if exists public.support_tickets(text);
drop function if exists public.support_ticket_get(bigint);
drop function if exists public.support_ticket_status(bigint, text);
drop function if exists public.support_category_label(text);
drop function if exists public.support_check_image(text);

drop table if exists public.support_messages;
drop table if exists public.support_tickets;
drop table if exists public.sub_alerts;
drop table if exists public.payment_requests;
drop table if exists public.group_flags;

alter table public.owner_settings drop column if exists app_url;
alter table public.owner_settings drop column if exists support_phone;
alter table public.owner_settings drop column if exists approvals_phone;
alter table public.owner_settings drop column if exists paybox_link;
alter table public.owner_settings drop column if exists bit_link;
alter table public.stations drop column if exists plan;
alter table public.stations drop column if exists logo_data;
$r2$, 'pending');
insert into public.releases (version, title, changes, components, affects_arms, disconnect_risk, restart_engine, risk_notes, commit_sha, migration_sql, rollback_sql, status)
values ('2.0.2', 'BotiX 2 – שרת הוואטסאפ', array['שליחת הודעות מערכת בוואטסאפ: קודי כניסה, בקשות תשלום, תשובות לפניות, התראות מנוי (היום לא נשלחות בכלל)', 'החתימה מתווספת מתחת לכל הודעה של התחנה', 'מנוי שהסתיים: הבוט לא מטפל בהודעות התחנה, הזרועות נשארות מחוברות (בלי QR בחידוש), והתחנה יכולה להיכנס רק כדי לשלם', 'קבוצות מושבתות לא מקבלות נסיעות', 'קבוצות שאין בהן זרוע מחוברת של הרשימה לא נספרות ככישלון'], '{engine,db}', true, 'short', true,
  'הפעלה מחדש של השרת: הזרועות מתנתקות לכ-30 שניות וחוזרות לבד, בלי QR. העדכון מחכה אוטומטית לרגע בלי הפצה פעילה. אם הזרועות לא חוזרות – חזרה אוטומטית לגרסה הקודמת. חייב לעלות אחרי 2.0.1.', 'fe2a5513a1445f6733067b14e5da3c1b9385bc5d',
  $r2$-- BotiX v2b – a station whose subscription ended keeps its WhatsApp arms connected (no QR on renewal) and can
-- still log in with its code, but only to pay and renew. The engine (branch engine-v2) stops handling that
-- station's rides via engine_station_active().
-- ORDER: deploy the engine-v2 code BEFORE this file. With the old engine this file would let the arms of an
-- expired station keep distributing.
select set_config('lock_timeout', '5s', true);

-- arms run for: the home station and every active (not suspended) station, also after the subscription ended
create or replace function public.engine_station_states()
 returns table(id uuid, allowed boolean)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return query select s.id, (s.is_home or s.status = 'active') from public.stations s;
end $function$;

-- same as the live version (login hardening), except: an ended subscription logs in too and is marked expired
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
  tok := encode(extensions.gen_random_bytes(32), 'hex');
  insert into public.station_sessions (token_hash, station_id) values (encode(extensions.digest(tok, 'sha256'), 'hex'), st.id);
  insert into public.station_login_attempts (ip, ok) values (v_ip, true);
  return json_build_object('token', tok, 'station', st.name,
    'expired', st.sub_end is not null and st.sub_end < (now() at time zone 'Asia/Jerusalem')::date);
end $function$;
$r2$, $r2$-- Undo of 20261013_v2b_expired.sql: back to the live behaviour (expired → arms stop, login refused).
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
$r2$, 'pending');
insert into public.releases (version, title, changes, components, affects_arms, disconnect_risk, restart_engine, risk_notes, commit_sha, migration_sql, rollback_sql, status)
values ('2.0.3', 'BotiX 2 – האתר החדש', array['עיצוב חדש לכל המסכים, מצב כהה, התאמה מלאה לטלפון', 'מסך בית חדש עם מצב התחנה', 'ניהול קבוצות והפצה משופר', 'מסכי מנוי ותשלומים, אישור תשלום, תמיכה טכנית, חתימה בהודעות', 'לוגו לכל תחנה'], '{web}', false, 'none', false,
  'שינוי באתר בלבד – הזרועות וההפצות לא מושפעות. חייב לעלות אחרי 2.0.1.', 'fe2a5513a1445f6733067b14e5da3c1b9385bc5d',
  null, null, 'pending');

select id, version, title, status, components from public.releases where version like '2.0.%' order by id;
