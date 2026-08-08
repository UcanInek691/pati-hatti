-- Rollback-only proof for public.finalize_intake_queue_job. Validated in the
-- disposable `vetai-test` project on 2026-08-08; never run this fixture script
-- against a real clinic database.

begin;

insert into public.clinics (id, name)
values ('63000000-0000-0000-0000-000000000001', 'Finalize Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('63000000-0000-0000-0000-000000000002', '63000000-0000-0000-0000-000000000001', '633000001');

insert into public.clinics (id, name)
values ('63000000-0000-0000-0000-000000000004', 'Finalize Test Clinic B');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('63000000-0000-0000-0000-000000000005', '63000000-0000-0000-0000-000000000004', '633000002');

-- A pet owned by clinic B, used only to prove cross-tenant pet input fails.
insert into public.owners (id, clinic_id, phone_e164, full_name)
values ('63000000-0000-0000-0000-000000000006', '63000000-0000-0000-0000-000000000004', '+15550009999', 'Cross Tenant Owner');

insert into public.pets (id, clinic_id, owner_id, name, species, created_at)
values ('63000000-0000-0000-0000-000000000007', '63000000-0000-0000-0000-000000000004', '63000000-0000-0000-0000-000000000006', 'Cross Pet', 'dog', now());

-- Fixture 1: real service_role claim + finalize, closing Task 012's
-- read-only grant-test gap and proving one full applied cycle.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '633000001',
    p_provider_message_id => 'wamid.FIN1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'Finalize Owner One',
    p_message_text => 'Hello there',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed fixture for FIN1, got %', v_result;
  end if;
end;
$$;

set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '63000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.FIN1';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.FIN1');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for FIN1 under service_role, got %', v_claim_result;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.FIN1', v_token, 1, 'complaint_collection', null, '{"note": "first"}'::jsonb
  );
  if v_result <> 'applied' or v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected applied/complaint_collection/2 under service_role, got %/%/%', v_result, v_stage, v_version;
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN1') <> 'completed' then
    raise exception 'expected the FIN1 lease to be completed after applied finalize';
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 2 then
    raise exception 'expected conversation state_version 2 after applied finalize';
  end if;

  -- A repeat finalize with the same (now-stale) token must not bump state again.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.FIN1', v_token, 2, 'safety_check', null, '{"note": "second"}'::jsonb
  );
  if v_result <> 'already_completed' or v_stage is not null or v_version is not null then
    raise exception 'expected already_completed with null stage/version on repeat, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 2 then
    raise exception 'repeat finalize must not bump state_version again';
  end if;
end;
$$;
reset role;

-- Fixture 2: stale_claim (wrong token) and stale_state (wrong expected
-- version), then a corrected retry against the same preserved lease.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '633000001',
    p_provider_message_id => 'wamid.FIN2',
    p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15550002222',
    p_owner_name => 'Finalize Owner Two',
    p_message_text => 'Second message',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed fixture for FIN2, got %', v_result;
  end if;
end;
$$;

set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '63000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.FIN2';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.FIN2');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for FIN2, got %', v_claim_result;
  end if;

  -- Wrong token: stale_claim, no mutation.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.FIN2', gen_random_uuid(), 1, 'complaint_collection', null, '{"note": "wrong token"}'::jsonb
  );
  if v_result <> 'stale_claim' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_claim with null stage/version for wrong token, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 1 then
    raise exception 'stale_claim (wrong token) must not change conversation state';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN2') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN2') <> v_token then
    raise exception 'stale_claim (wrong token) must leave the original lease untouched';
  end if;

  -- Correct token, wrong expected_version: stale_state, lease preserved.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.FIN2', v_token, 99, 'complaint_collection', null, '{"note": "wrong version"}'::jsonb
  );
  if v_result <> 'stale_state' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_state with null stage/version for wrong expected_version, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 1 then
    raise exception 'stale_state must not change conversation state';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN2') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN2') <> v_token then
    raise exception 'stale_state must keep the same processing lease available for a corrected retry';
  end if;

  -- Corrected retry with the same preserved lease token succeeds.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.FIN2', v_token, 1, 'complaint_collection', null, '{"note": "retry"}'::jsonb
  );
  if v_result <> 'applied' or v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected the corrected retry to apply, got %/%/%', v_result, v_stage, v_version;
  end if;
end;
$$;
reset role;

-- Fixture 3: invalid stage, empty/non-object intake data, and cross-tenant
-- pet input all fail without any partial conversation or event mutation.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '633000001',
    p_provider_message_id => 'wamid.FIN3',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550003333',
    p_owner_name => 'Finalize Owner Three',
    p_message_text => 'Third message',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed fixture for FIN3, got %', v_result;
  end if;
