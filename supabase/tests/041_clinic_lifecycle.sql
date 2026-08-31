-- Task 041: rollback-only proof for clinic lifecycle provisioning and
-- offboarding. Not run against any database by the implementer.

begin;

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('41000000-0000-0000-0000-000000000101', 'authenticated', 'authenticated', 'owner-041a@example.invalid', now(), now()),
  ('41000000-0000-0000-0000-000000000102', 'authenticated', 'authenticated', 'staff-041b@example.invalid', now(), now());

-- Local helper: drives one inbound message through the real
-- ingest -> claim_intake_queue_job -> finalize_intake_queue_job pipeline,
-- exactly like supabase/tests/019_outbound_status_tracking.sql, so every
-- outbox row this fixture uses satisfies the real FK/shape constraints
-- (conversation_id, source_provider_message_id, reply_category, the
-- per-status delivery_state_check) instead of a hand-rolled insert.
--
-- Since Task 034, whatsapp_accounts.automation_default is hard-locked to
-- 'personal', so an account with no explicit route now resolves 'personal'
-- and ingest returns 'ignored' before writing anything. This helper
-- provisions an explicit 'ai' route for the exact (account, contact) pair
-- first so the pipeline actually runs, mirroring what a real pilot clinic's
-- reviewed route configuration would do.
create function pg_temp.make_pending_outbox_row(
  p_clinic_id uuid,
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
  v_account_id uuid;
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_finalize_result text;
  v_outbox_id uuid;
begin
  select wa.id into v_account_id
  from public.whatsapp_accounts wa
  where wa.phone_number_id = p_phone_number_id;

  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values (v_account_id, p_clinic_id, p_sender_e164, 'ai')
  on conflict (whatsapp_account_id, contact_e164) do nothing;

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => p_phone_number_id,
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat(p_payload_hash_char, 64),
    p_sender_e164 => p_sender_e164,
    p_owner_name => p_owner_name,
    p_message_text => 'Fixture message for ' || p_provider_message_id,
    p_provider_timestamp => now()
  );

  select conversation_id into v_conversation_id
  from public.messages
  where whatsapp_message_id = p_provider_message_id;

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, p_provider_message_id);
  if v_claim_result <> 'claimed' then
    raise exception 'make_pending_outbox_row: expected claimed for %, got %', p_provider_message_id, v_claim_result;
  end if;

  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, p_provider_message_id, v_token, 1, 'complaint_collection', null,
    '{"note": "fixture"}'::jsonb, p_reply_category, p_reply_text
  );
  if v_finalize_result <> 'applied' then
    raise exception 'make_pending_outbox_row: expected applied for %, got %', p_provider_message_id, v_finalize_result;
  end if;

  select id into v_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  if v_outbox_id is null then
    raise exception 'make_pending_outbox_row: no outbox row produced for %', p_provider_message_id;
  end if;

  return v_outbox_id;
end;
$$;

-- Local helper: pending row driven one V1 claim further, into 'processing'.
create function pg_temp.make_processing_outbox_row(
  p_clinic_id uuid,
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
  v_outbox_id uuid;
  v_claim_token uuid;
begin
  v_outbox_id := pg_temp.make_pending_outbox_row(
    p_clinic_id, p_phone_number_id, p_provider_message_id, p_payload_hash_char, p_sender_e164, p_owner_name, p_reply_category, p_reply_text
  );

  v_claim_token := pg_catalog.gen_random_uuid();
  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = v_claim_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = 1,
        next_attempt_at = null
    where id = v_outbox_id;
  if not found then
    raise exception 'make_processing_outbox_row: target disappeared for %', p_provider_message_id;
  end if;

  return v_outbox_id;
end;
$$;

-- Local helper: pending row driven all the way to 'accepted', exactly like
-- a live Task 018 send would.
create function pg_temp.make_accepted_outbox_row(
  p_clinic_id uuid,
  p_phone_number_id text,
  p_inbound_provider_message_id text,
  p_outbound_provider_message_id text,
  p_payload_hash_char text,
  p_sender_e164 text,
  p_owner_name text,
  p_reply_category text,
  p_reply_text text
) returns uuid
language plpgsql
as $$
declare
  v_outbox_id uuid;
  v_claim_token uuid;
  v_accept record;
begin
  v_outbox_id := pg_temp.make_pending_outbox_row(
    p_clinic_id, p_phone_number_id, p_inbound_provider_message_id, p_payload_hash_char, p_sender_e164, p_owner_name, p_reply_category, p_reply_text
  );

  v_claim_token := pg_catalog.gen_random_uuid();
  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = v_claim_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = 1,
        next_attempt_at = null
    where id = v_outbox_id;
  if not found then
    raise exception 'make_accepted_outbox_row: target disappeared for %', p_inbound_provider_message_id;
  end if;

  select * into v_accept from public.accept_outbound_message(v_outbox_id, v_claim_token, p_outbound_provider_message_id);
  if v_accept.result <> 'accepted' then
    raise exception 'make_accepted_outbox_row: expected accepted for %, got %', p_outbound_provider_message_id, v_accept.result;
  end if;

  return v_outbox_id;
end;
$$;

-- =========================================================================
-- Setup: a control clinic that must survive every destructive operation on
-- the other clinics below completely untouched.
-- =========================================================================

insert into public.clinics (id, name)
values ('41000000-0000-0000-0000-000000000008', 'Control Clinic');

update public.clinics set operational_status = 'active', suspended_at = null
where id = '41000000-0000-0000-0000-000000000008';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name)
values ('41000000-0000-0000-0000-000000000009', '41000000-0000-0000-0000-000000000008', '4100000009', 'Control Account');

