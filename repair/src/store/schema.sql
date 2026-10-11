-- BotiX AI Repair – own database (separate from BotiX's Supabase, so the repair bot can never
-- load or break the production database). Safe to run on every start.

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists allowed_numbers (
  id bigserial primary key,
  phone text not null unique,          -- 9725XXXXXXXX
  lid text,                            -- WhatsApp hidden id, learned automatically
  name text not null default '',
  role text not null default 'requester' check (role in ('requester', 'approver')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists tickets (
  id bigserial primary key,
  requester_phone text not null,
  requester_name text not null default '',
  description text not null,
  images jsonb not null default '[]',
  area text,
  status text not null default 'queued',
  branch text,
  base_sha text,
  pr_url text,
  pr_number int,
  summary text,
  root_cause text,
  risk text,
  files jsonb not null default '[]',
  warnings jsonb not null default '[]',
  diff_stat text,
  test_result jsonb,
  staging_result jsonb,
  deploy jsonb,
  error text,
  cost_usd numeric,
  start_after timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tickets_status_idx on tickets (status, start_after);

-- the audit log: every action, who did it, what happened
create table if not exists events (
  id bigserial primary key,
  ticket_id bigint references tickets (id) on delete set null,
  actor text not null,                 -- phone number, 'admin', 'claude', 'system'
  type text not null,
  message text not null,
  data jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_ticket_idx on events (ticket_id, id);
create index if not exists events_id_idx on events (id desc);

create table if not exists approvals (
  id bigserial primary key,
  ticket_id bigint not null references tickets (id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text,
  attempts int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists wa_auth (
  key text primary key,
  value text not null                  -- AES-256-GCM encrypted
);
