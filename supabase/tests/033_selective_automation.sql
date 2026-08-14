-- Rollback-only proof for Task 033 (selective WhatsApp automation): the
-- account default/contact override columns, resolve_whatsapp_contact_automation,
-- set_whatsapp_contact_route, and the new ignored/manual/suppressed results on
-- ingest_whatsapp_text_message, claim_intake_queue_job, and
-- finalize_intake_queue_job/finalize_appointment_offer_queue_job/
-- finalize_appointment_decision_queue_job. Never run
-- this fixture script against a real clinic database. Codex ran it on
-- disposable `vetai-test` on 2026-08-14: PASS with zero fixture residue.

begin;

insert into public.clinics (id, name)
values ('33000000-0000-0000-0000-000000000001', 'Selective Automation Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, automation_default)
values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '933000001', 'ai');

insert into public.clinics (id, name)
values ('33000000-0000-0000-0000-000000000003', 'Selective Automation Test Clinic B');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, automation_default)
values ('33000000-0000-0000-0000-000000000004', '33000000-0000-0000-0000-000000000003', '933000002', 'manual');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('33100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sel-a@example.invalid', now(), now()),
  ('33100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'sel-b@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('33000000-0000-0000-0000-000000000001', '33100000-0000-0000-0000-000000000001', 'admin'),
  ('33000000-0000-0000-0000-000000000003', '33100000-0000-0000-0000-000000000002', 'admin');

-- =========================================================================
-- Fixture 1: resolve_whatsapp_contact_automation. Unknown account, each
-- account's own default with no override, an override that beats the
-- account default, and service_role-only access.
-- =========================================================================
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.resolve_whatsapp_contact_automation('does-not-exist', '+15550101010');
  if v_result <> 'unknown_account' then
    raise exception 'expected unknown_account for an unknown phone_number_id, got %', v_result;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('933000001', '+15550101010');
  if v_result <> 'ai' then
    raise exception 'expected account A default ai with no override, got %', v_result;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('933000002', '+15550202020');
  if v_result <> 'manual' then
    raise exception 'expected account B default manual with no override, got %', v_result;
  end if;

  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15550101010', 'personal');

  select result into v_result
  from public.resolve_whatsapp_contact_automation('933000001', '+15550101010');
  if v_result <> 'personal' then
    raise exception 'expected a per-contact override to beat the account default, got %', v_result;
  end if;

  delete from public.whatsapp_contact_routes
    where whatsapp_account_id = '33000000-0000-0000-0000-000000000002' and contact_e164 = '+15550101010';
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform result from public.resolve_whatsapp_contact_automation('933000001', '+15550101010');
    raise exception 'authenticated role unexpectedly executed resolve_whatsapp_contact_automation';
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
    perform result from public.resolve_whatsapp_contact_automation('933000001', '+15550101010');
    raise exception 'anon role unexpectedly executed resolve_whatsapp_contact_automation';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 2: set_whatsapp_contact_route as authenticated staff. updated,
-- unchanged, inherit-delete, cross-tenant/unknown not_found, invalid input,
-- and anon denial.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '33100000-0000-0000-0000-000000000001', true);

do $$
declare
  v_result text;
  v_mode text;
  v_row_count integer;
begin
  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'manual');
  if v_result <> 'updated' then
    raise exception 'expected updated for a brand-new override, got %', v_result;
  end if;

  select mode into v_mode
  from public.whatsapp_contact_routes
  where whatsapp_account_id = '33000000-0000-0000-0000-000000000002' and contact_e164 = '+15550303030';
  if v_mode <> 'manual' then
    raise exception 'expected the stored route mode to be manual, got %', v_mode;
  end if;

  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'manual');
  if v_result <> 'unchanged' then
    raise exception 'expected unchanged for a repeat of the same mode, got %', v_result;
  end if;

  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'inherit');
  if v_result <> 'updated' then
    raise exception 'expected updated when inherit deletes an existing override, got %', v_result;
  end if;

  select count(*) into v_row_count
  from public.whatsapp_contact_routes
  where whatsapp_account_id = '33000000-0000-0000-0000-000000000002' and contact_e164 = '+15550303030';
  if v_row_count <> 0 then
    raise exception 'expected inherit to leave no override row, found %', v_row_count;
  end if;

  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'inherit');
  if v_result <> 'unchanged' then
    raise exception 'expected unchanged when inherit has nothing to delete, got %', v_result;
  end if;

  select result into v_result
  from public.set_whatsapp_contact_route('00000000-0000-0000-0000-000000000099', '+15550303030', 'manual');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown whatsapp_account_id, got %', v_result;
  end if;

  begin
    perform result from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'bogus');
    raise exception 'set_whatsapp_contact_route unexpectedly accepted an invalid mode';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'set_whatsapp_contact_route: invalid mode' then raise; end if;
  end;

  begin
    perform result from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '5550303030', 'manual');
    raise exception 'set_whatsapp_contact_route unexpectedly accepted a non-E.164 contact';
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'set_whatsapp_contact_route: invalid contact_e164' then raise; end if;
  end;