do $$
begin
  perform pg_temp.make_pending_outbox_row(
    '41000000-0000-0000-0000-000000000008', '4100000009', 'wamid.041-ctrl-1', 'a', '+15550000901', '041 Control Owner', 'intake_received', 'Control clinic receipt.'
  );
end;
$$;

do $$
declare
  v_volatility "char";
  v_definition text;
begin
  select p.provolatile, pg_get_functiondef(p.oid)
    into v_volatility, v_definition
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'vetai_private'
    and p.proname = 'effective_contact_automation_mode'
    and pg_get_function_identity_arguments(p.oid) = 'p_whatsapp_account_id uuid, p_contact_e164 text';

  if v_volatility <> 'v' or v_definition !~* 'for key share of cl' then
    raise exception 'effective_contact_automation_mode must hold the clinic lifecycle lock';
  end if;
end;
$$;

-- =========================================================================
-- 1. New clinics default to suspended (table default); the migration's
--    backfill statement is the same shape as this literal transition --
--    proven directly here on a row inserted the same "old" way pre-041
--    fixtures already insert clinics.
-- =========================================================================

insert into public.clinics (id, name)
values ('41000000-0000-0000-0000-000000000003', 'Backfill Demo Clinic');

do $$
begin
  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000003') <> 'suspended' then
    raise exception 'expected a bare clinic insert to default to suspended';
  end if;
end;
$$;

update public.clinics
  set operational_status = 'active', suspended_at = null
  where id = '41000000-0000-0000-0000-000000000003'
    and operational_status = 'suspended';

do $$
begin
  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000003') <> 'active' then
    raise exception 'expected the backfill-shaped update to activate the clinic';
  end if;
end;
$$;

-- =========================================================================
-- 2. provision_clinic_v1: happy path starts suspended with no AI route or
--    business data; exact replay is idempotent; a changed field on the
--    same clinic_id rolls back the whole attempt; a missing Auth user
--    rolls back the whole attempt too.
-- =========================================================================

do $$
declare
  v_result text;
  v_rejected boolean;
