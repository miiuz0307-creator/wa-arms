#!/usr/bin/env bash
# BotiX – external, encrypted database backup with a restore test.
#
#   1. counts every table (manifest)                    – read only
#   2. pg_dump of the schemas public, ops, auth         – read only (one consistent snapshot)
#   3. RESTORE TEST: the dump is restored into an empty PostgreSQL and every table is counted again.
#      Settings, stations, arms, groups, lists, users and WhatsApp logins must match exactly;
#      busy tables (rides, delivery rows, logs) must be at least 95% (they move while the dump runs).
#      The backup is uploaded only if this test passes.
#   4. encrypts with age (public key only – the private key never leaves the owner)
#   5. uploads to Cloudflare R2 (S3 API), downloads it back and compares the checksum
#
# Nothing here writes to the production database.
#
# Environment (GitHub Actions secrets / variables – never in the code):
#   SOURCE_DB_URL      production connection string (Supabase "Session pooler" URI)
#   RESTORE_DB_URL     an empty scratch PostgreSQL for the restore test (in GitHub: a service container)
#   AGE_RECIPIENT      the age PUBLIC key (age1...)
#   R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET   (not needed with NO_UPLOAD=1)
#   NO_UPLOAD=1        local test: everything except the upload
set -euo pipefail
: "${SOURCE_DB_URL:?}" "${RESTORE_DB_URL:?}" "${AGE_RECIPIENT:?}"
WORK=${WORK:-$(mktemp -d)}
STAMP=$(date -u +%Y-%m-%dT%H%MZ)
NAME="botix-db-$STAMP"
SCHEMAS=(public ops auth)
# exact match required (the data a station cannot work without)
CRITICAL="public.stations public.app_settings public.arms public.groups public.distribution_lists public.list_groups public.list_arms public.source_groups public.dispatchers public.wa_operators public.templates public.triggers public.profiles auth.users"
log() { echo "[$(date -u +%H:%M:%S)] $*"; }

counts() { # $1 = db url -> "schema.table<TAB>rows" for every table of the backed-up schemas
  psql "$1" -X -At -F $'\t' -v ON_ERROR_STOP=1 <<'SQL'
select format('select %L || chr(9) || count(*) from %I.%I', n.nspname || '.' || c.relname, n.nspname, c.relname)
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and n.nspname in ('public', 'ops', 'auth') order by 1
\gexec
SQL
}

log "1/5 counting tables (production, read only)"
counts "$SOURCE_DB_URL" | sort > "$WORK/manifest.tsv"
log "    $(wc -l < "$WORK/manifest.tsv") tables"

log "2/5 pg_dump (read only)"
pg_dump "$SOURCE_DB_URL" -Fc --no-owner --no-privileges $(printf -- '-n %s ' "${SCHEMAS[@]}") -f "$WORK/$NAME.dump"
log "    $(du -h "$WORK/$NAME.dump" | cut -f1)"

log "3/5 restore test into an empty database"
psql "$RESTORE_DB_URL" -X -q -v ON_ERROR_STOP=1 <<'SQL'
do $$ begin
  -- the roles and extension schema the Supabase schema refers to
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
SQL
# Supabase-only parts (pg_cron jobs, pg_net calls, vault) cannot exist in a plain PostgreSQL; pg_restore reports
# them and goes on. What counts is the data – checked table by table below.
pg_restore -d "$RESTORE_DB_URL" --no-owner --no-privileges "$WORK/$NAME.dump" 2> "$WORK/restore.log" || true
log "    restore notes: $(grep -c 'error:' "$WORK/restore.log" || true) (Supabase-only objects – see restore.log)"
counts "$RESTORE_DB_URL" | sort > "$WORK/restored.tsv"

fail=0
while IFS=$'\t' read -r t n; do
  r=$(awk -F'\t' -v t="$t" '$1 == t { print $2 }' "$WORK/restored.tsv")
  r=${r:-missing}
  if [[ " $CRITICAL " == *" $t "* ]]; then
    [[ "$r" == "$n" ]] || { echo "    FAIL $t: production $n, restored $r"; fail=1; }
  else
    [[ "$r" != missing ]] && (( r * 100 >= n * 95 )) || { echo "    FAIL $t: production $n, restored $r"; fail=1; }
  fi
done < "$WORK/manifest.tsv"
if [[ $fail == 1 ]]; then log "RESTORE TEST FAILED – nothing uploaded"; exit 1; fi
log "    restore test passed: $(wc -l < "$WORK/manifest.tsv") tables (critical ones exact)"

log "4/5 encrypting (age public key)"
age -r "$AGE_RECIPIENT" -o "$WORK/$NAME.dump.age" "$WORK/$NAME.dump"
cp "$WORK/manifest.tsv" "$WORK/$NAME.manifest.tsv"
( cd "$WORK" && sha256sum "$NAME.dump.age" "$NAME.manifest.tsv" > "$NAME.sha256" )
rm -f "$WORK/$NAME.dump"   # no unencrypted copy is kept

if [[ "${NO_UPLOAD:-}" == 1 ]]; then log "5/5 upload skipped (NO_UPLOAD=1): $WORK/$NAME.dump.age"; exit 0; fi
: "${R2_ACCOUNT_ID:?}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_BUCKET:?}"
export AWS_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY AWS_DEFAULT_REGION=auto
EP="https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com"
log "5/5 uploading to R2 and checking it back"
for f in "$NAME.dump.age" "$NAME.manifest.tsv" "$NAME.sha256"; do
  aws s3 cp --only-show-errors --endpoint-url "$EP" "$WORK/$f" "s3://$R2_BUCKET/daily/$f"
done
mkdir -p "$WORK/check"
aws s3 cp --only-show-errors --endpoint-url "$EP" "s3://$R2_BUCKET/daily/$NAME.dump.age" "$WORK/check/$NAME.dump.age"
( cd "$WORK/check" && grep "$NAME.dump.age" "../$NAME.sha256" | sha256sum -c --quiet ) || { log "UPLOAD CHECK FAILED"; exit 1; }
log "done: s3://$R2_BUCKET/daily/$NAME.dump.age (checksum verified after upload)"