end;
$$;

set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_rejected boolean;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '63000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.FIN3';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.FIN3');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for FIN3, got %', v_claim_result;
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.FIN3', v_token, 1, 'not_a_real_stage', null, '{"note": "bad stage"}'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid next_stage' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'finalize unexpectedly accepted an invalid next_stage';
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.FIN3', v_token, 1, 'complaint_collection', null, '{}'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid intake_data' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'finalize unexpectedly accepted empty intake_data';
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.FIN3', v_token, 1, 'complaint_collection', null, '["not", "an", "object"]'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid intake_data' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'finalize unexpectedly accepted non-object intake_data';
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.FIN3', v_token, 1, 'complaint_collection',
      '63000000-0000-0000-0000-000000000007', '{"note": "cross tenant pet"}'::jsonb
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'advance_conversation_intake: pet does not belong to the conversation owner/clinic' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'finalize unexpectedly accepted a cross-tenant pet_id';
  end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = v_conversation_id) <> 'pet_identification' then
    raise exception 'invalid-input attempts must leave conversation state untouched';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN3') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '63000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.FIN3') <> v_token then
    raise exception 'invalid-input attempts must leave the lease untouched';
  end if;
end;
$$;
reset role;

-- Fixture 4: two clinics reusing the same provider ID apply independently.
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '633000001',
    p_provider_message_id => 'wamid.SHARED1',
    p_payload_hash => repeat('d', 64),
    p_sender_e164 => '+15550004444',
    p_owner_name => 'Finalize Owner Four',
    p_message_text => 'Shared id clinic A',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed fixture for clinic A SHARED1, got %', v_result;
  end if;

  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '633000002',
    p_provider_message_id => 'wamid.SHARED1',
    p_payload_hash => repeat('e', 64),
    p_sender_e164 => '+15550005555',
    p_owner_name => 'Finalize Owner Five',
    p_message_text => 'Shared id clinic B',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then
    raise exception 'expected processed fixture for clinic B SHARED1, got %', v_result;
  end if;
end;
$$;

set local role service_role;
do $$
declare
  v_conversation_a uuid;
  v_conversation_b uuid;
  v_claim_result text;
  v_token_a uuid;
  v_token_b uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  select conversation_id into v_conversation_a
  from public.messages
  where clinic_id = '63000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.SHARED1';
  select conversation_id into v_conversation_b
  from public.messages
  where clinic_id = '63000000-0000-0000-0000-000000000004' and whatsapp_message_id = 'wamid.SHARED1';

  select result, claim_token into v_claim_result, v_token_a
  from public.claim_intake_queue_job(v_conversation_a, 'wamid.SHARED1');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for clinic A SHARED1, got %', v_claim_result;
  end if;
  select result, claim_token into v_claim_result, v_token_b
  from public.claim_intake_queue_job(v_conversation_b, 'wamid.SHARED1');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for clinic B SHARED1, got %', v_claim_result;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_a, 'wamid.SHARED1', v_token_a, 1, 'complaint_collection', null, '{"note": "clinic a"}'::jsonb
  );
  if v_result <> 'applied' or v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected clinic A SHARED1 to apply independently, got %/%/%', v_result, v_stage, v_version;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_b, 'wamid.SHARED1', v_token_b, 1, 'complaint_collection', null, '{"note": "clinic b"}'::jsonb
  );
  if v_result <> 'applied' or v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected clinic B SHARED1 to apply independently, got %/%/%', v_result, v_stage, v_version;
  end if;
end;
$$;
reset role;

-- anon and authenticated must not be able to execute the RPC at all.
set local role authenticated;
do $$
begin
  begin
    perform result from public.finalize_intake_queue_job(
      gen_random_uuid(), 'wamid.AUTH_DENIED', gen_random_uuid(), 1, 'complaint_collection', null, '{"a": 1}'::jsonb
    );
    raise exception 'authenticated role unexpectedly executed finalize_intake_queue_job';
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
    perform result from public.finalize_intake_queue_job(
      gen_random_uuid(), 'wamid.ANON_DENIED', gen_random_uuid(), 1, 'complaint_collection', null, '{"a": 1}'::jsonb
    );
    raise exception 'anon role unexpectedly executed finalize_intake_queue_job';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('63000000-0000-0000-0000-000000000002', '63000000-0000-0000-0000-000000000005')) as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_owners,
  (select count(*) from public.pets where clinic_id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_pets,
  (select count(*) from public.conversations where clinic_id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('63000000-0000-0000-0000-000000000001', '63000000-0000-0000-0000-000000000004')) as remaining_test_webhook_events;
