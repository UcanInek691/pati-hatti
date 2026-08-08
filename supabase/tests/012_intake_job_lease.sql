begin;

insert into public.clinics (id, name)
values ('62000000-0000-0000-0000-000000000001', 'Lease Test Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('62000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000001', '622000001');

insert into public.clinics (id, name)
values ('62000000-0000-0000-0000-000000000004', 'Other Lease Test Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('62000000-0000-0000-0000-000000000005', '62000000-0000-0000-0000-000000000004', '622000002');

-- Persist one real processed inbound message/event in clinic A to claim.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '622000001',
    p_provider_message_id => 'wamid.LEASE1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'Lease Owner',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );

  if v_result <> 'processed' then
    raise exception 'expected processed fixture, got %', v_result;
  end if;
end;
$$;

-- A pending job claims: returns the exact message text and a token.
do $$
declare
  v_conversation_id uuid;
  v_result text;
  v_token uuid;
  v_text text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select result, claim_token, message_text into v_result, v_token, v_text
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.LEASE1');

  if v_result <> 'claimed' then
    raise exception 'expected claimed for a pending job, got %', v_result;
  end if;
  if v_token is null then
    raise exception 'claimed result returned a null token';
  end if;
  if v_text <> 'Hello there' then
    raise exception 'claimed result returned unexpected message text: %', v_text;
  end if;
end;
$$;

-- A second claim before the lease expires returns busy.
do $$
declare
  v_conversation_id uuid;
  v_result text;
  v_token uuid;
  v_text text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select result, claim_token, message_text into v_result, v_token, v_text
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.LEASE1');

  if v_result <> 'busy' then
    raise exception 'expected busy for an unexpired lease, got %', v_result;
  end if;
  if v_token is not null or v_text is not null then
    raise exception 'busy result returned a non-null token or text';
  end if;
end;
$$;

-- Manually expire the lease, then confirm reclaim mints a different token.
update public.webhook_events
  set intake_lease_until = now() - interval '1 second'
  where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1';

do $$
declare
  v_conversation_id uuid;
  v_result text;
  v_old_token uuid;
  v_new_token uuid;
  v_stale_result text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select intake_claim_token into v_old_token
  from public.webhook_events
  where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1';

  select result, claim_token into v_result, v_new_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.LEASE1');

  if v_result <> 'claimed' then
    raise exception 'expected claimed for an expired lease, got %', v_result;
  end if;
  if v_new_token is null then
    raise exception 'reclaim returned a null token';
  end if;
  if v_new_token = v_old_token then
    raise exception 'reclaim token matches the expired token';
  end if;

  select result into v_stale_result
  from public.complete_intake_queue_job(v_conversation_id, 'wamid.LEASE1', v_old_token);
  if v_stale_result <> 'stale' then
    raise exception 'expected stale for the superseded lease token, got %', v_stale_result;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1') <> 'processing' then
    raise exception 'superseded-token completion attempt changed job status';
  end if;
end;
$$;

-- An unrelated token also cannot complete the job.
do $$
declare
  v_conversation_id uuid;
  v_result text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select result into v_result
  from public.complete_intake_queue_job(v_conversation_id, 'wamid.LEASE1', gen_random_uuid());

  if v_result <> 'stale' then
    raise exception 'expected stale for an unrelated random token, got %', v_result;
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1') <> 'processing' then
    raise exception 'stale completion attempt changed job status';
  end if;
end;
$$;

-- The current token completes the job.
do $$
declare
  v_conversation_id uuid;
  v_current_token uuid;
  v_result text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select intake_claim_token into v_current_token
  from public.webhook_events
  where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1';

  select result into v_result
  from public.complete_intake_queue_job(v_conversation_id, 'wamid.LEASE1', v_current_token);

  if v_result <> 'completed' then
    raise exception 'expected completed with the current token, got %', v_result;
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1') <> 'completed' then
    raise exception 'completion did not persist intake_status';
  end if;
  if (select intake_claim_token from public.webhook_events where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.LEASE1') is not null then
    raise exception 'completion left a claim token behind';
  end if;
end;
$$;

-- A completed job cannot be reclaimed or re-completed by the same token.
do $$
declare
  v_conversation_id uuid;
  v_result text;
  v_token uuid;
  v_text text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select result, claim_token, message_text into v_result, v_token, v_text
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.LEASE1');

  if v_result <> 'completed' then
    raise exception 'expected completed on re-claim of a finished job, got %', v_result;
  end if;
  if v_token is not null or v_text is not null then
    raise exception 'completed re-claim returned a non-null token or text';
  end if;

  select result into v_result
  from public.complete_intake_queue_job(v_conversation_id, 'wamid.LEASE1', gen_random_uuid());
  if v_result <> 'stale' then
    raise exception 'expected stale re-completion of a finished job, got %', v_result;
  end if;
end;
$$;

-- Another clinic may reuse the same provider ID with no cross-tenant leakage.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '622000002',
    p_provider_message_id => 'wamid.LEASE1',
    p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15550002222',
    p_owner_name => 'Other Clinic Owner',
    p_message_text => 'Same provider id, other tenant',
    p_provider_timestamp => now()
  );

  if v_result <> 'processed' then
    raise exception 'expected processed for the other tenant fixture, got %', v_result;
  end if;
end;
$$;

do $$
declare
  v_conversation_id uuid;
  v_result text;
  v_token uuid;
  v_text text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000004' and whatsapp_message_id = 'wamid.LEASE1';

  select result, claim_token, message_text into v_result, v_token, v_text
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.LEASE1');

  if v_result <> 'claimed' then
    raise exception 'expected the other tenant''s own job to be claimable, got %', v_result;
  end if;
  if v_text <> 'Same provider id, other tenant' then
    raise exception 'cross-tenant claim returned the wrong tenant''s message text: %', v_text;
  end if;

  select result into v_result
  from public.complete_intake_queue_job(v_conversation_id, 'wamid.LEASE1', v_token);
  if v_result <> 'completed' then
    raise exception 'expected the other tenant''s own job to complete, got %', v_result;
  end if;
end;
$$;

-- Wrong conversation/provider pairing resolves to not_found.
do $$
declare
  v_conversation_id_a uuid;
  v_result text;
begin
  select conversation_id into v_conversation_id_a
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  select result into v_result from public.claim_intake_queue_job(v_conversation_id_a, 'wamid.NO_SUCH_MESSAGE');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a mismatched provider id, got %', v_result;
  end if;

  select result into v_result from public.claim_intake_queue_job(gen_random_uuid(), 'wamid.LEASE1');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a mismatched conversation id, got %', v_result;
  end if;
end;
$$;

-- A processed but non-inbound (outbound) message must never be claimable.
do $$
declare
  v_conversation_id uuid;
  v_result text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, processed_at)
  values ('62000000-0000-0000-0000-000000000001', 'wamid.OUTBOUND1', repeat('c', 64), 'processed', now());

  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
  values ('62000000-0000-0000-0000-000000000001', v_conversation_id, 'outbound', 'An outbound reply', 'wamid.OUTBOUND1');

  select result into v_result from public.claim_intake_queue_job(v_conversation_id, 'wamid.OUTBOUND1');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a non-inbound message, got %', v_result;
  end if;
end;
$$;

-- A message whose webhook event is not yet processed must never be claimable.
do $$
declare
  v_conversation_id uuid;
  v_result text;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '62000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.LEASE1';

  insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status)
  values ('62000000-0000-0000-0000-000000000001', 'wamid.PENDING1', repeat('d', 64), 'received');

  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
  values ('62000000-0000-0000-0000-000000000001', v_conversation_id, 'inbound', 'Not yet processed', 'wamid.PENDING1');

  select result into v_result from public.claim_intake_queue_job(v_conversation_id, 'wamid.PENDING1');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a non-processed event, got %', v_result;
  end if;