begin
  select result into v_result
  from public.provision_clinic_v1(
    '41000000-0000-0000-0000-000000000001',
    'New Pilot Clinic',
    '+15550001234',
    '123 Test Street',
    '41000000-0000-0000-0000-000000000101',
    'admin',
    '41000000-0000-0000-0000-000000000002',
    '4100000001',
    'New Pilot WhatsApp'
  );

  if v_result <> 'provisioned' then
    raise exception 'expected provision_clinic_v1 happy path to return provisioned, got %', v_result;
  end if;

  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000001') <> 'suspended' then
    raise exception 'expected a freshly provisioned clinic to start suspended';
  end if;

  if (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id = '41000000-0000-0000-0000-000000000002') <> 0 then
    raise exception 'provisioning must not create any AI route';
  end if;

  if (select count(*) from public.owners where clinic_id = '41000000-0000-0000-0000-000000000001') <> 0
    or (select count(*) from public.conversations where clinic_id = '41000000-0000-0000-0000-000000000001') <> 0
    or (select count(*) from public.messages where clinic_id = '41000000-0000-0000-0000-000000000001') <> 0 then
    raise exception 'provisioning must not create any business data';
  end if;

  -- Exact replay is idempotent.
  select result into v_result
  from public.provision_clinic_v1(
    '41000000-0000-0000-0000-000000000001',
    'New Pilot Clinic',
    '+15550001234',
    '123 Test Street',
    '41000000-0000-0000-0000-000000000101',
    'admin',
    '41000000-0000-0000-0000-000000000002',
    '4100000001',
    'New Pilot WhatsApp'
  );

  if v_result <> 'already_provisioned' then
    raise exception 'expected exact replay to return already_provisioned, got %', v_result;
  end if;

  -- A changed field on the same clinic_id must raise and roll back, not merge.
  v_rejected := false;
  begin
    perform result from public.provision_clinic_v1(
      '41000000-0000-0000-0000-000000000001',
      'Renamed Pilot Clinic',
      '+15550001234',
      '123 Test Street',
      '41000000-0000-0000-0000-000000000101',
      'admin',
      '41000000-0000-0000-0000-000000000002',
      '4100000001',
      'New Pilot WhatsApp'
    );
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected a conflicting replay of provision_clinic_v1 to raise';
  end if;

  if (select name from public.clinics where id = '41000000-0000-0000-0000-000000000001') <> 'New Pilot Clinic' then
    raise exception 'a conflicting replay must not have mutated the existing clinic name';
  end if;
end;
$$;

do $$
declare
  v_rejected boolean;
begin
  -- A missing Auth user must roll back the whole attempt: no half-created
  -- clinic, staff link or WhatsApp account survives.
  v_rejected := false;
  begin
    perform result from public.provision_clinic_v1(
      '41000000-0000-0000-0000-000000000004',
      'Orphan Owner Clinic',
      null,
      null,
      '41000000-0000-0000-0000-000000000999',
      'admin',
      '41000000-0000-0000-0000-000000000005',
      '4100000005',
      null
    );
  exception when foreign_key_violation then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected provision_clinic_v1 to raise for a missing Auth user';
  end if;

  if (select count(*) from public.clinics where id = '41000000-0000-0000-0000-000000000004') <> 0 then
    raise exception 'a missing-Auth-user rejection must not leave a partial clinic row';
  end if;
  if (select count(*) from public.whatsapp_accounts where id = '41000000-0000-0000-0000-000000000005') <> 0 then
    raise exception 'a missing-Auth-user rejection must not leave a partial whatsapp_accounts row';
  end if;
end;
$$;

-- =========================================================================
-- 3. Runtime suspension boundary: a suspended clinic's inbound always
--    resolves personal with zero owner/conversation/message residue growth,
--    and suspension deletes only this tenant's own pending/processing rows
--    while preserving its own accepted row and every other clinic.
-- =========================================================================

insert into public.clinics (id, name)
values ('41000000-0000-0000-0000-000000000006', 'Suspend Demo Clinic');

update public.clinics set operational_status = 'active', suspended_at = null
where id = '41000000-0000-0000-0000-000000000006';

insert into public.clinic_staff (clinic_id, user_id, role)
values ('41000000-0000-0000-0000-000000000006', '41000000-0000-0000-0000-000000000102', 'veterinarian');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name)
values ('41000000-0000-0000-0000-000000000007', '41000000-0000-0000-0000-000000000006', '4100000007', 'Suspend Demo Account');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values ('41000000-0000-0000-0000-000000000007', '41000000-0000-0000-0000-000000000006', '+15550007001', 'ai');

do $$
declare
  v_mode text;
begin
  -- Active with an explicit route: the boundary gates on clinic status, not
  -- on the route/default machinery itself.
  v_mode := vetai_private.effective_contact_automation_mode('41000000-0000-0000-0000-000000000007', '+15550007001');
  if v_mode <> 'ai' then
    raise exception 'expected an active clinic with an explicit ai route to resolve ai, got %', v_mode;
  end if;
end;
$$;

do $$
declare
  v_pending_id uuid;
  v_processing_id uuid;
  v_accepted_id uuid;
