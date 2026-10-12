-- Undo of 1.7: every removed key back from the copy. A key the engine re-created since then is kept as it is.
insert into public.arm_auth select * from ops.arm_auth_stale_20261012 on conflict do nothing;
