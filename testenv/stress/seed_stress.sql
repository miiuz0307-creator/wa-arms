-- Station A gets the real coverage of the home station (Nov 20): 257 groups, arms A / Y / M and the limited S.
-- Station B keeps its 2 seeded arms and 30 groups (to check that the stations never mix).
alter table public.arms add column if not exists rate_per_min numeric;
update public.arms set name = 'A' where id = '00000000-0000-0000-0001-00000000000a';
update public.arms set name = 'Y' where id = '00000000-0000-0000-0002-00000000000a';
insert into public.arms (id, name, status, is_active, daily_limit, station_id) values
 ('00000000-0000-0000-0003-00000000000a', 'M', 'online', true, 100000, '0000000a-0000-0000-0000-000000000000'),
 ('00000000-0000-0000-0004-00000000000a', 'S', 'online', true, 100000, '0000000a-0000-0000-0000-000000000000');
delete from public.groups where station_id = '0000000a-0000-0000-0000-000000000000';
create temp table combos(k text, n int);
insert into combos values ('AY',63),('Y',35),('AYMS',1),('YM',13),('M',50),('AM',2),('AYM',10),('A',83);
create temp table g as select row_number() over () as gi, k from combos, generate_series(1, n);
insert into public.groups (arm_id, wa_group_id, name, station_id)
select a.id, 'A-' || g.gi || '@g.us', 'קבוצה ' || g.gi, '0000000a-0000-0000-0000-000000000000'
from g join public.arms a on a.station_id = '0000000a-0000-0000-0000-000000000000' and position(a.name in g.k) > 0;
update public.arms set only_groups = array[(select 'A-' || gi || '@g.us' from g where k = 'AYMS')] where name = 'S';
update public.app_settings set priority_groups = array[(select 'A-' || gi || '@g.us' from g where k = 'AYMS')]
where station_id = '0000000a-0000-0000-0000-000000000000';
