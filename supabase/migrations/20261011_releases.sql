-- Update center: nothing reaches production without the owner's approval.
--  * Code is pushed to GitHub, but production services no longer auto-deploy (Railway watch paths never match).
--  * Every update is registered here as a release: what changes, which parts, risk to the arms, restart needed.
--  * The owner approves / rejects in the app ("ניהול עדכונים"). Approval may be "now" or "tonight".
--  * The release-runner edge function (called every minute by pg_cron) takes a data snapshot, applies the
--    release's DB change, deploys the exact approved commit through the Railway API, watches health, and on
--    failure redeploys the previous commit (and runs the release's DB undo script, if it has one).

create schema if not exists ops;
revoke all on schema ops from public, anon, authenticated;

create table if not exists public.releases (
  id bigint generated always as identity primary key,
  version text not null,
  title text not null,
  changes text[] not null default '{}',
  components text[] not null default '{}' check (components <@ array['web', 'engine', 'db']),
  affects_arms boolean not null default false,
  disconnect_risk text not null default 'none' check (disconnect_risk in ('none', 'short', 'high')),
  restart_engine boolean not null default false,
  risk_notes text,
  commit_sha text not null,
  migration_sql text,
  rollback_sql text,
  status text not null default 'pending' check (status in
    ('pending', 'approved', 'rejected', 'deploying', 'verifying', 'live', 'failed', 'rolled_back', 'rollback_requested', 'superseded')),
  deploy_after timestamptz,
  decided_by uuid,
  decided_at timestamptz,
  started_at timestamptz,
  deployed_at timestamptz,
  verify_until timestamptz,
  baseline jsonb,
  prev jsonb,
  deployments jsonb,
  health jsonb,
  log jsonb not null default '[]',
  created_at timestamptz not null default now()
);
create index if not exists releases_status_idx on public.releases (status, created_at);
alter table public.releases enable row level security;
revoke all on public.releases from anon, authenticated;

-- one snapshot of the important data before each release (login identity of the arms included, per-chat keys not)
create table if not exists ops.release_backups (
  id bigint generated always as identity primary key,
  release_id bigint not null,
  tbl text not null,
  rows jsonb not null,
  created_at timestamptz not null default now()
);

-- what is live right now, per part (filled by the runner)
create table if not exists public.release_live (
  component text primary key check (component in ('web', 'engine')),
  commit_sha text,
  release_id bigint,
  since timestamptz not null default now()
);
alter table public.release_live enable row level security;
revoke all on public.release_live from anon, authenticated;

---------------------------------------------------------------- owner (app)

create or replace function public.owner_releases()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
declare eng timestamptz; online int; active int;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  select max(last_seen_at) into eng from public.arms where is_active and status = 'online';
  select count(*) filter (where status = 'online'), count(*) into online, active from public.arms where is_active;
  return json_build_object(
    'releases', coalesce((select json_agg(r order by r.created_at desc) from (
        select id, version, title, changes, components, affects_arms, disconnect_risk, restart_engine, risk_notes,
               left(commit_sha, 7) as commit, migration_sql is not null as has_db, rollback_sql is not null as has_undo,
               status, deploy_after, decided_at, started_at, deployed_at, verify_until, health, log, created_at
        from public.releases order by created_at desc limit 50) r), '[]'),
    'live', coalesce((select json_agg(json_build_object('component', l.component, 'commit', left(l.commit_sha, 7), 'since', l.since,
                       'version', (select version from public.releases where id = l.release_id))) from public.release_live l), '[]'),
    'health', json_build_object('engine_seen', eng, 'arms_online', online, 'arms_active', active,
                                'campaigns_running', (select count(*) from public.campaigns where status in ('queued', 'running')))
  );
end $function$;

-- approve (now / tonight) or reject; or ask to roll back a live release
create or replace function public.owner_release_decide(p_id bigint, p_action text)
 returns json language plpgsql volatile security definer set search_path to 'public'
as $function$
declare r public.releases; tz text := 'Asia/Jerusalem'; night timestamptz;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  select * into r from public.releases where id = p_id for update;
  if r.id is null then return json_build_object('error', 'עדכון לא נמצא'); end if;
  if p_action in ('approve_now', 'approve_night') then
    if r.status <> 'pending' then return json_build_object('error', 'העדכון כבר טופל'); end if;
    night := (date_trunc('day', now() at time zone tz) + interval '3 hours') at time zone tz;
    if night < now() then night := night + interval '1 day'; end if;
    update public.releases set status = 'approved', decided_by = auth.uid(), decided_at = now(),
      deploy_after = case when p_action = 'approve_night' then night else now() end,
      log = log || jsonb_build_array(jsonb_build_object('at', now(), 'msg',
        case when p_action = 'approve_night' then 'אושר לפריסה בלילה' else 'אושר לפריסה מיידית' end))
    where id = p_id;
  elsif p_action = 'reject' then
    if r.status not in ('pending', 'approved') then return json_build_object('error', 'אי אפשר לדחות בשלב הזה'); end if;
    update public.releases set status = 'rejected', decided_by = auth.uid(), decided_at = now(),
      log = log || jsonb_build_array(jsonb_build_object('at', now(), 'msg', 'נדחה'))
    where id = p_id;
  elsif p_action = 'rollback' then
    if r.status not in ('live', 'verifying') then return json_build_object('error', 'אפשר להחזיר רק עדכון פעיל'); end if;
    update public.releases set status = 'rollback_requested',
      log = log || jsonb_build_array(jsonb_build_object('at', now(), 'msg', 'התבקשה חזרה לגרסה הקודמת'))
    where id = p_id;
  else
    return json_build_object('error', 'פעולה לא מוכרת');
  end if;
  insert into public.activity_log (actor_id, action, entity, entity_id, details)
  values (auth.uid(), 'release_' || p_action, 'release', p_id::text, jsonb_build_object('version', r.version));
  return json_build_object('ok', true);
end $function$;

revoke execute on function public.owner_releases() from public, anon;
revoke execute on function public.owner_release_decide(bigint, text) from public, anon;
grant execute on function public.owner_releases() to authenticated;
grant execute on function public.owner_release_decide(bigint, text) to authenticated;

---------------------------------------------------------------- runner (service role only)

create or replace function public.runner_snapshot(p_release bigint)
 returns int language plpgsql volatile security definer set search_path to 'public'
as $function$
declare t text; n int := 0; res jsonb;
begin
  for t in select tablename from pg_tables where schemaname = 'public'
           and tablename not in ('campaign_targets', 'processed_messages', 'activity_log', 'quote_sessions',
                                 'login_otps', 'wa_outbox', 'station_login_attempts', 'releases', 'release_live')
  loop
    if t = 'arm_auth' then
      select coalesce(jsonb_agg(to_jsonb(x)), '[]') into res from public.arm_auth x
      where x.key = 'creds' or x.key like 'app-state-sync-key-%';
    else
      execute format('select coalesce(jsonb_agg(to_jsonb(x)), ''[]'') from public.%I x', t) into res;
    end if;
    insert into ops.release_backups (release_id, tbl, rows) values (p_release, t, res);
    n := n + 1;
  end loop;
  return n;
end $function$;

-- the release's own DB change / undo script (written by the developer, shown to the owner, run only after approval)
create or replace function public.runner_exec(p_release bigint, p_undo boolean default false)
 returns void language plpgsql volatile security definer set search_path to 'public'
as $function$
declare s text;
begin
  select case when p_undo then rollback_sql else migration_sql end into s from public.releases where id = p_release;
  if s is not null and length(trim(s)) > 0 then execute s; end if;
end $function$;

revoke all on function public.runner_snapshot(bigint) from public, anon, authenticated;
revoke all on function public.runner_exec(bigint, boolean) from public, anon, authenticated;
grant execute on function public.runner_snapshot(bigint) to service_role;
grant execute on function public.runner_exec(bigint, boolean) to service_role;
grant all on public.releases, public.release_live to service_role;