begin
  v_pending_id := pg_temp.make_pending_outbox_row(
    '41000000-0000-0000-0000-000000000006', '4100000007', 'wamid.041-susp-pending', 'b', '+15550007101', '041 Suspend Owner Pending', 'intake_received', 'Pending receipt.'
  );
  v_processing_id := pg_temp.make_processing_outbox_row(
    '41000000-0000-0000-0000-000000000006', '4100000007', 'wamid.041-susp-processing', 'c', '+15550007102', '041 Suspend Owner Processing', 'intake_received', 'Processing receipt.'
  );
  v_accepted_id := pg_temp.make_accepted_outbox_row(
    '41000000-0000-0000-0000-000000000006', '4100000007', 'wamid.041-susp-accepted', 'wamid.041-susp-accepted-out', 'd', '+15550007103', '041 Suspend Owner Accepted', 'intake_received', 'Accepted receipt.'
  );

  perform set_config('vetai.task041.pending_id', v_pending_id::text, false);
  perform set_config('vetai.task041.processing_id', v_processing_id::text, false);
  perform set_config('vetai.task041.accepted_id', v_accepted_id::text, false);
end;
$$;

do $$
declare
  v_result text;
  v_owners_before integer;
  v_conversations_before integer;
  v_messages_before integer;
  v_ingest_result text;
begin
  select result into v_result from public.suspend_clinic_v1('41000000-0000-0000-0000-000000000006');
  if v_result <> 'suspended' then
    raise exception 'expected suspend_clinic_v1 to return suspended, got %', v_result;
  end if;

  select result into v_result from public.suspend_clinic_v1('41000000-0000-0000-0000-000000000006');
  if v_result <> 'already_suspended' then
    raise exception 'expected a second suspend to return already_suspended, got %', v_result;
  end if;

  if exists (select 1 from public.outbound_message_outbox where id = current_setting('vetai.task041.pending_id')::uuid) then
    raise exception 'expected suspension to delete the clinic''s own pending row';
  end if;
  if exists (select 1 from public.outbound_message_outbox where id = current_setting('vetai.task041.processing_id')::uuid) then
    raise exception 'expected suspension to delete the clinic''s own processing row';
  end if;
  if not exists (select 1 from public.outbound_message_outbox where id = current_setting('vetai.task041.accepted_id')::uuid) then
    raise exception 'expected suspension to preserve the clinic''s own accepted row';
  end if;
  if not exists (select 1 from public.outbound_message_outbox where whatsapp_account_id = '41000000-0000-0000-0000-000000000009' and delivery_status = 'pending') then
    raise exception 'expected suspension of one clinic to leave another clinic''s outbox untouched';
  end if;

  if vetai_private.effective_contact_automation_mode('41000000-0000-0000-0000-000000000007', '+15550007001') <> 'personal' then
    raise exception 'expected a suspended clinic to resolve personal even with an explicit ai route';
  end if;

  select count(*) into v_owners_before from public.owners where clinic_id = '41000000-0000-0000-0000-000000000006';
  select count(*) into v_conversations_before from public.conversations where clinic_id = '41000000-0000-0000-0000-000000000006';
  select count(*) into v_messages_before from public.messages where clinic_id = '41000000-0000-0000-0000-000000000006';

  select result into v_ingest_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '4100000007',
    p_provider_message_id => 'wamid.041-susp-inbound',
    p_payload_hash => repeat('9', 64),
    p_sender_e164 => '+15550007001',
    p_owner_name => 'Should Not Be Created',
    p_message_text => 'Hello from a suspended clinic',
    p_provider_timestamp => now()
  );

  if v_ingest_result <> 'ignored' then
    raise exception 'expected ingest against a suspended clinic to return ignored, got %', v_ingest_result;
  end if;

  if (select count(*) from public.owners where clinic_id = '41000000-0000-0000-0000-000000000006') <> v_owners_before
    or (select count(*) from public.conversations where clinic_id = '41000000-0000-0000-0000-000000000006') <> v_conversations_before
    or (select count(*) from public.messages where clinic_id = '41000000-0000-0000-0000-000000000006') <> v_messages_before then
    raise exception 'a suspended clinic''s inbound must add zero owner/conversation/message residue';
  end if;

  -- Status callback for the already-accepted row remains recordable while
  -- suspended.
  perform public.record_whatsapp_outbound_status(
    '4100000007', 'wamid.041-susp-accepted-out', '+15550007103', 'delivered', now()
  );
  if (select delivery_status from public.outbound_message_outbox where id = current_setting('vetai.task041.accepted_id')::uuid) <> 'accepted' then
    raise exception 'a status callback must not change delivery_status away from accepted';
  end if;
  if (select provider_delivery_status from public.outbound_message_outbox where id = current_setting('vetai.task041.accepted_id')::uuid) <> 'delivered' then
    raise exception 'expected a status callback on an accepted row to remain recordable while suspended';
  end if;
