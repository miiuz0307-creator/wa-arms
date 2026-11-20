#!/usr/bin/env python3
"""Stress + fault test against an isolated DB, in real time.
Each arm is a worker: take a group (claim_target_engine), "send" it (sleep its real speed), report the result.
Faults: M disconnects for a while (handover), 0.5% sends never report (unknown result), 1% sends fail.
Usage: run.py <db> <minutes> <ride_every_sec> [extreme]"""
import sys, time, random, threading, psycopg2, json
DB, MINUTES, EVERY = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
random.seed(7)
ARMS = {  # id, seconds per message (measured on Nov 20: ~64/min for A and Y, ~48/min for M while active)
 'A': ('00000000-0000-0000-0001-00000000000a', 60/64), 'Y': ('00000000-0000-0000-0002-00000000000a', 60/64),
 'M': ('00000000-0000-0000-0003-00000000000a', 60/48), 'S': ('00000000-0000-0000-0004-00000000000a', 2.0),
 'b1': ('00000000-0000-0000-0001-00000000000b', 60/64), 'b2': ('00000000-0000-0000-0002-00000000000b', 60/64)}
def conn():
    c = psycopg2.connect(dbname=DB, user='postgres'); c.autocommit = True
    cur = c.cursor(); cur.execute("select testkit.as_engine()"); return c, cur
stop = time.time() + MINUTES * 60
finished = threading.Event()
lock = threading.Lock(); stats = {'claims': 0, 'unknown': 0, 'failed': 0, 'errors': 0}
def arm_worker(name):
    aid, sec = ARMS[name]; c, cur = conn()
    while not finished.is_set():   # keep draining until every ride is done (or the 15-minute rule closed it)
        try:
            cur.execute("select target_id from public.claim_target_engine(%s)", (aid,))
            r = cur.fetchone()
            if not r or r[0] is None: time.sleep(0.25); continue
            time.sleep(sec)
            x = random.random()
            with lock: stats['claims'] += 1
            if x < 0.005: 
                with lock: stats['unknown'] += 1
                continue                           # never reported: unknown result
            ok = x >= 0.015
            if not ok:
                with lock: stats['failed'] += 1
            cur.execute("select public.target_result_engine(%s, %s, %s, %s)", (r[0], aid, ok, None if ok else 'test failure'))
        except Exception as e:
            with lock: stats['errors'] += 1
            print('ERR', name, str(e)[:200]); time.sleep(0.5); c, cur = conn()
def rides(station_tok, groups_sql, every, label):
    c, cur = conn(); n = 0; t0 = time.time()
    while time.time() < stop:
        cur.execute("select testkit.as_station(%s)", (station_tok,))
        cur.execute("select public.create_manual_campaign(%s, null, array(" + groups_sql + "))", (f'{label} ride {n}',))
        cid = cur.fetchone()[0]
        cur.execute("update campaigns set kind = 'quote' where id = %s", (cid,))
        cur.execute("select testkit.as_engine()")
        n += 1
        time.sleep(max(0.5, random.expovariate(1 / every)))
def faults():
    c, cur = conn()
    time.sleep(MINUTES * 60 * 0.3)
    cur.execute("update arms set status = 'offline' where name = 'M'"); print('M offline', flush=True)
    time.sleep(60)
    cur.execute("update arms set status = 'online' where name = 'M'"); print('M back', flush=True)
def minute_jobs():
    c, cur = conn()
    while not finished.is_set():
        if time.time() > stop:
            cur.execute("select count(*) from campaign_targets t join groups g on g.wa_group_id=t.wa_group_id where t.status in ('pending','sending')")
            if cur.fetchone()[0] == 0 or time.time() > stop + 17*60: finished.set()
        for f in ("select public.finalize_campaigns()", "select public.update_arm_rates()"):
            try: cur.execute(f)
            except Exception: pass
        time.sleep(10)
th = [threading.Thread(target=arm_worker, args=(n,)) for n in ARMS]
th += [threading.Thread(target=rides, args=('tok-a', "select 'A-' || g || '@g.us' from generate_series(1, 257) g", EVERY, 'A')),
       threading.Thread(target=rides, args=('tok-b', "select '0000000b-0000-0000-0000-000000000000-' || g || '@g.us' from generate_series(1, 30) g", EVERY * 3, 'B')),
       threading.Thread(target=faults), threading.Thread(target=minute_jobs)]
for t in th: t.start()
for t in th: t.join()
c, cur = conn()
cur.execute("select public.finalize_campaigns()")
q = lambda s: (cur.execute(s), cur.fetchall())[1]
res = {}
res['rides_A'] = q("select count(*) from campaigns where station_id='0000000a-0000-0000-0000-000000000000'")[0][0]
res['dup_sends'] = q("select count(*) from (select campaign_id, wa_group_id from campaign_targets where status in ('sent','sending') group by 1,2 having count(*)>1) x")[0][0]
res['cross_station'] = q("select count(*) from campaign_targets t join arms a on a.id=t.arm_id where a.station_id<>t.station_id")[0][0]
res['first_send_s'] = q("""select round(avg(f)::numeric,1), round(percentile_cont(.9) within group (order by f)::numeric,1) from (
   select extract(epoch from min(t.sent_at) filter (where a.name<>'S') - c.created_at) f from campaigns c join campaign_targets t on t.campaign_id=c.id join arms a on a.id=t.arm_id
   where c.station_id='0000000a-0000-0000-0000-000000000000' and t.status='sent' group by c.id, c.created_at) z""")[0]
res['done_s'] = q("""select round(avg(d)::numeric,1), round(percentile_cont(.9) within group (order by d)::numeric,1) from (
   select extract(epoch from max(t.sent_at) - c.created_at) d from campaigns c join campaign_targets t on t.campaign_id=c.id
   where c.station_id='0000000a-0000-0000-0000-000000000000' and t.status='sent' group by c.id, c.created_at) z""")[0]
res['targets_A_by_status'] = dict(q("""select t.status||coalesce(' / '||left(t.error,40),''), count(*) from campaign_targets t join campaigns c on c.id=t.campaign_id
   where c.station_id='0000000a-0000-0000-0000-000000000000' and exists(select 1 from groups g where g.wa_group_id=t.wa_group_id) group by 1 order by 2 desc"""))
res['sent_on_time_pct'] = q("""select round(100.0*count(*) filter (where t.status='sent')/count(*),1) from campaign_targets t join campaigns c on c.id=t.campaign_id
   where c.station_id='0000000a-0000-0000-0000-000000000000' and exists(select 1 from groups g where g.wa_group_id=t.wa_group_id)""")[0][0]
res['stats'] = stats
print(json.dumps(res, ensure_ascii=False, default=str))
