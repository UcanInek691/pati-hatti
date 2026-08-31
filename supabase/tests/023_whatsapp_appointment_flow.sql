-- Rollback-only proof for public.finalize_appointment_offer_queue_job and
-- public.finalize_appointment_decision_queue_job (migration
-- 20260810000200_whatsapp_appointment_flow.sql). Never run this fixture
-- against a real clinic database; Codex alone applies it to disposable
-- vetai-test.

begin;

-- =========================================================================
-- Stable future half-hour-aligned instants for this transaction.
-- =========================================================================
do $$
declare
  v_base timestamptz := date_trunc('hour', pg_catalog.now()) + interval '2 hours';
begin
  create temporary table fixture_times (key text primary key, value timestamptz not null) on commit drop;
  insert into pg_temp.fixture_times (key, value) values
    ('t_earliest', v_base),
    ('t_later', v_base + interval '30 minutes'),
    ('t_elsewhere', v_base + interval '5 hours 30 minutes'),
    ('t_confirm', v_base + interval '3 hours'),
    ('t_decline', v_base + interval '3 hours 30 minutes'),
    ('t_decline_exp', v_base + interval '4 hours'),
    ('t_repeat', v_base + interval '4 hours 30 minutes'),
    ('t_stale_confirm', v_base + interval '5 hours');
end;
$$;

grant select on pg_temp.fixture_times to service_role;

