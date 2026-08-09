-- Rollback-only proof for the intake reply outbox and exact WhatsApp account
-- preservation (public.ingest_whatsapp_text_message,
-- public.outbound_message_outbox, public.finalize_intake_queue_job). Never
-- run this fixture script against a real clinic database.
-- Validated against disposable `vetai-test` on 2026-08-09.
--
-- Single-session limit: this fixture proves the documented result/state
-- contract inside one PostgreSQL session and cannot itself prove a real
-- process crash or a genuine concurrent transaction interleaving; those are
-- reviewed from PostgreSQL's documented single-statement atomicity and
-- locking semantics instead of exercised directly here.

begin;

insert into public.clinics (id, name)
values ('17000000-0000-0000-0000-000000000001', 'Outbox Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('17000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000001', '917000001');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('17000000-0000-0000-0000-000000000003', '17000000-0000-0000-0000-000000000001', '917000002');

insert into public.clinics (id, name)
values ('17000000-0000-0000-0000-000000000004', 'Outbox Test Clinic B');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('17000000-0000-0000-0000-000000000005', '17000000-0000-0000-0000-000000000004', '917000003');

-- A conversation/pet owned by clinic B, used only to prove cross-tenant
-- inputs are rejected.
insert into public.owners (id, clinic_id, phone_e164, full_name)
values ('17000000-0000-0000-0000-000000000006', '17000000-0000-0000-0000-000000000004', '+15550009999', 'Cross Tenant Owner');

insert into public.pets (id, clinic_id, owner_id, name, species, created_at)
values ('17000000-0000-0000-0000-000000000007', '17000000-0000-0000-0000-000000000004', '17000000-0000-0000-0000-000000000006', 'Cross Pet', 'dog', now());

-- =========================================================================
-- Fixture 1: ingestion stores the exact account, including two accounts in
-- one clinic.
-- =========================================================================
do $$
declare
  v_result text;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT1',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550001111',
    p_owner_name => 'Outbox Owner One',
    p_message_text => 'First account message',
    p_provider_timestamp => now()
  );
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000002',
    p_provider_message_id => 'wamid.OUT2',
    p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15550002222',
    p_owner_name => 'Outbox Owner Two',
    p_message_text => 'Second account message',
    p_provider_timestamp => now()
  );

  if (select whatsapp_account_id from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT1')
    is distinct from '17000000-0000-0000-0000-000000000002' then
    raise exception 'expected wamid.OUT1 to persist whatsapp_account_id for account 1';
  end if;
  if (select whatsapp_account_id from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT2')
    is distinct from '17000000-0000-0000-0000-000000000003' then
    raise exception 'expected wamid.OUT2 to persist whatsapp_account_id for account 2, proving two accounts in one clinic are told apart';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: exact duplicate preserves/backfills the account link; a
-- conflicting account raises and mutates nothing.
-- =========================================================================
do $$
declare
  v_result text;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT3',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550003333',
    p_owner_name => 'Outbox Owner Three',
    p_message_text => 'Third message',
    p_provider_timestamp => now()
  );

  -- Simulate a legacy row written before this migration.
  update public.webhook_events
    set whatsapp_account_id = null
    where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT3';

  -- Same account redelivers: null legacy link is backfilled.
  select result into v_result
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT3',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550003333',
    p_owner_name => 'Outbox Owner Three',
    p_message_text => 'Third message',
    p_provider_timestamp => now()
  );
  if v_result <> 'duplicate' then
    raise exception 'expected duplicate for wamid.OUT3 redelivery, got %', v_result;
  end if;
  if (select whatsapp_account_id from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT3')
    is distinct from '17000000-0000-0000-0000-000000000002' then
    raise exception 'expected the null legacy whatsapp_account_id to be backfilled to account 1';
  end if;

  -- A different account redelivering the same event/hash must raise and
  -- leave the backfilled link untouched.
  begin
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '917000002',
      p_provider_message_id => 'wamid.OUT3',
      p_payload_hash => repeat('c', 64),
      p_sender_e164 => '+15550003333',
      p_owner_name => 'Outbox Owner Three',
      p_message_text => 'Third message',
      p_provider_timestamp => now()
    );
    raise exception 'expected a conflicting account redelivery to raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'ingest_whatsapp_text_message: conflicting whatsapp_account_id for provider_event_id wamid.OUT3' then raise; end if;
  end;
  if (select whatsapp_account_id from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT3')
    is distinct from '17000000-0000-0000-0000-000000000002' then
    raise exception 'a rejected conflicting account must not change the persisted whatsapp_account_id';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: service-role claim + send-plan finalization atomically advances
-- state, completes the lease, and inserts exactly one outbox row derived
-- from the locked event/conversation/owner (no caller-supplied routing).
-- =========================================================================
do $$
declare
  v_result text;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT4',
    p_payload_hash => repeat('d', 64),
    p_sender_e164 => '+15550004444',
    p_owner_name => 'Outbox Owner Four',
    p_message_text => 'Fourth message',
    p_provider_timestamp => now()
  );
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
  v_outbox_count integer;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.OUT4';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.OUT4');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for OUT4, got %', v_claim_result;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.OUT4', v_token, 1, 'complaint_collection', null, '{"note": "reply"}'::jsonb,
    'intake_received', 'Bilgileri aldim.'
  );
  if v_result <> 'applied' or v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected applied/complaint_collection/2 for OUT4 send-plan finalize, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT4') <> 'completed' then
    raise exception 'expected the OUT4 lease to be completed after applied send-plan finalize';
  end if;

  select count(*) into v_outbox_count
  from public.outbound_message_outbox
  where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT4';
  if v_outbox_count <> 1 then
    raise exception 'expected exactly one outbox row for OUT4, got %', v_outbox_count;
  end if;

  if not exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '17000000-0000-0000-0000-000000000001'
      and source_provider_message_id = 'wamid.OUT4'
      and conversation_id = v_conversation_id
      and whatsapp_account_id = '17000000-0000-0000-0000-000000000002'
      and recipient_e164 = '+15550004444'
      and reply_category = 'intake_received'
      and content = 'Bilgileri aldim.'
  ) then
    raise exception 'the OUT4 outbox row did not derive the expected clinic/conversation/account/recipient/category/content';
  end if;

  -- Fixture 6: retry after an already-completed successful finalization
  -- creates no duplicate outbox row, even with a different reply supplied.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.OUT4', v_token, 2, 'safety_check', null, '{"note": "retry"}'::jsonb,
    'complaint', 'Farkli bir metin.'
  );
  if v_result <> 'already_completed' or v_stage is not null or v_version is not null then
    raise exception 'expected already_completed with null stage/version on OUT4 retry, got %/%/%', v_result, v_stage, v_version;
  end if;

  select count(*) into v_outbox_count
  from public.outbound_message_outbox
  where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT4';
  if v_outbox_count <> 1 then
    raise exception 'retry after already_completed must not create a duplicate outbox row, got count %', v_outbox_count;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 5: `none` finalization advances/completes but inserts no outbox
