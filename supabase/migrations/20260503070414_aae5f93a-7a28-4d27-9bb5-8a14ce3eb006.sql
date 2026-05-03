create or replace function public.create_bridge_account(display_name text default 'Personal console')
returns public.bridge_accounts
language plpgsql
security definer
set search_path = public
as $$
declare
  created_account public.bridge_accounts;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to create a bridge account.';
  end if;

  insert into public.bridge_accounts (owner_user_id, display_name, status)
  values (
    auth.uid(),
    coalesce(nullif(trim(display_name), ''), 'Personal console'),
    'disconnected'
  )
  returning * into created_account;

  insert into public.bridge_account_members (account_id, user_id, role)
  values (created_account.id, auth.uid(), 'owner')
  on conflict (account_id, user_id) do update
    set role = 'owner';

  return created_account;
end;
$$;

grant execute on function public.create_bridge_account(text) to authenticated;