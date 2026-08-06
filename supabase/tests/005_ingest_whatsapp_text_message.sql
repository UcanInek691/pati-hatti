begin;

insert into public.clinics (id, name)
values ('60000000-0000-0000-0000-000000000001', 'Ingest Test Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('60000000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001', '999999999');

-- First call for a brand-new sender: processed, writes one owner/conversation/message/event.
do $$
declare
  v_result text;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '999999999',
    p_provider_message_id => 'wamid.TEST1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'New Owner',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed, got %', v_result;
  end if;

  if (select count(*) from public.owners where clinic_id = '60000000-0000-0000-0000-000000000001' and phone_e164 = '+15550001111') <> 1 then
    raise exception 'expected exactly one owner after first call';
  end if;
  if (select count(*) from public.conversations c join public.owners o on o.id = c.owner_id where o.phone_e164 = '+15550001111' and c.status in ('active', 'handoff')) <> 1 then
    raise exception 'expected exactly one open conversation after first call';
  end if;
  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.TEST1') <> 1 then
    raise exception 'expected exactly one message after first call';
  end if;
  if (select count(*) from public.webhook_events where clinic_id = '60000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.TEST1') <> 1 then
    raise exception 'expected exactly one webhook_event after first call';
  end if;
end;
$$;

-- Identical retry: duplicate, no additional mutation.
do $$
declare
  v_result text;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '999999999',
    p_provider_message_id => 'wamid.TEST1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'New Owner',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );
  if v_result <> 'duplicate' then
    raise exception 'expected duplicate on retry, got %', v_result;
  end if;

  if (select count(*) from public.owners where clinic_id = '60000000-0000-0000-0000-000000000001' and phone_e164 = '+15550001111') <> 1 then
    raise exception 'duplicate retry created an extra owner';
  end if;
  if (select count(*) from public.conversations c join public.owners o on o.id = c.owner_id where o.phone_e164 = '+15550001111' and c.status in ('active', 'handoff')) <> 1 then
    raise exception 'duplicate retry created an extra conversation';
  end if;
  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.TEST1') <> 1 then
    raise exception 'duplicate retry created an extra message';
  end if;
end;
$$;

-- Same provider ID, different hash: must fail and write nothing.
do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '999999999',
      p_provider_message_id => 'wamid.TEST1',
      p_payload_hash => repeat('b', 64),
      p_sender_e164 => '+15550001111',
      p_owner_name => 'New Owner',
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

  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.TEST1') <> 1 then
    raise exception 'hash-mismatch call mutated the message table';
  end if;
end;
$$;

-- Unknown phone_number_id: unknown_account, no mutation.
do $$
declare
  v_result text;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => 'no-such-account',
    p_provider_message_id => 'wamid.UNKNOWN',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550009999',
    p_owner_name => 'Nobody',
    p_message_text => 'Hi',
    p_provider_timestamp => now()
  );
  if v_result <> 'unknown_account' then
    raise exception 'expected unknown_account, got %', v_result;
  end if;
  if exists (select 1 from public.webhook_events where provider_event_id = 'wamid.UNKNOWN') then
    raise exception 'unknown_account call wrote a webhook_event';
  end if;
  if exists (select 1 from public.owners where phone_e164 = '+15550009999') then
    raise exception 'unknown_account call wrote an owner';
  end if;
end;
$$;

-- An existing verified (non-fallback) owner name must not be overwritten.
insert into public.owners (id, clinic_id, full_name, phone_e164)
values ('60000000-0000-0000-0000-000000000003', '60000000-0000-0000-0000-000000000001', 'Verified Real Name', '+15550002222');

do $$
declare
  v_result text;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '999999999',
    p_provider_message_id => 'wamid.TEST2',
    p_payload_hash => repeat('d', 64),
    p_sender_e164 => '+15550002222',
    p_owner_name => 'Different Profile Name',
    p_message_text => 'Second message',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed for verified-owner case, got %', v_result;
  end if;
  if (select full_name from public.owners where id = '60000000-0000-0000-0000-000000000003') <> 'Verified Real Name' then
    raise exception 'verified owner name was overwritten';
  end if;
end;
$$;

-- An existing handoff conversation is reused rather than duplicated.
insert into public.owners (id, clinic_id, full_name, phone_e164)
values ('60000000-0000-0000-0000-000000000004', '60000000-0000-0000-0000-000000000001', 'Handoff Owner', '+15550003333');

insert into public.conversations (id, clinic_id, owner_id, status)
values ('60000000-0000-0000-0000-000000000005', '60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000004', 'handoff');

do $$
declare
  v_result text;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '999999999',
    p_provider_message_id => 'wamid.TEST3',
    p_payload_hash => repeat('e', 64),
    p_sender_e164 => '+15550003333',
    p_owner_name => 'Handoff Owner',
    p_message_text => 'Continuing conversation',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed for handoff-reuse case, got %', v_result;
  end if;
  if (select count(*) from public.conversations where owner_id = '60000000-0000-0000-0000-000000000004') <> 1 then
    raise exception 'expected the existing handoff conversation to be reused, not duplicated';
  end if;
  if (select conversation_id from public.messages where whatsapp_message_id = 'wamid.TEST3') <> '60000000-0000-0000-0000-000000000005' then
    raise exception 'message was not attached to the existing handoff conversation';
  end if;
end;
$$;

-- Only service_role may execute the RPC.
set local role authenticated;
do $$
begin
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '999999999',
      p_provider_message_id => 'wamid.AUTH_DENIED',
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
      p_phone_number_id => '999999999',
      p_provider_message_id => 'wamid.ANON_DENIED',
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
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '999999999',
    p_provider_message_id => 'wamid.SERVICE_OK',
    p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15550006666',
    p_owner_name => 'Service Role Caller',
    p_message_text => 'allowed',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'service_role execution unexpectedly failed: %', v_result;
  end if;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id = '60000000-0000-0000-0000-000000000001') as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id = '60000000-0000-0000-0000-000000000002') as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id = '60000000-0000-0000-0000-000000000001') as remaining_test_owners,
  (select count(*) from public.webhook_events where clinic_id = '60000000-0000-0000-0000-000000000001') as remaining_test_webhook_events;