-- row.
-- =========================================================================
do $$
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT5',
    p_payload_hash => repeat('e', 64),
    p_sender_e164 => '+15550005555',
    p_owner_name => 'Outbox Owner Five',
    p_message_text => 'Fifth message',
    p_provider_timestamp => now()
  );
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
  where clinic_id = '17000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.OUT5';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.OUT5');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for OUT5, got %', v_claim_result;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.OUT5', v_token, 1, 'pet_identification', null, '{"note": "no reply"}'::jsonb,
    null, null
  );
  if v_result <> 'applied' or v_stage <> 'pet_identification' or v_version <> 2 then
    raise exception 'expected applied/pet_identification/2 for OUT5 none finalize, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT5') <> 'completed' then
    raise exception 'expected the OUT5 lease to be completed after applied none finalize';
  end if;
  if exists (select 1 from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT5') then
    raise exception 'a none finalization must not insert an outbox row';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 6: stale claim, stale state, invalid transition/pet, malformed
-- reply pair, unknown category, blank/oversized content, and a missing
-- legacy account link all leave conversation, lease, and outbox unchanged.
-- =========================================================================
do $$
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT6',
    p_payload_hash => repeat('f', 64),
    p_sender_e164 => '+15550006666',
    p_owner_name => 'Outbox Owner Six',
    p_message_text => 'Sixth message',
    p_provider_timestamp => now()
  );
end;
$$;

