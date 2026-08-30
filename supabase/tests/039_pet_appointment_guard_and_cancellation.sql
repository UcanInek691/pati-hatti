-- Rollback-only proof for Task 039 Part A (per-pet appointment integrity)
-- and Part B (owner-initiated cancellation), both defined by
-- supabase/migrations/20260829000100_pet_appointment_guard_and_cancellation.sql.
-- That migration must be applied to the target database first.
--
-- WRITE-ONLY as delivered by Sonnet: never executed against any database as
-- part of Task 039's implementation step. Codex alone applies it to
-- disposable `vetai-test`.
--
-- Coverage:
--   Fixture 0 -- grants/role denial: anon and authenticated are denied
--     EXECUTE on both new RPCs; RLS is enabled on appointment_cancellations
--     with no public/anon/authenticated grant.
--   Fixture 1 -- hold_appointment_slot returns 'existing_confirmed' when the
--     pet already has a future confirmed appointment booked under a
--     DIFFERENT (now-completed) conversation; finalize_appointment_offer_queue_job
--     surfaces this as 'existing_confirmed', creates no new hold, advances
--     straight to completed, and the reply names only the pet and its
--     existing Europe/Istanbul date/time.
--   Fixture 2 -- hold_appointment_slot returns 'in_progress' when a
--     different conversation still holds an unexpired slot for the same
--     pet; finalize_appointment_offer_queue_job advances to human_handoff
--     with a generic reply that discloses no slot time, and the other
--     conversation's hold is left completely untouched (lock-order proof:
--     conversation -> pet -> slot, exercised end to end without deadlock in
--     this single session).
--   Fixture 3 -- cross-tenant denial: a pet id that is valid in clinic X can
--     never be used to look up, block or cancel an appointment in clinic Y.
--   Fixture 4 -- advance_conversation_intake: appointment_cancel_confirmation
--     is reachable from the terminal `completed` stage but explicitly NOT
--     from `human_handoff`, and always resolves onward to `completed`.
--   Fixture 5 -- finalize_appointment_cancel_offer_queue_job: no confirmed
--     appointment for the pet -> 'no_appointment', zero audit rows, stage
--     completed, truthful reply.
--   Fixture 6 -- finalize_appointment_cancel_offer_queue_job: a confirmed
--     future appointment is found, pinned into intake_data as
--     `pending_cancel_slot_id`, and offered back with its exact time.
--   Fixture 7 -- finalize_appointment_cancel_decision_queue_job 'cancel':
--     one audit row inserted with exactly identifiers/timestamps, the slot
--     released to `available`, stage completed, exact cancellation copy --
--     all in the one transaction (rollback below proves nothing survives
--     independently of the others).
--   Fixture 8 -- finalize_appointment_cancel_decision_queue_job 'keep': slot
--     and audit table both untouched, stage completed, decline copy.
--   Fixture 9 -- finalize_appointment_cancel_decision_queue_job 'repeat':
--     same-stage advance only, identical confirmation copy repeated, the
--     pinned slot id and the slot itself are untouched.
--   Fixture 10 -- finalize_appointment_cancel_decision_queue_job at decision
--     time the pinned appointment no longer matches (already released
--     elsewhere in the meantime) -> 'stale_appointment', fail closed, zero
--     audit rows.
--   Fixture 11 -- KVKK erasure cascade: deleting the owner behind a recorded
--     cancellation removes the appointment_cancellations row too (composite
--     FK on delete cascade), leaving zero residue.
--   Fixture 12 -- automation-mode suppression: a `manual` contact route
--     suppresses finalize_appointment_cancel_offer_queue_job with zero
--     mutation, mirroring the existing selective-automation template.
--   Fixture 13 -- a stale HAYIR decision returns stale_appointment rather
--     than falsely claiming a released appointment remains valid.
--   Fixture 14 -- source-level conversation -> pet -> slot lock-order guard.
--   Fixture 15 -- a past confirmed appointment does not block a new hold.
--
-- Everything below is wrapped in BEGIN/ROLLBACK. Nothing is committed.

begin;

-- =========================================================================
-- Fixture 0: grants, RLS, and role denial.
-- =========================================================================
do $$
declare
  v_function_count integer;
  v_owner_name text;
  v_grantees text[];
  v_rls_enabled boolean;
