-- Automated database tests (run by run-tests.sh on a local copy of the production schema).
\set ON_ERROR_STOP 0
truncate testkit.results;
-- ========== 1. station isolation ==========
set role anon;
select testkit.as_station('tok-a');
select testkit.check((select count(*) from arms) = 2 and (select bool_and(station_id = '0000000a-0000-0000-0000-000000000000') from arms), 'isolation: station A sees only its 2 arms');
select testkit.check((select count(*) from groups) = 62, 'isolation: station A sees only its groups', (select count(*)::text from groups));
select testkit.check((select count(*) from app_settings) = 1, 'isolation: station A sees only its settings');
-- try to change station B's arm by id
update arms set name = 'hacked' where id = '00000000-0000-0000-0001-00000000000b';
select testkit.check(true, 'isolation: (update attempted)');
-- try to create a row in station B
do $$ begin
  insert into distribution_lists (name, station_id) values ('x', '0000000b-0000-0000-0000-000000000000');
  perform testkit.check(false, 'isolation: A cannot create rows in B');
exception when others then perform testkit.check(true, 'isolation: A cannot create rows in B', sqlerrm); end $$;
-- campaign with B's arm ids is limited to A's own arms
do $$ declare cid uuid; n int; begin
  cid := public.create_manual_campaign('בדיקה', array['00000000-0000-0000-0001-00000000000b'::uuid], array['shared@g.us']);
  perform testkit.check(false, 'isolation: campaign with another station''s arm is refused');
exception when others then perform testkit.check(true, 'isolation: campaign with another station''s arm is refused', sqlerrm); end $$;
-- station token cannot act as another station via x-act-station
do $$ begin
  perform set_config('request.headers', json_build_object('x-station-token', 'tok-a', 'x-act-station', '0000000b-0000-0000-0000-000000000000')::text, false);
  perform testkit.check(public.my_station() = '0000000a-0000-0000-0000-000000000000', 'isolation: station token cannot switch to another station');
end $$;
-- no token: nothing
select testkit.as_nobody();
select testkit.check((select count(*) from arms) = 0 and (select count(*) from campaigns) = 0, 'isolation: without login nothing is visible');
-- forged token
select testkit.as_station('tok-forged');
select testkit.check((select count(*) from arms) = 0, 'isolation: a made-up token sees nothing');
reset role;
select testkit.check((select name from arms where id = '00000000-0000-0000-0001-00000000000b') <> 'hacked', 'isolation: B''s arm was not changed by A');

-- ========== 2. distribution only inside the station ==========
set role anon;
select testkit.as_station('tok-a');
select public.create_manual_campaign('נסיעה של א', null, array['shared@g.us', '0000000a-0000-0000-0000-000000000000-1@g.us']) as camp_a \gset
reset role;
set role anon;
select testkit.as_engine();
-- arms of B try to claim: must get nothing from A's distribution (even for the shared group)
select testkit.check((select count(*) from public.claim_target_engine('00000000-0000-0000-0001-00000000000b')) = 0, 'distribution: arm of B never gets a ride of A (same group in both)');
select testkit.check((select count(*) from public.claim_target_engine('00000000-0000-0000-0001-00000000000a')) = 1, 'distribution: arm of A gets its own ride');
reset role;


-- ladder: an arm stays on its ride, a second arm takes the ride nobody is on
reset role;
update campaigns set status = 'completed' where station_id = '0000000b-0000-0000-0000-000000000000';
set role anon; select testkit.as_station('tok-b');
select public.create_manual_campaign('ride 1', null, array(select '0000000b-0000-0000-0000-000000000000-' || g || '@g.us' from generate_series(1, 5) g)) as r1 \gset
select pg_sleep(0.01);
select public.create_manual_campaign('ride 2', null, array(select '0000000b-0000-0000-0000-000000000000-' || g || '@g.us' from generate_series(6, 10) g)) as r2 \gset
select testkit.as_engine();
select campaign_id as c1 from public.claim_target_engine('00000000-0000-0000-0001-00000000000b') \gset
select campaign_id as c2 from public.claim_target_engine('00000000-0000-0000-0002-00000000000b') \gset
select campaign_id as c3 from public.claim_target_engine('00000000-0000-0000-0001-00000000000b') \gset
select testkit.check(:'c1' = :'r1' and :'c2' = :'r2' and :'c3' = :'r1', 'distribution: each arm keeps its own ride, the free ride gets the other arm');
reset role;