-- PL/pgSQL has no nested function/procedure declarations, so this repeated
-- assertion is a real (rollback-scoped) function instead of a `do` block
-- local. It is created before the service_role switch so its owner grants
-- default PUBLIC execute privilege and every role below can call it.
create function assert_outbox_fixture6_unchanged(p_conversation_id uuid, p_token uuid, p_label text) returns void as $$
begin
  if (select state_version from public.conversations where id = p_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = p_conversation_id) <> 'pet_identification' then
    raise exception '% must leave conversation state untouched', p_label;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT6') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT6') <> p_token then
    raise exception '% must leave the lease untouched', p_label;
  end if;
  if exists (select 1 from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT6') then
    raise exception '% must not insert an outbox row', p_label;
  end if;
end;
$$ language plpgsql;

set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_rejected boolean;
begin
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.OUT6';

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.OUT6');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for OUT6, got %', v_claim_result;
  end if;

  -- Wrong token: stale_claim.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.OUT6', gen_random_uuid(), 1, 'complaint_collection', null, '{"note": "wrong token"}'::jsonb,
    'intake_received', 'Bilgileri aldim.'
  );
  if v_result <> 'stale_claim' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_claim for wrong token, got %/%/%', v_result, v_stage, v_version;
  end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'stale_claim (wrong token)');

  -- Correct token, wrong expected_version: stale_state.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.OUT6', v_token, 99, 'complaint_collection', null, '{"note": "wrong version"}'::jsonb,
    'intake_received', 'Bilgileri aldim.'
  );
  if v_result <> 'stale_state' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_state for wrong expected_version, got %/%/%', v_result, v_stage, v_version;
  end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'stale_state (wrong expected_version)');

  -- Invalid next_stage.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'not_a_real_stage', null, '{"note": "bad stage"}'::jsonb,
      null, null
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid next_stage' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted an invalid next_stage'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'invalid next_stage');

  -- Cross-tenant pet_id.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection',
      '17000000-0000-0000-0000-000000000007', '{"note": "cross tenant pet"}'::jsonb,
      null, null
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'advance_conversation_intake: pet does not belong to the conversation owner/clinic' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted a cross-tenant pet_id'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'cross-tenant pet_id');

  -- Malformed reply pair: category without text.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "malformed pair"}'::jsonb,
      'intake_received', null
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: reply_category and reply_text must both be null or both be non-null' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted category without text'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'malformed reply pair (category without text)');

  -- Malformed reply pair: text without category.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "malformed pair 2"}'::jsonb,
      null, 'Bilgileri aldim.'
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: reply_category and reply_text must both be null or both be non-null' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted text without category'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'malformed reply pair (text without category)');

  -- Unknown category.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "unknown category"}'::jsonb,
      'not_a_real_category', 'Bilgileri aldim.'
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid reply_category' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted an unknown reply_category'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'unknown reply_category');

  -- Blank content.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "blank content"}'::jsonb,
      'intake_received', ''
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid reply_text' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted blank reply_text'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'blank reply_text');

  -- Oversized content.
  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "oversized content"}'::jsonb,
      'intake_received', repeat('x', 4097)
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: invalid reply_text' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted oversized reply_text'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'oversized reply_text');

  -- Missing legacy account link: a send-plan finalize against an event with
  -- no whatsapp_account_id must raise and roll back the state advance too.
  update public.webhook_events
    set whatsapp_account_id = null
    where clinic_id = '17000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.OUT6';

  v_rejected := false;
  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id, 'wamid.OUT6', v_token, 1, 'complaint_collection', null, '{"note": "missing account link"}'::jsonb,
      'intake_received', 'Bilgileri aldim.'
    );
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'finalize_intake_queue_job: inbound event has no linked whatsapp_account_id' then raise; end if;
      v_rejected := true;
  end;
  if not v_rejected then raise exception 'finalize unexpectedly accepted a send plan with no linked whatsapp_account_id'; end if;
  perform assert_outbox_fixture6_unchanged(v_conversation_id, v_token,'missing legacy whatsapp_account_id link');
end;
$$;
reset role;

