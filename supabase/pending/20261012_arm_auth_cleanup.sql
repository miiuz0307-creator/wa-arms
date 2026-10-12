-- ONE-TIME, owner approval required. Old per-chat WhatsApp keys in the database (arm_auth).
--
-- Why they are not used: since 9 Oct the per-chat keys live on the engine's disk; the database keeps only
-- the login identity (creds + app-state keys). The engine reads the other rows only when an arm has NO
-- login on disk at all – and then a 3-day-old copy of chat keys is worse than none (members would ask
-- for re-sends). Every arm that runs today was loaded from disk (engine log "auth state loaded … disk"),
-- the rows were last written 9 Oct 13:49 UTC, and every active arm has its creds row in the database.
-- Reconnecting without a QR needs exactly creds + app-state keys – what a freshly scanned arm has.
--
-- Kept, never touched: key = 'creds' and keys starting with 'app-state-' (19 rows today).

-- step 1: copy what will be removed (stays 7 days, then dropped with a separate approval)
create table if not exists ops.arm_auth_stale_20261012 as
  select * from public.arm_auth where key <> 'creds' and key not like 'app-state-%';

-- step 2: check the copy is complete before removing anything
do $$
declare a int; b int;
begin
  select count(*) into a from public.arm_auth where key <> 'creds' and key not like 'app-state-%';
  select count(*) into b from ops.arm_auth_stale_20261012;
  if a <> b then raise exception 'copy incomplete (% vs %) – nothing removed', a, b; end if;
end $$;

-- step 3: remove in batches of 5,000 (run until it returns 0)
with v as (select s.arm_id, s.key from ops.arm_auth_stale_20261012 s
           join public.arm_auth a on a.arm_id = s.arm_id and a.key = s.key limit 5000)
delete from public.arm_auth a using v where a.arm_id = v.arm_id and a.key = v.key;

-- step 4 (after all batches): give the space back to the disk. Takes a lock for well under a second
-- (only ~20 rows are left); the engine writes this table once every 10 minutes.
-- vacuum full public.arm_auth;

-- restore if ever needed:
-- insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;
