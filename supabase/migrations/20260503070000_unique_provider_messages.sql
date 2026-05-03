with ranked_messages as (
  select
    id,
    row_number() over (
      partition by account_id, session_id, provider_message_id
      order by created_at desc, id desc
    ) as duplicate_rank
  from public.bridge_messages
  where provider_message_id is not null
)
delete from public.bridge_messages m
using ranked_messages r
where m.id = r.id
  and r.duplicate_rank > 1;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'bridge_messages_provider_message_unique'
  ) then
    alter table public.bridge_messages
      add constraint bridge_messages_provider_message_unique
      unique (account_id, session_id, provider_message_id);
  end if;
end;
$$;
