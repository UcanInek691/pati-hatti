-- Return the tenant-scoped conversation locator from inbound WhatsApp text
-- ingestion. Forward-only replacement of the Task 005 function; the return
-- type changes, so the old signature must be dropped before recreating it.
-- Validated with supabase/tests/010_ingest_whatsapp_conversation_locator.sql.
-- Production must apply this file through the managed Supabase migration
-- workflow.

drop function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz);

create function public.ingest_whatsapp_text_message(
  p_phone_number_id text,
  p_provider_message_id text,
  p_payload_hash text,
  p_sender_e164 text,
  p_owner_name text,
  p_message_text text,
  p_provider_timestamp timestamptz
)
returns table (result text, conversation_id uuid)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_owner_id uuid;
  v_conversation_id uuid;
  v_event_id uuid;
  v_existing_hash text;
begin
  if p_phone_number_id is null or char_length(p_phone_number_id) < 1 or char_length(p_phone_number_id) > 512 then
    raise exception 'ingest_whatsapp_text_message: invalid phone_number_id';
  end if;
  if p_provider_message_id is null or char_length(p_provider_message_id) < 1 or char_length(p_provider_message_id) > 512 then
    raise exception 'ingest_whatsapp_text_message: invalid provider_message_id';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ingest_whatsapp_text_message: invalid payload_hash';
  end if;
  if p_sender_e164 is null or p_sender_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'ingest_whatsapp_text_message: invalid sender_e164';
  end if;
  if p_owner_name is null or char_length(p_owner_name) < 1 or char_length(p_owner_name) > 200 then
    raise exception 'ingest_whatsapp_text_message: invalid owner_name';
  end if;
  if p_message_text is null or char_length(p_message_text) < 1 or char_length(p_message_text) > 65536 then
    raise exception 'ingest_whatsapp_text_message: invalid message_text';
  end if;
  if p_provider_timestamp is null then
    raise exception 'ingest_whatsapp_text_message: invalid provider_timestamp';
  end if;

  -- Resolve tenant before writing anything; an unknown account writes nothing.
  select wa.clinic_id into v_clinic_id
  from public.whatsapp_accounts wa
  where wa.phone_number_id = p_phone_number_id;

  if v_clinic_id is null then
    return query select 'unknown_account'::text, null::uuid;
    return;
  end if;

  -- Claim idempotency first: concurrent duplicate deliveries race here, and
  -- only one wins the insert.
  insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status)
  values (v_clinic_id, p_provider_message_id, p_payload_hash, 'received')
  on conflict (clinic_id, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select we.payload_hash into v_existing_hash
    from public.webhook_events we
    where we.clinic_id = v_clinic_id
      and we.provider_event_id = p_provider_message_id;

    if v_existing_hash = p_payload_hash then
      -- Always tenant-scoped: the provider message ID alone is not unique
      -- across clinics, so it must never be searched without clinic_id.
      select m.conversation_id into v_conversation_id
      from public.messages m
      where m.clinic_id = v_clinic_id
        and m.whatsapp_message_id = p_provider_message_id;

      if v_conversation_id is null then
        raise exception 'ingest_whatsapp_text_message: duplicate event has no persisted message for provider_event_id %', p_provider_message_id;
      end if;

      return query select 'duplicate'::text, v_conversation_id;
      return;
    end if;

    raise exception 'ingest_whatsapp_text_message: payload_hash mismatch for provider_event_id %', p_provider_message_id;
  end if;

  -- Upsert-then-touch: a plain no-op DO UPDATE always returns the row via
  -- RETURNING, unlike a conditional DO UPDATE ... WHERE, which returns no
  -- row at all when its condition is false.
  insert into public.owners (clinic_id, phone_e164, full_name)
  values (v_clinic_id, p_sender_e164, p_owner_name)
  on conflict (clinic_id, phone_e164) do update
    set clinic_id = excluded.clinic_id
  returning id into v_owner_id;

  -- Only replace the fallback placeholder name; never overwrite a real one.
  update public.owners
    set full_name = p_owner_name
    where id = v_owner_id
      and full_name = 'WhatsApp user'
      and p_owner_name <> 'WhatsApp user';

  insert into public.conversations (clinic_id, owner_id, status)
  values (v_clinic_id, v_owner_id, 'active')
  on conflict (clinic_id, owner_id) where status in ('active', 'handoff') do update
    set clinic_id = excluded.clinic_id
  returning id into v_conversation_id;

  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic_id, v_conversation_id, 'inbound', p_message_text, p_provider_message_id, p_provider_timestamp);

  update public.webhook_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = v_event_id;

  return query select 'processed'::text, v_conversation_id;
  return;
end;
$$;

revoke all on function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz)
  to service_role;