-- ========== 3. permissions of engine-only functions ==========
set role anon;
select testkit.as_station('tok-a');
do $$ begin perform public.claim_target_engine('00000000-0000-0000-0001-00000000000a'); perform testkit.check(false, 'security: station cannot call engine functions');
exception when others then perform testkit.check(true, 'security: station cannot call engine functions'); end $$;
do $$ begin perform public.engine_backup_rows('stations', 0, 10); perform testkit.check(false, 'security: backup export is engine-only');
exception when others then perform testkit.check(true, 'security: backup export is engine-only'); end $$;
do $$ begin perform public.station_save('{"name":"x"}'::jsonb); perform testkit.check(false, 'security: station cannot create stations');
exception when others then perform testkit.check(true, 'security: station cannot create stations'); end $$;
select testkit.check((select count(*) from information_schema.role_table_grants where grantee = 'anon' and table_name in ('stations', 'station_sessions', 'engine_keys')) = 0, 'security: login/key tables not reachable directly');
reset role;

-- ========== 4. subscription ==========
update stations set status = 'suspended' where id = '0000000c-0000-0000-0000-000000000000';
set role anon;
select testkit.as_station('tok-c');
select testkit.check((select count(*) from arms) = 0, 'subscription: suspended station is locked out at once');
reset role;
select testkit.check((select count(*) from arms where station_id = '0000000c-0000-0000-0000-000000000000') = 2
  and (select count(*) from groups where station_id = '0000000c-0000-0000-0000-000000000000') = 60, 'subscription: suspension deletes nothing');
set role anon; select testkit.as_engine();
select testkit.check((select allowed from public.engine_station_states() where id = '0000000c-0000-0000-0000-000000000000') = false, 'subscription: engine stops a suspended station''s arms');
reset role;
update stations set status = 'active', sub_end = current_date - 1 where id = '0000000c-0000-0000-0000-000000000000';
set role anon; select testkit.as_station('tok-c');
select testkit.check((select count(*) from arms) = 0, 'subscription: ended subscription is locked out');
reset role;
update stations set sub_end = current_date + 30 where id = '0000000c-0000-0000-0000-000000000000';
set role anon; select testkit.as_station('tok-c');
select testkit.check((select count(*) from arms) = 2, 'subscription: renewal restores access with all data');
reset role;

-- ========== 5. no duplicates / no late rides (finalize) ==========
-- a send that never reported back must not be re-queued
update campaign_targets set status = 'sending', claimed_at = now() - interval '6 minutes' where campaign_id = :'camp_a' and status = 'sending';
select public.finalize_campaigns();
select testkit.check((select count(*) from campaign_targets where campaign_id = :'camp_a' and status = 'pending' and attempts > 0) = 0
  and (select count(*) from campaign_targets where campaign_id = :'camp_a' and status = 'failed' and error like '%כפילות%') = 1,
  'duplicates: interrupted send is closed, not sent again');
-- a stuck help ride (no progress 25 min) expires instead of going out late
insert into campaigns (id, kind, status, message_text, final_text, station_id, created_at, last_claim_at)
values ('00000000-0000-0000-0000-0000000000d1', 'help', 'running', 'נסיעה ישנה', 'נסיעה ישנה', '0000000a-0000-0000-0000-000000000000', now() - interval '25 minutes', now() - interval '25 minutes');
insert into campaign_arms (campaign_id, arm_id, station_id) values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0001-00000000000a', '0000000a-0000-0000-0000-000000000000');
insert into campaign_targets (campaign_id, wa_group_id, station_id) values ('00000000-0000-0000-0000-0000000000d1', '0000000a-0000-0000-0000-000000000000-2@g.us', '0000000a-0000-0000-0000-000000000000');
-- a fresh ride (2 min) keeps going
insert into campaigns (id, kind, status, message_text, final_text, station_id, created_at) values ('00000000-0000-0000-0000-0000000000d2', 'help', 'running', 'נסיעה חדשה', 'נסיעה חדשה', '0000000a-0000-0000-0000-000000000000', now() - interval '2 minutes');
insert into campaign_arms (campaign_id, arm_id, station_id) values ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0001-00000000000a', '0000000a-0000-0000-0000-000000000000');
insert into campaign_targets (campaign_id, wa_group_id, station_id) values ('00000000-0000-0000-0000-0000000000d2', '0000000a-0000-0000-0000-000000000000-3@g.us', '0000000a-0000-0000-0000-000000000000');
select public.finalize_campaigns();
select testkit.check((select status from campaign_targets where campaign_id = '00000000-0000-0000-0000-0000000000d1') = 'skipped'
  and (select status from campaigns where id = '00000000-0000-0000-0000-0000000000d1') = 'completed', 'late rides: a ride stuck 25 minutes is not sent late');
