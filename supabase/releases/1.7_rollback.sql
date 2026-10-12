-- Undo of 1.7 – safe restore from ops.arm_auth_stale_20261012, key by key:
--   * key missing                                   -> put back from the copy
--   * key present, identical to the copy            -> nothing to do
--   * key present, different and NEWER than the copy -> a valid key the engine wrote since: kept as it is
--   * key present, different but NOT newer           -> wrong content: replaced by the copy
-- Afterwards it checks that every key of the copy is in the table, identical or newer; else everything is undone.
select set_config('lock_timeout', '5s', true);
do $undo$
declare missing int; wrong int; newer int; same int; bad int;
begin
  select count(*) filter (where x.arm_id is null),
         count(*) filter (where x.arm_id is not null and x.value is distinct from s.value and x.updated_at <= s.updated_at),
         count(*) filter (where x.arm_id is not null and x.value is distinct from s.value and x.updated_at > s.updated_at),
         count(*) filter (where x.arm_id is not null and x.value is not distinct from s.value)
  into missing, wrong, newer, same
  from ops.arm_auth_stale_20261012 s
  left join public.arm_auth x on x.arm_id = s.arm_id and x.key = s.key;

  insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;

  update public.arm_auth x set value = s.value, updated_at = s.updated_at, station_id = s.station_id
  from ops.arm_auth_stale_20261012 s
  where x.arm_id = s.arm_id and x.key = s.key
    and x.value is distinct from s.value and x.updated_at <= s.updated_at;

  select count(*) into bad from ops.arm_auth_stale_20261012 s
  where not exists (select 1 from public.arm_auth x where x.arm_id = s.arm_id and x.key = s.key
                    and ((x.value = s.value and x.updated_at = s.updated_at) or x.updated_at > s.updated_at));
  if bad > 0 then raise exception '1.7 undo: % keys could not be restored – undone', bad; end if;

  raise notice '1.7 undo: put back %, fixed wrong content %, kept newer %, already identical %', missing, wrong, newer, same;
end $undo$;
