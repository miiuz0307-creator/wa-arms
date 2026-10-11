-- Runs the release runner every minute (pg_cron → pg_net → edge function). The key is generated here,
-- stays inside the database, and is checked by the function through runner_key_ok (service role only).
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists ops.runner_key (id int primary key default 1 check (id = 1), key text not null);
insert into ops.runner_key (key) values (encode(extensions.gen_random_bytes(24), 'hex')) on conflict (id) do nothing;

create or replace function public.runner_key_ok(p_key text)
 returns boolean language sql stable security definer set search_path to 'public'
as $function$ select exists (select 1 from ops.runner_key where key = p_key and length(p_key) > 20) $function$;
revoke all on function public.runner_key_ok(text) from public, anon, authenticated;
grant execute on function public.runner_key_ok(text) to service_role;

create or replace function ops.call_release_runner()
 returns void language plpgsql security definer set search_path to 'public'
as $function$
begin
  perform net.http_post(
    url := 'https://tiszpzpotkyifejyjlxe.supabase.co/functions/v1/release-runner',
    headers := jsonb_build_object('content-type', 'application/json', 'x-runner-key', (select key from ops.runner_key where id = 1)),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000);
end $function$;

select cron.schedule('release-runner', '* * * * *', 'select ops.call_release_runner()');