-- =========================================================================
-- Fixture 7: the same provider message ID in two clinics creates
-- independent outbox rows.
-- =========================================================================
do $$
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000001',
    p_provider_message_id => 'wamid.OUT_SHARED',
    p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15550007777',
    p_owner_name => 'Outbox Owner Shared A',
    p_message_text => 'Shared id clinic A',
    p_provider_timestamp => now()
  );
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '917000003',
    p_provider_message_id => 'wamid.OUT_SHARED',
    p_payload_hash => repeat('2', 64),
    p_sender_e164 => '+15550008888',
    p_owner_name => 'Outbox Owner Shared B',
    p_message_text => 'Shared id clinic B',
    p_provider_timestamp => now()
  );
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
  where clinic_id = '17000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.OUT_SHARED';
  select conversation_id into v_conversation_b
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000004' and whatsapp_message_id = 'wamid.OUT_SHARED';

  select result, claim_token into v_claim_result, v_token_a
  from public.claim_intake_queue_job(v_conversation_a, 'wamid.OUT_SHARED');
  if v_claim_result <> 'claimed' then raise exception 'expected claimed for clinic A OUT_SHARED, got %', v_claim_result; end if;
  select result, claim_token into v_claim_result, v_token_b
  from public.claim_intake_queue_job(v_conversation_b, 'wamid.OUT_SHARED');
  if v_claim_result <> 'claimed' then raise exception 'expected claimed for clinic B OUT_SHARED, got %', v_claim_result; end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_a, 'wamid.OUT_SHARED', v_token_a, 1, 'complaint_collection', null, '{"note": "clinic a"}'::jsonb,
    'intake_received', 'Clinic A reply.'
  );
  if v_result <> 'applied' then raise exception 'expected clinic A OUT_SHARED to apply, got %', v_result; end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_b, 'wamid.OUT_SHARED', v_token_b, 1, 'complaint_collection', null, '{"note": "clinic b"}'::jsonb,
    'intake_received', 'Clinic B reply.'
  );
  if v_result <> 'applied' then raise exception 'expected clinic B OUT_SHARED to apply, got %', v_result; end if;

  if (select count(*) from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT_SHARED') <> 1
    or (select count(*) from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000004' and source_provider_message_id = 'wamid.OUT_SHARED') <> 1 then
    raise exception 'expected exactly one independent outbox row per clinic for the shared provider message id';
  end if;
  if (select content from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000001' and source_provider_message_id = 'wamid.OUT_SHARED') <> 'Clinic A reply.'
    or (select content from public.outbound_message_outbox where clinic_id = '17000000-0000-0000-0000-000000000004' and source_provider_message_id = 'wamid.OUT_SHARED') <> 'Clinic B reply.' then
    raise exception 'expected each clinic''s outbox row to keep its own content';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 8: table constraints reject cross-tenant conversation/account/
-- source combinations and duplicate source rows.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_a uuid;
begin
  insert into public.webhook_events (
    clinic_id, provider_event_id, payload_hash, processing_status, whatsapp_account_id
  ) values (
    '17000000-0000-0000-0000-000000000004', 'wamid.OUT_SHARED_NEVER_A', repeat('3', 64),
    'processed', '17000000-0000-0000-0000-000000000005'
  );

  select conversation_id into v_conversation_a
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.OUT4';

  -- Cross-tenant conversation_id for clinic_id.
  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000004', v_conversation_a, '17000000-0000-0000-0000-000000000005',
      'wamid.CONSTRAINT1', '+15550001111', 'intake_received', 'x'
    );
    raise exception 'expected a cross-tenant conversation_id to violate a foreign key';
  exception
    when foreign_key_violation then null;
  end;

  -- Cross-tenant whatsapp_account_id for clinic_id.
  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000001', v_conversation_a, '17000000-0000-0000-0000-000000000005',
      'wamid.CONSTRAINT2', '+15550001111', 'intake_received', 'x'
    );
    raise exception 'expected a cross-tenant whatsapp_account_id to violate a foreign key';
  exception
    when foreign_key_violation then null;
  end;

  -- source_provider_message_id with no matching webhook_events row in this
  -- clinic (it exists only under clinic B).
  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000001', v_conversation_a, '17000000-0000-0000-0000-000000000002',
      'wamid.OUT_SHARED_NEVER_A', '+15550001111', 'intake_received', 'x'
    );
    raise exception 'expected an unknown source_provider_message_id to violate a foreign key';
  exception
    when foreign_key_violation then null;
  end;

  -- Duplicate (clinic_id, source_provider_message_id): OUT4 already has one
  -- outbox row from fixture 3.
  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000001', v_conversation_a, '17000000-0000-0000-0000-000000000002',
      'wamid.OUT4', '+15550004444', 'complaint', 'a second planned reply'
    );
    raise exception 'expected a duplicate (clinic_id, source_provider_message_id) to violate a unique constraint';
  exception
    when unique_violation then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 9: anon and authenticated have zero table privileges/policies and
