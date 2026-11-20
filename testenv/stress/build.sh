#!/bin/bash
# Builds an isolated stress database. Usage: sudo ./build.sh <db> <old|new>
#   old = the engine running today (without 20261120b_engine_v2.sql), new = engine v2
set -e
cd "$(dirname "$0")/.."
DB=$1; MODE=$2
pg_ctlcluster 16 main status >/dev/null 2>&1 || pg_ctlcluster 16 main start
su postgres -c "psql -q -c 'drop database if exists $DB' -c 'create database $DB'"
su postgres -c "psql -q -d $DB -f supabase_shim.sql" >/dev/null 2>&1
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f schema_ordered.sql" >/dev/null
for f in ../supabase/migrations/20261011_*.sql ../supabase/migrations/20261012_*.sql ../supabase/pending/*.sql; do
  case $f in *_cron.sql) continue;; esac
  if [ "$MODE" = old ] && [[ $f == *20261120b_engine_v2.sql ]]; then continue; fi
  su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f $f" >/dev/null
done
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f seed.sql" >/dev/null
su postgres -c "psql -q -d $DB -v ON_ERROR_STOP=1 -f stress/seed_stress.sql" >/dev/null
echo "built $DB ($MODE)"
