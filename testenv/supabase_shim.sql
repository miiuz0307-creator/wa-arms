-- Minimal stand-ins for what Supabase provides, so the production schema runs on a plain Postgres.
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
create schema extensions; create extension pgcrypto schema extensions;
create schema auth;
create table auth.users (id uuid primary key, email text);
create or replace function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth, extensions, public to anon, authenticated;
grant execute on all functions in schema auth, extensions to anon, authenticated;