-- =========================================================================
-- Fixture 0: exact CHECK constraint, both function shapes/security/grants,
-- and role denial for anon/authenticated on both new RPCs and the outbox
-- table (unchanged from Task 022's grant shape).
-- =========================================================================
do $$
declare
  v_condef text;
  v_function_count integer;
  v_owner_name text;
  v_grantees text[];
begin
  select pg_catalog.pg_get_constraintdef(oid) into v_condef
  from pg_catalog.pg_constraint
  where conrelid = 'public.outbound_message_outbox'::regclass
    and conname = 'outbound_message_outbox_reply_category_check';

  if v_condef is null
    or v_condef !~ '''emergency_handoff'''
    or v_condef !~ '''human_handoff'''
    or v_condef !~ '''safety_questions'''
    or v_condef !~ '''pet_identity'''
    or v_condef !~ '''complaint'''
    or v_condef !~ '''intake_received'''
    or v_condef !~ '''appointment_offer'''
    or v_condef !~ '''appointment_confirmed'''
    or v_condef !~ '''appointment_declined'''
    or v_condef !~ '''appointment_unavailable'''
  then
    raise exception 'expected the reply_category CHECK to contain exactly the six existing plus four new values, got %', v_condef;
  end if;

  select count(*) into v_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('finalize_appointment_offer_queue_job', 'finalize_appointment_decision_queue_job')
    and p.prosecdef = false
    and p.provolatile = 'v'
    and p.proconfig is not null
    and (p.proconfig @> array['search_path='] or p.proconfig @> array['search_path=""']);
  if v_function_count <> 2 then
    raise exception 'expected both new functions to be SECURITY INVOKER, VOLATILE, SET search_path = '''', got % matching', v_function_count;
  end if;

  select array_agg(distinct r.routine_name || ':' || g.grantee order by r.routine_name || ':' || g.grantee)
    into v_grantees
  from information_schema.routines r
  join information_schema.routine_privileges g
    on g.specific_name = r.specific_name and g.specific_schema = r.specific_schema
  where r.routine_schema = 'public'
    and r.routine_name in ('finalize_appointment_offer_queue_job', 'finalize_appointment_decision_queue_job')
    and g.privilege_type = 'EXECUTE';

  select pg_catalog.pg_get_userbyid(p.proowner)::text into v_owner_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_appointment_offer_queue_job'
  limit 1;

  if exists (
    select 1 from unnest(v_grantees) g
    where g not like '%:service_role' and g not like '%:' || v_owner_name
  ) then
    raise exception 'expected only service_role (plus owner) to hold EXECUTE on the two new RPCs, got %', v_grantees;
  end if;

  select array_agg(distinct grantee::text order by grantee::text) into v_grantees
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'outbound_message_outbox';
  if exists (
    select 1 from unnest(v_grantees) grantee
    where grantee not in ('service_role', v_owner_name)
  ) then
    raise exception 'expected outbound_message_outbox table privileges unchanged (service_role plus owner only), got %', v_grantees;
  end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      gen_random_uuid(), 'wamid.DENY1', gen_random_uuid(), 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
    raise exception 'expected anon to be denied execute on finalize_appointment_offer_queue_job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      gen_random_uuid(), 'wamid.DENY2', gen_random_uuid(), 1, 'confirm', null, '{"note": "x"}'::jsonb
    );
    raise exception 'expected anon to be denied execute on finalize_appointment_decision_queue_job';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      gen_random_uuid(), 'wamid.DENY1', gen_random_uuid(), 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
    raise exception 'expected authenticated to be denied execute on finalize_appointment_offer_queue_job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      gen_random_uuid(), 'wamid.DENY2', gen_random_uuid(), 1, 'confirm', null, '{"note": "x"}'::jsonb
    );
    raise exception 'expected authenticated to be denied execute on finalize_appointment_decision_queue_job';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Shared fixture data: clinics, WhatsApp accounts, and one cross-tenant pet.
-- =========================================================================
insert into public.clinics (id, name) values
  ('02300000-0000-0000-0000-000000000001', '023 Clinic A'),
  ('02300000-0000-0000-0000-000000000002', '023 Clinic C (no slots)'),
  ('02300000-0000-0000-0000-000000000003', '023 Clinic PX (cross-tenant pet owner)'),
  ('02300000-0000-0000-0000-000000000010', '023 Clinic Erasure Owner'),
  ('02300000-0000-0000-0000-000000000011', '023 Clinic Erasure Account'),
  ('02300000-0000-0000-0000-000000000012', '023 Clinic Erasure Source'),
  ('02300000-0000-0000-0000-000000000013', '023 Clinic Erasure Clinic');

-- Task 041: clinics default to suspended; activate this fixture's clinics so
-- the existing AI/ingest/outbound assertions below stay unchanged.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id) values
  ('02360000-0000-0000-0000-000000000001', '02300000-0000-0000-0000-000000000001', '023000001'),
  ('02360000-0000-0000-0000-000000000002', '02300000-0000-0000-0000-000000000002', '023000002'),
  ('02360000-0000-0000-0000-000000000003', '02300000-0000-0000-0000-000000000003', '023000003'),
  ('02360000-0000-0000-0000-000000000010', '02300000-0000-0000-0000-000000000010', '023000010'),
  ('02360000-0000-0000-0000-000000000011', '02300000-0000-0000-0000-000000000011', '023000011'),
  ('02360000-0000-0000-0000-000000000012', '02300000-0000-0000-0000-000000000012', '023000012'),
  ('02360000-0000-0000-0000-000000000013', '02300000-0000-0000-0000-000000000013', '023000013');

insert into public.owners (id, clinic_id, phone_e164, full_name) values
  ('02310000-0000-0000-0000-000000000099', '02300000-0000-0000-0000-000000000003', '+15550990099', '023 PX Owner');
insert into public.pets (id, clinic_id, owner_id, name, species) values
  ('02320000-0000-0000-0000-000000000099', '02300000-0000-0000-0000-000000000003', '02310000-0000-0000-0000-000000000099', '023 PX Pet', 'dog');

-- Two available clinic-A slots shared by Fixtures A and C.
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status) values
  ('02340000-0000-0000-0000-000000000001', '02300000-0000-0000-0000-000000000001',
   (select value from pg_temp.fixture_times where key = 't_earliest'), (select value from pg_temp.fixture_times where key = 't_earliest') + interval '30 minutes', 'available'),
  ('02340000-0000-0000-0000-000000000002', '02300000-0000-0000-0000-000000000001',
   (select value from pg_temp.fixture_times where key = 't_later'), (select value from pg_temp.fixture_times where key = 't_later') + interval '30 minutes', 'available');

-- =========================================================================
-- Fixture A: successful offer -- earliest-only hold, one-step advances to
-- appointment_selection, exact Istanbul copy, atomic claim completion.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_expected_copy text;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000001', '02300000-0000-0000-0000-000000000001', '+15550990001', '023 Owner Offer');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000001', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000001', '023 Pet Offer', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'OFFER1', p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15550990001', p_owner_name => '023 Owner Offer', p_message_text => 'appointment please',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'OFFER1';
  update public.conversations set intake_stage = 'safety_check' where id = v_conversation_id;

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'OFFER1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'OFFER1', v_token, 1, 'ready_for_triage',
    '02320000-0000-0000-0000-000000000001', '{"note": "offer"}'::jsonb
  );
  if v_result <> 'offered' or v_stage <> 'appointment_selection' or v_version <> 4 then
    raise exception 'expected offered/appointment_selection/4, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.appointment_slots
    where id = '02340000-0000-0000-0000-000000000001'
      and status = 'held' and conversation_id = v_conversation_id
      and owner_id = '02310000-0000-0000-0000-000000000001' and pet_id = '02320000-0000-0000-0000-000000000001'
      and booking_token is not null and hold_until > pg_catalog.now()
  ) then
    raise exception 'expected the earliest slot to be held for this conversation';
  end if;
  if not exists (select 1 from public.appointment_slots where id = '02340000-0000-0000-0000-000000000002' and status = 'available' and conversation_id is null) then
    raise exception 'expected the later slot to remain untouched (earliest-only selection)';
  end if;

  select 'En erken uygun randevu saati: '
      || to_char((select value from pg_temp.fixture_times where key = 't_earliest') at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || '. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.'
    into v_expected_copy;
  if not exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '02300000-0000-0000-0000-000000000001' and source_provider_message_id = 'OFFER1'
      and reply_category = 'appointment_offer' and content = v_expected_copy
  ) then
    raise exception 'expected exactly one appointment_offer outbox row with the exact Istanbul-rendered copy';
  end if;
  if (select count(*) from public.outbound_message_outbox where source_provider_message_id = 'OFFER1') <> 1 then
    raise exception 'expected exactly one outbox row for OFFER1';
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'OFFER1') <> 'completed' then
    raise exception 'expected the OFFER1 lease to be completed';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture B: no eligible slot -> human_handoff, exact no-slot copy, no
-- appointment mutation. Clinic C has zero appointment_slots rows.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000020', '02300000-0000-0000-0000-000000000002', '+15550990020', '023 Owner NoSlot');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000020', '02300000-0000-0000-0000-000000000002', '02310000-0000-0000-0000-000000000020', '023 Pet NoSlot', 'cat');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000002', p_provider_message_id => 'NOSLOT1', p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15550990020', p_owner_name => '023 Owner NoSlot', p_message_text => 'appointment please',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000002' and whatsapp_message_id = 'NOSLOT1';
  -- Already at appointment_offer: exercises the same-stage (step-2-skipped) path.
  update public.conversations set intake_stage = 'appointment_offer' where id = v_conversation_id;

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'NOSLOT1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'NOSLOT1', v_token, 1, 'appointment_offer',
    '02320000-0000-0000-0000-000000000020', '{"note": "noslot"}'::jsonb
  );
  if v_result <> 'unavailable' or v_stage <> 'human_handoff' or v_version <> 3 then
    raise exception 'expected unavailable/human_handoff/3, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'NOSLOT1' and reply_category = 'appointment_unavailable'
      and content = 'Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen kliniğimizi telefonla arayın.'
  ) then
    raise exception 'expected exact no-slot copy';
  end if;
  if (select count(*) from public.appointment_slots where clinic_id = '02300000-0000-0000-0000-000000000002') <> 0 then
    raise exception 'expected zero appointment_slots rows created or touched for the no-slot clinic';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000002' and provider_event_id = 'NOSLOT1') <> 'completed' then
    raise exception 'expected the NOSLOT1 lease to be completed';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture C: hold refusal after a successful advisory list. A true
-- list-then-hold race cannot be reproduced within one PostgreSQL
-- transaction (pg_catalog.now() is transaction-stable, so list's and
-- hold's identical eligibility gates can never diverge). This uses the
-- one deterministic non-'held' outcome reachable after a successful list
-- in a single session -- hold_appointment_slot's own 'conflict' result,
-- because the conversation already holds a confirmed slot elsewhere --
-- as the closest honest single-session proof of the "raise so the whole
-- transaction rolls back" branch. It does not claim to prove true
-- cross-session lock contention; that remains reviewed from PostgreSQL
-- semantics, exactly as Task 022's own fixture documents for its RPCs.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_version_before integer;
  v_rejected boolean := false;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000002', '02300000-0000-0000-0000-000000000001', '+15550990002', '023 Owner Conflict');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000002', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000002', '023 Pet Conflict', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'CONFLICT1', p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15550990002', p_owner_name => '023 Owner Conflict', p_message_text => 'appointment please',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'CONFLICT1';
  update public.conversations set intake_stage = 'appointment_offer' where id = v_conversation_id;

  -- Artificial: a confirmed slot elsewhere while still at appointment_offer
  -- is not a reachable product state, only a mechanical way to force
  -- hold_appointment_slot's 'conflict' branch deterministically.
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, confirmed_at)
  values (
    '02340000-0000-0000-0000-000000000003', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_elsewhere'), (select value from pg_temp.fixture_times where key = 't_elsewhere') + interval '30 minutes',
    'confirmed', v_conversation_id, '02310000-0000-0000-0000-000000000002', '02320000-0000-0000-0000-000000000002',
    gen_random_uuid(), pg_catalog.now()
  );

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'CONFLICT1');
  select state_version into v_version_before from public.conversations where id = v_conversation_id;

  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'CONFLICT1', v_token, v_version_before, 'appointment_offer',
      '02320000-0000-0000-0000-000000000002', '{"note": "conflict"}'::jsonb
    );
  exception
    when others then
      if sqlerrm !~ 'could not hold slot .* \(result conflict\)' then
        raise exception 'expected a could-not-hold/conflict raise, got %', sqlerrm;
      end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected the conflicting hold attempt to raise and roll back';
  end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> v_version_before then
    raise exception 'expected the failed offer attempt to leave conversation state fully unchanged';
  end if;
  if not exists (select 1 from public.appointment_slots where id = '02340000-0000-0000-0000-000000000002' and status = 'available') then
    raise exception 'expected the later slot to remain available after the failed hold attempt';
  end if;
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'CONFLICT1') then
    raise exception 'expected zero outbox rows after the failed offer attempt';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'CONFLICT1') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'CONFLICT1') <> v_token then
    raise exception 'expected the CONFLICT1 lease to remain preserved for retry';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture D: RPC1 stale_claim, stale_state, invalid input, and a
-- cross-tenant pet_id all leave conversation/lease state unchanged.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_rejected boolean;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000004', '02300000-0000-0000-0000-000000000001', '+15550990004', '023 Owner Invalid1');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000004', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000004', '023 Pet Invalid1', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'INVALID1', p_payload_hash => repeat('d', 64),
    p_sender_e164 => '+15550990004', p_owner_name => '023 Owner Invalid1', p_message_text => 'appointment please',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'INVALID1';
  update public.conversations set intake_stage = 'safety_check' where id = v_conversation_id;

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'INVALID1');

  -- Wrong token: stale_claim, no mutation.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'INVALID1', gen_random_uuid(), 1, 'ready_for_triage', '02320000-0000-0000-0000-000000000004', '{"note": "x"}'::jsonb
  );
  if v_result <> 'stale_claim' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_claim with null stage/version for wrong token, got %/%/%', v_result, v_stage, v_version;
  end if;

  -- Wrong expected_version: stale_state, no mutation.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'INVALID1', v_token, 99, 'ready_for_triage', '02320000-0000-0000-0000-000000000004', '{"note": "x"}'::jsonb
  );
  if v_result <> 'stale_state' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_state with null stage/version for wrong expected_version, got %/%/%', v_result, v_stage, v_version;
  end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = v_conversation_id) <> 'safety_check' then
    raise exception 'expected stale_claim/stale_state to leave conversation state fully unchanged';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'INVALID1') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'INVALID1') <> v_token then
    raise exception 'expected the INVALID1 lease to remain preserved';
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      null, 'INVALID1', v_token, 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid conversation_id' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected null conversation_id to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, '', v_token, 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid provider_message_id' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected empty provider_message_id to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', null, 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid claim_token' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected null claim_token to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 0, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid expected_version' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected expected_version 0 to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 1, 'appointment_selection', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid planned_next_stage' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected an out-of-set planned_next_stage to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 1, 'ready_for_triage', null, '{}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid intake_data' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected empty intake_data to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 1, 'ready_for_triage', null, '["not", "an", "object"]'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid intake_data' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected non-object intake_data to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 1, 'ready_for_triage', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_offer_queue_job: invalid pet_id' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected null pet_id to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_offer_queue_job(
      v_conversation_id, 'INVALID1', v_token, 1, 'ready_for_triage',
      '02320000-0000-0000-0000-000000000099', '{"note": "cross tenant pet"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'advance_conversation_intake: pet does not belong to the conversation owner/clinic' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a cross-tenant pet_id to be rejected'; end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = v_conversation_id) <> 'safety_check' then
    raise exception 'expected every invalid-input rejection to leave conversation state fully unchanged';
  end if;
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'INVALID1') then
    raise exception 'expected zero outbox rows from any rejected call';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture D2: RPC2 stale_claim, stale_state, invalid input, and a
-- cross-tenant pet_id all leave conversation/lease/slot state unchanged.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_rejected boolean;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000011', '02300000-0000-0000-0000-000000000001', '+15550990011', '023 Owner Invalid2');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000011', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000011', '023 Pet Invalid2', 'cat');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'INVALID2', p_payload_hash => repeat('e', 64),
    p_sender_e164 => '+15550990011', p_owner_name => '023 Owner Invalid2', p_message_text => 'EVET',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'INVALID2';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'INVALID2');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'INVALID2', gen_random_uuid(), 1, 'confirm', '02320000-0000-0000-0000-000000000011', '{"note": "x"}'::jsonb
  );
  if v_result <> 'stale_claim' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_claim with null stage/version for wrong token, got %/%/%', v_result, v_stage, v_version;
  end if;

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'INVALID2', v_token, 99, 'confirm', '02320000-0000-0000-0000-000000000011', '{"note": "x"}'::jsonb
  );
  if v_result <> 'stale_state' or v_stage is not null or v_version is not null then
    raise exception 'expected stale_state with null stage/version for wrong expected_version, got %/%/%', v_result, v_stage, v_version;
  end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = v_conversation_id) <> 'appointment_selection' then
    raise exception 'expected stale_claim/stale_state to leave conversation state fully unchanged';
  end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      v_conversation_id, 'INVALID2', v_token, 1, 'maybe', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_decision_queue_job: invalid decision' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected an out-of-set decision to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      v_conversation_id, 'INVALID2', v_token, 1, 'confirm', null, '{}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_decision_queue_job: invalid intake_data' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected empty intake_data to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      v_conversation_id, 'INVALID2', v_token, 1, 'confirm', null, '{"note": "x"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'finalize_appointment_decision_queue_job: invalid pet_id' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected null pet_id to be rejected'; end if;

  v_rejected := false;
  begin
    perform result from public.finalize_appointment_decision_queue_job(
      v_conversation_id, 'INVALID2', v_token, 1, 'confirm',
      '02320000-0000-0000-0000-000000000099', '{"note": "cross tenant pet"}'::jsonb
    );
  exception when sqlstate 'P0001' then
    if sqlerrm <> 'advance_conversation_intake: pet does not belong to the conversation owner/clinic' then raise; end if;
    v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a cross-tenant pet_id to be rejected'; end if;

  if (select state_version from public.conversations where id = v_conversation_id) <> 1
    or (select intake_stage from public.conversations where id = v_conversation_id) <> 'appointment_selection' then
    raise exception 'expected every invalid-input rejection to leave conversation state fully unchanged';
  end if;
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'INVALID2') then
    raise exception 'expected zero outbox rows from any rejected call';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'INVALID2') <> 'processing'
    or (select intake_claim_token from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'INVALID2') <> v_token then
    raise exception 'expected the INVALID2 lease to remain preserved';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture E: exact confirm -- one confirmed slot, completed conversation,
-- exact Istanbul confirmation copy, completed claim, one transaction.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_expected_copy text;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000005', '02300000-0000-0000-0000-000000000001', '+15550990005', '023 Owner Confirm');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000005', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000005', '023 Pet Confirm', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'CONFIRM1', p_payload_hash => repeat('f', 64),
    p_sender_e164 => '+15550990005', p_owner_name => '023 Owner Confirm', p_message_text => 'EVET',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'CONFIRM1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values (
    '02340000-0000-0000-0000-000000000004', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_confirm'), (select value from pg_temp.fixture_times where key = 't_confirm') + interval '30 minutes',
    'held', v_conversation_id, '02310000-0000-0000-0000-000000000005', '02320000-0000-0000-0000-000000000005',
    gen_random_uuid(), pg_catalog.now() + interval '9 minutes'
  );

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'CONFIRM1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'CONFIRM1', v_token, 1, 'confirm', '02320000-0000-0000-0000-000000000005', '{"note": "confirm"}'::jsonb
  );
  if v_result <> 'confirmed' or v_stage <> 'completed' or v_version <> 3 then
    raise exception 'expected confirmed/completed/3, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.appointment_slots
    where id = '02340000-0000-0000-0000-000000000004' and status = 'confirmed'
      and hold_until is null and confirmed_at is not null
      and conversation_id = v_conversation_id and owner_id = '02310000-0000-0000-0000-000000000005' and pet_id = '02320000-0000-0000-0000-000000000005'
  ) then
    raise exception 'expected exactly one confirmed slot for this conversation';
  end if;

  select 'Randevunuz '
      || to_char((select value from pg_temp.fixture_times where key = 't_confirm') at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || ' için oluşturuldu.'
    into v_expected_copy;
  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'CONFIRM1' and reply_category = 'appointment_confirmed' and content = v_expected_copy
  ) then
    raise exception 'expected exact Istanbul-rendered confirmation copy';
  end if;
  if (select count(*) from public.outbound_message_outbox where source_provider_message_id = 'CONFIRM1') <> 1 then
    raise exception 'expected exactly one outbox row for CONFIRM1';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'CONFIRM1') <> 'completed' then
    raise exception 'expected the CONFIRM1 lease to be completed';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture F1/F2: decline releases the hold to the exact coherent
-- available shape, creates no confirmed slot, completes the conversation,
-- writes decline copy, completes the claim -- for both an unexpired and an
-- already-expired hold (decline never gates on hold validity).
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000006', '02300000-0000-0000-0000-000000000001', '+15550990006', '023 Owner Decline');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000006', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000006', '023 Pet Decline', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'DECLINE1', p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15550990006', p_owner_name => '023 Owner Decline', p_message_text => 'HAYIR',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'DECLINE1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values (
    '02340000-0000-0000-0000-000000000005', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_decline'), (select value from pg_temp.fixture_times where key = 't_decline') + interval '30 minutes',
    'held', v_conversation_id, '02310000-0000-0000-0000-000000000006', '02320000-0000-0000-0000-000000000006',
    gen_random_uuid(), pg_catalog.now() + interval '9 minutes'
  );

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'DECLINE1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'DECLINE1', v_token, 1, 'decline', '02320000-0000-0000-0000-000000000006', '{"note": "decline"}'::jsonb
  );
  if v_result <> 'declined' or v_stage <> 'completed' or v_version <> 3 then
    raise exception 'expected declined/completed/3, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.appointment_slots
    where id = '02340000-0000-0000-0000-000000000005' and status = 'available'
      and conversation_id is null and owner_id is null and pet_id is null and booking_token is null and hold_until is null and confirmed_at is null
  ) then
    raise exception 'expected the declined slot released to the exact coherent available shape';
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'DECLINE1' and reply_category = 'appointment_declined' and content = 'Randevu oluşturulmadı.'
  ) then
    raise exception 'expected exact decline copy';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000001' and provider_event_id = 'DECLINE1') <> 'completed' then
    raise exception 'expected the DECLINE1 lease to be completed';
  end if;
end;
$$;

do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000007', '02300000-0000-0000-0000-000000000001', '+15550990007', '023 Owner DeclineExp');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000007', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000007', '023 Pet DeclineExp', 'cat');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'DECLINEEXP1', p_payload_hash => repeat('2', 64),
    p_sender_e164 => '+15550990007', p_owner_name => '023 Owner DeclineExp', p_message_text => 'HAYIR',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'DECLINEEXP1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values (
    '02340000-0000-0000-0000-000000000006', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_decline_exp'), (select value from pg_temp.fixture_times where key = 't_decline_exp') + interval '30 minutes',
    'held', v_conversation_id, '02310000-0000-0000-0000-000000000007', '02320000-0000-0000-0000-000000000007',
    gen_random_uuid(), pg_catalog.now() - interval '1 minute'
  );

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'DECLINEEXP1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'DECLINEEXP1', v_token, 1, 'decline', '02320000-0000-0000-0000-000000000007', '{"note": "decline"}'::jsonb
  );
  if v_result <> 'declined' or v_stage <> 'completed' or v_version <> 3 then
    raise exception 'expected declined/completed/3 even with an already-expired hold, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.appointment_slots
    where id = '02340000-0000-0000-0000-000000000006' and status = 'available'
      and conversation_id is null and owner_id is null and pet_id is null and booking_token is null and hold_until is null and confirmed_at is null
  ) then
    raise exception 'expected the already-expired held slot released to the exact coherent available shape';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture G: repeat preserves the slot/token/hold time exactly and writes
-- the same offer copy again as a fresh reply.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
  v_token_before uuid;
  v_hold_before timestamptz;
  v_expected_copy text;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000008', '02300000-0000-0000-0000-000000000001', '+15550990008', '023 Owner Repeat');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000008', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000008', '023 Pet Repeat', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'REPEAT1', p_payload_hash => repeat('3', 64),
    p_sender_e164 => '+15550990008', p_owner_name => '023 Owner Repeat', p_message_text => 'tamam',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'REPEAT1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values (
    '02340000-0000-0000-0000-000000000007', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_repeat'), (select value from pg_temp.fixture_times where key = 't_repeat') + interval '30 minutes',
    'held', v_conversation_id, '02310000-0000-0000-0000-000000000008', '02320000-0000-0000-0000-000000000008',
    gen_random_uuid(), pg_catalog.now() + interval '9 minutes'
  );
  select booking_token, hold_until into v_token_before, v_hold_before
  from public.appointment_slots where id = '02340000-0000-0000-0000-000000000007';

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'REPEAT1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'REPEAT1', v_token, 1, 'repeat', '02320000-0000-0000-0000-000000000008', '{"note": "repeat"}'::jsonb
  );
  if v_result <> 'repeated' or v_stage <> 'appointment_selection' or v_version <> 2 then
    raise exception 'expected repeated/appointment_selection/2, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (
    select 1 from public.appointment_slots
    where id = '02340000-0000-0000-0000-000000000007' and status = 'held'
      and booking_token = v_token_before and hold_until = v_hold_before
  ) then
    raise exception 'expected repeat to leave the held slot/token/hold time exactly unchanged';
  end if;

  select 'En erken uygun randevu saati: '
      || to_char((select value from pg_temp.fixture_times where key = 't_repeat') at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || '. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.'
    into v_expected_copy;
  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'REPEAT1' and reply_category = 'appointment_offer' and content = v_expected_copy
  ) then
    raise exception 'expected the same offer copy to be repeated exactly';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture H1/H2: an expired or missing hold never confirms/repeats,
-- routes to human_handoff, and writes the exact unavailable copy.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000009', '02300000-0000-0000-0000-000000000001', '+15550990009', '023 Owner StaleConfirm');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000009', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000009', '023 Pet StaleConfirm', 'dog');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'STALECONFIRM1', p_payload_hash => repeat('4', 64),
    p_sender_e164 => '+15550990009', p_owner_name => '023 Owner StaleConfirm', p_message_text => 'EVET',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'STALECONFIRM1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values (
    '02340000-0000-0000-0000-000000000008', '02300000-0000-0000-0000-000000000001',
    (select value from pg_temp.fixture_times where key = 't_stale_confirm'), (select value from pg_temp.fixture_times where key = 't_stale_confirm') + interval '30 minutes',
    'held', v_conversation_id, '02310000-0000-0000-0000-000000000009', '02320000-0000-0000-0000-000000000009',
    gen_random_uuid(), pg_catalog.now() - interval '1 minute'
  );

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'STALECONFIRM1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'STALECONFIRM1', v_token, 1, 'confirm', '02320000-0000-0000-0000-000000000009', '{"note": "confirm"}'::jsonb
  );
  if v_result <> 'stale_hold' or v_stage <> 'human_handoff' or v_version <> 2 then
    raise exception 'expected stale_hold/human_handoff/2 for an expired hold, got %/%/%', v_result, v_stage, v_version;
  end if;

  if not exists (select 1 from public.appointment_slots where id = '02340000-0000-0000-0000-000000000008' and status = 'held') then
    raise exception 'expected the expired held slot to remain completely untouched by the stale_hold branch';
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'STALECONFIRM1' and reply_category = 'appointment_unavailable'
      and content = 'Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.'
  ) then
    raise exception 'expected exact expired-hold unavailable copy';
  end if;
end;
$$;

do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000010', '02300000-0000-0000-0000-000000000001', '+15550990010', '023 Owner StaleMissing');
  insert into public.pets (id, clinic_id, owner_id, name, species)
  values ('02320000-0000-0000-0000-000000000010', '02300000-0000-0000-0000-000000000001', '02310000-0000-0000-0000-000000000010', '023 Pet StaleMissing', 'cat');

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000001', p_provider_message_id => 'STALEMISSING1', p_payload_hash => repeat('5', 64),
    p_sender_e164 => '+15550990010', p_owner_name => '023 Owner StaleMissing', p_message_text => 'tamam',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'STALEMISSING1';
  update public.conversations set intake_stage = 'appointment_selection' where id = v_conversation_id;
  -- Deliberately no appointment_slots row at all: the hold vanished (e.g. an
  -- external cleanup) before this reply was processed.

  select claim_token into v_token from public.claim_intake_queue_job(v_conversation_id, 'STALEMISSING1');

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'STALEMISSING1', v_token, 1, 'repeat', '02320000-0000-0000-0000-000000000010', '{"note": "repeat"}'::jsonb
  );
  if v_result <> 'stale_hold' or v_stage <> 'human_handoff' or v_version <> 2 then
    raise exception 'expected stale_hold/human_handoff/2 for a missing hold, got %/%/%', v_result, v_stage, v_version;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where source_provider_message_id = 'STALEMISSING1' and reply_category = 'appointment_unavailable'
      and content = 'Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.'
  ) then
    raise exception 'expected exact missing-hold unavailable copy';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture I: duplicate/replayed events on both RPCs remain idempotent --
-- already_completed, zero new outbox rows, zero new mutation.
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_token uuid;
  v_result text;
  v_stage text;
  v_version integer;
begin
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'OFFER1';

  -- Same claim_token as before is now stale (the lease is already
  -- completed), so any value here must still short-circuit first.
  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'OFFER1', gen_random_uuid(), 4, 'ready_for_triage',
    '02320000-0000-0000-0000-000000000001', '{"note": "replay"}'::jsonb
  );
  if v_result <> 'already_completed' or v_stage is not null or v_version is not null then
    raise exception 'expected already_completed with null stage/version on OFFER1 replay, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select count(*) from public.outbound_message_outbox where source_provider_message_id = 'OFFER1') <> 1 then
    raise exception 'expected OFFER1 replay to create no second outbox row';
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 4 then
    raise exception 'expected OFFER1 replay to leave conversation state unchanged';
  end if;

  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000001' and whatsapp_message_id = 'CONFIRM1';

  select result, intake_stage, state_version into v_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'CONFIRM1', gen_random_uuid(), 3, 'confirm',
    '02320000-0000-0000-0000-000000000005', '{"note": "replay"}'::jsonb
  );
  if v_result <> 'already_completed' or v_stage is not null or v_version is not null then
    raise exception 'expected already_completed with null stage/version on CONFIRM1 replay, got %/%/%', v_result, v_stage, v_version;
  end if;
  if (select count(*) from public.outbound_message_outbox where source_provider_message_id = 'CONFIRM1') <> 1 then
    raise exception 'expected CONFIRM1 replay to create no second outbox row (no second confirmation)';
  end if;
  if (select count(*) from public.appointment_slots where id = '02340000-0000-0000-0000-000000000004' and status = 'confirmed') <> 1 then
    raise exception 'expected CONFIRM1 replay to leave the confirmed slot unchanged';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture J: owner/account/source/clinic erasure cascades remain intact
-- for the four new appointment reply categories, exactly as the six
-- existing categories already cascade (20260809000100_intake_reply_outbox).
-- =========================================================================
set local role service_role;
do $$
declare
  v_conversation_id uuid;
  v_count integer;
begin
  -- Owner erasure cascades transitively through conversations -> outbox.
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000101', '02300000-0000-0000-0000-000000000010', '+15550990101', '023 Erasure Owner');
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000010', p_provider_message_id => 'ERASEOWNER1', p_payload_hash => repeat('6', 64),
    p_sender_e164 => '+15550990101', p_owner_name => '023 Erasure Owner', p_message_text => 'x', p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000010' and whatsapp_message_id = 'ERASEOWNER1';
  insert into public.outbound_message_outbox (clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content)
  values ('02300000-0000-0000-0000-000000000010', v_conversation_id, '02360000-0000-0000-0000-000000000010', 'ERASEOWNER1', '+15550990101', 'appointment_confirmed', 'test');

  delete from public.owners where id = '02310000-0000-0000-0000-000000000101';
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'ERASEOWNER1') then
    raise exception 'expected owner erasure to cascade its appointment_confirmed outbox row';
  end if;

  -- WhatsApp account erasure cascades directly.
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000111', '02300000-0000-0000-0000-000000000011', '+15550990111', '023 Erasure Account Owner');
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000011', p_provider_message_id => 'ERASEACCOUNT1', p_payload_hash => repeat('7', 64),
    p_sender_e164 => '+15550990111', p_owner_name => '023 Erasure Account Owner', p_message_text => 'x', p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000011' and whatsapp_message_id = 'ERASEACCOUNT1';
  -- Use a same-clinic account with no webhook_events reference so this
  -- isolates the outbox account FK's cascade; the ingest account correctly
  -- remains protected by webhook_events' deliberate NO ACTION FK.
  insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
  values ('02360000-0000-0000-0000-000000000111', '02300000-0000-0000-0000-000000000011', '023000111');
  insert into public.outbound_message_outbox (clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content)
  values ('02300000-0000-0000-0000-000000000011', v_conversation_id, '02360000-0000-0000-0000-000000000111', 'ERASEACCOUNT1', '+15550990111', 'appointment_declined', 'test');

  delete from public.whatsapp_accounts where id = '02360000-0000-0000-0000-000000000111';
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'ERASEACCOUNT1') then
    raise exception 'expected whatsapp_account erasure to cascade its appointment_declined outbox row';
  end if;

  -- Source webhook_event erasure cascades directly.
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000112', '02300000-0000-0000-0000-000000000012', '+15550990112', '023 Erasure Source Owner');
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000012', p_provider_message_id => 'ERASESOURCE1', p_payload_hash => repeat('8', 64),
    p_sender_e164 => '+15550990112', p_owner_name => '023 Erasure Source Owner', p_message_text => 'x', p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000012' and whatsapp_message_id = 'ERASESOURCE1';
  insert into public.outbound_message_outbox (clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content)
  values ('02300000-0000-0000-0000-000000000012', v_conversation_id, '02360000-0000-0000-0000-000000000012', 'ERASESOURCE1', '+15550990112', 'appointment_unavailable', 'test');

  delete from public.webhook_events where clinic_id = '02300000-0000-0000-0000-000000000012' and provider_event_id = 'ERASESOURCE1';
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'ERASESOURCE1') then
    raise exception 'expected source webhook_event erasure to cascade its appointment_unavailable outbox row';
  end if;

  -- Clinic erasure cascades transitively through every path at once.
  insert into public.owners (id, clinic_id, phone_e164, full_name)
  values ('02310000-0000-0000-0000-000000000113', '02300000-0000-0000-0000-000000000013', '+15550990113', '023 Erasure Clinic Owner');
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '023000013', p_provider_message_id => 'ERASECLINIC1', p_payload_hash => repeat('9', 64),
    p_sender_e164 => '+15550990113', p_owner_name => '023 Erasure Clinic Owner', p_message_text => 'x', p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id from public.messages
  where clinic_id = '02300000-0000-0000-0000-000000000013' and whatsapp_message_id = 'ERASECLINIC1';
  insert into public.outbound_message_outbox (clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id, recipient_e164, reply_category, content)
  values ('02300000-0000-0000-0000-000000000013', v_conversation_id, '02360000-0000-0000-0000-000000000013', 'ERASECLINIC1', '+15550990113', 'appointment_offer', 'test');

  delete from public.clinics where id = '02300000-0000-0000-0000-000000000013';
  select count(*) into v_count from public.outbound_message_outbox where source_provider_message_id = 'ERASECLINIC1';
  if v_count <> 0 then
    raise exception 'expected clinic erasure to cascade its appointment_offer outbox row';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Residue check: after rollback, zero fixture rows from this script
-- survive in any table.
-- =========================================================================
rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id::text like '023%') as remaining_clinics,
  (select count(*) from public.whatsapp_accounts where id::text like '023%') as remaining_whatsapp_accounts,
  (select count(*) from public.owners where id::text like '023%') as remaining_owners,
  (select count(*) from public.pets where id::text like '023%') as remaining_pets,
  (select count(*) from public.conversations where clinic_id::text like '023%') as remaining_conversations,
  (select count(*) from public.appointment_slots where clinic_id::text like '023%') as remaining_slots,
  (select count(*) from public.outbound_message_outbox where clinic_id::text like '023%') as remaining_outbox;
