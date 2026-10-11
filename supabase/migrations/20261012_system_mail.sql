-- System e-mail: the owner sets the system's own mailbox (e.g. a Gmail with an app password) in the app.
-- "Forgot password" sends a 6-digit code from that mailbox; the user types it in the app and picks a new
-- password. No links, so nothing depends on the auth Site URL.

create table if not exists public.mail_settings (
  id int primary key default 1 check (id = 1),
  from_name text not null default 'BotiX',
  address text,
  smtp_host text not null default 'smtp.gmail.com',
  smtp_port int not null default 465,
  smtp_user text,
  smtp_pass text,
  updated_at timestamptz not null default now()
);
alter table public.mail_settings enable row level security;
revoke all on public.mail_settings from anon, authenticated;
insert into public.mail_settings (id) values (1) on conflict do nothing;

create table if not exists public.password_reset_codes (
  id bigint generated always as identity primary key,
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  ip text,
  created_at timestamptz not null default now()
);
create index if not exists password_reset_codes_email_idx on public.password_reset_codes (email, created_at desc);
alter table public.password_reset_codes enable row level security;
revoke all on public.password_reset_codes from anon, authenticated;

-- owner: read (without the password) / save
create or replace function public.owner_mail_settings()
 returns json language plpgsql stable security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  return (select json_build_object('from_name', from_name, 'address', address, 'smtp_host', smtp_host, 'smtp_port', smtp_port,
    'smtp_user', smtp_user, 'has_pass', smtp_pass is not null and smtp_pass <> '', 'updated_at', updated_at)
    from public.mail_settings where id = 1);
end $function$;

create or replace function public.owner_mail_settings_save(p json)
 returns json language plpgsql volatile security definer set search_path to 'public'
as $function$
begin
  if not public.is_super() then raise exception 'not allowed'; end if;
  update public.mail_settings set
    from_name = coalesce(nullif(trim(p->>'from_name'), ''), from_name),
    address = nullif(trim(p->>'address'), ''),
    smtp_host = coalesce(nullif(trim(p->>'smtp_host'), ''), 'smtp.gmail.com'),
    smtp_port = coalesce((p->>'smtp_port')::int, 465),
    smtp_user = coalesce(nullif(trim(p->>'smtp_user'), ''), nullif(trim(p->>'address'), '')),
    -- an empty password field keeps the saved one
    smtp_pass = coalesce(nullif(regexp_replace(coalesce(p->>'smtp_pass', ''), '\s', '', 'g'), ''), smtp_pass),
    updated_at = now()
  where id = 1;
  insert into public.activity_log (actor_id, action, entity, details)
  values (auth.uid(), 'mail_settings_saved', 'settings', jsonb_build_object('address', p->>'address'));
  return json_build_object('ok', true);
end $function$;

revoke execute on function public.owner_mail_settings() from public, anon;
revoke execute on function public.owner_mail_settings_save(json) from public, anon;
grant execute on function public.owner_mail_settings() to authenticated;
grant execute on function public.owner_mail_settings_save(json) to authenticated;
grant all on public.mail_settings, public.password_reset_codes to service_role;

-- for the account-mail function only (service role): which login an e-mail belongs to
create or replace function public.auth_user_by_email(p_email text)
 returns uuid language sql stable security definer set search_path to 'public', 'auth'
as $function$ select id from auth.users where lower(email) = lower(trim(p_email)) and deleted_at is null limit 1 $function$;
revoke all on function public.auth_user_by_email(text) from public, anon, authenticated;
grant execute on function public.auth_user_by_email(text) to service_role;
