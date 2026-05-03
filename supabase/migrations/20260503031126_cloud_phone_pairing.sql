create table if not exists public.bridge_account_members (
  account_id uuid not null references public.bridge_accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'phone' check (role in ('owner', 'phone')),
  created_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

insert into public.bridge_account_members (account_id, user_id, role)
select id, owner_user_id, 'owner'
from public.bridge_accounts
on conflict (account_id, user_id) do nothing;

alter table public.bridge_account_members enable row level security;

drop policy if exists "Users manage their bridge account memberships" on public.bridge_account_members;
create policy "Users manage their bridge account memberships"
  on public.bridge_account_members
  for all
  using (user_id = auth.uid() or exists (
    select 1
    from public.bridge_accounts a
    where a.id = bridge_account_members.account_id
      and a.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1
    from public.bridge_accounts a
    where a.id = bridge_account_members.account_id
      and a.owner_user_id = auth.uid()
  ));

create or replace function public.can_access_bridge_account(target_account_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.bridge_accounts a
    where a.id = target_account_id
      and a.owner_user_id = auth.uid()
  )
  or exists (
    select 1
    from public.bridge_account_members m
    where m.account_id = target_account_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.consume_bridge_pairing_code(pairing_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  code_hash_value text;
  pairing_id uuid;
  paired_account_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to pair this phone.';
  end if;

  code_hash_value := encode(digest(coalesce(pairing_code, ''), 'sha256'), 'hex');

  select p.id, p.account_id
    into pairing_id, paired_account_id
  from public.bridge_pairing_codes p
  where p.code_hash = code_hash_value
    and p.consumed_at is null
    and p.expires_at > now()
  order by p.created_at desc
  limit 1;

  if paired_account_id is null then
    raise exception 'Pairing code is invalid or expired.';
  end if;

  insert into public.bridge_account_members (account_id, user_id, role)
  values (paired_account_id, auth.uid(), 'phone')
  on conflict (account_id, user_id) do nothing;

  update public.bridge_pairing_codes
  set consumed_at = now()
  where id = pairing_id;

  return paired_account_id;
end;
$$;

grant execute on function public.can_access_bridge_account(uuid) to authenticated;
grant execute on function public.consume_bridge_pairing_code(text) to authenticated;

drop policy if exists "Users manage their bridge accounts" on public.bridge_accounts;
create policy "Users read accessible bridge accounts"
  on public.bridge_accounts
  for select
  using (public.can_access_bridge_account(id));
create policy "Users create their bridge accounts"
  on public.bridge_accounts
  for insert
  with check (owner_user_id = auth.uid());
create policy "Owners update their bridge accounts"
  on public.bridge_accounts
  for update
  using (owner_user_id = auth.uid())
  with check (owner_user_id = auth.uid());
create policy "Owners delete their bridge accounts"
  on public.bridge_accounts
  for delete
  using (owner_user_id = auth.uid());

drop policy if exists "Users manage their bridge devices" on public.bridge_devices;
create policy "Users read accessible bridge devices"
  on public.bridge_devices
  for select
  using (public.can_access_bridge_account(account_id));
create policy "Owners manage bridge devices"
  on public.bridge_devices
  for all
  using (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_devices.account_id
      and a.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_devices.account_id
      and a.owner_user_id = auth.uid()
  ));

drop policy if exists "Users manage their bridge sessions" on public.bridge_sessions;
create policy "Users manage accessible bridge sessions"
  on public.bridge_sessions
  for all
  using (public.can_access_bridge_account(account_id))
  with check (public.can_access_bridge_account(account_id));

drop policy if exists "Users manage their bridge messages" on public.bridge_messages;
create policy "Users manage accessible bridge messages"
  on public.bridge_messages
  for all
  using (public.can_access_bridge_account(account_id))
  with check (public.can_access_bridge_account(account_id));

drop policy if exists "Users manage their bridge commands" on public.bridge_commands;
create policy "Users read accessible bridge commands"
  on public.bridge_commands
  for select
  using (public.can_access_bridge_account(account_id));
create policy "Users create accessible bridge commands"
  on public.bridge_commands
  for insert
  with check (requested_by = auth.uid() and public.can_access_bridge_account(account_id));
create policy "Owners update bridge commands"
  on public.bridge_commands
  for update
  using (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_commands.account_id
      and a.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_commands.account_id
      and a.owner_user_id = auth.uid()
  ));

drop policy if exists "Users manage their bridge pairing codes" on public.bridge_pairing_codes;
create policy "Owners manage their bridge pairing codes"
  on public.bridge_pairing_codes
  for all
  using (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_pairing_codes.account_id
      and a.owner_user_id = auth.uid()
  ))
  with check (exists (
    select 1 from public.bridge_accounts a
    where a.id = bridge_pairing_codes.account_id
      and a.owner_user_id = auth.uid()
  ));

drop policy if exists "Users read their bridge attachments" on storage.objects;
drop policy if exists "Users upload their bridge attachments" on storage.objects;

create policy "Users read accessible bridge attachments"
  on storage.objects
  for select
  using (
    bucket_id = 'bridge-attachments'
    and array_length(storage.foldername(name), 1) >= 2
    and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_access_bridge_account(((storage.foldername(name))[2])::uuid)
  );

create policy "Users upload accessible bridge attachments"
  on storage.objects
  for insert
  with check (
    bucket_id = 'bridge-attachments'
    and array_length(storage.foldername(name), 1) >= 2
    and (storage.foldername(name))[1] = auth.uid()::text
    and (storage.foldername(name))[2] ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    and public.can_access_bridge_account(((storage.foldername(name))[2])::uuid)
  );
