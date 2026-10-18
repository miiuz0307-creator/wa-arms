-- Notifications (18 Oct): one feed per station + one for the system owner, phone notifications (web push),
-- an automatic notice when an arm is not working for 5 minutes and when it is back, and the owner's system
-- messages go to the same feed. Additive only.

create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  station_id uuid references public.stations(id),          -- the station whose people see it (null = owner only)
  for_owner boolean not null default false,                 -- the system owner sees it too
  kind text not null default 'system' check (kind in ('system', 'arm_down', 'arm_up')),
  level text not null default 'info' check (level in ('info', 'warning', 'urgent')),
  title text not null,
  body text,
  url text,
  arm_id uuid,
  created_at timestamptz not null default now(),
  station_read_at timestamptz,
  owner_read_at timestamptz,
  pushed_at timestamptz
);
create index if not exists notifications_station_idx on public.notifications (station_id, created_at desc);
create index if not exists notifications_owner_idx on public.notifications (created_at desc) where for_owner;
alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;

-- phones / browsers that agreed to get notifications
create table if not exists public.push_subscriptions (
  id bigint generated always as identity primary key,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  station_id uuid references public.stations(id),
  is_owner boolean not null default false,
  user_id uuid,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures int not null default 0
);
create index if not exists push_subscriptions_station_idx on public.push_subscriptions (station_id);
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon, authenticated;

-- when the "not working" notice was sent for an arm (cleared when it works again)
alter table public.arms add column if not exists down_notified_at timestamptz;
-- arms that are already down today (blocked, waiting for QR) do not all fire at once when this goes live
update public.arms set down_notified_at = now()
where is_active and status <> 'online' and down_notified_at is null;

-- who is asking: the owner (own account) or a station
create or replace function public.notif_viewer() returns table(is_owner boolean, station uuid)
language sql stable security definer set search_path = public as $$
  select public.is_super() and public.req_header('x-act-station') is null,
         case when public.is_super() and public.req_header('x-act-station') is null then null else public.my_station() end
$$;

create or replace function public.my_notifications(p_limit int default 60)
returns json language plpgsql stable security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.notif_viewer();
  if not v.is_owner and v.station is null then return '[]'::json; end if;
  return coalesce((
    select json_agg(x order by x.created_at desc) from (
      select n.id, n.kind, n.level, n.title, n.body, n.url, n.created_at,
             (case when v.is_owner then n.owner_read_at else n.station_read_at end) is not null as read,
             case when v.is_owner and n.station_id is not null then (select s.name from public.stations s where s.id = n.station_id and not s.is_home) end as station_name
      from public.notifications n
      where (v.is_owner and n.for_owner) or (not v.is_owner and n.station_id = v.station)
      order by n.created_at desc
      limit least(greatest(coalesce(p_limit, 60), 1), 200)
    ) x), '[]'::json);
end $$;

create or replace function public.notifications_unread() returns int
language plpgsql stable security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.notif_viewer();
  if v.is_owner then
    return (select count(*) from public.notifications where for_owner and owner_read_at is null and created_at > now() - interval '30 days');
  end if;
  if v.station is null then return 0; end if;
  return (select count(*) from public.notifications where station_id = v.station and station_read_at is null and created_at > now() - interval '30 days');
end $$;