select testkit.check((select status from campaign_targets where campaign_id = '00000000-0000-0000-0000-0000000000d2') = 'pending', 'late rides: a fresh ride keeps going');

-- ========== 6. login ==========
set role anon;
select testkit.as_nobody('10.1.1.1');
select testkit.check((public.station_login('codeaaaa') ->> 'token') is not null, 'login: correct code works (any case, spaces ignored)');
select testkit.check((public.station_login('wrong') ->> 'error') is not null, 'login: wrong code refused');
do $$ declare i int; r json; begin
  for i in 1..10 loop perform public.station_login('WRONG' || i); end loop;
  r := public.station_login('CODEAAAA');
  perform testkit.check(r ->> 'token' is null, 'login: 10 wrong codes from one address block it (even the right code)', r::text);
end $$;
-- the browser forges x-forwarded-for but the edge address stays the same
do $$ declare r json; begin
  perform testkit.as_nobody('10.1.1.1', '1.2.3.' || floor(random() * 200)::int);
  r := public.station_login('CODEAAAA');
  perform testkit.check(r ->> 'token' is null, 'login: changing x-forwarded-for does not bypass the limit', r::text);
end $$;
-- many addresses guessing → system-wide brake
do $$ declare i int; r json; begin
  for i in 1..60 loop perform testkit.as_nobody('10.2.0.' || i); perform public.station_login('GUESS' || i); end loop;
  perform testkit.as_nobody('10.3.3.3');
  r := public.station_login('CODEBBBB');
  perform testkit.check(r ->> 'token' is null, 'login: guessing from many addresses triggers a system-wide pause', r::text);
end $$;
reset role;
delete from station_login_attempts;
-- a login unused for 31 days expires
update station_sessions set last_seen = now() - interval '31 days' where station_id = '0000000b-0000-0000-0000-000000000000';
set role anon; select testkit.as_station('tok-b');
select testkit.check((select count(*) from arms) = 0, 'login: a login unused for 30 days expires');
reset role;
update station_sessions set last_seen = now() where station_id = '0000000b-0000-0000-0000-000000000000';

-- ========== 7. owner ==========
set role authenticated;
select testkit.as_owner();
select testkit.check((select count(*) from public.stations_overview()) = 3, 'owner: sees all stations in the overview');
select testkit.as_owner('0000000b-0000-0000-0000-000000000000');
select testkit.check((select count(*) from arms) = 2 and (select bool_and(station_id = '0000000b-0000-0000-0000-000000000000') from arms), 'owner: can enter a station to support it');
reset role;

-- monitoring
reset role;
update arms set status = 'offline', last_error = 'החיבור נפל' where id = '00000000-0000-0000-0002-00000000000c';
set role authenticated; select testkit.as_owner();
select testkit.check((select count(*) from public.owner_health() where arm_name is not null and station_name = 'תחנה ג') = 1, 'monitoring: owner sees a disconnected number of another station');
set role anon; select testkit.as_station('tok-a');
do $$ begin perform public.owner_health(); perform testkit.check(false, 'monitoring: stations cannot see the system monitor');
exception when others then perform testkit.check(true, 'monitoring: stations cannot see the system monitor'); end $$;
reset role;

-- temporary data cleanup keeps history
reset role;
insert into processed_messages (station_id, source_group_id, message_id, processed_at) values
 ('0000000a-0000-0000-0000-000000000000', 'g', 'old', now() - interval '4 days'),
 ('0000000a-0000-0000-0000-000000000000', 'g', 'new', now() - interval '10 minutes');
select count(*) as camps_before from campaigns \gset
set role anon; select testkit.as_engine();
select public.engine_cleanup();
reset role;
select testkit.check((select count(*) from processed_messages where message_id = 'old') = 0 and (select count(*) from processed_messages where message_id = 'new') = 1
  and (select count(*) from campaigns) = :camps_before, 'cleanup: old temporary rows removed, recent ones and distribution history kept');
set role anon; select testkit.as_station('tok-a');
do $$ begin perform public.engine_cleanup(); perform testkit.check(false, 'cleanup: engine only');
exception when others then perform testkit.check(true, 'cleanup: engine only'); end $$;
reset role;

-- owner control center + payments
set role authenticated; select testkit.as_owner();
select testkit.check((select count(*) from public.owner_arms()) = 6, 'control: owner sees every arm of every station');
select testkit.check((select count(distinct station_id) from public.owner_today()) >= 3, 'control: today summary per station');
select public.owner_arm_command('00000000-0000-0000-0001-00000000000b', 'connect');
select public.owner_arm_limit('00000000-0000-0000-0002-00000000000b', 0);
reset role;
select testkit.check((select station_id from arm_commands where arm_id = '00000000-0000-0000-0001-00000000000b' order by id desc limit 1) = '0000000b-0000-0000-0000-000000000000',
  'control: a button pressed in the center reaches the right station''s arm');
