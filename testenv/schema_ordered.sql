set check_function_bodies = off;
create type public.app_role as enum ('owner','admin','operator','viewer');
create sequence if not exists public.arm_commands_id_seq;
create sequence if not exists public.campaign_targets_id_seq;
create sequence if not exists public.activity_log_id_seq;
create sequence if not exists public.app_settings_id_seq;
create sequence if not exists public.station_login_attempts_id_seq;
CREATE OR REPLACE FUNCTION public.check_max_arms()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare lim int; n int;
begin
  select max_arms into lim from public.stations where id = new.station_id;
  if lim is null then return new; end if;
  select count(*) into n from public.arms where station_id = new.station_id;
  if n >= lim then
    raise exception 'הגעת למספר המכשירים המקסימלי לתחנה (%). פנה למנהל המערכת.', lim;
  end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.check_same_station()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.claim_target(p_arm uuid)
 RETURNS TABLE(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare s public.app_settings; a public.arms; t_id bigint; c_id uuid;
begin
  select * into a from public.arms where id = p_arm;
  if a.id is null or not a.is_active or a.status <> 'online' then return; end if;
  if a.sent_day = current_date and a.sent_today >= a.daily_limit then return; end if;
  select * into s from public.app_settings where station_id = a.station_id;

  -- "ladder": an arm keeps working on its own ride; a ride nobody else is working on comes next;
  -- only when every open ride already has an arm on it does this arm help with one of them.
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
  order by
    (exists (select 1 from public.campaign_targets m where m.campaign_id = c.id and m.arm_id = p_arm
             and coalesce(m.sent_at, m.claimed_at) > now() - interval '20 seconds')) desc,
    (exists (select 1 from public.campaign_targets o where o.campaign_id = c.id and o.arm_id <> p_arm
             and coalesce(o.sent_at, o.claimed_at) > now() - interval '20 seconds')) asc,
    c.created_at, t.id
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
end $function$
;
CREATE OR REPLACE FUNCTION public.claim_target_engine(p_arm uuid)
 RETURNS TABLE(target_id bigint, campaign_id uuid, wa_group_id text, final_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return query select * from public.claim_target(p_arm);
end $function$
;
CREATE OR REPLACE FUNCTION public.create_manual_campaign(p_message text, p_arm_ids uuid[], p_group_ids text[], p_list_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare cid uuid; sid uuid := public.my_station(); v_arms uuid[] := p_arm_ids; grps text[] := p_group_ids;
begin
  if public.my_rank() < 2 or sid is null then raise exception 'אין הרשאה'; end if;
  if coalesce(trim(p_message), '') = '' then raise exception 'ההודעה ריקה'; end if;
  if p_list_id is not null and not exists (select 1 from public.distribution_lists where id = p_list_id and station_id = sid) then
    raise exception 'רשימה לא נמצאה';
  end if;
  if p_list_id is not null then
    select coalesce(array_agg(wa_group_id), '{}') into grps from public.list_groups where list_id = p_list_id;
    if v_arms is null or cardinality(v_arms) = 0 then
      select coalesce(array_agg(arm_id), '{}') into v_arms from public.list_arms where list_id = p_list_id;
    end if;
  end if;
  if v_arms is null or cardinality(v_arms) = 0 then
    select coalesce(array_agg(a.id), '{}') into v_arms from public.arms a where a.is_active and a.station_id = sid;
  end if;
  select coalesce(array_agg(a.id), '{}') into v_arms from public.arms a where a.id = any (v_arms) and a.station_id = sid;
  if cardinality(v_arms) = 0 then raise exception 'לא נבחרו זרועות'; end if;
  if grps is null or cardinality(grps) = 0 then raise exception 'לא נבחרו קבוצות'; end if;
  insert into public.campaigns (kind, status, message_text, final_text, list_id, created_by, station_id)
  values ('manual', 'queued', p_message, p_message, p_list_id, auth.uid(), sid)
  returning id into cid;
  insert into public.campaign_arms (campaign_id, arm_id, station_id) select cid, unnest(v_arms), sid on conflict do nothing;
  insert into public.campaign_targets (campaign_id, wa_group_id, group_name, station_id)
  select cid, g, (select gr.name from public.groups gr where gr.wa_group_id = g and gr.station_id = sid order by gr.updated_at desc limit 1), sid
  from (select distinct unnest(grps) g) s
  on conflict do nothing;
  update public.campaigns set total = (select count(*) from public.campaign_targets where campaign_id = cid) where id = cid;
  perform public.log_activity('campaign_created', 'campaign', cid::text,
    jsonb_build_object('arms', cardinality(v_arms), 'groups', cardinality(grps)));
  return cid;
end $function$
;
CREATE OR REPLACE FUNCTION public.engine_backup_rows(p_table text, p_offset integer, p_limit integer DEFAULT 2000)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare pk text; res jsonb; extra text := '';
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = p_table) then
    raise exception 'unknown table';
  end if;
  select string_agg(quote_ident(a.attname), ',' order by a.attnum) into pk
  from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
  where i.indrelid = ('public.' || quote_ident(p_table))::regclass and i.indisprimary;
  -- WhatsApp: only the login identity (per-chat keys live on the server disk and are re-created)
  if p_table = 'arm_auth' then extra := ' where key = ''creds'' or key like ''app-state-sync-key-%'''; end if;
  execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from (select * from public.%I%s order by %s limit %s offset %s) t',
                 p_table, extra, coalesce(pk, '1'), least(greatest(p_limit, 1), 5000), greatest(p_offset, 0))
  into res;
  return res;
end $function$
;
CREATE OR REPLACE FUNCTION public.engine_lock_acquire(p_holder text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n int;
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  update public.engine_lock set holder = p_holder, heartbeat = now()
  where id = 1 and (holder is null or holder = p_holder or heartbeat < now() - interval '20 seconds');
  get diagnostics n = row_count;
  return n > 0;
end $function$
;
CREATE OR REPLACE FUNCTION public.engine_lock_release(p_holder text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  update public.engine_lock set holder = null, heartbeat = null where id = 1 and holder = p_holder;
end $function$
;
CREATE OR REPLACE FUNCTION public.engine_station_states()
 RETURNS TABLE(id uuid, allowed boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
#variable_conflict use_column
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  return query select s.id, (s.is_home or (s.status = 'active' and (s.sub_end is null or s.sub_end >= current_date))) from public.stations s;
end $function$
;
CREATE OR REPLACE FUNCTION public.finalize_campaigns()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- A send that never reported back (engine restart / crash mid-send) may already be in the group.
  -- Sending it again would duplicate the ride, so it is closed as "uncertain" instead of re-queued.
  update public.campaign_targets set status = 'failed',
    error = 'השליחה נקטעה ולא התקבל אישור – ייתכן שנשלחה. לא נשלחה שוב כדי למנוע כפילות'
  where status = 'sending' and claimed_at < now() - interval '5 minutes';

  -- A ride that stopped moving (arms offline/disconnected) must not go out hours later.
  -- help/quote: no progress for 20 minutes; manual: no progress for 24 hours.
  update public.campaign_targets t set status = 'skipped',
    error = 'הנסיעה לא נשלחה: ההפצה נתקעה (אין זרוע מחוברת) ופג תוקפה – לא נשלחת באיחור'
  from public.campaigns c
  where c.id = t.campaign_id and t.status = 'pending'
    and c.status in ('queued', 'running') and c.final_text is not null
    and coalesce(c.last_claim_at, c.created_at) < now() - case when c.kind = 'manual' then interval '24 hours' else interval '20 minutes' end
    and c.created_at < now() - case when c.kind = 'manual' then interval '24 hours' else interval '20 minutes' end;

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
end $function$
;
CREATE OR REPLACE FUNCTION public.finalize_campaigns_engine()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  perform public.finalize_campaigns();
end $function$
;
CREATE OR REPLACE FUNCTION public.gen_station_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; c text; b bytea; i int;
begin
  loop
    b := extensions.gen_random_bytes(8); c := '';
    for i in 0..7 loop c := c || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.stations where code_hash = encode(extensions.digest(c, 'sha256'), 'hex'));
  end loop;
  return c;
end $function$
;
CREATE OR REPLACE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare first_user boolean := not exists (select 1 from public.profiles);
begin
  insert into public.profiles (id, email, full_name, role, is_active, station_id)
  values (new.id, new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)),
    case when first_user then 'owner'::public.app_role else 'viewer'::public.app_role end,
    first_user, public.home_station());
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.home_station()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id from public.stations where is_home limit 1
$function$
;
CREATE OR REPLACE FUNCTION public.inherit_station()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare sid uuid; pid text := to_jsonb(new) ->> tg_argv[1];
begin
  if pid is null then return new; end if;
  execute format('select station_id from public.%I where id = $1', tg_argv[0]) into sid using pid::uuid;
  if sid is not null then new.station_id := sid; end if;
  return new;
end $function$
;
CREATE OR REPLACE FUNCTION public.is_engine()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare h text;
begin
  begin
    h := current_setting('request.headers', true)::json->>'x-engine-key';
  exception when others then
    return false;
  end;
  if h is null or h = '' then return false; end if;
  return exists (select 1 from public.engine_keys where key_hash = encode(extensions.digest(h, 'sha256'), 'hex'));
end $function$
;
CREATE OR REPLACE FUNCTION public.is_super()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.req_header('x-station-token') is null
     and exists (select 1 from public.profiles where id = auth.uid() and is_active and role = 'owner')
$function$
;
CREATE OR REPLACE FUNCTION public.log_activity(p_action text, p_entity text, p_entity_id text, p_details jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.my_rank()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if public.req_header('x-station-token') is not null then
    return case when public.station_from_token() is not null then 3 else 0 end;
  end if;
  return coalesce((select public.role_rank(role) from public.profiles where id = auth.uid() and is_active), 0);
end $function$
;
CREATE OR REPLACE FUNCTION public.my_station()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare r public.app_role; act text;
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
end $function$
;
CREATE OR REPLACE FUNCTION public.req_header(p_name text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare h text;
begin
  begin
    h := current_setting('request.headers', true)::json ->> p_name;
  exception when others then
    return null;
  end;
  return nullif(h, '');
end $function$
;
CREATE OR REPLACE FUNCTION public.retry_failed(p_campaign uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.role_rank(r app_role)
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case r when 'owner' then 4 when 'admin' then 3 when 'operator' then 2 else 1 end
$function$
;
CREATE OR REPLACE FUNCTION public.station_extend(p_id uuid, p_months integer)
 RETURNS date
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare d date;
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.stations
  set sub_end = (greatest(coalesce(sub_end, current_date), current_date) + make_interval(months => p_months))::date,
      status = 'active'
  where id = p_id and not is_home
  returning sub_end into d;
  return d;
end $function$
;
CREATE OR REPLACE FUNCTION public.station_from_token()
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.station_login(p_code text)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.station_logout()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare tok text := public.req_header('x-station-token');
begin
  if tok is null then return; end if;
  update public.station_sessions set revoked_at = now()
  where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex');
end $function$
;
CREATE OR REPLACE FUNCTION public.station_logout_all(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.station_sessions set revoked_at = now() where station_id = p_id and revoked_at is null;
end $function$
;
CREATE OR REPLACE FUNCTION public.station_me()
 RETURNS json
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select json_build_object(
    'id', s.id, 'name', s.name, 'is_home', s.is_home, 'status', s.status, 'sub_end', s.sub_end,
    'max_arms', s.max_arms, 'via_code', public.req_header('x-station-token') is not null,
    'acting', public.req_header('x-act-station') is not null and public.req_header('x-station-token') is null)
  from public.stations s where s.id = public.my_station()
$function$
;
CREATE OR REPLACE FUNCTION public.station_ping()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare tok text := public.req_header('x-station-token');
begin
  if tok is null then return; end if;
  update public.station_sessions set last_seen = now()
  where token_hash = encode(extensions.digest(tok, 'sha256'), 'hex') and last_seen < now() - interval '1 minute';
end $function$
;
CREATE OR REPLACE FUNCTION public.station_save(p jsonb)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.station_set_code(p_id uuid, p_code text DEFAULT NULL::text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
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
  update public.station_sessions set revoked_at = now() where station_id = p_id and revoked_at is null;
  return code;
end $function$
;
CREATE OR REPLACE FUNCTION public.stations_overview()
 RETURNS TABLE(id uuid, name text, manager_name text, phone text, code_hint text, status text, joined_at date, sub_end date, price numeric, max_arms integer, notes text, created_at timestamp with time zone, arms_total integer, arms_online integer, groups_count integer, campaigns_count integer, last_campaign timestamp with time zone, last_login timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$
;
CREATE OR REPLACE FUNCTION public.sync_campaign_counters()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c uuid := coalesce(new.campaign_id, old.campaign_id);
begin
  update public.campaigns set
    sent = (select count(*) from public.campaign_targets where campaign_id = c and status = 'sent'),
    failed = (select count(*) from public.campaign_targets where campaign_id = c and status = 'failed')
  where id = c;
  return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.target_result(p_id bigint, p_arm uuid, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if p_ok then
    update public.campaign_targets set status = 'sent', sent_at = now(), error = null where id = p_id;
    update public.arms set sent_total = sent_total + 1,
      sent_today = case when sent_day = current_date then sent_today + 1 else 1 end,
      sent_day = current_date
    where id = p_arm;
  else
    update public.campaign_targets set tried_arms = array_append(tried_arms, p_arm), error = p_error,
      status = case when attempts >= 3 then 'failed' else 'pending' end
    where id = p_id;
  end if;
end $function$
;
CREATE OR REPLACE FUNCTION public.target_result_engine(p_id bigint, p_arm uuid, p_ok boolean, p_error text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_engine() then raise exception 'not allowed'; end if;
  perform public.target_result(p_id, p_arm, p_ok, p_error);
end $function$
;
create table public.arm_auth (arm_id uuid not null, key text not null, value text not null, updated_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.profiles (id uuid not null, email text, full_name text, role app_role default 'viewer'::app_role not null, is_active boolean default true not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.arms (id uuid default gen_random_uuid() not null, name text not null, phone text, status text default 'pending'::text not null, last_connected_at timestamp with time zone, last_seen_at timestamp with time zone, last_error text, daily_limit integer default 500 not null, sent_today integer default 0 not null, sent_total bigint default 0 not null, is_active boolean default true not null, created_by uuid, created_at timestamp with time zone default now() not null, sent_day date, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.arm_qr (arm_id uuid not null, qr text, updated_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.list_groups (list_id uuid not null, wa_group_id text not null, group_name text, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.list_arms (list_id uuid not null, arm_id uuid not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.source_groups (id uuid default gen_random_uuid() not null, wa_group_id text not null, name text, listen_arm_id uuid, is_active boolean default true not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.arm_commands (id bigint generated always as identity not null, arm_id uuid not null, command text not null, status text default 'pending'::text not null, error text, created_by uuid, created_at timestamp with time zone default now() not null, processed_at timestamp with time zone, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.groups (id uuid default gen_random_uuid() not null, arm_id uuid not null, wa_group_id text not null, name text, participants integer, updated_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.distribution_lists (id uuid default gen_random_uuid() not null, name text not null, description text, created_by uuid, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.templates (id uuid default gen_random_uuid() not null, name text not null, prefix text default ''::text not null, suffix text default ''::text not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.triggers (id uuid default gen_random_uuid() not null, keyword text not null, action text default 'distribute'::text not null, list_id uuid, template_id uuid, strip_keyword boolean default true not null, is_active boolean default true not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.dispatchers (id uuid default gen_random_uuid() not null, name text, phone text, wa_jid text, wa_lid text, auto_detected boolean default false not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.campaigns (id uuid default gen_random_uuid() not null, kind text not null, status text default 'queued'::text not null, message_text text not null, final_text text, requester_name text, requester_phone text, requester_jid text, source_group_id text, source_group_name text, source_message_id text, trigger_id uuid, list_id uuid, total integer default 0 not null, sent integer default 0 not null, failed integer default 0 not null, created_by uuid, created_at timestamp with time zone default now() not null, started_at timestamp with time zone, finished_at timestamp with time zone, trigger_key jsonb, trigger_arm_id uuid, reacted boolean default false not null, last_claim_at timestamp with time zone, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.campaign_arms (campaign_id uuid not null, arm_id uuid not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.app_settings (id integer default nextval('app_settings_id_seq'::regclass) not null, min_delay_sec integer default 8 not null, max_delay_sec integer default 20 not null, per_arm_group_limit integer default 60 not null, distribution_mode text default 'round_robin'::text not null, auto_distribution_enabled boolean default false not null, updated_at timestamp with time zone default now() not null, rate_per_minute integer, station_id uuid default COALESCE(my_station(), home_station()) not null, open_trigger boolean default false not null, duplicate_window_min integer default 10 not null, cancel_words text[] default ARRAY['ביטול'::text, 'בטל'::text, 'נ'::text, 'נמכר'::text, 'נמכרה'::text] not null);
create table public.campaign_targets (id bigint generated always as identity not null, campaign_id uuid not null, wa_group_id text not null, group_name text, arm_id uuid, status text default 'pending'::text not null, attempts integer default 0 not null, error text, sent_at timestamp with time zone, tried_arms uuid[] default '{}'::uuid[] not null, claimed_at timestamp with time zone, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.processed_messages (source_group_id text not null, message_id text not null, campaign_id uuid, processed_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.activity_log (id bigint generated always as identity not null, actor_id uuid, actor_name text, action text not null, entity text, entity_id text, details jsonb, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.engine_keys (key_hash text not null, created_at timestamp with time zone default now() not null);
create table public.engine_lock (id integer default 1 not null, holder text, heartbeat timestamp with time zone);
create table public.wa_operators (id uuid default gen_random_uuid() not null, name text, phone text, wa_jid text, wa_lid text, status text default 'pending'::text not null, created_at timestamp with time zone default now() not null, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.quote_sessions (id uuid default gen_random_uuid() not null, arm_id uuid, chat_jid text not null, chat_alt_jid text, operator_id uuid, operator_name text, operator_phone text, is_self boolean default false not null, source_group_id text, source_group_name text, source_message_id text, original_text text not null, clean_text text not null, removed_phones integer default 0 not null, needs_review boolean default false not null, review_reason text, selected_list_ids uuid[] default '{}'::uuid[] not null, status text default 'selecting'::text not null, campaign_id uuid, created_at timestamp with time zone default now() not null, updated_at timestamp with time zone default now() not null, trigger_key jsonb, station_id uuid default COALESCE(my_station(), home_station()) not null);
create table public.station_sessions (token_hash text not null, station_id uuid not null, created_at timestamp with time zone default now() not null, last_seen timestamp with time zone default now() not null, revoked_at timestamp with time zone);
create table public.station_login_attempts (id bigint default nextval('station_login_attempts_id_seq'::regclass) not null, ip text, ok boolean not null, created_at timestamp with time zone default now() not null);
create table public.stations (id uuid default gen_random_uuid() not null, name text not null, manager_name text, phone text, code_hash text, code_hint text, is_home boolean default false not null, status text default 'active'::text not null, joined_at date default CURRENT_DATE not null, sub_end date, price numeric(10,2), max_arms integer, notes text, created_at timestamp with time zone default now() not null);
alter table public.source_groups add constraint source_groups_pkey PRIMARY KEY (id);
alter table public.campaign_targets add constraint campaign_targets_pkey PRIMARY KEY (id);
alter table public.dispatchers add constraint dispatchers_pkey PRIMARY KEY (id);
alter table public.processed_messages add constraint processed_messages_pkey PRIMARY KEY (station_id, source_group_id, message_id);
alter table public.campaigns add constraint campaigns_pkey PRIMARY KEY (id);
alter table public.campaign_arms add constraint campaign_arms_pkey PRIMARY KEY (campaign_id, arm_id);
alter table public.triggers add constraint triggers_pkey PRIMARY KEY (id);
alter table public.templates add constraint templates_pkey PRIMARY KEY (id);
alter table public.arms add constraint arms_pkey PRIMARY KEY (id);
alter table public.engine_lock add constraint engine_lock_pkey PRIMARY KEY (id);
alter table public.arm_qr add constraint arm_qr_pkey PRIMARY KEY (arm_id);
alter table public.quote_sessions add constraint quote_sessions_pkey PRIMARY KEY (id);
alter table public.arm_auth add constraint arm_auth_pkey PRIMARY KEY (arm_id, key);
alter table public.wa_operators add constraint wa_operators_pkey PRIMARY KEY (id);
alter table public.profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table public.stations add constraint stations_pkey PRIMARY KEY (id);
alter table public.arm_commands add constraint arm_commands_pkey PRIMARY KEY (id);
alter table public.station_login_attempts add constraint station_login_attempts_pkey PRIMARY KEY (id);
alter table public.station_sessions add constraint station_sessions_pkey PRIMARY KEY (token_hash);
alter table public.groups add constraint groups_pkey PRIMARY KEY (id);
alter table public.activity_log add constraint activity_log_pkey PRIMARY KEY (id);
alter table public.list_arms add constraint list_arms_pkey PRIMARY KEY (list_id, arm_id);
alter table public.app_settings add constraint app_settings_pkey PRIMARY KEY (id);
alter table public.distribution_lists add constraint distribution_lists_pkey PRIMARY KEY (id);
alter table public.engine_keys add constraint engine_keys_pkey PRIMARY KEY (key_hash);
alter table public.list_groups add constraint list_groups_pkey PRIMARY KEY (list_id, wa_group_id);
alter table public.groups add constraint groups_arm_id_wa_group_id_key UNIQUE (arm_id, wa_group_id);
alter table public.stations add constraint stations_code_hash_key UNIQUE (code_hash);
alter table public.campaign_targets add constraint campaign_targets_campaign_id_wa_group_id_key UNIQUE (campaign_id, wa_group_id);
alter table public.app_settings add constraint app_settings_distribution_mode_check CHECK ((distribution_mode = ANY (ARRAY['round_robin'::text, 'fill'::text])));
alter table public.triggers add constraint triggers_action_check CHECK ((action = 'distribute'::text));
alter table public.arms add constraint arms_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'qr'::text, 'connecting'::text, 'online'::text, 'offline'::text, 'error'::text, 'paused'::text])));
alter table public.arm_commands add constraint arm_commands_command_check CHECK ((command = ANY (ARRAY['connect'::text, 'disconnect'::text, 'reset'::text, 'refresh_groups'::text])));
alter table public.arm_commands add constraint arm_commands_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text, 'failed'::text])));
alter table public.campaigns add constraint campaigns_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'paused'::text, 'completed'::text, 'cancelled'::text, 'failed'::text, 'pending_phone'::text])));
alter table public.campaign_targets add constraint campaign_targets_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'failed'::text, 'skipped'::text])));
alter table public.campaigns add constraint campaigns_kind_check CHECK ((kind = ANY (ARRAY['manual'::text, 'help'::text, 'quote'::text])));
alter table public.wa_operators add constraint wa_operators_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'approved'::text, 'blocked'::text])));
alter table public.quote_sessions add constraint quote_sessions_status_check CHECK ((status = ANY (ARRAY['selecting'::text, 'sending'::text, 'done'::text, 'cancelled'::text, 'expired'::text])));
alter table public.engine_lock add constraint engine_lock_id_check CHECK ((id = 1));
alter table public.app_settings add constraint app_settings_rate_per_minute_check CHECK (((rate_per_minute IS NULL) OR ((rate_per_minute >= 1) AND (rate_per_minute <= 600))));
alter table public.stations add constraint stations_status_check CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text])));
alter table public.app_settings add constraint app_settings_duplicate_window_min_check CHECK (((duplicate_window_min >= 0) AND (duplicate_window_min <= 1440)));
alter table public.campaign_targets add constraint campaign_targets_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
alter table public.campaign_targets add constraint campaign_targets_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE SET NULL;
alter table public.processed_messages add constraint processed_messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
alter table public.list_arms add constraint list_arms_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.list_arms add constraint list_arms_list_id_fkey FOREIGN KEY (list_id) REFERENCES distribution_lists(id) ON DELETE CASCADE;
alter table public.list_groups add constraint list_groups_list_id_fkey FOREIGN KEY (list_id) REFERENCES distribution_lists(id) ON DELETE CASCADE;
alter table public.activity_log add constraint activity_log_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES profiles(id) ON DELETE SET NULL;
alter table public.distribution_lists add constraint distribution_lists_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.quote_sessions add constraint quote_sessions_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.groups add constraint groups_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.arm_commands add constraint arm_commands_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.station_sessions add constraint station_sessions_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.arm_commands add constraint arm_commands_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.arm_commands add constraint arm_commands_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.arm_auth add constraint arm_auth_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.arm_qr add constraint arm_qr_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.arm_qr add constraint arm_qr_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.quote_sessions add constraint quote_sessions_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.quote_sessions add constraint quote_sessions_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES wa_operators(id) ON DELETE SET NULL;
alter table public.quote_sessions add constraint quote_sessions_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;
alter table public.arm_auth add constraint arm_auth_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.arms add constraint arms_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.campaigns add constraint campaigns_trigger_arm_id_fkey FOREIGN KEY (trigger_arm_id) REFERENCES arms(id) ON DELETE SET NULL;
alter table public.profiles add constraint profiles_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.source_groups add constraint source_groups_listen_arm_id_fkey FOREIGN KEY (listen_arm_id) REFERENCES arms(id) ON DELETE SET NULL;
alter table public.profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.arms add constraint arms_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.groups add constraint groups_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.distribution_lists add constraint distribution_lists_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.list_groups add constraint list_groups_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.list_arms add constraint list_arms_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.source_groups add constraint source_groups_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.templates add constraint templates_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.triggers add constraint triggers_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.dispatchers add constraint dispatchers_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.campaigns add constraint campaigns_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.campaign_arms add constraint campaign_arms_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.campaign_targets add constraint campaign_targets_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.processed_messages add constraint processed_messages_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.app_settings add constraint app_settings_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.activity_log add constraint activity_log_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.campaigns add constraint campaigns_list_id_fkey FOREIGN KEY (list_id) REFERENCES distribution_lists(id) ON DELETE SET NULL;
alter table public.campaigns add constraint campaigns_created_by_fkey FOREIGN KEY (created_by) REFERENCES profiles(id);
alter table public.campaigns add constraint campaigns_trigger_id_fkey FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE SET NULL;
alter table public.campaign_arms add constraint campaign_arms_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
alter table public.campaign_arms add constraint campaign_arms_arm_id_fkey FOREIGN KEY (arm_id) REFERENCES arms(id) ON DELETE CASCADE;
alter table public.wa_operators add constraint wa_operators_station_id_fkey FOREIGN KEY (station_id) REFERENCES stations(id) ON DELETE CASCADE;
alter table public.triggers add constraint triggers_template_id_fkey FOREIGN KEY (template_id) REFERENCES templates(id) ON DELETE SET NULL;
alter table public.triggers add constraint triggers_list_id_fkey FOREIGN KEY (list_id) REFERENCES distribution_lists(id) ON DELETE SET NULL;
CREATE INDEX arm_auth_station_idx ON public.arm_auth USING btree (station_id);
CREATE INDEX profiles_station_idx ON public.profiles USING btree (station_id);
CREATE INDEX arms_station_idx ON public.arms USING btree (station_id);
CREATE INDEX arm_qr_station_idx ON public.arm_qr USING btree (station_id);
CREATE INDEX list_groups_station_idx ON public.list_groups USING btree (station_id);
CREATE INDEX list_arms_station_idx ON public.list_arms USING btree (station_id);
CREATE INDEX source_groups_station_idx ON public.source_groups USING btree (station_id);
CREATE UNIQUE INDEX source_groups_station_group ON public.source_groups USING btree (station_id, wa_group_id);
CREATE INDEX arm_commands_status_created_at_idx ON public.arm_commands USING btree (status, created_at);
CREATE INDEX arm_commands_station_idx ON public.arm_commands USING btree (station_id);
CREATE INDEX groups_wa_group_id_idx ON public.groups USING btree (wa_group_id);
CREATE INDEX groups_station_idx ON public.groups USING btree (station_id);
CREATE INDEX distribution_lists_station_idx ON public.distribution_lists USING btree (station_id);
CREATE INDEX templates_station_idx ON public.templates USING btree (station_id);
CREATE INDEX triggers_station_idx ON public.triggers USING btree (station_id);
CREATE UNIQUE INDEX triggers_station_keyword ON public.triggers USING btree (station_id, keyword);
CREATE INDEX dispatchers_station_idx ON public.dispatchers USING btree (station_id);
CREATE UNIQUE INDEX dispatchers_station_jid ON public.dispatchers USING btree (station_id, wa_jid);
CREATE UNIQUE INDEX dispatchers_station_lid ON public.dispatchers USING btree (station_id, wa_lid);
CREATE INDEX campaigns_created_at_idx ON public.campaigns USING btree (created_at DESC);
CREATE INDEX campaigns_station_idx ON public.campaigns USING btree (station_id);
CREATE INDEX campaign_arms_station_idx ON public.campaign_arms USING btree (station_id);
CREATE INDEX app_settings_station_idx ON public.app_settings USING btree (station_id);
CREATE UNIQUE INDEX app_settings_station ON public.app_settings USING btree (station_id);
CREATE INDEX campaign_targets_campaign_id_status_idx ON public.campaign_targets USING btree (campaign_id, status);
CREATE INDEX campaign_targets_station_idx ON public.campaign_targets USING btree (station_id);
CREATE INDEX processed_messages_station_idx ON public.processed_messages USING btree (station_id);
CREATE INDEX activity_log_created_at_idx ON public.activity_log USING btree (created_at DESC);
CREATE INDEX activity_log_station_idx ON public.activity_log USING btree (station_id);
CREATE INDEX wa_operators_station_idx ON public.wa_operators USING btree (station_id);
CREATE UNIQUE INDEX wa_operators_station_jid ON public.wa_operators USING btree (station_id, wa_jid);
CREATE UNIQUE INDEX wa_operators_station_lid ON public.wa_operators USING btree (station_id, wa_lid);
CREATE INDEX quote_sessions_arm_id_status_idx ON public.quote_sessions USING btree (arm_id, status);
CREATE INDEX quote_sessions_source_message_id_idx ON public.quote_sessions USING btree (source_message_id);
CREATE INDEX quote_sessions_station_idx ON public.quote_sessions USING btree (station_id);
CREATE INDEX station_sessions_station ON public.station_sessions USING btree (station_id);
CREATE INDEX station_login_attempts_ip ON public.station_login_attempts USING btree (ip, created_at);
CREATE UNIQUE INDEX stations_one_home ON public.stations USING btree (is_home) WHERE is_home;
CREATE TRIGGER campaign_targets_counters AFTER UPDATE OF status ON public.campaign_targets FOR EACH ROW WHEN ((old.status IS DISTINCT FROM new.status)) EXECUTE FUNCTION sync_campaign_counters();
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF arm_id ON public.groups FOR EACH ROW EXECUTE FUNCTION inherit_station('arms', 'arm_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF arm_id ON public.arm_qr FOR EACH ROW EXECUTE FUNCTION inherit_station('arms', 'arm_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF arm_id ON public.arm_auth FOR EACH ROW EXECUTE FUNCTION inherit_station('arms', 'arm_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF arm_id ON public.arm_commands FOR EACH ROW EXECUTE FUNCTION inherit_station('arms', 'arm_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF arm_id ON public.quote_sessions FOR EACH ROW EXECUTE FUNCTION inherit_station('arms', 'arm_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF list_id ON public.list_groups FOR EACH ROW EXECUTE FUNCTION inherit_station('distribution_lists', 'list_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF list_id ON public.list_arms FOR EACH ROW EXECUTE FUNCTION inherit_station('distribution_lists', 'list_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF campaign_id ON public.campaign_arms FOR EACH ROW EXECUTE FUNCTION inherit_station('campaigns', 'campaign_id');
CREATE TRIGGER inherit_station BEFORE INSERT OR UPDATE OF campaign_id ON public.campaign_targets FOR EACH ROW EXECUTE FUNCTION inherit_station('campaigns', 'campaign_id');
CREATE TRIGGER same_station BEFORE INSERT OR UPDATE ON public.list_arms FOR EACH ROW EXECUTE FUNCTION check_same_station('arms', 'arm_id');
CREATE TRIGGER same_station BEFORE INSERT OR UPDATE ON public.campaign_arms FOR EACH ROW EXECUTE FUNCTION check_same_station('arms', 'arm_id');
CREATE TRIGGER same_station BEFORE INSERT OR UPDATE ON public.source_groups FOR EACH ROW EXECUTE FUNCTION check_same_station('arms', 'listen_arm_id');
CREATE TRIGGER same_station BEFORE INSERT OR UPDATE ON public.triggers FOR EACH ROW EXECUTE FUNCTION check_same_station('distribution_lists', 'list_id', 'templates', 'template_id');
CREATE TRIGGER same_station BEFORE INSERT OR UPDATE ON public.campaigns FOR EACH ROW EXECUTE FUNCTION check_same_station('distribution_lists', 'list_id', 'arms', 'trigger_arm_id');
CREATE TRIGGER max_arms BEFORE INSERT ON public.arms FOR EACH ROW EXECUTE FUNCTION check_max_arms();
alter table public.arm_auth enable row level security;
alter table public.profiles enable row level security;
alter table public.arms enable row level security;
alter table public.arm_qr enable row level security;
alter table public.list_groups enable row level security;
alter table public.list_arms enable row level security;
alter table public.source_groups enable row level security;
alter table public.arm_commands enable row level security;
alter table public.groups enable row level security;
alter table public.distribution_lists enable row level security;
alter table public.templates enable row level security;
alter table public.triggers enable row level security;
alter table public.dispatchers enable row level security;
alter table public.campaigns enable row level security;
alter table public.campaign_arms enable row level security;
alter table public.app_settings enable row level security;
alter table public.campaign_targets enable row level security;
alter table public.processed_messages enable row level security;
alter table public.activity_log enable row level security;
alter table public.engine_keys enable row level security;
alter table public.engine_lock enable row level security;
alter table public.wa_operators enable row level security;
alter table public.quote_sessions enable row level security;
alter table public.station_sessions enable row level security;
alter table public.station_login_attempts enable row level security;
alter table public.stations enable row level security;
create policy "engine full access" on public.profiles as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.templates as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy station_isolation on public.arms as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.groups as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.distribution_lists as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.list_groups as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.list_arms as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.source_groups as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.templates as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.triggers as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.dispatchers as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.campaigns as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.campaign_arms as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.campaign_targets as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.processed_messages as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.app_settings as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.activity_log as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.wa_operators as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.quote_sessions as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.arm_commands as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.arm_qr as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.arm_auth as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (station_id = ( SELECT my_station() AS my_station))));
create policy station_isolation on public.profiles as RESTRICTIVE for ALL to public using ((( SELECT is_engine() AS is_engine) OR (id = auth.uid()) OR (station_id = ( SELECT my_station() AS my_station)))) with check ((( SELECT is_engine() AS is_engine) OR (id = auth.uid()) OR (station_id = ( SELECT my_station() AS my_station))));
create policy owner_removes_station on public.stations as PERMISSIVE for DELETE to authenticated using ((is_super() AND (NOT is_home)));
create policy owner_reads_stations on public.stations as PERMISSIVE for SELECT to authenticated using (is_super());
create policy "members read" on public.arms as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.groups as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.distribution_lists as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.list_groups as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.list_arms as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.source_groups as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.templates as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.triggers as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.dispatchers as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.campaigns as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.campaign_arms as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.campaign_targets as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "members read" on public.app_settings as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "operators insert" on public.distribution_lists as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "admins read commands" on public.arm_commands as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 3));
create policy "operators update" on public.distribution_lists as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.distribution_lists as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.list_groups as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.list_groups as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.list_groups as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.list_arms as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.list_arms as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.list_arms as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.dispatchers as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.dispatchers as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.dispatchers as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.campaigns as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.campaigns as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.campaigns as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.campaign_targets as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.campaign_targets as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.campaign_targets as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "operators insert" on public.campaign_arms as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 2));
create policy "operators update" on public.campaign_arms as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 2)) with check ((my_rank() >= 2));
create policy "operators delete" on public.campaign_arms as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 2));
create policy "admins insert" on public.arms as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins update" on public.arms as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.arms as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "admins insert" on public.source_groups as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins update" on public.source_groups as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.source_groups as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "admins insert" on public.templates as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins update" on public.templates as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.templates as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "admins insert" on public.triggers as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins read" on public.wa_operators as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 3));
create policy "admins update" on public.triggers as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.triggers as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "admins insert" on public.app_settings as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins update" on public.app_settings as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.app_settings as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "admins read qr" on public.arm_qr as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 3));
create policy "admins send commands" on public.arm_commands as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins read log" on public.activity_log as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 3));
create policy "members read processed" on public.processed_messages as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "read own or admin" on public.profiles as PERMISSIVE for SELECT to anon,authenticated using (((id = auth.uid()) OR (my_rank() >= 3)));
create policy "owner manages users" on public.profiles as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() = 4)) with check ((my_rank() = 4));
create policy "admins insert" on public.wa_operators as PERMISSIVE for INSERT to anon,authenticated with check ((my_rank() >= 3));
create policy "admins update" on public.wa_operators as PERMISSIVE for UPDATE to anon,authenticated using ((my_rank() >= 3)) with check ((my_rank() >= 3));
create policy "admins delete" on public.wa_operators as PERMISSIVE for DELETE to anon,authenticated using ((my_rank() >= 3));
create policy "members read" on public.quote_sessions as PERMISSIVE for SELECT to anon,authenticated using ((my_rank() >= 1));
create policy "engine full access" on public.arms as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.arm_qr as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.arm_auth as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.arm_commands as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.groups as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.distribution_lists as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.list_groups as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.list_arms as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.source_groups as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.triggers as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.dispatchers as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.campaigns as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.campaign_arms as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.campaign_targets as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.processed_messages as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.app_settings as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.activity_log as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.wa_operators as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
create policy "engine full access" on public.quote_sessions as PERMISSIVE for ALL to anon using (( SELECT is_engine() AS is_engine)) with check (( SELECT is_engine() AS is_engine));
grant INSERT on public.arm_auth to anon;
grant SELECT on public.arm_auth to anon;
grant UPDATE on public.arm_auth to anon;
grant DELETE on public.arm_auth to anon;
grant TRUNCATE on public.arm_auth to anon;
grant REFERENCES on public.arm_auth to anon;
grant TRIGGER on public.arm_auth to anon;
grant INSERT on public.arm_auth to authenticated;
grant SELECT on public.arm_auth to authenticated;
grant UPDATE on public.arm_auth to authenticated;
grant DELETE on public.arm_auth to authenticated;
grant TRUNCATE on public.arm_auth to authenticated;
grant REFERENCES on public.arm_auth to authenticated;
grant TRIGGER on public.arm_auth to authenticated;
grant INSERT on public.profiles to anon;
grant SELECT on public.profiles to anon;
grant UPDATE on public.profiles to anon;
grant DELETE on public.profiles to anon;
grant TRUNCATE on public.profiles to anon;
grant REFERENCES on public.profiles to anon;
grant TRIGGER on public.profiles to anon;
grant INSERT on public.profiles to authenticated;
grant SELECT on public.profiles to authenticated;
grant UPDATE on public.profiles to authenticated;
grant DELETE on public.profiles to authenticated;
grant TRUNCATE on public.profiles to authenticated;
grant REFERENCES on public.profiles to authenticated;
grant TRIGGER on public.profiles to authenticated;
grant INSERT on public.arms to anon;
grant SELECT on public.arms to anon;
grant UPDATE on public.arms to anon;
grant DELETE on public.arms to anon;
grant TRUNCATE on public.arms to anon;
grant REFERENCES on public.arms to anon;
grant TRIGGER on public.arms to anon;
grant INSERT on public.arms to authenticated;
grant SELECT on public.arms to authenticated;
grant UPDATE on public.arms to authenticated;
grant DELETE on public.arms to authenticated;
grant TRUNCATE on public.arms to authenticated;
grant REFERENCES on public.arms to authenticated;
grant TRIGGER on public.arms to authenticated;
grant INSERT on public.arm_qr to anon;
grant SELECT on public.arm_qr to anon;
grant UPDATE on public.arm_qr to anon;
grant DELETE on public.arm_qr to anon;
grant TRUNCATE on public.arm_qr to anon;
grant REFERENCES on public.arm_qr to anon;
grant TRIGGER on public.arm_qr to anon;
grant INSERT on public.arm_qr to authenticated;
grant SELECT on public.arm_qr to authenticated;
grant UPDATE on public.arm_qr to authenticated;
grant DELETE on public.arm_qr to authenticated;
grant TRUNCATE on public.arm_qr to authenticated;
grant REFERENCES on public.arm_qr to authenticated;
grant TRIGGER on public.arm_qr to authenticated;
grant INSERT on public.list_groups to anon;
grant SELECT on public.list_groups to anon;
grant UPDATE on public.list_groups to anon;
grant DELETE on public.list_groups to anon;
grant TRUNCATE on public.list_groups to anon;
grant REFERENCES on public.list_groups to anon;
grant TRIGGER on public.list_groups to anon;
grant INSERT on public.list_groups to authenticated;
grant SELECT on public.list_groups to authenticated;
grant UPDATE on public.list_groups to authenticated;
grant DELETE on public.list_groups to authenticated;
grant TRUNCATE on public.list_groups to authenticated;
grant REFERENCES on public.list_groups to authenticated;
grant TRIGGER on public.list_groups to authenticated;
grant INSERT on public.list_arms to anon;
grant SELECT on public.list_arms to anon;
grant UPDATE on public.list_arms to anon;
grant DELETE on public.list_arms to anon;
grant TRUNCATE on public.list_arms to anon;
grant REFERENCES on public.list_arms to anon;
grant TRIGGER on public.list_arms to anon;
grant INSERT on public.list_arms to authenticated;
grant SELECT on public.list_arms to authenticated;
grant UPDATE on public.list_arms to authenticated;
grant DELETE on public.list_arms to authenticated;
grant TRUNCATE on public.list_arms to authenticated;
grant REFERENCES on public.list_arms to authenticated;
grant TRIGGER on public.list_arms to authenticated;
grant INSERT on public.source_groups to anon;
grant SELECT on public.source_groups to anon;
grant UPDATE on public.source_groups to anon;
grant DELETE on public.source_groups to anon;
grant TRUNCATE on public.source_groups to anon;
grant REFERENCES on public.source_groups to anon;
grant TRIGGER on public.source_groups to anon;
grant INSERT on public.source_groups to authenticated;
grant SELECT on public.source_groups to authenticated;
grant UPDATE on public.source_groups to authenticated;
grant DELETE on public.source_groups to authenticated;
grant TRUNCATE on public.source_groups to authenticated;
grant REFERENCES on public.source_groups to authenticated;
grant TRIGGER on public.source_groups to authenticated;
grant INSERT on public.arm_commands to anon;
grant SELECT on public.arm_commands to anon;
grant UPDATE on public.arm_commands to anon;
grant DELETE on public.arm_commands to anon;
grant TRUNCATE on public.arm_commands to anon;
grant REFERENCES on public.arm_commands to anon;
grant TRIGGER on public.arm_commands to anon;
grant INSERT on public.arm_commands to authenticated;
grant SELECT on public.arm_commands to authenticated;
grant UPDATE on public.arm_commands to authenticated;
grant DELETE on public.arm_commands to authenticated;
grant TRUNCATE on public.arm_commands to authenticated;
grant REFERENCES on public.arm_commands to authenticated;
grant TRIGGER on public.arm_commands to authenticated;
grant INSERT on public.groups to anon;
grant SELECT on public.groups to anon;
grant UPDATE on public.groups to anon;
grant DELETE on public.groups to anon;
grant TRUNCATE on public.groups to anon;
grant REFERENCES on public.groups to anon;
grant TRIGGER on public.groups to anon;
grant INSERT on public.groups to authenticated;
grant SELECT on public.groups to authenticated;
grant UPDATE on public.groups to authenticated;
grant DELETE on public.groups to authenticated;
grant TRUNCATE on public.groups to authenticated;
grant REFERENCES on public.groups to authenticated;
grant TRIGGER on public.groups to authenticated;
grant INSERT on public.distribution_lists to anon;
grant SELECT on public.distribution_lists to anon;
grant UPDATE on public.distribution_lists to anon;
grant DELETE on public.distribution_lists to anon;
grant TRUNCATE on public.distribution_lists to anon;
grant REFERENCES on public.distribution_lists to anon;
grant TRIGGER on public.distribution_lists to anon;
grant INSERT on public.distribution_lists to authenticated;
grant SELECT on public.distribution_lists to authenticated;
grant UPDATE on public.distribution_lists to authenticated;
grant DELETE on public.distribution_lists to authenticated;
grant TRUNCATE on public.distribution_lists to authenticated;
grant REFERENCES on public.distribution_lists to authenticated;
grant TRIGGER on public.distribution_lists to authenticated;
grant INSERT on public.templates to anon;
grant SELECT on public.templates to anon;
grant UPDATE on public.templates to anon;
grant DELETE on public.templates to anon;
grant TRUNCATE on public.templates to anon;
grant REFERENCES on public.templates to anon;
grant TRIGGER on public.templates to anon;
grant INSERT on public.templates to authenticated;
grant SELECT on public.templates to authenticated;
grant UPDATE on public.templates to authenticated;
grant DELETE on public.templates to authenticated;
grant TRUNCATE on public.templates to authenticated;
grant REFERENCES on public.templates to authenticated;
grant TRIGGER on public.templates to authenticated;
grant INSERT on public.triggers to anon;
grant SELECT on public.triggers to anon;
grant UPDATE on public.triggers to anon;
grant DELETE on public.triggers to anon;
grant TRUNCATE on public.triggers to anon;
grant REFERENCES on public.triggers to anon;
grant TRIGGER on public.triggers to anon;
grant INSERT on public.triggers to authenticated;
grant SELECT on public.triggers to authenticated;
grant UPDATE on public.triggers to authenticated;
grant DELETE on public.triggers to authenticated;
grant TRUNCATE on public.triggers to authenticated;
grant REFERENCES on public.triggers to authenticated;
grant TRIGGER on public.triggers to authenticated;
grant INSERT on public.dispatchers to anon;
grant SELECT on public.dispatchers to anon;
grant UPDATE on public.dispatchers to anon;
grant DELETE on public.dispatchers to anon;
grant TRUNCATE on public.dispatchers to anon;
grant REFERENCES on public.dispatchers to anon;
grant TRIGGER on public.dispatchers to anon;
grant INSERT on public.dispatchers to authenticated;
grant SELECT on public.dispatchers to authenticated;
grant UPDATE on public.dispatchers to authenticated;
grant DELETE on public.dispatchers to authenticated;
grant TRUNCATE on public.dispatchers to authenticated;
grant REFERENCES on public.dispatchers to authenticated;
grant TRIGGER on public.dispatchers to authenticated;
grant INSERT on public.campaigns to anon;
grant SELECT on public.campaigns to anon;
grant UPDATE on public.campaigns to anon;
grant DELETE on public.campaigns to anon;
grant TRUNCATE on public.campaigns to anon;
grant REFERENCES on public.campaigns to anon;
grant TRIGGER on public.campaigns to anon;
grant INSERT on public.campaigns to authenticated;
grant SELECT on public.campaigns to authenticated;
grant UPDATE on public.campaigns to authenticated;
grant DELETE on public.campaigns to authenticated;
grant TRUNCATE on public.campaigns to authenticated;
grant REFERENCES on public.campaigns to authenticated;
grant TRIGGER on public.campaigns to authenticated;
grant INSERT on public.campaign_arms to anon;
grant SELECT on public.campaign_arms to anon;
grant UPDATE on public.campaign_arms to anon;
grant DELETE on public.campaign_arms to anon;
grant TRUNCATE on public.campaign_arms to anon;
grant REFERENCES on public.campaign_arms to anon;
grant TRIGGER on public.campaign_arms to anon;
grant INSERT on public.campaign_arms to authenticated;
grant SELECT on public.campaign_arms to authenticated;
grant UPDATE on public.campaign_arms to authenticated;
grant DELETE on public.campaign_arms to authenticated;
grant TRUNCATE on public.campaign_arms to authenticated;
grant REFERENCES on public.campaign_arms to authenticated;
grant TRIGGER on public.campaign_arms to authenticated;
grant INSERT on public.app_settings to anon;
grant SELECT on public.app_settings to anon;
grant UPDATE on public.app_settings to anon;
grant DELETE on public.app_settings to anon;
grant TRUNCATE on public.app_settings to anon;
grant REFERENCES on public.app_settings to anon;
grant TRIGGER on public.app_settings to anon;
grant INSERT on public.app_settings to authenticated;
grant SELECT on public.app_settings to authenticated;
grant UPDATE on public.app_settings to authenticated;
grant DELETE on public.app_settings to authenticated;
grant TRUNCATE on public.app_settings to authenticated;
grant REFERENCES on public.app_settings to authenticated;
grant TRIGGER on public.app_settings to authenticated;
grant INSERT on public.campaign_targets to anon;
grant SELECT on public.campaign_targets to anon;
grant UPDATE on public.campaign_targets to anon;
grant DELETE on public.campaign_targets to anon;
grant TRUNCATE on public.campaign_targets to anon;
grant REFERENCES on public.campaign_targets to anon;
grant TRIGGER on public.campaign_targets to anon;
grant INSERT on public.campaign_targets to authenticated;
grant SELECT on public.campaign_targets to authenticated;
grant UPDATE on public.campaign_targets to authenticated;
grant DELETE on public.campaign_targets to authenticated;
grant TRUNCATE on public.campaign_targets to authenticated;
grant REFERENCES on public.campaign_targets to authenticated;
grant TRIGGER on public.campaign_targets to authenticated;
grant INSERT on public.processed_messages to anon;
grant SELECT on public.processed_messages to anon;
grant UPDATE on public.processed_messages to anon;
grant DELETE on public.processed_messages to anon;
grant TRUNCATE on public.processed_messages to anon;
grant REFERENCES on public.processed_messages to anon;
grant TRIGGER on public.processed_messages to anon;
grant INSERT on public.processed_messages to authenticated;
grant SELECT on public.processed_messages to authenticated;
grant UPDATE on public.processed_messages to authenticated;
grant DELETE on public.processed_messages to authenticated;
grant TRUNCATE on public.processed_messages to authenticated;
grant REFERENCES on public.processed_messages to authenticated;
grant TRIGGER on public.processed_messages to authenticated;
grant INSERT on public.activity_log to anon;
grant SELECT on public.activity_log to anon;
grant UPDATE on public.activity_log to anon;
grant DELETE on public.activity_log to anon;
grant TRUNCATE on public.activity_log to anon;
grant REFERENCES on public.activity_log to anon;
grant TRIGGER on public.activity_log to anon;
grant INSERT on public.activity_log to authenticated;
grant SELECT on public.activity_log to authenticated;
grant UPDATE on public.activity_log to authenticated;
grant DELETE on public.activity_log to authenticated;
grant TRUNCATE on public.activity_log to authenticated;
grant REFERENCES on public.activity_log to authenticated;
grant TRIGGER on public.activity_log to authenticated;
grant INSERT on public.engine_lock to anon;
grant SELECT on public.engine_lock to anon;
grant UPDATE on public.engine_lock to anon;
grant DELETE on public.engine_lock to anon;
grant TRUNCATE on public.engine_lock to anon;
grant REFERENCES on public.engine_lock to anon;
grant TRIGGER on public.engine_lock to anon;
grant INSERT on public.engine_lock to authenticated;
grant SELECT on public.engine_lock to authenticated;
grant UPDATE on public.engine_lock to authenticated;
grant DELETE on public.engine_lock to authenticated;
grant TRUNCATE on public.engine_lock to authenticated;
grant REFERENCES on public.engine_lock to authenticated;
grant TRIGGER on public.engine_lock to authenticated;
grant INSERT on public.wa_operators to anon;
grant SELECT on public.wa_operators to anon;
grant UPDATE on public.wa_operators to anon;
grant DELETE on public.wa_operators to anon;
grant TRUNCATE on public.wa_operators to anon;
grant REFERENCES on public.wa_operators to anon;
grant TRIGGER on public.wa_operators to anon;
grant INSERT on public.wa_operators to authenticated;
grant SELECT on public.wa_operators to authenticated;
grant UPDATE on public.wa_operators to authenticated;
grant DELETE on public.wa_operators to authenticated;
grant TRUNCATE on public.wa_operators to authenticated;
grant REFERENCES on public.wa_operators to authenticated;
grant TRIGGER on public.wa_operators to authenticated;
grant INSERT on public.quote_sessions to anon;
grant SELECT on public.quote_sessions to anon;
grant UPDATE on public.quote_sessions to anon;
grant DELETE on public.quote_sessions to anon;
grant TRUNCATE on public.quote_sessions to anon;
grant REFERENCES on public.quote_sessions to anon;
grant TRIGGER on public.quote_sessions to anon;
grant INSERT on public.quote_sessions to authenticated;
grant SELECT on public.quote_sessions to authenticated;
grant UPDATE on public.quote_sessions to authenticated;
grant DELETE on public.quote_sessions to authenticated;
grant TRUNCATE on public.quote_sessions to authenticated;
grant REFERENCES on public.quote_sessions to authenticated;
grant TRIGGER on public.quote_sessions to authenticated;
grant SELECT on public.stations to authenticated;
grant DELETE on public.stations to authenticated;
grant execute on function check_max_arms() to anon;
grant execute on function check_max_arms() to authenticated;
grant execute on function check_same_station() to anon;
grant execute on function check_same_station() to authenticated;
grant execute on function claim_target_engine(uuid) to anon;
grant execute on function create_manual_campaign(text,uuid[],text[],uuid) to anon;
grant execute on function create_manual_campaign(text,uuid[],text[],uuid) to authenticated;
grant execute on function engine_backup_rows(text,integer,integer) to anon;
grant execute on function engine_lock_acquire(text) to anon;
grant execute on function engine_lock_release(text) to anon;
grant execute on function engine_station_states() to anon;
grant execute on function engine_station_states() to authenticated;
grant execute on function finalize_campaigns_engine() to anon;
grant execute on function home_station() to anon;
grant execute on function home_station() to authenticated;
grant execute on function inherit_station() to anon;
grant execute on function inherit_station() to authenticated;
grant execute on function is_engine() to anon;
grant execute on function is_engine() to authenticated;
grant execute on function is_super() to anon;
grant execute on function is_super() to authenticated;
grant execute on function log_activity(text,text,text,jsonb) to anon;
grant execute on function log_activity(text,text,text,jsonb) to authenticated;
grant execute on function my_rank() to anon;
grant execute on function my_rank() to authenticated;
grant execute on function my_station() to anon;
grant execute on function my_station() to authenticated;
grant execute on function req_header(text) to anon;
grant execute on function req_header(text) to authenticated;
grant execute on function retry_failed(uuid) to anon;
grant execute on function retry_failed(uuid) to authenticated;
grant execute on function role_rank(app_role) to anon;
grant execute on function role_rank(app_role) to authenticated;
grant execute on function station_extend(uuid,integer) to anon;
grant execute on function station_extend(uuid,integer) to authenticated;
grant execute on function station_from_token() to anon;
grant execute on function station_from_token() to authenticated;
grant execute on function station_login(text) to anon;
grant execute on function station_login(text) to authenticated;
grant execute on function station_logout() to anon;
grant execute on function station_logout() to authenticated;
grant execute on function station_logout_all(uuid) to anon;
grant execute on function station_logout_all(uuid) to authenticated;
grant execute on function station_me() to anon;
grant execute on function station_me() to authenticated;
grant execute on function station_ping() to anon;
grant execute on function station_ping() to authenticated;
grant execute on function station_save(jsonb) to anon;
grant execute on function station_save(jsonb) to authenticated;
grant execute on function station_set_code(uuid,text) to anon;
grant execute on function station_set_code(uuid,text) to authenticated;
grant execute on function stations_overview() to anon;
grant execute on function stations_overview() to authenticated;
grant execute on function target_result_engine(bigint,uuid,boolean,text) to anon;