end;
$$;

-- The state check constraint rejects an incoherent row.
do $$
begin
  begin
    update public.webhook_events
      set intake_status = 'processing', intake_claim_token = null, intake_lease_until = null
      where clinic_id = '62000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.PENDING1';
    raise exception 'expected the intake state check constraint to reject an incoherent row';
  exception
    when check_violation then null;
  end;
end;
$$;

-- Only service_role may execute either RPC.
set local role authenticated;
do $$
begin
  begin
    perform result from public.claim_intake_queue_job(gen_random_uuid(), 'wamid.AUTH_DENIED');
    raise exception 'authenticated role unexpectedly executed claim_intake_queue_job';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform result from public.complete_intake_queue_job(gen_random_uuid(), 'wamid.AUTH_DENIED', gen_random_uuid());
    raise exception 'authenticated role unexpectedly executed complete_intake_queue_job';
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
    perform result from public.claim_intake_queue_job(gen_random_uuid(), 'wamid.ANON_DENIED');
    raise exception 'anon role unexpectedly executed claim_intake_queue_job';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform result from public.complete_intake_queue_job(gen_random_uuid(), 'wamid.ANON_DENIED', gen_random_uuid());
    raise exception 'anon role unexpectedly executed complete_intake_queue_job';
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
  select result into v_result from public.claim_intake_queue_job(gen_random_uuid(), 'wamid.SERVICE_ROLE_OK');
  if v_result <> 'not_found' then
    raise exception 'service_role execution of claim_intake_queue_job unexpectedly failed: %', v_result;
  end if;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('62000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000004')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('62000000-0000-0000-0000-000000000002', '62000000-0000-0000-0000-000000000005')) as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id in ('62000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000004')) as remaining_test_owners,
  (select count(*) from public.conversations where clinic_id in ('62000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000004')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('62000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000004')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('62000000-0000-0000-0000-000000000001', '62000000-0000-0000-0000-000000000004')) as remaining_test_webhook_events;