end;
$$;

-- Cross-tenant: clinic B's staff member targeting clinic A's account.
select set_config('request.jwt.claim.sub', '33100000-0000-0000-0000-000000000002', true);
do $$
declare
  v_result text;
  v_row_count integer;
begin
  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550404040', 'manual');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a staff member outside the target clinic, got %', v_result;
  end if;

  select count(*) into v_row_count
  from public.whatsapp_contact_routes
  where whatsapp_account_id = '33000000-0000-0000-0000-000000000002' and contact_e164 = '+15550404040';
  if v_row_count <> 0 then
    raise exception 'expected the denied cross-tenant attempt to create no row, found %', v_row_count;
  end if;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform result from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550303030', 'manual');
    raise exception 'anon role unexpectedly executed set_whatsapp_contact_route';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 3: switching a contact to manual/personal removes only its own
-- still-pending outbound replies; a claimed (processing) reply survives.
-- =========================================================================
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_finalize_result text;
  v_older_outbox_id uuid;
  v_newer_outbox_id uuid;
  v_expected_version integer;
  v_claim record;
begin
  -- Older reply, claimed immediately below so it is 'processing' (not
  -- 'pending') by the time the route changes.
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_OUTBOX_OLDER',
    p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15550505050',
    p_owner_name => 'Selective Outbox Owner',
    p_message_text => 'Older message',
    p_provider_timestamp => now() - interval '1 minute'
  );
  select conversation_id into v_conversation_id
  from public.messages where whatsapp_message_id = 'wamid.SEL_OUTBOX_OLDER';
  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_OUTBOX_OLDER');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for the older fixture message, got %', v_claim_result;
  end if;
  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.SEL_OUTBOX_OLDER', v_token, 1, 'complaint_collection', null,
    '{"note": "older"}'::jsonb, 'intake_received', 'Bilgileri aldik.'
  );
  if v_finalize_result <> 'applied' then
    raise exception 'expected applied for the older fixture message, got %', v_finalize_result;
  end if;

  select outbox_id into v_older_outbox_id from public.claim_outbound_message();
  if v_older_outbox_id is null then
    raise exception 'expected claim_outbound_message to claim the older pending reply';
  end if;

  -- Newer reply for the same owner/account stays pending.
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_OUTBOX_NEWER',
    p_payload_hash => repeat('2', 64),
    p_sender_e164 => '+15550505050',
    p_owner_name => 'Selective Outbox Owner',
    p_message_text => 'Newer message',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id
  from public.messages where whatsapp_message_id = 'wamid.SEL_OUTBOX_NEWER';
  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_OUTBOX_NEWER');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for the newer fixture message, got %', v_claim_result;
  end if;
  select state_version into v_expected_version
  from public.conversations where id = v_conversation_id;
  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.SEL_OUTBOX_NEWER', v_token, v_expected_version, 'complaint_collection', null,
    '{"note": "newer"}'::jsonb, 'intake_received', 'Tekrar bilgi aldik.'
  );
  if v_finalize_result <> 'applied' then
    raise exception 'expected applied for the newer fixture message, got %', v_finalize_result;
  end if;

  select id into v_newer_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = 'wamid.SEL_OUTBOX_NEWER';
  if (select delivery_status from public.outbound_message_outbox where id = v_newer_outbox_id) <> 'pending' then
    raise exception 'expected the newer reply to still be pending before the route change';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '33100000-0000-0000-0000-000000000001', true);
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.set_whatsapp_contact_route('33000000-0000-0000-0000-000000000002', '+15550505050', 'manual');
  if v_result <> 'updated' then
    raise exception 'expected updated when switching the outbox-fixture contact to manual, got %', v_result;
  end if;
