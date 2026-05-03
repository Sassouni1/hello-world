create extension if not exists pgcrypto with schema extensions;

create or replace function public.consume_bridge_pairing_code(pairing_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $function$
declare
  code_hash_value text;
  pairing_id uuid;
  paired_account_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required to pair this phone.';
  end if;

  code_hash_value := encode(extensions.digest(coalesce(pairing_code, ''), 'sha256'), 'hex');

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
$function$;