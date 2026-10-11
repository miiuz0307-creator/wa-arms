-- Delivery monitoring: per arm, per minute – how many of our messages members could not decrypt
-- ("waiting for this message"), how many were repaired/re-sent, and incoming messages we could not
-- decrypt. Written by the engine, read by the owner's system monitor.
create table if not exists public.arm_delivery_stats (
  id bigint generated always as identity primary key,
  arm_id uuid not null references public.arms(id) on delete cascade,
  minute timestamptz not null default date_trunc('minute', now()),
  sent int not null default 0,
  retry_receipts int not null default 0,      -- member devices that could not decrypt one of our messages
  failing_devices int not null default 0,     -- distinct member devices among them
  resent int not null default 0,              -- re-sent to that device after a session refresh
  resend_failed int not null default 0,
  resend_lost int not null default 0,         -- too old / gave up / queue full – stays "waiting" for that member
  sessions_learned int not null default 0,    -- new encryption sessions from members, processed
  undecrypted_in int not null default 0,      -- incoming messages the arm could not decrypt
  detail jsonb
);
create index if not exists arm_delivery_stats_arm_minute on public.arm_delivery_stats (arm_id, minute desc);
alter table public.arm_delivery_stats enable row level security;
revoke all on public.arm_delivery_stats from anon, authenticated;

create or replace function public.engine_delivery_stats(p_rows jsonb)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  insert into public.arm_delivery_stats (arm_id, sent, retry_receipts, failing_devices, resent, resend_failed, resend_lost, sessions_learned, undecrypted_in, detail)
  select (r->>'arm_id')::uuid, coalesce((r->>'sent')::int, 0), coalesce((r->>'retry_receipts')::int, 0),
         coalesce((r->>'failing_devices')::int, 0), coalesce((r->>'resent')::int, 0), coalesce((r->>'resend_failed')::int, 0),
         coalesce((r->>'resend_lost')::int, 0), coalesce((r->>'sessions_learned')::int, 0), coalesce((r->>'undecrypted_in')::int, 0),
         r->'detail'
  from jsonb_array_elements(p_rows) r
  where exists (select 1 from public.arms a where a.id = (r->>'arm_id')::uuid);
  -- keep 14 days
  delete from public.arm_delivery_stats where minute < now() - interval '14 days';
end $function$;
revoke execute on function public.engine_delivery_stats(jsonb) from public;
grant execute on function public.engine_delivery_stats(jsonb) to anon, authenticated;

-- Owner: per arm, last hour and last 24 hours
create or replace function public.owner_delivery()
 returns table(station_name text, arm_id uuid, arm_name text, arm_status text,
               sent_hour int, failed_hour int, devices_hour int, resent_hour int, lost_hour int, undecrypted_hour int,
               sent_day int, failed_day int, resent_day int, lost_day int, last_minute timestamptz)
 language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return query
  select s.name, a.id, a.name, a.status,
    coalesce(sum(d.sent) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.retry_receipts) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.failing_devices) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.resent) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.resend_lost + d.resend_failed) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.undecrypted_in) filter (where d.minute > now() - interval '1 hour'), 0)::int,
    coalesce(sum(d.sent), 0)::int, coalesce(sum(d.retry_receipts), 0)::int, coalesce(sum(d.resent), 0)::int,
    coalesce(sum(d.resend_lost + d.resend_failed), 0)::int, max(d.minute)
  from public.arms a
  join public.stations s on s.id = a.station_id
  left join public.arm_delivery_stats d on d.arm_id = a.id and d.minute > now() - interval '24 hours'
  where a.is_active
  group by s.name, a.id, a.name, a.status
  order by 6 desc, 2;
end $function$;
revoke execute on function public.owner_delivery() from public, anon;
grant execute on function public.owner_delivery() to authenticated;
