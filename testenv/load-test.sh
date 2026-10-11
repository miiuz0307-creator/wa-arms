#!/bin/bash
# Load test on the local test database: N stations, 2 arms each, 40 groups per arm, all distributing at once.
# Measures how many "take a group + mark sent" cycles the database handles per second, and the delay of each.
# Usage: ./load-test.sh <stations> [clients] [seconds]
set -e
cd "$(dirname "$0")"
N=${1:-10}; C=${2:-8}; T=${3:-20}; R=${4:-3}; DB=botix_load
su postgres -c "psql -q -c 'drop database if exists $DB' -c 'create database $DB'"
su postgres -c "psql -q -d $DB -f supabase_shim.sql" >/dev/null 2>&1
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f schema_ordered.sql" >/dev/null
for f in ../supabase/migrations/20261011_*.sql; do su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null; done
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f seed.sql" >/dev/null
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -v n=$N -v rides=$R -f load_seed.sql" >/dev/null
ARMS=$((N*2))
cp load_claim.pgb /tmp/load_claim.pgb && chmod 644 /tmp/load_claim.pgb
# finalize runs alongside, like the engine does every 10s
( for i in $(seq 1 $((T/5))); do sleep 5; su postgres -c "psql -q -d $DB -c 'select public.finalize_campaigns()'" >/dev/null; done ) &
su postgres -c "pgbench -n -c $C -j 2 -T $T -D narms=$ARMS -f /tmp/load_claim.pgb -r $DB" 2>&1 | grep -E "tps|latency average|latency stddev|number of transactions actually|failed"
wait
echo "stations=$N arms=$ARMS rides=$((N*R)) targets=$((N*R*80)) seconds=$T"
su postgres -c "psql -At -d $DB -c \"select 'sent='||count(*) filter (where status='sent')||' pending='||count(*) filter (where status='pending')||' sending='||count(*) filter (where status='sending')||' drain_sec='||round(extract(epoch from max(sent_at)-min(sent_at))::numeric,1)||' sends_per_sec='||round(count(*) filter (where status='sent')/greatest(extract(epoch from max(sent_at)-min(sent_at)),0.001)::numeric)||' dup_claims='||(select count(*) from (select campaign_id, wa_group_id from campaign_targets where status='sent' group by 1,2 having count(*)>1) x) from campaign_targets where station_id::text like '10000000%'\""
su postgres -c "psql -At -d $DB -c \"select 'cross_station_sends='||count(*) from campaign_targets t join arms a on a.id=t.arm_id where a.station_id<>t.station_id\""