begin
  select count(*) into v_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('finalize_appointment_cancel_offer_queue_job', 'finalize_appointment_cancel_decision_queue_job')
    and p.prosecdef = false
    and p.provolatile = 'v'
    and p.proconfig is not null
    and (p.proconfig @> array['search_path='] or p.proconfig @> array['search_path=""']);
  if v_function_count <> 2 then
    raise exception 'fixture 0: expected both new cancellation RPCs to be SECURITY INVOKER, VOLATILE, SET search_path = '''', got % matching', v_function_count;
  end if;

  select pg_catalog.pg_get_userbyid(p.proowner)::text into v_owner_name
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_appointment_cancel_offer_queue_job'
  limit 1;

  select array_agg(distinct r.routine_name || ':' || g.grantee order by r.routine_name || ':' || g.grantee)
    into v_grantees
  from information_schema.routines r
  join information_schema.routine_privileges g
    on g.specific_name = r.specific_name and g.specific_schema = r.specific_schema
  where r.routine_schema = 'public'
    and r.routine_name in ('finalize_appointment_cancel_offer_queue_job', 'finalize_appointment_cancel_decision_queue_job')
    and g.privilege_type = 'EXECUTE';

  if exists (
    select 1 from unnest(v_grantees) g
    where g not like '%:service_role' and g not like '%:' || v_owner_name
  ) then
    raise exception 'fixture 0: expected only service_role (plus owner) to hold EXECUTE on the two new RPCs, got %', v_grantees;
  end if;

  select relrowsecurity into v_rls_enabled
  from pg_catalog.pg_class
  where oid = 'public.appointment_cancellations'::regclass;
  if not v_rls_enabled then
    raise exception 'fixture 0: expected RLS enabled on appointment_cancellations';
  end if;

  select array_agg(distinct grantee::text order by grantee::text) into v_grantees
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'appointment_cancellations';
  if exists (
    select 1 from unnest(v_grantees) grantee
    where grantee not in ('service_role', v_owner_name)
  ) then
    raise exception 'fixture 0: expected appointment_cancellations privileges restricted to service_role (plus owner), got %', v_grantees;
  end if;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform result from public.finalize_appointment_cancel_offer_queue_job(
      gen_random_uuid(), 'wamid.DENY1', gen_random_uuid(), 1, gen_random_uuid(), '{"note": "x"}'::jsonb
    );
    raise exception 'fixture 0: expected anon to be denied execute on finalize_appointment_cancel_offer_queue_job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.finalize_appointment_cancel_decision_queue_job(
      gen_random_uuid(), 'wamid.DENY2', gen_random_uuid(), 1, 'cancel', gen_random_uuid(), '{"note": "x"}'::jsonb
    );
    raise exception 'fixture 0: expected anon to be denied execute on finalize_appointment_cancel_decision_queue_job';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.appointment_cancellations;
    raise exception 'fixture 0: expected anon to be denied select on appointment_cancellations';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform result from public.finalize_appointment_cancel_offer_queue_job(
      gen_random_uuid(), 'wamid.DENY1', gen_random_uuid(), 1, gen_random_uuid(), '{"note": "x"}'::jsonb
    );
    raise exception 'fixture 0: expected authenticated to be denied execute on finalize_appointment_cancel_offer_queue_job';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Shared fixture data.
-- =========================================================================
insert into public.clinics (id, name) values
  ('39100000-0000-0000-0000-000000000001', '039 Clinic A'),
  ('39100000-0000-0000-0000-000000000002', '039 Clinic B (cross-tenant)'),
  ('39100000-0000-0000-0000-000000000003', '039 Clinic C (manual mode)');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id) values
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '939100001'),
  ('39100000-0000-0000-0000-000000000012', '39100000-0000-0000-0000-000000000002', '939100002'),
  ('39100000-0000-0000-0000-000000000013', '39100000-0000-0000-0000-000000000003', '939100003');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode) values
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100001', 'ai'),
  ('39100000-0000-0000-0000-000000000012', '39100000-0000-0000-0000-000000000002', '+15559100011', 'ai'),
  ('39100000-0000-0000-0000-000000000013', '39100000-0000-0000-0000-000000000003', '+15559100003', 'manual'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100021', 'ai'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100022', 'ai'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100023', 'ai'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100024', 'ai'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100025', 'ai'),
  ('39100000-0000-0000-0000-000000000011', '39100000-0000-0000-0000-000000000001', '+15559100026', 'ai');

-- A stable future half-hour-aligned base instant for this transaction.
do $$
declare
  v_base timestamptz := date_trunc('hour', pg_catalog.now()) + interval '2 hours';
begin
  create temporary table fixture_times (key text primary key, value timestamptz not null) on commit drop;
  insert into pg_temp.fixture_times (key, value) values
    ('t_p1_confirmed', v_base),
    ('t_p1_alt', v_base + interval '30 minutes'),
    ('t_p2_held', v_base + interval '1 hour'),
    ('t_p2_alt', v_base + interval '1 hour 30 minutes'),
    ('t_px_slot', v_base + interval '2 hours'),
    ('t_cancel_pet_slot', v_base + interval '2 hours 30 minutes'),
    ('t_keep_pet_slot', v_base + interval '3 hours'),
    ('t_repeat_pet_slot', v_base + interval '3 hours 30 minutes'),
    ('t_stale_pet_slot', v_base + interval '4 hours'),
    ('t_erasure_pet_slot', v_base + interval '4 hours 30 minutes'),
    ('t_stale_keep_pet_slot', v_base + interval '5 hours');
end;
$$;

grant select on pg_temp.fixture_times to service_role;

set local role service_role;

-- Boot one conversation for Clinic A's fixture owner. Every later fixture
-- that needs a fresh conversation for the same owner first drives this one
-- to `completed` (the partial unique index on
-- (clinic_id, owner_id) where status in ('active','handoff') only allows a
-- new conversation row once the previous one has left that set).
do $$
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-BOOT-A',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15559100001',
    p_owner_name => '039 Fixture Owner A',
    p_message_text => 'Merhaba',
    p_provider_timestamp => pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100002',
    p_provider_message_id => 'wamid.039-BOOT-B',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15559100011',
    p_owner_name => '039 Fixture Owner B (cross-tenant)',
    p_message_text => 'Merhaba',
    p_provider_timestamp => pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100003',
    p_provider_message_id => 'wamid.039-BOOT-C',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15559100003',
    p_owner_name => '039 Fixture Owner C (manual)',
    p_message_text => 'Merhaba',
    p_provider_timestamp => pg_catalog.now()
  );
end;
$$;

reset role;

insert into public.pets (id, clinic_id, owner_id, name, species)
select '39100000-0000-0000-0000-0000000000e1', c.clinic_id, c.owner_id, '039 Pet One', 'kedi'
from public.conversations c
join public.owners o on o.id = c.owner_id
where o.full_name = '039 Fixture Owner A';

insert into public.pets (id, clinic_id, owner_id, name, species)
select '39100000-0000-0000-0000-0000000000e2', c.clinic_id, c.owner_id, '039 Pet Two', 'köpek'
from public.conversations c
join public.owners o on o.id = c.owner_id
where o.full_name = '039 Fixture Owner A';

insert into public.pets (id, clinic_id, owner_id, name, species)
select '39200000-0000-0000-0000-0000000000ef', c.clinic_id, c.owner_id, '039 Cross-Tenant Pet', 'kedi'
from public.conversations c
join public.owners o on o.id = c.owner_id
where o.full_name = '039 Fixture Owner B (cross-tenant)';

-- Available clinic-A slots used across Fixtures 1-2.
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
select '39100000-0000-0000-0000-00000000a001', '39100000-0000-0000-0000-000000000001', t.value, t.value + interval '30 minutes', 'available'
from pg_temp.fixture_times t where t.key = 't_p1_confirmed';
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
select '39100000-0000-0000-0000-00000000a002', '39100000-0000-0000-0000-000000000001', t.value, t.value + interval '30 minutes', 'available'
from pg_temp.fixture_times t where t.key = 't_p1_alt';
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
select '39100000-0000-0000-0000-00000000a003', '39100000-0000-0000-0000-000000000001', t.value, t.value + interval '30 minutes', 'available'
from pg_temp.fixture_times t where t.key = 't_p2_held';
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
select '39100000-0000-0000-0000-00000000a004', '39100000-0000-0000-0000-000000000001', t.value, t.value + interval '30 minutes', 'available'
from pg_temp.fixture_times t where t.key = 't_p2_alt';

-- =========================================================================
-- Fixture 1: existing_confirmed. Pet One already has a future confirmed
-- appointment booked under conversation A1 (now completed); a new
-- conversation A2 for the same owner tries to book pet One a DIFFERENT
-- slot.
-- =========================================================================
do $$
declare
  v_conv_a1 uuid;
  v_conv_a2 uuid;
  v_owner_a uuid;
  v_result text;
  v_token uuid;
  v_starts timestamptz;
  v_ends timestamptz;
  v_offer_result text;
  v_stage text;
  v_version integer;
  v_claim_token uuid;
  v_claim_result text;
  v_a2_version integer;
  v_slot_status text;
  v_reply_content text;
begin
  select c.id, c.owner_id into v_conv_a1, v_owner_a
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039 Fixture Owner A';

  update public.conversations
    set intake_stage = 'appointment_confirmation', pet_id = '39100000-0000-0000-0000-0000000000e1'
    where id = v_conv_a1;

  select h.result, h.booking_token into v_result, v_token
  from public.hold_appointment_slot(v_conv_a1, '39100000-0000-0000-0000-00000000a001') h;
  if v_result <> 'held' then
    raise exception 'fixture 1: expected held, got %', v_result;
  end if;

  select c.result, c.starts_at, c.ends_at into v_result, v_starts, v_ends
  from public.confirm_appointment_slot(v_conv_a1, '39100000-0000-0000-0000-00000000a001', v_token) c;
  if v_result <> 'confirmed' then
    raise exception 'fixture 1: expected confirmed, got %', v_result;
  end if;

  -- Simulate this original booking conversation having wrapped up.
  update public.conversations set intake_stage = 'completed', status = 'completed' where id = v_conv_a1;

  -- A brand-new conversation for the same owner is now allowed (A1 has left
  -- the active/handoff set).
  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F1-A2',
    p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15559100001',
    p_owner_name => '039 Fixture Owner A',
    p_message_text => 'Pamuk için tekrar randevu almak istiyorum',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv_a2
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F1-A2' and m.direction = 'inbound';

  if v_conv_a2 is null or v_conv_a2 = v_conv_a1 then
    raise exception 'fixture 1: expected a distinct new conversation for the same owner, got %', v_conv_a2;
  end if;

  update public.conversations
    set intake_stage = 'appointment_offer', pet_id = '39100000-0000-0000-0000-0000000000e1', status = 'active'
    where id = v_conv_a2;

  -- Direct RPC-level proof: hold_appointment_slot on a DIFFERENT slot must
  -- surface the pet's existing confirmed time, not create a hold.
  select h.result, h.starts_at, h.ends_at into v_result, v_starts, v_ends
  from public.hold_appointment_slot(v_conv_a2, '39100000-0000-0000-0000-00000000a002') h;
  if v_result <> 'existing_confirmed' then
    raise exception 'fixture 1: expected existing_confirmed, got %', v_result;
  end if;
  if v_starts <> (select value from pg_temp.fixture_times where key = 't_p1_confirmed') then
    raise exception 'fixture 1: expected the disclosed time to be pet One''s existing confirmed slot, got %', v_starts;
  end if;

  select status into v_slot_status from public.appointment_slots where id = '39100000-0000-0000-0000-00000000a002';
  if v_slot_status <> 'available' then
    raise exception 'fixture 1: expected the alternate slot to remain available, got %', v_slot_status;
  end if;

  -- Full RPC-flow proof via finalize_appointment_offer_queue_job.
  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv_a2, 'wamid.039-F1-A2') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 1: expected claimed, got %', v_claim_result;
  end if;

  select c.state_version into v_a2_version from public.conversations c where c.id = v_conv_a2;

  select f.result, f.intake_stage, f.state_version into v_offer_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conv_a2, 'wamid.039-F1-A2', v_claim_token, v_a2_version, 'appointment_offer',
    '39100000-0000-0000-0000-0000000000e1', jsonb_build_object('pet_id', '39100000-0000-0000-0000-0000000000e1')
  ) f;

  if v_offer_result <> 'existing_confirmed' then
    raise exception 'fixture 1: expected finalize_appointment_offer_queue_job to return existing_confirmed, got %', v_offer_result;
  end if;
  if v_stage <> 'completed' then
    raise exception 'fixture 1: expected stage completed, got %', v_stage;
  end if;

  select content into v_reply_content
  from public.outbound_message_outbox
  where conversation_id = v_conv_a2 and reply_category = 'appointment_unavailable'
  order by created_at desc limit 1;
  if v_reply_content is null
    or v_reply_content !~ '039 Pet One'
    or v_reply_content ~ 'randevu (oluştur|alındı)'
  then
    raise exception 'fixture 1: expected a truthful existing-appointment reply naming the pet only, got %', v_reply_content;
  end if;

  select status into v_slot_status from public.appointment_slots where id = '39100000-0000-0000-0000-00000000a002';
  if v_slot_status <> 'available' then
    raise exception 'fixture 1: expected the alternate slot to still be available after finalize, got %', v_slot_status;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: in_progress. Pet Two has an unexpired held slot under a
-- (now-completed) conversation A3; a new conversation A4 for the same owner
-- tries to hold a DIFFERENT slot for the same pet.
-- =========================================================================
do $$
declare
  v_conv_a3 uuid;
  v_conv_a4 uuid;
  v_result text;
  v_token uuid;
  v_offer_result text;
  v_stage text;
  v_version integer;
  v_claim_token uuid;
  v_claim_result text;
  v_a4_version integer;
  v_a3_slot_status text;
  v_reply_content text;
begin
  select m.conversation_id into v_conv_a3
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F1-A2'
    and m.direction = 'inbound';

  -- v_conv_a3 above is actually conversation A2 from Fixture 1, already
  -- `completed`. Reuse it directly for the held-slot setup: it is
  -- allowed to hold a slot for a different pet before it completes.
  update public.conversations
    set intake_stage = 'appointment_offer', pet_id = '39100000-0000-0000-0000-0000000000e2', status = 'active'
    where id = v_conv_a3;

  select h.result, h.booking_token into v_result, v_token
  from public.hold_appointment_slot(v_conv_a3, '39100000-0000-0000-0000-00000000a003') h;
  if v_result <> 'held' then
    raise exception 'fixture 2: expected held, got %', v_result;
  end if;

  -- Simulate this conversation having wrapped up (e.g. handed off) while
  -- its 10-minute hold on Pet Two's slot has not yet expired.
  update public.conversations set intake_stage = 'completed', status = 'completed' where id = v_conv_a3;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F2-A4',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15559100001',
    p_owner_name => '039 Fixture Owner A',
    p_message_text => 'Karamel için randevu almak istiyorum',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv_a4
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F2-A4' and m.direction = 'inbound';

  if v_conv_a4 is null or v_conv_a4 = v_conv_a3 then
    raise exception 'fixture 2: expected a distinct new conversation for the same owner, got %', v_conv_a4;
  end if;

  update public.conversations
    set intake_stage = 'appointment_offer', pet_id = '39100000-0000-0000-0000-0000000000e2', status = 'active'
    where id = v_conv_a4;

  select h.result into v_result
  from public.hold_appointment_slot(v_conv_a4, '39100000-0000-0000-0000-00000000a004') h;
  if v_result <> 'in_progress' then
    raise exception 'fixture 2: expected in_progress, got %', v_result;
  end if;

  select status into v_a3_slot_status from public.appointment_slots where id = '39100000-0000-0000-0000-00000000a003';
  if v_a3_slot_status <> 'held' then
    raise exception 'fixture 2: expected conversation A3''s hold to remain untouched, got %', v_a3_slot_status;
  end if;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv_a4, 'wamid.039-F2-A4') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 2: expected claimed, got %', v_claim_result;
  end if;

  select c.state_version into v_a4_version from public.conversations c where c.id = v_conv_a4;

  select f.result, f.intake_stage, f.state_version into v_offer_result, v_stage, v_version
  from public.finalize_appointment_offer_queue_job(
    v_conv_a4, 'wamid.039-F2-A4', v_claim_token, v_a4_version, 'appointment_offer',
    '39100000-0000-0000-0000-0000000000e2', jsonb_build_object('pet_id', '39100000-0000-0000-0000-0000000000e2')
  ) f;

  if v_offer_result <> 'in_progress' then
    raise exception 'fixture 2: expected finalize_appointment_offer_queue_job to return in_progress, got %', v_offer_result;
  end if;
  if v_stage <> 'human_handoff' then
    raise exception 'fixture 2: expected stage human_handoff, got %', v_stage;
  end if;

  select content into v_reply_content
  from public.outbound_message_outbox
  where conversation_id = v_conv_a4 and reply_category = 'appointment_unavailable'
  order by created_at desc limit 1;
  if v_reply_content is null or v_reply_content ~ to_char(
    (select value from pg_temp.fixture_times where key = 't_p2_held') at time zone 'Europe/Istanbul', 'DD.MM.YYYY'
  ) then
    raise exception 'fixture 2: expected a generic in-progress reply disclosing no slot time, got %', v_reply_content;
  end if;

  select status into v_a3_slot_status from public.appointment_slots where id = '39100000-0000-0000-0000-00000000a003';
  if v_a3_slot_status <> 'held' then
    raise exception 'fixture 2: expected conversation A3''s hold to remain untouched after finalize, got %', v_a3_slot_status;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: cross-tenant denial. Clinic B's pet id is never treated as a
-- clinic-A pet by the guard.
-- =========================================================================
do $$
declare
  v_conv_a uuid;
begin
  select m.conversation_id into v_conv_a
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F2-A4'
    and m.direction = 'inbound';

  begin
    update public.conversations set pet_id = '39200000-0000-0000-0000-0000000000ef' where id = v_conv_a;
    raise exception 'fixture 3: expected a direct cross-tenant pet_id assignment to be structurally impossible';
  exception when foreign_key_violation then null;
  end;
end;
$$;

-- =========================================================================
-- Fixture 4: advance_conversation_intake stage-graph proof for the new
-- appointment_cancel_confirmation edges.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_owner uuid;
  v_stage text;
  v_version integer;
begin
  select c.id, c.owner_id, c.state_version into v_conv, v_owner, v_version
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039 Fixture Owner B (cross-tenant)';

  update public.conversations set intake_stage = 'completed', status = 'completed' where id = v_conv;

  -- Allowed: completed -> appointment_cancel_confirmation.
  select a.intake_stage, a.state_version into v_stage, v_version
  from public.advance_conversation_intake(
    v_conv, v_version, 'appointment_cancel_confirmation', null, jsonb_build_object('note', 'fixture4')
  ) a;
  if v_stage <> 'appointment_cancel_confirmation' then
    raise exception 'fixture 4: expected completed -> appointment_cancel_confirmation to be allowed, got %', v_stage;
  end if;

  -- Allowed: appointment_cancel_confirmation -> completed.
  select a.intake_stage, a.state_version into v_stage, v_version
  from public.advance_conversation_intake(
    v_conv, v_version, 'completed', null, jsonb_build_object('note', 'fixture4')
  ) a;
  if v_stage <> 'completed' then
    raise exception 'fixture 4: expected appointment_cancel_confirmation -> completed to be allowed, got %', v_stage;
  end if;

  update public.conversations set intake_stage = 'human_handoff', status = 'handoff' where id = v_conv;

  -- Forbidden: human_handoff -> appointment_cancel_confirmation.
  begin
    perform a.intake_stage from public.advance_conversation_intake(
      v_conv, v_version, 'appointment_cancel_confirmation', null, jsonb_build_object('note', 'fixture4')
    ) a;
    raise exception 'fixture 4: expected human_handoff -> appointment_cancel_confirmation to be rejected';
  exception when others then
    if sqlerrm !~ 'is terminal' then
      raise exception 'fixture 4: expected a terminal-stage exception, got %', sqlerrm;
    end if;
  end;
end;
$$;

-- =========================================================================
-- Fixture 5: finalize_appointment_cancel_offer_queue_job -- no_appointment.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_reply_content text;
  v_audit_count integer;
begin
  -- Fixture 2 intentionally left Owner A's newest conversation in the
  -- terminal human_handoff state. Close that synthetic conversation so this
  -- fixture exercises a fresh cancellation turn instead of the handoff guard.
  update public.conversations c
    set intake_stage = 'completed', status = 'completed'
  from public.owners o
  where c.owner_id = o.id
    and c.clinic_id = o.clinic_id
    and o.full_name = '039 Fixture Owner A'
    and c.status = 'handoff';

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F5',
    p_payload_hash => repeat('d', 64),
    p_sender_e164 => '+15559100001',
    p_owner_name => '039 Fixture Owner A',
    p_message_text => 'randevumu iptal etmek istiyorum',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F5' and m.direction = 'inbound';

  -- Pet One's earlier confirmed slot (from Fixture 1) belongs to a different
  -- conversation lineage; scope this fixture to Pet Two, which has no
  -- confirmed (only a held, non-blocking-for-cancel) slot.
  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F5') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 5: expected claimed, got %', v_claim_result;
  end if;

  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F5', v_claim_token, v_version,
    '39100000-0000-0000-0000-0000000000e2', jsonb_build_object('pet_id', '39100000-0000-0000-0000-0000000000e2')
  ) f;

  if v_result <> 'no_appointment' then
    raise exception 'fixture 5: expected no_appointment, got %', v_result;
  end if;
  if v_stage <> 'completed' then
    raise exception 'fixture 5: expected stage completed, got %', v_stage;
  end if;

  select count(*) into v_audit_count from public.appointment_cancellations;
  if v_audit_count <> 0 then
    raise exception 'fixture 5: expected zero audit rows, got %', v_audit_count;
  end if;

  select content into v_reply_content
  from public.outbound_message_outbox
  where conversation_id = v_conv and reply_category = 'appointment_cancel_unavailable'
  order by created_at desc limit 1;
  if v_reply_content is null then
    raise exception 'fixture 5: expected a truthful no-appointment reply';
  end if;
end;
$$;

-- =========================================================================
-- Fixtures 6-10: a fresh pet with its own confirmed future appointment,
-- exercised through offer -> {cancel, keep, repeat, stale}. Each fixture
-- gets its own owner/pet/slot so the fixtures are independent of each
-- other's mutations.
-- =========================================================================
do $$
declare
  v_suffix text;
  v_owner_name text;
  v_pet_id uuid;
  v_slot_id uuid;
  v_slot_time timestamptz;
begin
  foreach v_suffix in array array['cancel', 'keep', 'repeat', 'stale', 'erasure', 'stale_keep'] loop
    v_owner_name := '039 Fixture Owner ' || v_suffix;

    set local role service_role;
    perform result from public.ingest_whatsapp_text_message(
      p_phone_number_id => '939100001',
      p_provider_message_id => 'wamid.039-BOOT-' || v_suffix,
      p_payload_hash => repeat('e', 64),
      p_sender_e164 => '+1555910' || (case v_suffix
        when 'cancel' then '0021' when 'keep' then '0022' when 'repeat' then '0023'
        when 'stale' then '0024' when 'erasure' then '0025' else '0026' end),
      p_owner_name => v_owner_name,
      p_message_text => 'Merhaba',
      p_provider_timestamp => pg_catalog.now()
    );
    reset role;
  end loop;
end;
$$;

do $$
declare
  v_suffix text;
  v_owner_name text;
  v_owner_id uuid;
  v_pet_id uuid;
  v_slot_id uuid;
  v_slot_time timestamptz;
  v_conv uuid;
  v_result text;
  v_token uuid;
begin
  foreach v_suffix in array array['cancel', 'keep', 'repeat', 'stale', 'erasure', 'stale_keep'] loop
    v_owner_name := '039 Fixture Owner ' || v_suffix;

    select c.id, c.owner_id into v_conv, v_owner_id
    from public.conversations c
    join public.owners o on o.id = c.owner_id
    where o.full_name = v_owner_name;

    v_pet_id := ('39300000-0000-0000-0000-0000000000' || (case v_suffix
      when 'cancel' then 'ca' when 'keep' then 'cb' when 'repeat' then 'cc'
      when 'stale' then 'cd' when 'erasure' then 'ce' else 'cf' end))::uuid;
    insert into public.pets (id, clinic_id, owner_id, name, species)
    values (v_pet_id, '39100000-0000-0000-0000-000000000001', v_owner_id, '039 Pet ' || v_suffix, 'kedi');

    select t.value into v_slot_time from pg_temp.fixture_times t where t.key = 't_' || v_suffix || '_pet_slot';
    v_slot_id := ('39400000-0000-0000-0000-0000000000' || (case v_suffix
      when 'cancel' then 'ca' when 'keep' then 'cb' when 'repeat' then 'cc'
      when 'stale' then 'cd' when 'erasure' then 'ce' else 'cf' end))::uuid;
    insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
    values (v_slot_id, '39100000-0000-0000-0000-000000000001', v_slot_time, v_slot_time + interval '30 minutes', 'available');

    update public.conversations
      set intake_stage = 'appointment_confirmation', pet_id = v_pet_id, status = 'active'
      where id = v_conv;

    select h.result, h.booking_token into v_result, v_token
    from public.hold_appointment_slot(v_conv, v_slot_id) h;
    if v_result <> 'held' then
      raise exception 'fixture 6-10 setup (%): expected held, got %', v_suffix, v_result;
    end if;

    select c.result into v_result
    from public.confirm_appointment_slot(v_conv, v_slot_id, v_token) c;
    if v_result <> 'confirmed' then
      raise exception 'fixture 6-10 setup (%): expected confirmed, got %', v_suffix, v_result;
    end if;

    update public.conversations set intake_stage = 'completed', status = 'completed' where id = v_conv;
  end loop;
end;
$$;

-- Fixture 6: offer pins the exact confirmed appointment.
do $$
declare
  v_owner_id uuid;
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000ca';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000ca';
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_pinned_id uuid;
  v_reply_content text;
begin
  select o.id into v_owner_id from public.owners o where o.full_name = '039 Fixture Owner cancel';

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F6',
    p_payload_hash => repeat('f', 64),
    p_sender_e164 => '+15559100021',
    p_owner_name => '039 Fixture Owner cancel',
    p_message_text => 'randevumu iptal edelim',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F6' and m.direction = 'inbound';

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F6') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 6: expected claimed, got %', v_claim_result;
  end if;

  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F6', v_claim_token, v_version, v_pet_id, jsonb_build_object('pet_id', v_pet_id)
  ) f;

  if v_result <> 'offered' then
    raise exception 'fixture 6: expected offered, got %', v_result;
  end if;
  if v_stage <> 'appointment_cancel_confirmation' then
    raise exception 'fixture 6: expected stage appointment_cancel_confirmation, got %', v_stage;
  end if;

  select (c.intake_data ->> 'pending_cancel_slot_id')::uuid into v_pinned_id
  from public.conversations c where c.id = v_conv;
  if v_pinned_id <> v_slot_id then
    raise exception 'fixture 6: expected pending_cancel_slot_id to be pinned to %, got %', v_slot_id, v_pinned_id;
  end if;

  select content into v_reply_content
  from public.outbound_message_outbox
  where conversation_id = v_conv and reply_category = 'appointment_cancel_offer'
  order by created_at desc limit 1;
  if v_reply_content is null or v_reply_content !~ 'EVET' or v_reply_content !~ 'HAYIR' then
    raise exception 'fixture 6: expected exact EVET/HAYIR instructions in the offer reply, got %', v_reply_content;
  end if;
end;
$$;

-- Fixture 7: decision 'cancel' -- atomic audit insert + slot release +
-- stage completion + reply.
do $$
declare
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000ca';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000ca';
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_slot_status text;
  v_audit_count integer;
  v_reply_content text;
  v_intake_data jsonb;
begin
  select c.id into v_conv from public.conversations c
  where c.pet_id = v_pet_id and c.intake_stage = 'appointment_cancel_confirmation';

  select c.state_version, c.intake_data into v_version, v_intake_data
  from public.conversations c where c.id = v_conv;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F7',
    p_payload_hash => repeat('1', 64),
    p_sender_e164 => '+15559100021',
    p_owner_name => '039 Fixture Owner cancel',
    p_message_text => 'EVET',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F7') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 7: expected claimed, got %', v_claim_result;
  end if;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_decision_queue_job(
    v_conv, 'wamid.039-F7', v_claim_token, v_version, 'cancel', v_pet_id, v_intake_data
  ) f;

  if v_result <> 'cancelled' then
    raise exception 'fixture 7: expected cancelled, got %', v_result;
  end if;
  if v_stage <> 'completed' then
    raise exception 'fixture 7: expected stage completed, got %', v_stage;
  end if;

  select status into v_slot_status from public.appointment_slots where id = v_slot_id;
  if v_slot_status <> 'available' then
    raise exception 'fixture 7: expected the slot to be released to available, got %', v_slot_status;
  end if;

  select count(*) into v_audit_count from public.appointment_cancellations where appointment_slot_id = v_slot_id;
  if v_audit_count <> 1 then
    raise exception 'fixture 7: expected exactly one audit row, got %', v_audit_count;
  end if;

  select content into v_reply_content
  from public.outbound_message_outbox
  where conversation_id = v_conv and reply_category = 'appointment_cancelled'
  order by created_at desc limit 1;
  if v_reply_content is null then
    raise exception 'fixture 7: expected a cancellation-confirmed reply';
  end if;
end;
$$;

-- Fixture 8: decision 'keep' -- no mutation to the slot or audit table.
do $$
declare
  v_owner_id uuid;
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000cb';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000cb';
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_slot_status text;
  v_audit_count integer;
  v_intake_data jsonb;
begin
  select c.id into v_conv from public.conversations c where c.pet_id = v_pet_id;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F8-offer',
    p_payload_hash => repeat('2', 64),
    p_sender_e164 => '+15559100022',
    p_owner_name => '039 Fixture Owner keep',
    p_message_text => 'randevumu iptal edelim',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F8-offer'
    and m.direction = 'inbound';

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F8-offer') claimed;
  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  select f.intake_stage into v_stage
  from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F8-offer', v_claim_token, v_version, v_pet_id, jsonb_build_object('pet_id', v_pet_id)
  ) f;
  if v_stage <> 'appointment_cancel_confirmation' then
    raise exception 'fixture 8: expected offer stage appointment_cancel_confirmation, got %', v_stage;
  end if;

  select c.state_version, c.intake_data into v_version, v_intake_data
  from public.conversations c where c.id = v_conv;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F8-decide',
    p_payload_hash => repeat('3', 64),
    p_sender_e164 => '+15559100022',
    p_owner_name => '039 Fixture Owner keep',
    p_message_text => 'HAYIR',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F8-decide') claimed;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_decision_queue_job(
    v_conv, 'wamid.039-F8-decide', v_claim_token, v_version, 'keep', v_pet_id, v_intake_data
  ) f;

  if v_result <> 'kept' then
    raise exception 'fixture 8: expected kept, got %', v_result;
  end if;
  if v_stage <> 'completed' then
    raise exception 'fixture 8: expected stage completed, got %', v_stage;
  end if;

  select status into v_slot_status from public.appointment_slots where id = v_slot_id;
  if v_slot_status <> 'confirmed' then
    raise exception 'fixture 8: expected the slot to remain confirmed, got %', v_slot_status;
  end if;

  select count(*) into v_audit_count from public.appointment_cancellations where appointment_slot_id = v_slot_id;
  if v_audit_count <> 0 then
    raise exception 'fixture 8: expected zero audit rows, got %', v_audit_count;
  end if;
end;
$$;

-- Fixture 9: decision 'repeat' -- same-stage advance only, no mutation.
do $$
declare
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000cc';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000cc';
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_slot_status text;
  v_intake_data jsonb;
  v_offer_reply text;
  v_repeat_reply text;
begin
  select c.id into v_conv from public.conversations c where c.pet_id = v_pet_id;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F9-offer',
    p_payload_hash => repeat('4', 64),
    p_sender_e164 => '+15559100023',
    p_owner_name => '039 Fixture Owner repeat',
    p_message_text => 'randevumu iptal edelim',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F9-offer'
    and m.direction = 'inbound';

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F9-offer') claimed;
  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  perform f.result from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F9-offer', v_claim_token, v_version, v_pet_id, jsonb_build_object('pet_id', v_pet_id)
  ) f;

  select content into v_offer_reply
  from public.outbound_message_outbox
  where conversation_id = v_conv and reply_category = 'appointment_cancel_offer'
  order by created_at desc limit 1;

  select c.state_version, c.intake_data into v_version, v_intake_data
  from public.conversations c where c.id = v_conv;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F9-decide',
    p_payload_hash => repeat('5', 64),
    p_sender_e164 => '+15559100023',
    p_owner_name => '039 Fixture Owner repeat',
    p_message_text => 'belki',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F9-decide') claimed;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_decision_queue_job(
    v_conv, 'wamid.039-F9-decide', v_claim_token, v_version, 'repeat', v_pet_id, v_intake_data
  ) f;

  if v_result <> 'repeated' then
    raise exception 'fixture 9: expected repeated, got %', v_result;
  end if;
  if v_stage <> 'appointment_cancel_confirmation' then
    raise exception 'fixture 9: expected same-stage advance, got %', v_stage;
  end if;

  select status into v_slot_status from public.appointment_slots where id = v_slot_id;
  if v_slot_status <> 'confirmed' then
    raise exception 'fixture 9: expected the slot to remain confirmed, got %', v_slot_status;
  end if;

  select content into v_repeat_reply
  from public.outbound_message_outbox
  where conversation_id = v_conv and reply_category = 'appointment_cancel_offer'
  order by created_at desc limit 1;
  if v_repeat_reply is distinct from v_offer_reply then
    raise exception 'fixture 9: expected the exact same confirmation copy repeated, got % vs %', v_offer_reply, v_repeat_reply;
  end if;
end;
$$;

-- Fixture 10: pinned appointment goes stale before the decision arrives.
do $$
declare
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000cd';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000cd';
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_stage text;
  v_intake_data jsonb;
  v_audit_count integer;
begin
  select c.id into v_conv from public.conversations c where c.pet_id = v_pet_id;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F10-offer',
    p_payload_hash => repeat('6', 64),
    p_sender_e164 => '+15559100024',
    p_owner_name => '039 Fixture Owner stale',
    p_message_text => 'randevumu iptal edelim',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select m.conversation_id into v_conv
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F10-offer'
    and m.direction = 'inbound';

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F10-offer') claimed;
  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  perform f.result from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F10-offer', v_claim_token, v_version, v_pet_id, jsonb_build_object('pet_id', v_pet_id)
  ) f;

  -- The appointment is released out-of-band before EVET arrives (e.g. a
  -- staff member cancelled it by phone in the meantime).
  update public.appointment_slots
    set status = 'available', conversation_id = null, owner_id = null, pet_id = null,
        booking_token = null, hold_until = null, confirmed_at = null
    where id = v_slot_id;

  select c.state_version, c.intake_data into v_version, v_intake_data
  from public.conversations c where c.id = v_conv;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100001',
    p_provider_message_id => 'wamid.039-F10-decide',
    p_payload_hash => repeat('7', 64),
    p_sender_e164 => '+15559100024',
    p_owner_name => '039 Fixture Owner stale',
    p_message_text => 'EVET',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F10-decide') claimed;

  select f.result, f.intake_stage into v_result, v_stage
  from public.finalize_appointment_cancel_decision_queue_job(
    v_conv, 'wamid.039-F10-decide', v_claim_token, v_version, 'cancel', v_pet_id, v_intake_data
  ) f;

  if v_result <> 'stale_appointment' then
    raise exception 'fixture 10: expected stale_appointment (fail closed), got %', v_result;
  end if;
  if v_stage <> 'completed' then
    raise exception 'fixture 10: expected stage completed, got %', v_stage;
  end if;

  select count(*) into v_audit_count from public.appointment_cancellations where appointment_slot_id = v_slot_id;
  if v_audit_count <> 0 then
    raise exception 'fixture 10: expected zero audit rows for the already-released appointment, got %', v_audit_count;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 11: KVKK erasure cascade. Deleting the owner behind Fixture 7's
-- recorded cancellation removes the audit row too.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000ca';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000ca';
  v_audit_count integer;
begin
  select count(*) into v_audit_count from public.appointment_cancellations where appointment_slot_id = v_slot_id;
  if v_audit_count <> 1 then
    raise exception 'fixture 11: expected Fixture 7''s audit row to still exist before erasure, got %', v_audit_count;
  end if;

  select owner_id into v_owner_id from public.pets where id = v_pet_id;

  delete from public.owners where id = v_owner_id;

  select count(*) into v_audit_count from public.appointment_cancellations where appointment_slot_id = v_slot_id;
  if v_audit_count <> 0 then
    raise exception 'fixture 11: expected owner erasure to cascade-delete the cancellation audit row, got %', v_audit_count;
  end if;

  if exists (select 1 from public.pets where id = v_pet_id) then
    raise exception 'fixture 11: expected the pet to be cascade-deleted with the owner';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 12: automation-mode suppression on the cancel-offer RPC.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_claim_token uuid;
  v_claim_result text;
  v_version integer;
  v_result text;
  v_pet_id uuid;
  v_owner_id uuid;
begin
  select c.id, c.owner_id into v_conv, v_owner_id
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039 Fixture Owner C (manual)';

  insert into public.pets (clinic_id, owner_id, name, species)
  values ('39100000-0000-0000-0000-000000000003', v_owner_id, '039 Pet Manual', 'kedi')
  returning id into v_pet_id;

  -- Let the inbound event enter the AI lease path, then change the route
  -- after claim to prove the finalizer's lock-and-recheck suppression race.
  update public.whatsapp_contact_routes
    set mode = 'ai'
  where whatsapp_account_id = '39100000-0000-0000-0000-000000000013'
    and contact_e164 = '+15559100003';

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '939100003',
    p_provider_message_id => 'wamid.039-F12',
    p_payload_hash => repeat('8', 64),
    p_sender_e164 => '+15559100003',
    p_owner_name => '039 Fixture Owner C (manual)',
    p_message_text => 'randevumu iptal edelim',
    p_provider_timestamp => pg_catalog.now()
  );
  reset role;

  select claimed.result, claimed.claim_token into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F12') claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'fixture 12: expected claimed, got %', v_claim_result;
  end if;

  update public.whatsapp_contact_routes
    set mode = 'manual'
  where whatsapp_account_id = '39100000-0000-0000-0000-000000000013'
    and contact_e164 = '+15559100003';

  select c.state_version into v_version from public.conversations c where c.id = v_conv;

  select f.result into v_result
  from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F12', v_claim_token, v_version, v_pet_id, jsonb_build_object('pet_id', v_pet_id)
  ) f;

  if v_result <> 'suppressed' then
    raise exception 'fixture 12: expected suppressed under manual mode, got %', v_result;
  end if;

  if exists (select 1 from public.outbound_message_outbox where conversation_id = v_conv) then
    raise exception 'fixture 12: expected zero replies written while suppressed';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 13: HAYIR also fails closed if the pinned appointment changed.
-- It must not claim that a released appointment remains valid.
-- =========================================================================
do $$
declare
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000cf';
  v_slot_id uuid := '39400000-0000-0000-0000-0000000000cf';
  v_conv uuid;
  v_claim_token uuid;
  v_version integer;
  v_intake_data jsonb;
  v_result text;
begin
  select c.id into v_conv from public.conversations c where c.pet_id = v_pet_id;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    '939100001', 'wamid.039-F13-offer', repeat('9', 64), '+15559100026',
    '039 Fixture Owner stale_keep', 'randevumu iptal et', pg_catalog.now()
  );
  reset role;
  select m.conversation_id into v_conv
  from public.messages m
  where m.whatsapp_message_id = 'wamid.039-F13-offer'
    and m.direction = 'inbound';
  select c.result, c.claim_token into v_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F13-offer') c;
  select c.state_version into v_version from public.conversations c where c.id = v_conv;
  perform f.result from public.finalize_appointment_cancel_offer_queue_job(
    v_conv, 'wamid.039-F13-offer', v_claim_token, v_version, v_pet_id,
    jsonb_build_object('pet_id', v_pet_id)
  ) f;

  update public.appointment_slots
    set status = 'available', conversation_id = null, owner_id = null, pet_id = null,
        booking_token = null, hold_until = null, confirmed_at = null
  where id = v_slot_id;
  select c.state_version, c.intake_data into v_version, v_intake_data
  from public.conversations c where c.id = v_conv;

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    '939100001', 'wamid.039-F13-keep', repeat('0', 64), '+15559100026',
    '039 Fixture Owner stale_keep', 'HAYIR', pg_catalog.now()
  );
  reset role;
  select c.result, c.claim_token into v_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039-F13-keep') c;
  select f.result into v_result
  from public.finalize_appointment_cancel_decision_queue_job(
    v_conv, 'wamid.039-F13-keep', v_claim_token, v_version, 'keep', v_pet_id, v_intake_data
  ) f;

  if v_result <> 'stale_appointment' then
    raise exception 'fixture 13: stale HAYIR must return stale_appointment, got %', v_result;
  end if;
  if exists (select 1 from public.appointment_cancellations where appointment_slot_id = v_slot_id) then
    raise exception 'fixture 13: stale HAYIR must not create an audit row';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 14: source-level lock-order guard for both public confirmation
-- entry points. Runtime blocking still requires a separate two-session test.
-- =========================================================================
do $$
declare
  v_confirm_def text;
  v_finalize_def text;
begin
  select pg_catalog.pg_get_functiondef(
    'public.confirm_appointment_slot(uuid,uuid,uuid)'::regprocedure
  ) into v_confirm_def;
  if position('from public.conversations' in lower(v_confirm_def)) = 0
    or position('from public.pets' in lower(v_confirm_def)) <= position('from public.conversations' in lower(v_confirm_def))
    or position('from public.appointment_slots' in lower(v_confirm_def)) <= position('from public.pets' in lower(v_confirm_def)) then
    raise exception 'fixture 14: confirm_appointment_slot must lock conversation -> pet -> slot';
  end if;

  select pg_catalog.pg_get_functiondef(
    'public.finalize_appointment_decision_queue_job(uuid,text,uuid,integer,text,uuid,jsonb)'::regprocedure
  ) into v_finalize_def;
  if position('from public.conversations' in lower(v_finalize_def)) = 0
    or position('from public.pets' in lower(v_finalize_def)) <= position('from public.conversations' in lower(v_finalize_def))
    or position('from vetai_private.finalize_appointment_decision_queue_job_locked_body' in lower(v_finalize_def))
       <= position('from public.pets' in lower(v_finalize_def)) then
    raise exception 'fixture 14: decision finalizer must lock conversation -> pet before the private slot-locking body';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 15: a past confirmed appointment does not block a new future hold.
-- =========================================================================
do $$
declare
  v_pet_id uuid := '39300000-0000-0000-0000-0000000000cf';
  v_old_slot_id uuid := '39400000-0000-0000-0000-0000000000cf';
  v_new_slot_id uuid := '39400000-0000-0000-0000-0000000000d0';
  v_old_conv uuid;
  v_new_conv uuid;
  v_owner_id uuid;
  v_result text;
begin
  select c.id, c.owner_id into v_old_conv, v_owner_id
  from public.conversations c where c.pet_id = v_pet_id;

  update public.appointment_slots
    set starts_at = date_trunc('hour', pg_catalog.now()) - interval '2 hours',
        ends_at = date_trunc('hour', pg_catalog.now()) - interval '90 minutes',
        status = 'confirmed', conversation_id = v_old_conv, owner_id = v_owner_id,
        pet_id = v_pet_id, booking_token = pg_catalog.gen_random_uuid(),
        hold_until = null, confirmed_at = pg_catalog.now() - interval '3 hours'
  where id = v_old_slot_id;

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
  values (
    v_new_slot_id, '39100000-0000-0000-0000-000000000001',
    date_trunc('hour', pg_catalog.now()) + interval '8 hours',
    date_trunc('hour', pg_catalog.now()) + interval '8 hours 30 minutes', 'available'
  );

  set local role service_role;
  perform result from public.ingest_whatsapp_text_message(
    '939100001', 'wamid.039-F15', repeat('a', 64), '+15559100026',
    '039 Fixture Owner stale_keep', 'yeni randevu', pg_catalog.now()
  );
  reset role;
  select m.conversation_id into v_new_conv
  from public.messages m where m.whatsapp_message_id = 'wamid.039-F15';
  update public.conversations
    set intake_stage = 'appointment_offer', pet_id = v_pet_id, status = 'active'
  where id = v_new_conv;

  select h.result into v_result
  from public.hold_appointment_slot(v_new_conv, v_new_slot_id) h;
  if v_result <> 'held' then
    raise exception 'fixture 15: past confirmed appointment must not block a new hold, got %', v_result;
  end if;
end;
$$;

reset role;
-- Rollback-proof: nothing written by this fixture is ever committed.
rollback;
