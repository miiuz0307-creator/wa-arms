#!/bin/bash
# Builds a fresh local test database from the production schema (no production data, no WhatsApp),
# loads 3 trial stations, and runs the automated database tests. Usage: sudo ./run-tests.sh
set -e
cd "$(dirname "$0")"
DB=botix_test
pg_ctlcluster 16 main status >/dev/null 2>&1 || pg_ctlcluster 16 main start
su postgres -c "psql -q -c 'drop database if exists $DB' -c 'create database $DB'"
su postgres -c "psql -q -d $DB -f supabase_shim.sql" >/dev/null
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f schema_ordered.sql" >/dev/null
for f in ../supabase/migrations/20261011_*.sql ../supabase/pending/*.sql; do case $f in *_cron.sql) continue;; esac; su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null; done
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f seed.sql" >/dev/null
su postgres -c "psql -q -d $DB -f tests.sql" 2>/dev/null | grep -E "PASS|FAIL"
fails=$(su postgres -c "psql -At -d $DB -c \"select count(*) from testkit.results where not ok\"")
echo "failed: $fails"
[ "$fails" = "0" ]
