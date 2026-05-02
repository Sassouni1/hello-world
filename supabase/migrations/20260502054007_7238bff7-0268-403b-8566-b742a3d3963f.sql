create extension if not exists "pgcrypto";

create table public.bridge_accounts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null default 'Personal console',
  status text not null default 'disconnected' check (status in ('disconnected', 'pairing', 'connected', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bridge_devices (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  device_name text not null,
  platform text,
  public_key text,
  status text not null default 'offline' check (status in ('offline', 'online', 'revoked')),
  paired_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.bridge_sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  provider text not null default 'codex',
  provider_session_id text not null,
  title text not null default 'Untitled chat',
  workspace_path text,
  status text not null default 'idle' check (status in ('idle', 'working', 'done', 'error', 'archived')),
  activity_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, provider, provider_session_id)
);

create table public.bridge_messages (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  session_id uuid not null references public.bridge_sessions(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'system', 'tool', 'event')),
  body text,
  event_type text,
  event_payload jsonb not null default '{}'::jsonb,
  attachments jsonb not null default '[]'::jsonb,
  provider_message_id text,
  created_at timestamptz not null default now()
);

create table public.bridge_commands (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  session_id uuid references public.bridge_sessions(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  kind text not null default 'message' check (kind in ('message', 'stop', 'create_session', 'sync')),
  body text,
  attachments jsonb not null default '[]'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'claimed', 'completed', 'failed', 'cancelled')),
  error text,
  claimed_by_device_id uuid references public.bridge_devices(id) on delete set null,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.bridge_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.bridge_accounts enable row level security;
alter table public.bridge_devices enable row level security;
alter table public.bridge_sessions enable row level security;
alter table public.bridge_messages enable row level security;
alter table public.bridge_commands enable row level security;
alter table public.bridge_pairing_codes enable row level security;

create policy "Users manage their bridge accounts"
  on public.bridge_accounts
  for all
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());

create policy "Users manage their bridge devices"
  on public.bridge_devices
  for all
  using (exists (select 1 from public.bridge_accounts a where a.id = bridge_devices.account_id and a.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.bridge_accounts a where a.id = bridge_devices.account_id and a.owner_user_id = auth.uid()));

create policy "Users manage their bridge sessions"
  on public.bridge_sessions
  for all
  using (exists (select 1 from public.bridge_accounts a where a.id = bridge_sessions.account_id and a.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.bridge_accounts a where a.id = bridge_sessions.account_id and a.owner_user_id = auth.uid()));

create policy "Users manage their bridge messages"
  on public.bridge_messages
  for all
  using (exists (select 1 from public.bridge_accounts a where a.id = bridge_messages.account_id and a.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.bridge_accounts a where a.id = bridge_messages.account_id and a.owner_user_id = auth.uid()));

create policy "Users manage their bridge commands"
  on public.bridge_commands
  for all
  using (requested_by = auth.uid() or exists (select 1 from public.bridge_accounts a where a.id = bridge_commands.account_id and a.owner_user_id = auth.uid()))
  with check (requested_by = auth.uid() and exists (select 1 from public.bridge_accounts a where a.id = bridge_commands.account_id and a.owner_user_id = auth.uid()));

create policy "Users manage their bridge pairing codes"
  on public.bridge_pairing_codes
  for all
  using (exists (select 1 from public.bridge_accounts a where a.id = bridge_pairing_codes.account_id and a.owner_user_id = auth.uid()))
  with check (exists (select 1 from public.bridge_accounts a where a.id = bridge_pairing_codes.account_id and a.owner_user_id = auth.uid()));

insert into storage.buckets (id, name, public)
values ('bridge-attachments', 'bridge-attachments', false)
on conflict (id) do nothing;

create policy "Users read their bridge attachments"
  on storage.objects
  for select
  using (bucket_id = 'bridge-attachments' and owner = auth.uid());

create policy "Users upload their bridge attachments"
  on storage.objects
  for insert
  with check (bucket_id = 'bridge-attachments' and owner = auth.uid());