-- Release 1.7 – old per-chat WhatsApp keys in the database (arm_auth). One transaction (the update center
-- runs it as one): if any check fails, everything is undone and nothing is removed.
--
-- Removed: rows written before 10 Oct 2026 that are not the login identity. Since 9 Oct the engine keeps
-- per-chat keys on its disk (/data/auth – the working copy, newer than these rows); the database keeps only
-- the login identity. Never touched: 'creds' and 'app-state-*' rows (what reconnecting without a QR needs).
--
-- Safety:
--  1. a full copy goes to ops.arm_auth_stale_20261012 first; it is kept until the owner approves removing it
--     (nothing removes it automatically);
--  2. the copy is counted against the table;
--  3. a row is removed only if it is STILL exactly what was copied (same value, same updated_at) and still
--     older than 10 Oct. A key the engine wrote in the meantime – even with the same arm and key name – stays.
--     If the engine is writing that row at this very moment, the removal waits for it (at most 5 seconds,
--     else everything is undone) and then checks the new version, which no longer matches;
--  4. every removed key is checked against the copy (same value, same time) – any mismatch undoes everything;
--  5. after removal: no identity row is missing and every connected arm still has its creds row.
-- Undo: 1.7_rollback.sql – safe restore (see there).
select set_config('lock_timeout', '5s', true);

create table if not exists ops.arm_auth_stale_20261012 as
  select * from public.arm_auth
  where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';

do $chk$
declare a int; b int; c0 int; c1 int; removed int; in_copy int; online_without_creds int;
begin
  select count(*) into a from public.arm_auth where key <> 'creds' and key not like 'app-state-%' and updated_at < '2026-10-10';
  select count(*) into b from ops.arm_auth_stale_20261012;
  if b = 0 or a <> b then raise exception '1.7: copy incomplete (% in table, % copied) – nothing removed', a, b; end if;

  select count(*) into c0 from public.arm_auth where key = 'creds' or key like 'app-state-%';

  -- remove, and prove every removed key is in the copy, identical (value and time)
  with d as (
    delete from public.arm_auth x
    using ops.arm_auth_stale_20261012 s
    where x.arm_id = s.arm_id and x.key = s.key
      and x.key <> 'creds' and x.key not like 'app-state-%'
      and x.updated_at < '2026-10-10'
      and x.updated_at = s.updated_at
      and x.value = s.value
    returning x.arm_id, x.key, x.value, x.updated_at
  )
  select count(*), count(*) filter (where exists (
           select 1 from ops.arm_auth_stale_20261012 s
           where s.arm_id = d.arm_id and s.key = d.key and s.value = d.value and s.updated_at = d.updated_at))
  into removed, in_copy from d;
  if in_copy <> removed then raise exception '1.7: % removed keys are not in the copy – undone', removed - in_copy; end if;

  select count(*) into c1 from public.arm_auth where key = 'creds' or key like 'app-state-%';
  if c1 < c0 then raise exception '1.7: identity rows went from % to % – undone', c0, c1; end if;
  select count(*) into online_without_creds from public.arms a
  where a.is_active and a.status = 'online'
    and not exists (select 1 from public.arm_auth x where x.arm_id = a.id and x.key = 'creds');
  if online_without_creds > 0 then raise exception '1.7: % connected arm(s) without creds – undone', online_without_creds; end if;

  raise notice '1.7: copied %, removed %, kept because they changed since the copy %', b, removed, b - removed;
end $chk$;
