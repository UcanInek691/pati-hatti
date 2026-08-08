begin;

insert into public.clinics (id, name)
values ('61000000-0000-0000-0000-000000000001', 'Locator Test Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('61000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000001', '888888888');

-- Processed returns the conversation ID that owns the inserted message.
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_message_conversation_id uuid;
begin
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '888888888',
    p_provider_message_id => 'wamid.LOC1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'Locator Owner',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );

  if v_result <> 'processed' then
    raise exception 'expected processed, got %', v_result;
  end if;
  if v_conversation_id is null then
    raise exception 'processed returned a null conversation locator';
  end if;

  select m.conversation_id into v_message_conversation_id
  from public.messages m
  where m.clinic_id = '61000000-0000-0000-0000-000000000001'
    and m.whatsapp_message_id = 'wamid.LOC1';

  if v_message_conversation_id is distinct from v_conversation_id then
    raise exception 'processed locator % does not match the inserted message conversation %', v_conversation_id, v_message_conversation_id;
  end if;
  if (select c.clinic_id from public.conversations c where c.id = v_conversation_id) <> '61000000-0000-0000-0000-000000000001' then
    raise exception 'processed locator points outside the calling tenant';
  end if;
end;
$$;

-- An exact duplicate returns the same locator and mutates nothing.
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_expected_id uuid;
begin
  select m.conversation_id into v_expected_id
  from public.messages m
  where m.clinic_id = '61000000-0000-0000-0000-000000000001'
    and m.whatsapp_message_id = 'wamid.LOC1';

  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '888888888',
    p_provider_message_id => 'wamid.LOC1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'Locator Owner',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );

  if v_result <> 'duplicate' then
    raise exception 'expected duplicate on retry, got %', v_result;
  end if;
  if v_conversation_id is distinct from v_expected_id then
    raise exception 'duplicate locator % does not match the persisted conversation %', v_conversation_id, v_expected_id;
  end if;

  if (select count(*) from public.webhook_events where clinic_id = '61000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LOC1') <> 1 then
    raise exception 'duplicate retry created an extra webhook_event';
  end if;
  if (select count(*) from public.owners where clinic_id = '61000000-0000-0000-0000-000000000001' and phone_e164 = '+15550001111') <> 1 then
    raise exception 'duplicate retry created an extra owner';
  end if;
  if (select count(*) from public.conversations where clinic_id = '61000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'duplicate retry created an extra conversation';
  end if;
  if (select count(*) from public.messages where clinic_id = '61000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'duplicate retry created an extra message';
  end if;
end;
$$;

-- Unknown account: null locator, no mutation.
do $$
declare
  v_result text;
  v_conversation_id uuid;
begin
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => 'no-such-account',
    p_provider_message_id => 'wamid.LOC_UNKNOWN',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550009999',
    p_owner_name => 'Nobody',
    p_message_text => 'Hi',
    p_provider_timestamp => now()
  );

  if v_result <> 'unknown_account' then
    raise exception 'expected unknown_account, got %', v_result;
  end if;
  if v_conversation_id is not null then
    raise exception 'unknown_account returned a non-null conversation locator';
  end if;
  if exists (select 1 from public.webhook_events where provider_event_id = 'wamid.LOC_UNKNOWN') then
    raise exception 'unknown_account call wrote a webhook_event';
  end if;
  if exists (select 1 from public.owners where phone_e164 = '+15550009999') then
    raise exception 'unknown_account call wrote an owner';
  end if;
end;
$$;

-- Same provider ID, different hash: still raises, still writes nothing.
do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '888888888',
      p_provider_message_id => 'wamid.LOC1',
      p_payload_hash => repeat('b', 64),
      p_sender_e164 => '+15550001111',
      p_owner_name => 'Locator Owner',
      p_message_text => 'Hello there',
      p_provider_timestamp => now()
    );
    raise exception 'expected payload_hash mismatch to raise';
  exception
    when others then
      if sqlerrm not like '%payload_hash mismatch%' then
        raise;
      end if;
  end;

  if (select count(*) from public.messages where clinic_id = '61000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'hash-mismatch call mutated the message table';
  end if;
end;
$$;

-- An exact-duplicate event with no persisted message must raise rather than
-- return a nullable or synthetic locator.
insert into public.webhook_events (id, clinic_id, provider_event_id, payload_hash, processing_status)
values ('61000000-0000-0000-0000-000000000003', '61000000-0000-0000-0000-000000000001', 'wamid.LOC_ORPHAN', repeat('d', 64), 'received');

do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '888888888',
      p_provider_message_id => 'wamid.LOC_ORPHAN',
      p_payload_hash => repeat('d', 64),
      p_sender_e164 => '+15550007777',
      p_owner_name => 'Orphan Owner',
      p_message_text => 'Orphaned duplicate',
      p_provider_timestamp => now()
    );
    raise exception 'expected an orphaned duplicate event to raise';
  exception
    when others then
      if sqlerrm not like '%no persisted message%' then
        raise;
      end if;
  end;

  if exists (select 1 from public.owners where phone_e164 = '+15550007777') then
    raise exception 'orphaned duplicate call wrote an owner';
  end if;
end;
$$;

-- Another clinic's identical provider message ID must not leak across tenants.
insert into public.clinics (id, name)
values ('61000000-0000-0000-0000-000000000004', 'Other Locator Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('61000000-0000-0000-0000-000000000005', '61000000-0000-0000-0000-000000000004', '777777777');

do $$
declare
  v_result text;
  v_conversation_id uuid;
begin
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '777777777',
    p_provider_message_id => 'wamid.LOC1',
    p_payload_hash => repeat('e', 64),
    p_sender_e164 => '+15550008888',
    p_owner_name => 'Other Clinic Owner',
    p_message_text => 'Same provider id, other tenant',
    p_provider_timestamp => now()
  );

  if v_result <> 'processed' then
    raise exception 'expected processed for the other tenant, got %', v_result;
  end if;
  if (select c.clinic_id from public.conversations c where c.id = v_conversation_id) <> '61000000-0000-0000-0000-000000000004' then
    raise exception 'cross-tenant provider ID resolved to the wrong clinic';
  end if;
end;
$$;

-- Only service_role may execute the revised RPC.
set local role authenticated;
do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '888888888',
      p_provider_message_id => 'wamid.LOC_AUTH_DENIED',
      p_payload_hash => repeat('f', 64),
      p_sender_e164 => '+15550004444',
      p_owner_name => 'Should Not Run',
      p_message_text => 'blocked',
      p_provider_timestamp => now()
    );
    raise exception 'authenticated role unexpectedly executed the RPC';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '888888888',
      p_provider_message_id => 'wamid.LOC_ANON_DENIED',
      p_payload_hash => repeat('0', 64),
      p_sender_e164 => '+15550005555',
      p_owner_name => 'Should Not Run',
      p_message_text => 'blocked',
      p_provider_timestamp => now()
    );
    raise exception 'anon role unexpectedly executed the RPC';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_result text;
  v_conversation_id uuid;
begin
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '888888888',
    p_provider_message_id => 'wamid.LOC_SERVICE_OK',
    p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15550006666',
    p_owner_name => 'Service Role Caller',
    p_message_text => 'allowed',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'service_role execution unexpectedly failed: %', v_result;
  end if;
  if v_conversation_id is null then
    raise exception 'service_role execution returned a null conversation locator';
  end if;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000004')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('61000000-0000-0000-0000-000000000002', '61000000-0000-0000-0000-000000000005')) as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id in ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000004')) as remaining_test_owners,
  (select count(*) from public.conversations where clinic_id in ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000004')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000004')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('61000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000004')) as remaining_test_webhook_events;
