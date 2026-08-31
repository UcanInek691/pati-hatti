-- Rollback-only proof for Task 040's expand-only V2 outbound claim RPC
-- (public.claim_outbound_message_v2). V1 (public.claim_outbound_message) is
-- unchanged and already proven by supabase/tests/018_outbound_delivery.sql;
-- this fixture proves only what V2 adds: the passthrough tenant-safe
-- whatsapp_account_id column, its cross-account isolation, that the
-- existing empty/exhausted/reclaim contract is unchanged, and grants. Never
-- run this fixture against a real clinic database.
--
-- Single-session limit: proves the documented result/state contract inside
-- one PostgreSQL session; true two-connection lock contention is reviewed
-- from PostgreSQL's `FOR UPDATE ... SKIP LOCKED` semantics (unchanged from
-- V1) rather than exercised directly here.

begin;

insert into public.clinics (id, name)
values ('40000000-0000-0000-0000-000000000001', 'Credential Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '940000001');

insert into public.clinics (id, name)
values ('40000000-0000-0000-0000-000000000003', 'Credential Test Clinic B');

-- Task 041: clinics default to suspended; activate this fixture's clinics so
-- the existing AI/ingest/outbound assertions below stay unchanged.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003', '940000002');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode) values
  ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '+15550091111', 'ai'),
  ('40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000003', '+15550092222', 'ai'),
  ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '+15550093333', 'ai'),
  ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '+15550094444', 'ai');

-- Local helper: ingest one inbound text message, claim its intake job, and
-- finalize it with a fixed-copy reply so exactly one outbound_message_outbox
-- row exists for it. Mirrors the current claim/finalize signatures reviewed
-- in supabase/migrations/20260829000200_inbound_message_bursts.sql and
-- 20260827000100_second_pet_registration_atomicity.sql; redefined here
-- because pg_temp functions do not survive across fixture files/sessions.
create function pg_temp.make_outbox_row(
  p_phone_number_id text,
  p_provider_message_id text,
  p_payload_hash_char text,
  p_sender_e164 text,
  p_owner_name text,
  p_reply_category text,
  p_reply_text text
) returns uuid
language plpgsql
as $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_finalize_result text;
  v_outbox_id uuid;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => p_phone_number_id,
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat(p_payload_hash_char, 64),
    p_sender_e164 => p_sender_e164,
    p_owner_name => p_owner_name,
    p_message_text => 'Fixture message for ' || p_provider_message_id,
    p_provider_timestamp => pg_catalog.now()
  );

  select conversation_id into v_conversation_id
  from public.messages
  where whatsapp_message_id = p_provider_message_id;

  select claimed.result, claimed.claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, p_provider_message_id) claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'make_outbox_row: expected claimed for %, got %', p_provider_message_id, v_claim_result;
  end if;

  select f.result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, p_provider_message_id, v_token, 1, 'complaint_collection', null,
    '{"note": "fixture"}'::jsonb, p_reply_category, p_reply_text
  ) f;
  if v_finalize_result <> 'applied' then
    raise exception 'make_outbox_row: expected applied for %, got %', p_provider_message_id, v_finalize_result;
  end if;

  select id into v_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  if v_outbox_id is null then
    raise exception 'make_outbox_row: no outbox row produced for %', p_provider_message_id;
  end if;

  return v_outbox_id;
end;
$$;

-- =========================================================================
-- Fixture 1: V2 returns the exact tenant-bound whatsapp_account_id and
-- phone_number_id from the same composite join as the outbox row itself,
-- for both clinics, and never conflates the two accounts -- regardless of
-- which of the two due rows the scheduler happens to claim first.
-- =========================================================================
do $$
declare
  v_outbox_a uuid;
  v_outbox_b uuid;
  v_claim1 record;
  v_claim2 record;
begin
  v_outbox_a := pg_temp.make_outbox_row(
    '940000001', 'wamid.040-C1A', 'a', '+15550091111', '040 Credential Owner A', 'intake_received', 'Clinic A receipt.'
  );
  v_outbox_b := pg_temp.make_outbox_row(
    '940000002', 'wamid.040-C1B', 'b', '+15550092222', '040 Credential Owner B', 'intake_received', 'Clinic B receipt.'
  );

  select * into v_claim1 from public.claim_outbound_message_v2();
  select * into v_claim2 from public.claim_outbound_message_v2();

  if v_claim1.result <> 'claimed' or v_claim2.result <> 'claimed' then
    raise exception 'expected both due rows to be claimed, got %/%', v_claim1.result, v_claim2.result;
  end if;
  if v_claim1.outbox_id = v_claim2.outbox_id then
    raise exception 'expected two distinct rows to be claimed';
  end if;
  if v_claim1.outbox_id not in (v_outbox_a, v_outbox_b) or v_claim2.outbox_id not in (v_outbox_a, v_outbox_b) then
    raise exception 'expected exactly the two freshly created rows to be claimed';
  end if;

  if v_claim1.whatsapp_account_id <> (select whatsapp_account_id from public.outbound_message_outbox where id = v_claim1.outbox_id)
    or v_claim2.whatsapp_account_id <> (select whatsapp_account_id from public.outbound_message_outbox where id = v_claim2.outbox_id)
  then
    raise exception 'expected the returned account id to always match the claimed row''s own account';
  end if;
  if v_claim1.whatsapp_account_id = v_claim2.whatsapp_account_id then
    raise exception 'expected the two distinct clinics'' accounts never to be conflated';
  end if;
  if v_claim1.phone_number_id = v_claim2.phone_number_id then
    raise exception 'expected the two distinct clinics'' phone number ids never to be conflated';
  end if;

  if v_claim1.outbox_id = v_outbox_a then
    if v_claim1.whatsapp_account_id <> '40000000-0000-0000-0000-000000000002' or v_claim1.phone_number_id <> '940000001' then
      raise exception 'expected clinic A''s claim to report clinic A''s exact account/phone id, got %', to_json(v_claim1);
    end if;
    if v_claim2.whatsapp_account_id <> '40000000-0000-0000-0000-000000000004' or v_claim2.phone_number_id <> '940000002' then
      raise exception 'expected clinic B''s claim to report clinic B''s exact account/phone id, got %', to_json(v_claim2);
    end if;
  else
    if v_claim1.whatsapp_account_id <> '40000000-0000-0000-0000-000000000004' or v_claim1.phone_number_id <> '940000002' then
      raise exception 'expected clinic B''s claim to report clinic B''s exact account/phone id, got %', to_json(v_claim1);
    end if;
    if v_claim2.whatsapp_account_id <> '40000000-0000-0000-0000-000000000002' or v_claim2.phone_number_id <> '940000001' then
      raise exception 'expected clinic A''s claim to report clinic A''s exact account/phone id, got %', to_json(v_claim2);
    end if;
  end if;

  delete from public.outbound_message_outbox where id in (v_outbox_a, v_outbox_b);