-- cannot execute the finalizer.
-- =========================================================================
set local role authenticated;
do $$
begin
  begin
    perform 1 from public.outbound_message_outbox limit 1;
    raise exception 'authenticated role unexpectedly read outbound_message_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000001', gen_random_uuid(), '17000000-0000-0000-0000-000000000002',
      'wamid.AUTH_INSERT_DENIED', '+15550001111', 'intake_received', 'x'
    );
    raise exception 'authenticated role unexpectedly inserted into outbound_message_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform result from public.finalize_intake_queue_job(
      gen_random_uuid(), 'wamid.AUTH_DENIED', gen_random_uuid(), 1, 'complaint_collection', null, '{"a": 1}'::jsonb,
      'intake_received', 'x'
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
    perform 1 from public.outbound_message_outbox limit 1;
    raise exception 'anon role unexpectedly read outbound_message_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content
    ) values (
      '17000000-0000-0000-0000-000000000001', gen_random_uuid(), '17000000-0000-0000-0000-000000000002',
      'wamid.ANON_INSERT_DENIED', '+15550001111', 'intake_received', 'x'
    );
    raise exception 'anon role unexpectedly inserted into outbound_message_outbox';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform result from public.finalize_intake_queue_job(
      gen_random_uuid(), 'wamid.ANON_DENIED', gen_random_uuid(), 1, 'complaint_collection', null, '{"a": 1}'::jsonb,
      'intake_received', 'x'
    );
    raise exception 'anon role unexpectedly executed finalize_intake_queue_job';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 10: pending replies follow the existing erasure/cascade model.
-- Owner deletion reaches the conversation FK; direct account and source-event
-- deletion exercise the other two outbox composite FKs independently.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
begin
  -- Owner -> conversation -> outbox. A pending recipient phone must never
  -- prevent erasing the owner who supplied it.
  delete from public.owners
  where clinic_id = '17000000-0000-0000-0000-000000000001'
    and phone_e164 = '+15550004444';
  if exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '17000000-0000-0000-0000-000000000001'
      and source_provider_message_id = 'wamid.OUT4'
  ) then
    raise exception 'owner erasure must cascade through conversation to the OUT4 outbox row';
  end if;

  -- Use a same-tenant account with no webhook-event link so this deletion
  -- isolates the outbox account FK action.
  insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
  values ('17000000-0000-0000-0000-000000000008', '17000000-0000-0000-0000-000000000001', '917000004');
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000001'
    and whatsapp_message_id = 'wamid.OUT2';
  insert into public.outbound_message_outbox (
    clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
    recipient_e164, reply_category, content
  ) values (
    '17000000-0000-0000-0000-000000000001', v_conversation_id,
    '17000000-0000-0000-0000-000000000008', 'wamid.OUT2',
    '+15550002222', 'intake_received', 'Account cascade proof.'
  );
  delete from public.whatsapp_accounts
  where id = '17000000-0000-0000-0000-000000000008'
    and clinic_id = '17000000-0000-0000-0000-000000000001';
  if exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '17000000-0000-0000-0000-000000000001'
      and source_provider_message_id = 'wamid.OUT2'
  ) then
    raise exception 'account deletion must cascade to its outbox row';
  end if;

  -- The source event is independently erasable; its pending reply must go
  -- with it even while the historical inbound message remains.
  select conversation_id into v_conversation_id
  from public.messages
  where clinic_id = '17000000-0000-0000-0000-000000000001'
    and whatsapp_message_id = 'wamid.OUT3';
  insert into public.outbound_message_outbox (
    clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
    recipient_e164, reply_category, content
  ) values (
    '17000000-0000-0000-0000-000000000001', v_conversation_id,
    '17000000-0000-0000-0000-000000000002', 'wamid.OUT3',
    '+15550003333', 'intake_received', 'Source cascade proof.'
  );
  delete from public.webhook_events
  where clinic_id = '17000000-0000-0000-0000-000000000001'
    and provider_event_id = 'wamid.OUT3';
  if exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '17000000-0000-0000-0000-000000000001'
      and source_provider_message_id = 'wamid.OUT3'
  ) then
    raise exception 'source-event deletion must cascade to its outbox row';
  end if;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('17000000-0000-0000-0000-000000000002', '17000000-0000-0000-0000-000000000003', '17000000-0000-0000-0000-000000000005')) as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_owners,
  (select count(*) from public.pets where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_pets,
  (select count(*) from public.conversations where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_webhook_events,
  (select count(*) from public.outbound_message_outbox where clinic_id in ('17000000-0000-0000-0000-000000000001', '17000000-0000-0000-0000-000000000004')) as remaining_test_outbox_rows;