end;
$$;

do $$
declare
  v_visible_count integer;
begin
  -- Staff RLS visibility remains available during suspension.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '41000000-0000-0000-0000-000000000102', true);
  select count(*) into v_visible_count from public.clinics where id = '41000000-0000-0000-0000-000000000006';
  reset role;

  if v_visible_count <> 1 then
    raise exception 'expected staff to still see their own suspended clinic under RLS';
  end if;
end;
$$;

-- =========================================================================
-- 3b. claim_outbound_message_v2() itself skips a non-active clinic's row,
--     independent of the suspend/prepare cleanup above. The clinic is
--     flipped to 'suspended' with a raw update (bypassing suspend_clinic_v1)
--     so its pending row survives to prove the claim-time gate in isolation.
-- =========================================================================

insert into public.clinics (id, name)
values ('41000000-0000-0000-0000-000000000010', 'V2 Gate Demo Clinic');

update public.clinics set operational_status = 'active', suspended_at = null
where id = '41000000-0000-0000-0000-000000000010';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name)
values ('41000000-0000-0000-0000-000000000011', '41000000-0000-0000-0000-000000000010', '4100000011', 'V2 Gate Demo Account');

do $$
declare
  v_gate_pending_id uuid;
begin
  v_gate_pending_id := pg_temp.make_pending_outbox_row(
    '41000000-0000-0000-0000-000000000010', '4100000011', 'wamid.041-gate-pending', 'e', '+15550011101', '041 Gate Owner', 'intake_received', 'Gate receipt.'
  );

  update public.clinics set operational_status = 'suspended', suspended_at = now()
  where id = '41000000-0000-0000-0000-000000000010';

  perform set_config('vetai.task041.gate_pending_id', v_gate_pending_id::text, false);
end;
$$;

do $$
declare
  v_claim_result text;
  v_claimed_id uuid;
begin
  select result, outbox_id into v_claim_result, v_claimed_id from public.claim_outbound_message_v2();
  if v_claim_result <> 'claimed' or v_claimed_id = current_setting('vetai.task041.gate_pending_id')::uuid then
    raise exception 'expected V2 to skip the non-active clinic''s row and claim a different one, got % %', v_claim_result, v_claimed_id;
  end if;

  if (select delivery_status from public.outbound_message_outbox
      where id = current_setting('vetai.task041.gate_pending_id')::uuid) <> 'pending' then
    raise exception 'the non-active clinic gate row must stay pending';
  end if;
end;
$$;

-- =========================================================================
-- 4. resume_clinic_v1 happy path.
-- =========================================================================

do $$
declare
  v_result text;
begin
  select result into v_result from public.resume_clinic_v1('41000000-0000-0000-0000-000000000006');
  if v_result <> 'resumed' then
    raise exception 'expected resume_clinic_v1 to return resumed, got %', v_result;
  end if;
  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000006') <> 'active' then
    raise exception 'expected resume_clinic_v1 to move the clinic back to active';
  end if;

  select result into v_result from public.resume_clinic_v1('41000000-0000-0000-0000-000000000006');
  if v_result <> 'already_active' then
    raise exception 'expected a second resume to return already_active, got %', v_result;
  end if;
end;
$$;

-- =========================================================================
-- 5. Offboarding: prepare/finalize two-step workflow, current-token
--    finalize, stale-token rejection, resume cannot escape offboarding,
--    exact replay after deletion and complete existing cascade behavior.
-- =========================================================================

insert into public.clinics (id, name)
values ('41000000-0000-0000-0000-000000000012', 'Offboard Demo Clinic');

update public.clinics set operational_status = 'active', suspended_at = null
where id = '41000000-0000-0000-0000-000000000012';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name)
values ('41000000-0000-0000-0000-000000000013', '41000000-0000-0000-0000-000000000012', '4100000013', 'Offboard Demo Account');

