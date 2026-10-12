#!/usr/bin/env bash
# BotiX – restore drill / real restore from an encrypted backup (run by the owner on his own computer).
#   bash restore-drill.sh <botix-db-....dump.age> <private key file> <TARGET_DB_URL>
# TARGET_DB_URL must be an EMPTY database: a local docker PostgreSQL 17 for the monthly drill, or a NEW Supabase
# project in a real disaster. Never the running production database.
# Checks the file against its .sha256 (same folder) and compares every table with the .manifest.tsv.
set -euo pipefail
FILE=$1 KEY=$2 TARGET=$3
BASE=${FILE%.dump.age}
DIR=$(dirname "$FILE")
if ( cd "$DIR" && grep "$(basename "$FILE")" "$(basename "$BASE").sha256" | sha256sum -c --quiet ); then echo "checksum OK"; else echo "CHECKSUM WRONG – file damaged or changed, not restored"; exit 1; fi
age -d -i "$KEY" -o "$BASE.dump" "$FILE"
psql "$TARGET" -X -q <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
SQL
pg_restore -d "$TARGET" --no-owner --no-privileges "$BASE.dump" 2> "$BASE.restore.log" || true
rm -f "$BASE.dump"
bad=0
while IFS=$'\t' read -r t n; do
  r=$(psql "$TARGET" -X -At -c "select count(*) from $t" 2>/dev/null || echo missing)
  printf '%-45s backup %-9s restored %s\n' "$t" "$n" "$r"
  [[ "$r" == "$n" ]] || bad=1
done < "$BASE.manifest.tsv"
[[ $bad == 0 ]] && echo "RESTORE OK – every table matches the backup" || { echo "RESTORE CHECK: differences above"; exit 1; }