select testkit.check((select daily_limit from arms where id = '00000000-0000-0000-0002-00000000000b') = 0, 'control: stop sending keeps the arm connected (limit 0)');
update stations set sub_end = current_date - 40 where id = '0000000c-0000-0000-0000-000000000000';
update stations set price = 200 where id = '0000000c-0000-0000-0000-000000000000';
set role authenticated; select testkit.as_owner();
select testkit.check((select owed from public.owner_billing() where station_id = '0000000c-0000-0000-0000-000000000000') = 400, 'billing: 40 days overdue at 200/month = 400 owed',
  (select owed::text from public.owner_billing() where station_id = '0000000c-0000-0000-0000-000000000000'));
select public.owner_payment_add('0000000c-0000-0000-0000-000000000000', 400, 2, 'ביט', 'בדיקה');
select testkit.check((select sub_end from stations where id = '0000000c-0000-0000-0000-000000000000') = (current_date + interval '2 months')::date
  and (select paid_total from public.owner_billing() where station_id = '0000000c-0000-0000-0000-000000000000') = 400
  and (select owed from public.owner_billing() where station_id = '0000000c-0000-0000-0000-000000000000') = 0, 'billing: a payment of 2 months extends the subscription and clears the debt');
select testkit.check((select count(*) from public.owner_payments()) = 1, 'billing: payment listed');
reset role;
set role anon; select testkit.as_station('tok-a');
do $$ begin perform public.owner_billing(); perform testkit.check(false, 'billing: stations cannot see payments');
exception when others then perform testkit.check(true, 'billing: stations cannot see payments'); end $$;
do $$ begin perform public.owner_arm_command('00000000-0000-0000-0001-00000000000b', 'reset'); perform testkit.check(false, 'control: a station cannot press buttons on another station');
exception when others then perform testkit.check(true, 'control: a station cannot press buttons on another station'); end $$;
select testkit.check((select count(*) from information_schema.role_table_grants where grantee in ('anon','authenticated') and table_name = 'station_payments') = 0, 'billing: payments table not reachable directly');
reset role;

-- arm requests, system messages, payment reminders
update stations set max_arms = 2, price = 200, sub_end = current_date + 3 where id = '0000000a-0000-0000-0000-000000000000';
set role authenticated; select testkit.as_owner();
select public.owner_settings_save('ביט ל-0501234567', 60, 5);
reset role;
set role anon; select testkit.as_station('tok-a');
select public.station_request_arms(2, 'צריך עוד שתיים');
select public.station_request_arms(1, 'בעצם אחת');
select testkit.check((public.station_inbox() -> 'arm_request' ->> 'count')::int = 1, 'requests: asking again updates the one open request');
select testkit.check((public.station_inbox() -> 'billing' ->> 'remind')::boolean and (public.station_inbox() -> 'billing' ->> 'payment_note') like 'ביט%',
  'reminder: station sees the payment reminder 3 days before, with how to pay');
reset role;
set role authenticated; select testkit.as_owner();
select testkit.check((select count(*) from public.owner_arm_requests() where status = 'pending') = 1, 'requests: owner sees the request');
select public.owner_decide_arm_request((select id from public.owner_arm_requests() where status = 'pending' limit 1), true, 260);
select public.owner_message_send('עדכון מערכת', 'תחזוקה הלילה ב-02:00', 'warning', null, 2);
reset role;
select testkit.check((select max_arms from stations where id = '0000000a-0000-0000-0000-000000000000') = 3
  and (select price from stations where id = '0000000a-0000-0000-0000-000000000000') = 260, 'requests: approval raises the arm limit and sets the new monthly price');
set role anon; select testkit.as_station('tok-a');
select testkit.check((select count(*) from json_array_elements(public.station_inbox() -> 'messages')) = 2, 'messages: station A sees the approval and the message to everyone');
select testkit.as_station('tok-b');
select testkit.check((select count(*) from json_array_elements(public.station_inbox() -> 'messages')) = 1, 'messages: station B sees only the message to everyone');
do $$ begin perform public.owner_message_send('x', 'y'); perform testkit.check(false, 'messages: only the owner can send');
exception when others then perform testkit.check(true, 'messages: only the owner can send'); end $$;
reset role;

select n, case when ok then 'PASS' else 'FAIL' end as result, name, coalesce(left(detail, 80), '') from testkit.results where name not like '%(update attempted)%' order by n;