end;
$$;
reset role;

do $$
declare
  v_pending_remaining integer;
  v_processing_status text;
begin
  select count(*) into v_pending_remaining
  from public.outbound_message_outbox
  where source_provider_message_id = 'wamid.SEL_OUTBOX_NEWER';
  if v_pending_remaining <> 0 then
    raise exception 'expected the still-pending reply to be removed after the route change, found %', v_pending_remaining;
  end if;

  select delivery_status into v_processing_status
  from public.outbound_message_outbox
  where source_provider_message_id = 'wamid.SEL_OUTBOX_OLDER';
  if v_processing_status <> 'processing' then
    raise exception 'expected the already-claimed reply to survive the route change, got %', v_processing_status;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: ingest_whatsapp_text_message honors a personal/manual override
-- ahead of the account default, and an unchanged default keeps processing.
-- =========================================================================
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_status text;
  v_completed_at timestamptz;
  v_processing_status text;
  v_claim_result text;
begin
  -- Account A defaults to ai; override this contact to personal.
  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15550606060', 'personal');

  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_PERSONAL',
    p_payload_hash => repeat('3', 64),
    p_sender_e164 => '+15550606060',
    p_owner_name => 'Personal Route Owner',
    p_message_text => 'Should never be stored',
    p_provider_timestamp => now()
  );
  if v_result <> 'ignored' or v_conversation_id is not null then
    raise exception 'expected ignored/null conversation_id for a personal route, got %/%', v_result, v_conversation_id;
  end if;
  if exists (select 1 from public.owners where clinic_id = '33000000-0000-0000-0000-000000000001' and phone_e164 = '+15550606060') then
    raise exception 'expected a personal route to leave no owner row';
  end if;
  if exists (select 1 from public.messages where whatsapp_message_id = 'wamid.SEL_PERSONAL') then
    raise exception 'expected a personal route to leave no message row';
  end if;
  if exists (select 1 from public.webhook_events where clinic_id = '33000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.SEL_PERSONAL') then
    raise exception 'expected a personal route to leave no webhook_events row';
  end if;

  -- Same account, a different contact overridden to manual: persisted, but
  -- the lease is opened and terminally completed in one step.
  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15550707070', 'manual');

  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_MANUAL',
    p_payload_hash => repeat('4', 64),
    p_sender_e164 => '+15550707070',
    p_owner_name => 'Manual Route Owner',
    p_message_text => 'A human will read this',
    p_provider_timestamp => now()
  );
  if v_result <> 'manual' or v_conversation_id is null then
    raise exception 'expected manual/non-null conversation_id for a manual route, got %/%', v_result, v_conversation_id;
  end if;

  select intake_status, intake_completed_at, processing_status
    into v_status, v_completed_at, v_processing_status
  from public.webhook_events
  where clinic_id = '33000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.SEL_MANUAL';
  if v_status <> 'completed' or v_completed_at is null or v_processing_status <> 'processed' then
    raise exception 'expected a manual-route event to be persisted already completed, got %/%/%', v_status, v_completed_at, v_processing_status;
  end if;

  -- A terminally completed event can never be claimed.
  select result into v_claim_result
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_MANUAL');
  if v_claim_result <> 'completed' then
    raise exception 'expected a manual-route event to be unclaimable, got %', v_claim_result;
  end if;

  -- A duplicate delivered after an AI-to-manual flip must also remain a
  -- terminal manual outcome, never a fresh Queue-enqueue signal.
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_MANUAL',
    p_payload_hash => repeat('4', 64),
    p_sender_e164 => '+15550707070',
    p_owner_name => 'Manual Route Owner',
    p_message_text => 'A human will read this',
    p_provider_timestamp => now()
  );
  if v_result <> 'manual' or v_conversation_id is null then
    raise exception 'expected a duplicate under the current manual route to remain manual, got %/%', v_result, v_conversation_id;
  end if;

  -- Unmodified default (ai, no override) still processes normally.
  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_DEFAULT_AI',
    p_payload_hash => repeat('5', 64),
    p_sender_e164 => '+15550808080',
    p_owner_name => 'Default Ai Owner',
    p_message_text => 'Normal ai-routed message',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' or v_conversation_id is null then
    raise exception 'expected the unmodified ai default to still process normally, got %/%', v_result, v_conversation_id;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 5: claim_intake_queue_job reports the resolved automation_mode,
