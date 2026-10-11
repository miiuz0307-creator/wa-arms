-- Load-test data: :n stations, 2 arms each, 40 groups per arm, one distribution per station
-- to all its groups (as if every station got a "עזרה" at the same moment). Nothing is sent anywhere.
insert into public.stations (id, name, code_hash, status, sub_end)
select ('10000000-0000-0000-0000-' || lpad(to_hex(s), 12, '0'))::uuid, 'עומס ' || s,
       encode(extensions.digest('LOAD' || s, 'sha256'), 'hex'), 'active', current_date + 30
from generate_series(1, :n) s;
insert into public.app_settings (station_id, distribution_mode, rate_per_minute)
select id, 'fill', 60 from public.stations where name like 'עומס %';
insert into public.arms (id, name, status, is_active, daily_limit, station_id)
select ('20000000-0000-' || lpad(to_hex(a), 4, '0') || '-0000-' || substr(st.id::text, 25, 12))::uuid, 'זרוע ' || a, 'online', true, 1000000, st.id
from public.stations st cross join generate_series(1, 2) a where st.name like 'עומס %';
insert into public.groups (arm_id, wa_group_id, name, station_id)
select a.id, a.id::text || '-' || g || '@g.us', 'קבוצה ' || g, a.station_id
from public.arms a cross join generate_series(1, 40) g where a.name like 'זרוע %' and a.station_id::text like '10000000%';
-- each station: :rides rides at once, each to all 80 of its groups
insert into public.campaigns (id, kind, status, message_text, final_text, station_id)
select gen_random_uuid(), 'help', 'queued', 'נסיעה לבדיקה', 'נסיעה לבדיקה', id from public.stations cross join generate_series(1, :rides) where name like 'עומס %';
insert into public.campaign_arms (campaign_id, arm_id, station_id)
select c.id, a.id, c.station_id from public.campaigns c join public.arms a on a.station_id = c.station_id where c.final_text = 'נסיעה לבדיקה';
insert into public.campaign_targets (campaign_id, wa_group_id, station_id)
select c.id, g.wa_group_id, c.station_id from public.campaigns c join public.groups g on g.station_id = c.station_id where c.final_text = 'נסיעה לבדיקה';
create table if not exists testkit.load_arms as select id, row_number() over () rn from public.arms where station_id::text like '10000000%';
analyze;
create or replace function testkit.cycle(p_rn int) returns void language plpgsql as $$
declare a uuid; j record;
begin
  select id into a from testkit.load_arms where rn = p_rn;
  select * into j from public.claim_target_engine(a);
  if j.target_id is not null then perform public.target_result_engine(j.target_id, a, true, null); end if;
end $$;