do $$
begin
  perform pg_temp.make_pending_outbox_row(
    '41000000-0000-0000-0000-000000000012', '4100000013', 'wamid.041-off-pending', 'f', '+15550013101', '041 Offboard Owner', 'intake_received', 'Offboard receipt.'
  );
end;
$$;

do $$
declare
  v_result text;
  v_token uuid;
  v_second_token uuid;
  v_rejected boolean;
begin
  select result, offboarding_token into v_result, v_token
  from public.prepare_clinic_offboarding_v1('41000000-0000-0000-0000-000000000012');

  if v_result <> 'prepared' or v_token is null then
    raise exception 'expected prepare_clinic_offboarding_v1 to return a fresh token, got % %', v_result, v_token;
  end if;

  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000012') <> 'offboarding' then
    raise exception 'expected prepare to move the clinic to offboarding';
  end if;

  if exists (select 1 from public.outbound_message_outbox where clinic_id = '41000000-0000-0000-0000-000000000012' and delivery_status = 'pending') then
    raise exception 'expected prepare to clear the clinic''s own pending outbox work';
  end if;

  -- Idempotent replay never re-mints a token.
  select result, offboarding_token into v_result, v_second_token
  from public.prepare_clinic_offboarding_v1('41000000-0000-0000-0000-000000000012');

  if v_result <> 'already_offboarding' or v_second_token <> v_token then
    raise exception 'expected a prepare replay to return the same token, got % %', v_result, v_second_token;
  end if;

  -- resume_clinic_v1 cannot escape offboarding.
  select result into v_result from public.resume_clinic_v1('41000000-0000-0000-0000-000000000012');
  if v_result <> 'refused_offboarding' then
    raise exception 'expected resume to refuse an offboarding clinic, got %', v_result;
  end if;
  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000012') <> 'offboarding' then
    raise exception 'a refused resume must not change clinic state';
  end if;

  -- A stale/wrong token must raise and change nothing.
  v_rejected := false;
  begin
    perform result from public.finalize_clinic_offboarding_v1(
      '41000000-0000-0000-0000-000000000012',
      '00000000-0000-0000-0000-000000000000'
    );
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected finalize_clinic_offboarding_v1 to raise for a wrong token';
  end if;

  if (select count(*) from public.clinics where id = '41000000-0000-0000-0000-000000000012') <> 1 then
    raise exception 'a stale-token finalize must not have deleted the clinic';
  end if;

  -- The current token finalizes and cascades.
  select result into v_result from public.finalize_clinic_offboarding_v1(
    '41000000-0000-0000-0000-000000000012',
    v_token
  );
  if v_result <> 'finalized' then
    raise exception 'expected finalize_clinic_offboarding_v1 to return finalized, got %', v_result;
  end if;

  if (select count(*) from public.clinics where id = '41000000-0000-0000-0000-000000000012') <> 0
    or (select count(*) from public.whatsapp_accounts where id = '41000000-0000-0000-0000-000000000013') <> 0
    or (select count(*) from public.owners where clinic_id = '41000000-0000-0000-0000-000000000012') <> 0
    or (select count(*) from public.conversations where clinic_id = '41000000-0000-0000-0000-000000000012') <> 0
    or (select count(*) from public.messages where clinic_id = '41000000-0000-0000-0000-000000000012') <> 0
    or (select count(*) from public.outbound_message_outbox where clinic_id = '41000000-0000-0000-0000-000000000012') <> 0 then
    raise exception 'expected finalize to cascade-delete the clinic and every tenant-scoped row';
  end if;

  if (select count(*) from public.clinic_offboarding_receipts where clinic_id = '41000000-0000-0000-0000-000000000012') <> 1 then
    raise exception 'expected exactly one offboarding receipt';
  end if;

  if (select action from public.clinic_offboarding_receipts where clinic_id = '41000000-0000-0000-0000-000000000012') <> 'offboarded' then
    raise exception 'expected the offboarding receipt action to be offboarded';
  end if;

  if (select offboarding_token_hash from public.clinic_offboarding_receipts where clinic_id = '41000000-0000-0000-0000-000000000012')
      <> pg_catalog.encode(pg_catalog.sha256(v_token::text::bytea), 'hex') then
    raise exception 'expected the offboarding receipt to store the SHA-256 token hash';
  end if;

  if exists (
    select 1 from public.clinic_offboarding_receipts
    where clinic_id = '41000000-0000-0000-0000-000000000012'
      and offboarding_token_hash = v_token::text
  ) then
    raise exception 'the offboarding receipt must never store the raw token';
  end if;

  -- Exact replay after deletion is idempotent.
  select result into v_result from public.finalize_clinic_offboarding_v1(
    '41000000-0000-0000-0000-000000000012',
    v_token
  );
  if v_result <> 'already_offboarded' then
    raise exception 'expected a post-delete exact replay to return already_offboarded, got %', v_result;
  end if;

  -- A different token against the now-deleted clinic is not_found, not a
  -- false already_offboarded.
  select result into v_result from public.finalize_clinic_offboarding_v1(
    '41000000-0000-0000-0000-000000000012',
    '00000000-0000-0000-0000-000000000000'
  );
  if v_result <> 'not_found' then
    raise exception 'expected a wrong-token replay after deletion to return not_found, got %', v_result;
  end if;