end;
$$;

-- =========================================================================
-- Fixture 2: empty and reclaim/attempt-increment behavior is unchanged from
-- V1, now via V2, with every nullable field null on empty and the account id
-- surviving a reclaim.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_claim record;
  v_first_token uuid;
begin
  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'empty'
    or v_claim.outbox_id is not null
    or v_claim.claim_token is not null
    or v_claim.whatsapp_account_id is not null
    or v_claim.phone_number_id is not null
    or v_claim.recipient_e164 is not null
    or v_claim.content is not null
    or v_claim.attempt_count is not null
  then
    raise exception 'expected an all-null empty result with no due rows, got %', to_json(v_claim);
  end if;

  v_outbox_id := pg_temp.make_outbox_row(
    '940000001', 'wamid.040-C2', 'c', '+15550093333', '040 Credential Owner C', 'complaint', 'Sikayetiniz icin tesekkurler.'
  );

  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'claimed' or v_claim.attempt_count <> 1 then
    raise exception 'expected claimed at attempt 1, got %', to_json(v_claim);
  end if;
  v_first_token := v_claim.claim_token;

  -- Simulate a crashed worker: expire the lease without exhausting attempts.
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;

  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'claimed' or v_claim.outbox_id <> v_outbox_id or v_claim.attempt_count <> 2 then
    raise exception 'expected reclaim at attempt 2, got %', to_json(v_claim);
  end if;
  if v_claim.claim_token = v_first_token then
    raise exception 'expected the reclaim to mint a different token than the first claim';
  end if;
  if v_claim.whatsapp_account_id <> '40000000-0000-0000-0000-000000000002' then
    raise exception 'expected the reclaimed row to still report its own account id';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: attempt exhaustion terminates with an all-null result, exactly
-- as V1, and the row never resurfaces to a later claim.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_claim record;
begin
  select id into v_outbox_id from public.outbound_message_outbox where source_provider_message_id = 'wamid.040-C2';

  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;
  perform public.claim_outbound_message_v2();
  if (select delivery_attempt_count from public.outbound_message_outbox where id = v_outbox_id) <> 3 then
    raise exception 'expected attempt 3 before the exhaustion probe, got %',
      (select delivery_attempt_count from public.outbound_message_outbox where id = v_outbox_id);
  end if;
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;

  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'exhausted'
    or v_claim.outbox_id is not null
    or v_claim.claim_token is not null
    or v_claim.whatsapp_account_id is not null
    or v_claim.phone_number_id is not null
    or v_claim.recipient_e164 is not null
    or v_claim.content is not null
    or v_claim.attempt_count is not null
  then
    raise exception 'expected an all-null exhausted result, got %', to_json(v_claim);
  end if;

  if (select delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'failed' then
    raise exception 'expected the row to be terminally failed after exhaustion';
  end if;
  if (select count(*) from public.claim_outbound_message_v2() where result = 'claimed' and outbox_id = v_outbox_id) <> 0 then
    raise exception 'a terminally failed row must never be claimed again';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: anon/authenticated cannot call V2; service_role can, and V1
-- remains callable unchanged for the previously deployed Worker's rollback.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '940000001', 'wamid.040-C3', 'd', '+15550094444', '040 Credential Owner D', 'pet_identity', 'Hangi evcil hayvanınız icin yaziyorsunuz?'
  );

  set local role anon;
  begin
    perform result from public.claim_outbound_message_v2();
    raise exception 'expected anon to be denied claim_outbound_message_v2';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role authenticated;
  begin
    perform result from public.claim_outbound_message_v2();
    raise exception 'expected authenticated to be denied claim_outbound_message_v2';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role service_role;
  if not exists (select 1 from public.claim_outbound_message_v2() where result = 'claimed' and outbox_id = v_outbox_id) then
    raise exception 'expected service_role to successfully claim through V2';
  end if;
  if not exists (select 1 from public.claim_outbound_message() where result in ('empty', 'exhausted')) then
    raise exception 'expected V1 claim_outbound_message to remain callable and coherent alongside V2';
  end if;
  reset role;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000004')) as remaining_test_accounts,
  (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id in ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000004')) as remaining_test_routes,
  (select count(*) from public.outbound_message_outbox where clinic_id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003')) as remaining_test_outbox_rows,
  (select count(*) from public.messages where clinic_id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003')) as remaining_test_messages,
  (select count(*) from public.conversations where clinic_id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003')) as remaining_test_conversations,
  (select count(*) from public.owners where clinic_id in ('40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003')) as remaining_test_owners;