-- and finalize_intake_queue_job / finalize_appointment_offer_queue_job
-- suppress a stale claim when the route flips to manual mid-flight.
-- =========================================================================
do $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_message_text text;
  v_automation_mode text;
  v_finalize_result text;
  v_stage text;
  v_version integer;
  v_status text;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_CLAIM_AI',
    p_payload_hash => repeat('6', 64),
    p_sender_e164 => '+15550909090',
    p_owner_name => 'Claim Mode Owner',
    p_message_text => 'ai-routed at claim time',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id
  from public.messages where whatsapp_message_id = 'wamid.SEL_CLAIM_AI';

  select result, claim_token, message_text, automation_mode
    into v_claim_result, v_token, v_message_text, v_automation_mode
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_CLAIM_AI');
  if v_claim_result <> 'claimed' or v_automation_mode <> 'ai' or v_message_text is null then
    raise exception 'expected claimed/ai with message_text for an unmodified default, got %/%/%', v_claim_result, v_automation_mode, v_message_text;
  end if;

  -- Race window (b): the route flips to manual after the claim above but
  -- before finalize below.
  update public.whatsapp_contact_routes
  set mode = 'manual'
  where whatsapp_account_id = '33000000-0000-0000-0000-000000000002' and contact_e164 = '+15550909090';
  if not found then
    insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
    values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15550909090', 'manual');
  end if;

  select result, intake_stage, state_version into v_finalize_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.SEL_CLAIM_AI', v_token, 1, 'complaint_collection', null, '{"note": "suppressed"}'::jsonb
  );
  if v_finalize_result <> 'suppressed' or v_stage is not null or v_version is not null then
    raise exception 'expected suppressed with null stage/version after a mid-flight route flip, got %/%/%', v_finalize_result, v_stage, v_version;
  end if;

  select we.intake_status into v_status
  from public.webhook_events we
  where we.clinic_id = '33000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.SEL_CLAIM_AI';
  if v_status <> 'completed' then
    raise exception 'expected a suppressed finalize to still complete the lease, got %', v_status;
  end if;
  if (select state_version from public.conversations where id = v_conversation_id) <> 1 then
    raise exception 'expected a suppressed finalize to leave conversation state untouched';
  end if;

  -- A repeat finalize against the now-completed lease is already_completed,
  -- not a second suppressed result.
  select result, intake_stage, state_version into v_finalize_result, v_stage, v_version
  from public.finalize_intake_queue_job(
    v_conversation_id, 'wamid.SEL_CLAIM_AI', v_token, 1, 'complaint_collection', null, '{"note": "replay"}'::jsonb
  );
  if v_finalize_result <> 'already_completed' or v_stage is not null or v_version is not null then
    raise exception 'expected already_completed with null stage/version on replay, got %/%/%', v_finalize_result, v_stage, v_version;
  end if;
end;
$$;

