-- Test data: the home system + 3 trial stations (A, B, C), each with 2 arms and 30 groups per arm.
-- Group 'shared@g.us' exists in A and B on purpose: same WhatsApp group in two stations.
create schema if not exists testkit;
create table if not exists testkit.results (n serial, name text, ok boolean, detail text);
grant usage on schema testkit to anon, authenticated;
grant insert, select on testkit.results to anon, authenticated;
grant usage on sequence testkit.results_n_seq to anon, authenticated;
create or replace function testkit.check(ok boolean, name text, detail text default null) returns void
language sql as $$ insert into testkit.results (name, ok, detail) values (name, coalesce(ok, false), detail) $$;
grant execute on function testkit.check(boolean, text, text) to anon, authenticated;

-- impersonation helpers (what PostgREST does per request)
create or replace function testkit.as_station(tok text) returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-station-token', tok, 'cf-connecting-ip', '10.0.0.1')::text, false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create or replace function testkit.as_engine() returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_build_object('x-engine-key', 'test-engine-key')::text, false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
create or replace function testkit.as_owner(act uuid default null) returns void language plpgsql as $$
begin
  perform set_config('request.headers', case when act is null then '{}' else json_build_object('x-act-station', act)::text end, false);
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000f', false);
end $$;
create or replace function testkit.as_nobody(ip text default '10.0.0.9', fwd text default null) returns void language plpgsql as $$
begin
  perform set_config('request.headers', json_strip_nulls(json_build_object('cf-connecting-ip', ip, 'x-forwarded-for', fwd))::text, false);
  perform set_config('request.jwt.claim.sub', '', false);
end $$;
grant usage on schema testkit to anon, authenticated;
grant execute on all functions in schema testkit to anon, authenticated;

insert into public.engine_keys (key_hash) values (encode(extensions.digest('test-engine-key', 'sha256'), 'hex'));
insert into public.stations (id, name, is_home, status) values ('00000000-0000-0000-0000-000000000000', 'בית', true, 'active');
insert into auth.users (id) values ('00000000-0000-0000-0000-00000000000f');
insert into public.profiles (id, email, role, is_active, station_id) values ('00000000-0000-0000-0000-00000000000f', 'owner@test', 'owner', true, '00000000-0000-0000-0000-000000000000');

insert into public.stations (id, name, code_hash, code_hint, status, sub_end) values
 ('0000000a-0000-0000-0000-000000000000', 'תחנה א', encode(extensions.digest('CODEAAAA', 'sha256'), 'hex'), 'AA', 'active', current_date + 30),
 ('0000000b-0000-0000-0000-000000000000', 'תחנה ב', encode(extensions.digest('CODEBBBB', 'sha256'), 'hex'), 'BB', 'active', current_date + 30),
 ('0000000c-0000-0000-0000-000000000000', 'תחנה ג', encode(extensions.digest('CODECCCC', 'sha256'), 'hex'), 'CC', 'active', current_date + 30);
insert into public.station_sessions (token_hash, station_id) select encode(extensions.digest('tok-' || x, 'sha256'), 'hex'), id
 from (values ('a', '0000000a-0000-0000-0000-000000000000'::uuid), ('b', '0000000b-0000-0000-0000-000000000000'), ('c', '0000000c-0000-0000-0000-000000000000')) v(x, id);

insert into public.app_settings (station_id, distribution_mode, rate_per_minute) select id, 'fill', 20 from public.stations;
insert into public.arms (id, name, status, is_active, daily_limit, station_id)
select ('00000000-0000-0000-' || lpad(n::text, 4, '0') || '-' || lpad(s.k, 12, '0'))::uuid, 'זרוע ' || s.k || n, 'online', true, 100000, s.id
from (values ('a', '0000000a-0000-0000-0000-000000000000'::uuid), ('b', '0000000b-0000-0000-0000-000000000000'), ('c', '0000000c-0000-0000-0000-000000000000')) s(k, id)
cross join generate_series(1, 2) n
-- hex-only ids: 'a','b','c' are hex digits
;
insert into public.groups (arm_id, wa_group_id, name, station_id)
select a.id, a.station_id::text || '-' || g || '@g.us', 'קבוצה ' || g, a.station_id from public.arms a cross join generate_series(1, 30) g;
insert into public.groups (arm_id, wa_group_id, name, station_id)
select a.id, 'shared@g.us', 'קבוצה משותפת', a.station_id from public.arms a where a.station_id in ('0000000a-0000-0000-0000-000000000000', '0000000b-0000-0000-0000-000000000000');