end;
$$;

-- =========================================================================
-- 6. RLS/grants: only service_role may execute the five RPCs or read the
--    receipts table.
-- =========================================================================

do $$
declare
  v_rejected boolean;
begin
  set local role authenticated;

  v_rejected := false;
  begin
    perform result from public.provision_clinic_v1(
      '41000000-0000-0000-0000-000000000020', 'Denied', null, null,
      '41000000-0000-0000-0000-000000000101', 'admin',
      '41000000-0000-0000-0000-000000000021', '4100000021', null
    );
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'authenticated must not be able to execute provision_clinic_v1';
  end if;

  v_rejected := false;
  begin
    perform result from public.suspend_clinic_v1('41000000-0000-0000-0000-000000000008');
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'authenticated must not be able to execute suspend_clinic_v1';
  end if;

  v_rejected := false;
  begin
    perform 1 from public.clinic_offboarding_receipts;
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'authenticated must not be able to read clinic_offboarding_receipts';
  end if;

  reset role;
end;
$$;

do $$
declare
  v_rejected boolean;
begin
  set local role anon;

  v_rejected := false;
  begin
    perform result from public.finalize_clinic_offboarding_v1(
      '41000000-0000-0000-0000-000000000008', '00000000-0000-0000-0000-000000000000'
    );
  exception when insufficient_privilege then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'anon must not be able to execute finalize_clinic_offboarding_v1';
  end if;

  reset role;
end;
$$;

do $$
begin
  -- Cross-tenant denial: the control clinic must be exactly as it started.
  if (select operational_status from public.clinics where id = '41000000-0000-0000-0000-000000000008') <> 'active' then
    raise exception 'expected the control clinic to remain active throughout';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '41000000-0000-0000-0000-000000000001',
    '41000000-0000-0000-0000-000000000003',
    '41000000-0000-0000-0000-000000000006',
    '41000000-0000-0000-0000-000000000008',
    '41000000-0000-0000-0000-000000000010',
    '41000000-0000-0000-0000-000000000012'
  )) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in (
    '41000000-0000-0000-0000-000000000002',
    '41000000-0000-0000-0000-000000000007',
    '41000000-0000-0000-0000-000000000009',
    '41000000-0000-0000-0000-000000000011',
    '41000000-0000-0000-0000-000000000013'
  )) as remaining_test_whatsapp_accounts,
  (select count(*) from public.owners where clinic_id in (
    '41000000-0000-0000-0000-000000000006',
    '41000000-0000-0000-0000-000000000008',
    '41000000-0000-0000-0000-000000000010',
    '41000000-0000-0000-0000-000000000012'
  )) as remaining_test_owners,
  (select count(*) from public.outbound_message_outbox where clinic_id in (
    '41000000-0000-0000-0000-000000000006',
    '41000000-0000-0000-0000-000000000008',
    '41000000-0000-0000-0000-000000000010',
    '41000000-0000-0000-0000-000000000012'
  )) as remaining_test_outbox_rows,
  (select count(*) from public.clinic_offboarding_receipts where clinic_id = '41000000-0000-0000-0000-000000000012') as remaining_test_receipts,
  (select count(*) from auth.users where id in (
    '41000000-0000-0000-0000-000000000101',
    '41000000-0000-0000-0000-000000000102'
  )) as remaining_test_users;