-- Same mid-flight flip, proved once more against
-- finalize_appointment_offer_queue_job to confirm the shared
-- lock_owner_and_resolve_automation recheck applies uniformly.
do $$
declare
  v_conversation_id uuid;
  v_pet_id uuid;
  v_owner_id uuid;
  v_claim_result text;
  v_token uuid;
  v_offer_result text;
  v_stage text;
  v_version integer;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_OFFER_AI',
    p_payload_hash => repeat('7', 64),
    p_sender_e164 => '+15551010101',
    p_owner_name => 'Offer Mode Owner',
    p_message_text => 'appointment please',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id
  from public.messages where whatsapp_message_id = 'wamid.SEL_OFFER_AI';
  select owner_id into v_owner_id from public.conversations where id = v_conversation_id;

  insert into public.pets (id, clinic_id, owner_id, name, species, created_at)
  values ('33200000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000001', v_owner_id, 'Offer Pet', 'cat', now())
  returning id into v_pet_id;

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_OFFER_AI');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for the offer-fixture message, got %', v_claim_result;
  end if;

  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15551010101', 'manual');

  select result, intake_stage, state_version into v_offer_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conversation_id, 'wamid.SEL_OFFER_AI', v_token, 1, 'ready_for_triage', v_pet_id, '{"note": "offer suppressed"}'::jsonb
  );
  if v_offer_result <> 'suppressed' or v_stage is not null or v_version is not null then
    raise exception 'expected suppressed with null stage/version from finalize_appointment_offer_queue_job, got %/%/%', v_offer_result, v_stage, v_version;
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '33000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.SEL_OFFER_AI') <> 'completed' then
    raise exception 'expected the offer finalizer to complete the lease on suppression';
  end if;
end;
$$;

-- The appointment-decision finalizer must use the same suppression gate.
-- Suppression happens before any slot lookup, but still completes the lease.
do $$
declare
  v_conversation_id uuid;
  v_pet_id uuid;
  v_owner_id uuid;
  v_claim_result text;
  v_token uuid;
  v_decision_result text;
  v_stage text;
  v_version integer;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '933000001',
    p_provider_message_id => 'wamid.SEL_DECISION_AI',
    p_payload_hash => repeat('8', 64),
    p_sender_e164 => '+15551111111',
    p_owner_name => 'Decision Mode Owner',
    p_message_text => 'EVET',
    p_provider_timestamp => now()
  );
  select conversation_id into v_conversation_id
  from public.messages where whatsapp_message_id = 'wamid.SEL_DECISION_AI';
  select owner_id into v_owner_id from public.conversations where id = v_conversation_id;

  insert into public.pets (id, clinic_id, owner_id, name, species, created_at)
  values ('33200000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', v_owner_id, 'Decision Pet', 'dog', now())
  returning id into v_pet_id;

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, 'wamid.SEL_DECISION_AI');
  if v_claim_result <> 'claimed' then
    raise exception 'expected claimed for the decision-fixture message, got %', v_claim_result;
  end if;

  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000001', '+15551111111', 'personal');

  select result, intake_stage, state_version into v_decision_result, v_stage, v_version
  from public.finalize_appointment_decision_queue_job(
    v_conversation_id, 'wamid.SEL_DECISION_AI', v_token, 1, 'confirm', v_pet_id, '{"note": "decision suppressed"}'::jsonb
  );
  if v_decision_result <> 'suppressed' or v_stage is not null or v_version is not null then
    raise exception 'expected suppressed with null stage/version from finalize_appointment_decision_queue_job, got %/%/%', v_decision_result, v_stage, v_version;
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '33000000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.SEL_DECISION_AI') <> 'completed' then
    raise exception 'expected the decision finalizer to complete the lease on suppression';
  end if;
  if exists (select 1 from public.outbound_message_outbox where source_provider_message_id = 'wamid.SEL_DECISION_AI') then
    raise exception 'expected the suppressed decision finalizer to create no outbox row';
  end if;
end;
$$;

-- The account row lock is the serialization point between an ingest write
-- and a staff route flip. A single-transaction fixture cannot prove blocking,
-- but this guard prevents the lock from being silently removed.
do $$
begin
  if pg_catalog.pg_get_functiondef(
    'public.ingest_whatsapp_text_message(text,text,text,text,text,text,timestamptz)'::regprocedure
  ) !~* 'where wa\.phone_number_id = p_phone_number_id[[:space:]]+for key share' then
    raise exception 'ingest_whatsapp_text_message is missing the account-row serialization lock';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004')) as remaining_test_whatsapp_accounts,
  (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id in ('33000000-0000-0000-0000-000000000002', '33000000-0000-0000-0000-000000000004')) as remaining_test_routes,
  (select count(*) from public.owners where clinic_id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_owners,
  (select count(*) from public.conversations where clinic_id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_webhook_events,
  (select count(*) from public.outbound_message_outbox where clinic_id in ('33000000-0000-0000-0000-000000000001', '33000000-0000-0000-0000-000000000003')) as remaining_test_outbox_rows;