-- mark read: the given ids, or everything when p_ids is null
create or replace function public.notifications_mark_read(p_ids bigint[] default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.notif_viewer();
  if v.is_owner then
    update public.notifications set owner_read_at = now()
    where for_owner and owner_read_at is null and (p_ids is null or id = any (p_ids));
  elsif v.station is not null then
    update public.notifications set station_read_at = now()
    where station_id = v.station and station_read_at is null and (p_ids is null or id = any (p_ids));
  end if;
end $$;

create or replace function public.push_subscribe(p_endpoint text, p_p256dh text, p_auth text, p_ua text default null) returns void
language plpgsql volatile security definer set search_path = public as $$
declare v record;
begin
  select * into v from public.notif_viewer();
  if not v.is_owner and v.station is null then raise exception 'not allowed'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then raise exception 'פרטי התראה לא תקינים'; end if;
  insert into public.push_subscriptions (endpoint, p256dh, auth, station_id, is_owner, user_id, user_agent)
  values (p_endpoint, p_p256dh, p_auth, case when v.is_owner then null else v.station end, v.is_owner, auth.uid(), left(p_ua, 300))
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth, station_id = excluded.station_id,
    is_owner = excluded.is_owner, user_id = excluded.user_id, user_agent = excluded.user_agent, failures = 0;
end $$;

create or replace function public.push_unsubscribe(p_endpoint text) returns void
language plpgsql volatile security definer set search_path = public as $$
begin
  -- turning off only marks it; the push sender skips it
  update public.push_subscriptions set failures = 99 where endpoint = p_endpoint;
end $$;

grant execute on function public.my_notifications(int), public.notifications_unread(), public.notifications_mark_read(bigint[]),
  public.push_subscribe(text, text, text, text), public.push_unsubscribe(text) to anon, authenticated;
revoke all on function public.notif_viewer() from public, anon, authenticated;

-- every new notification goes out as a phone notification (edge function push-send). A failure never
-- stops the notification itself from being saved.
create or replace function public.notifications_push() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  begin
    perform net.http_post(
      url := 'https://tiszpzpotkyifejyjlxe.supabase.co/functions/v1/push-send',
      headers := jsonb_build_object('content-type', 'application/json', 'x-runner-key', (select key from ops.runner_key where id = 1)),
      body := jsonb_build_object('id', new.id),
      timeout_milliseconds := 20000);
  exception when others then null;
  end;
  return new;
end $$;
create or replace trigger notifications_push after insert on public.notifications for each row execute function public.notifications_push();

-- every minute: an arm that has not worked for 5 minutes → notice (once), and when it works again → notice
create or replace function public.watch_arms() returns int
language plpgsql volatile security definer set search_path = public as $$
declare a record; n int := 0; why text;
begin
  for a in
    select * from public.arms
    where is_active and status <> 'online' and down_notified_at is null
      and coalesce(last_seen_at, last_connected_at, created_at) < now() - interval '5 minutes'
  loop
    why := case
      when a.status = 'error' and a.last_error like '%403%' then 'וואטסאפ חסם את המספר'
      when a.status in ('qr', 'pending') then 'הזרוע מחכה לחיבור מחדש (QR או קוד)'
      else coalesce(nullif(a.last_error, ''), 'הזרוע לא מחוברת') end;
    insert into public.notifications (station_id, for_owner, kind, level, title, body, url, arm_id)
    values (a.station_id, true, 'arm_down', 'urgent', 'זרוע לא עובדת: ' || a.name,
            why || coalesce(' · ' || a.phone, '') || '. שאר הזרועות ממשיכות להפיץ.', '/arms', a.id);
    update public.arms set down_notified_at = now() where id = a.id;
    n := n + 1;
  end loop;
  for a in select * from public.arms where status = 'online' and down_notified_at is not null loop
    insert into public.notifications (station_id, for_owner, kind, level, title, body, url, arm_id)
    values (a.station_id, true, 'arm_up', 'info', 'הזרוע חזרה לעבוד: ' || a.name,
            'מחוברת ומפיצה' || coalesce(' · ' || a.phone, '') || '.', '/arms', a.id);
    update public.arms set down_notified_at = null where id = a.id;
    n := n + 1;
  end loop;
  -- an arm someone turned off on purpose is not watched
  update public.arms set down_notified_at = null where not is_active and down_notified_at is not null;
  return n;
end $$;
revoke all on function public.watch_arms() from public, anon, authenticated;

-- the owner's system message also goes to the notifications of the stations it is for (+ phones)
create or replace function public.owner_message_send(p_title text, p_body text, p_level text default 'info'::text, p_station uuid default null::uuid, p_days integer default 7)
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
  insert into public.notifications (station_id, for_owner, kind, level, title, body, url)
  select s.id, false, 'system', coalesce(nullif(p_level, ''), 'info'), trim(p_title), nullif(trim(p_body), ''), '/notifications'
  from public.stations s
  where (p_station is null and not s.is_home and s.status = 'active') or s.id = p_station;
  return mid;
end $function$;
