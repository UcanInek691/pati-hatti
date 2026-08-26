-- Rollback-only proof for public.finalize_intake_dead_letter. Sonnet does
-- NOT run this file against any database; Codex alone validates it in the
-- disposable `vetai-test` project. Never run this fixture script against a
-- real clinic database. See docs/inbound-queue.md and docs/database-schema.md.

begin;

insert into public.clinics (id, name)
values
  ('02400000-0000-0000-0000-000000000001', 'DLQ Test Clinic A'),
  ('02400000-0000-0000-0000-000000000002', 'DLQ Test Clinic B');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('02400000-0000-0000-0000-000000000011', '02400000-0000-0000-0000-000000000001', 'DLQ Owner X', '+15550240001'),
  ('02400000-0000-0000-0000-000000000012', '02400000-0000-0000-0000-000000000001', 'DLQ Owner W', '+15550240002'),
  ('02400000-0000-0000-0000-000000000013', '02400000-0000-0000-0000-000000000001', 'DLQ Owner Z', '+15550240003'),
  ('02400000-0000-0000-0000-000000000014', '02400000-0000-0000-0000-000000000001', 'DLQ Owner Y', '+15550240004'),
  ('02400000-0000-0000-0000-000000000015', '02400000-0000-0000-0000-000000000001', 'DLQ Owner U', '+15550240005'),
  ('02400000-0000-0000-0000-000000000016', '02400000-0000-0000-0000-000000000001', 'DLQ Owner Empty', '+15550240006'),
  ('02400000-0000-0000-0000-000000000021', '02400000-0000-0000-0000-000000000002', 'DLQ Owner V (clinic B)', '+15550240011');

insert into public.conversations (id, clinic_id, owner_id, status)
values
  ('02400000-0000-0000-0000-000000000031', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000011', 'active'),
  ('02400000-0000-0000-0000-000000000032', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000012', 'active'),
  ('02400000-0000-0000-0000-000000000033', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000013', 'active'),
  ('02400000-0000-0000-0000-000000000034', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000014', 'active'),
  ('02400000-0000-0000-0000-000000000035', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000015', 'active'),
  ('02400000-0000-0000-0000-000000000036', '02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000016', 'active'),
  ('02400000-0000-0000-0000-000000000041', '02400000-0000-0000-0000-000000000002', '02400000-0000-0000-0000-000000000021', 'active');

-- =========================================================================
-- Function shape: SECURITY INVOKER, VOLATILE, empty search_path, and
-- service_role-only execute privilege.
-- =========================================================================

do $$
declare
  v_function_count integer;
  v_grantees text[];
  v_owner_name text;
begin
  select count(*) into v_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'finalize_intake_dead_letter';
  if v_function_count <> 1 then
    raise exception 'expected exactly one finalize_intake_dead_letter function, got %', v_function_count;
  end if;

  perform 1
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'finalize_intake_dead_letter'
    and p.pronargs = 2
    and p.provolatile = 'v'
    and not p.prosecdef
    and p.proconfig is not null
    and (p.proconfig @> array['search_path=""'] or p.proconfig @> array['search_path=']);
  if not found then
    raise exception 'expected finalize_intake_dead_letter to be a 2-arg SECURITY INVOKER VOLATILE function with an empty search_path';
  end if;

  select array_agg(distinct rp.grantee::text order by rp.grantee::text),
         pg_catalog.pg_get_userbyid(p.proowner)::text
    into v_grantees, v_owner_name
  from information_schema.routine_privileges rp
  join pg_catalog.pg_proc p on p.proname = rp.routine_name
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = rp.routine_schema
  where rp.routine_schema = 'public' and rp.routine_name = 'finalize_intake_dead_letter'
  group by p.proowner;

  if not ('service_role' = any(v_grantees)) or exists (
    select 1 from unnest(v_grantees) as grantee where grantee not in ('service_role', v_owner_name)
  ) then
    raise exception 'expected only service_role plus the function owner to have execute privilege, got %', v_grantees;
  end if;
end;
$$;

-- staff_work_items RLS/grants/policy must be unchanged: this migration adds
-- no table, column, policy, or grant.
do $$
begin
  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'staff_work_items') <> 1
    or not exists (
      select 1 from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = 'staff_work_items'
        and policyname = 'staff_work_items_select'
        and qual ~ 'is_clinic_staff'
    ) then
    raise exception 'expected staff_work_items to retain exactly its original select-only policy';
  end if;

  if exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'authenticated' and privilege_type <> 'SELECT'
  ) or not exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'authenticated' and privilege_type = 'SELECT'
  ) or exists (
    select 1 from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'anon'
  ) then
    raise exception 'expected staff_work_items grants (authenticated: select only, anon: none) to remain unchanged';
  end if;
end;
$$;

-- This migration adds no FK, but production readiness depends on the
-- pre-existing owner/account/source erasure chains remaining CASCADE. Prove
-- the structural links directly instead of rebuilding unrelated delivery
-- fixtures here.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.conversations'::regclass
      and confrelid = 'public.owners'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.staff_work_items'::regclass
      and confrelid = 'public.conversations'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) then
    raise exception 'expected owner -> conversation -> staff work item erasure cascade to remain intact';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.outbound_message_outbox'::regclass
      and confrelid = 'public.whatsapp_accounts'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.outbound_message_outbox'::regclass
      and confrelid = 'public.webhook_events'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) or not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.staff_work_items'::regclass
      and confrelid = 'public.outbound_message_outbox'::regclass
      and contype = 'f' and confdeltype = 'c'
  ) then
    raise exception 'expected account/source -> outbox -> staff work item erasure cascades to remain intact';
  end if;
end;
$$;

-- The new function must never hardcode a safety-signal name.
do $$
begin
  if (
    select pg_catalog.pg_get_functiondef(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'finalize_intake_dead_letter'
  ) ~ 'reported_safety_signals' then
    raise exception 'expected finalize_intake_dead_letter to never reference a safety-signal name directly';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 1: pending/processing hand-off, staff visibility, and a replay
-- that must not duplicate work or bump state again.
-- =========================================================================

-- Seed conversation X with real prior intake progress, as a normal DLQ
-- arrival would find (an earlier message already advanced the state; the
-- message under test is the one whose primary-consumer retries exhausted).
set local role service_role;
do $$
declare
  v_stage text;
  v_version integer;
begin
  select advanced.intake_stage, advanced.state_version into v_stage, v_version
  from public.advance_conversation_intake(
    '02400000-0000-0000-0000-000000000031'::uuid, 1, 'complaint_collection', null, '{"note": "seed-x"}'::jsonb
  ) advanced;
  if v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected conv X to seed at complaint_collection/2, got %/%', v_stage, v_version;
  end if;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000031', 'inbound', 'stuck message X2', 'wamid.DLQ.X2');

-- Unexpired processing lease: the message was claimed once and its primary
-- consumer retries exhausted before finalize_intake_queue_job ever ran.
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status, intake_claim_token, intake_lease_until)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.X2', 'hash-x2', 'processed', 'processing', gen_random_uuid(), now() + interval '2 minutes');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000031'::uuid, 'wamid.DLQ.X2');
  if v_result <> 'handed_off' then
    raise exception 'expected handed_off for conv X, got %', v_result;
  end if;

  if (select intake_stage from public.conversations where id = '02400000-0000-0000-0000-000000000031') <> 'human_handoff'
    or (select state_version from public.conversations where id = '02400000-0000-0000-0000-000000000031') <> 3
    or (select status from public.conversations where id = '02400000-0000-0000-0000-000000000031') <> 'handoff'
    or (select intake_data from public.conversations where id = '02400000-0000-0000-0000-000000000031') <> '{"note": "seed-x"}'::jsonb then
    raise exception 'expected conv X to reach human_handoff/3/handoff with its intake_data preserved';
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.X2') <> 'completed'
    or (select intake_claim_token from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.X2') is not null
    or (select intake_lease_until from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.X2') is not null
    or (select intake_completed_at from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.X2') is null then
    raise exception 'expected the X2 lease to be coherently completed';
  end if;

  if (select count(*) from public.staff_work_items where clinic_id = '02400000-0000-0000-0000-000000000001' and conversation_id = '02400000-0000-0000-0000-000000000031') <> 1
    or not exists (
      select 1 from public.staff_work_items
      where clinic_id = '02400000-0000-0000-0000-000000000001' and conversation_id = '02400000-0000-0000-0000-000000000031'
        and kind = 'human_handoff' and priority = 'normal' and reason = 'human_handoff' and status = 'open'
    ) then
    raise exception 'expected exactly one normal-priority staff work item for conv X';
  end if;

  -- Replay with the exact same event must not mutate state or duplicate work.
  select result into v_result
  from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000031'::uuid, 'wamid.DLQ.X2');
  if v_result <> 'already_completed' then
    raise exception 'expected already_completed on replay for conv X, got %', v_result;
  end if;
  if (select state_version from public.conversations where id = '02400000-0000-0000-0000-000000000031') <> 3 then
    raise exception 'replay must not bump conv X state_version again';
  end if;
  if (select count(*) from public.staff_work_items where clinic_id = '02400000-0000-0000-0000-000000000001' and conversation_id = '02400000-0000-0000-0000-000000000031') <> 1 then
    raise exception 'replay must not duplicate the staff work item for conv X';
  end if;
end;
$$;
reset role;

-- A first-message failure leaves the core schema's default empty intake
-- document. The DLQ must still terminate it instead of poisoning its own
-- retries.
insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000036', 'inbound', 'first stuck message', 'wamid.DLQ.EMPTY');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.EMPTY', 'hash-empty', 'processed', 'pending');

set local role service_role;
do $$
declare
  v_result text;
begin
  select f.result into v_result
  from public.finalize_intake_dead_letter(
    '02400000-0000-0000-0000-000000000036'::uuid, 'wamid.DLQ.EMPTY'
  ) f;
  if v_result <> 'handed_off' then
    raise exception 'expected empty-snapshot DLQ handoff, got %', v_result;
  end if;
  if (select intake_stage from public.conversations where id = '02400000-0000-0000-0000-000000000036') <> 'human_handoff'
    or (select intake_data from public.conversations where id = '02400000-0000-0000-0000-000000000036') <> '{"dead_letter_handoff": true}'::jsonb
    or (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.EMPTY') <> 'completed' then
    raise exception 'empty-snapshot handoff did not persist the coherent terminal marker/event state';
  end if;
  if (select count(*) from public.staff_work_items where conversation_id = '02400000-0000-0000-0000-000000000036' and status = 'open') <> 1 then
    raise exception 'empty-snapshot handoff must create exactly one open staff work item';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 2: an expired-processing lease reaches the same coherent
-- completed state as a fresh one -- this finalizer never checks lease
-- expiry, unlike claim_intake_queue_job.
-- =========================================================================

set local role service_role;
do $$
begin
  perform advanced.intake_stage
  from public.advance_conversation_intake(
    '02400000-0000-0000-0000-000000000034'::uuid, 1, 'complaint_collection', null, '{"note": "seed-y"}'::jsonb
  ) advanced;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000034', 'inbound', 'stuck message Y2', 'wamid.DLQ.Y2');

insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status, intake_claim_token, intake_lease_until)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.Y2', 'hash-y2', 'processed', 'processing', gen_random_uuid(), now() - interval '1 hour');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000034'::uuid, 'wamid.DLQ.Y2');
  if v_result <> 'handed_off' then
    raise exception 'expected handed_off for conv Y (expired lease), got %', v_result;
  end if;
  if (select intake_stage from public.conversations where id = '02400000-0000-0000-0000-000000000034') <> 'human_handoff'
    or (select state_version from public.conversations where id = '02400000-0000-0000-0000-000000000034') <> 3 then
    raise exception 'expected conv Y to reach human_handoff/3 despite the expired lease';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.Y2') <> 'completed' then
    raise exception 'expected the expired Y2 lease to still reach completed';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 3: a pending event with a persisted true safety signal upgrades
-- the trigger-created staff item to urgent/emergency_handoff without the
-- new function ever naming the signal.
-- =========================================================================

set local role service_role;
do $$
begin
  perform advanced.intake_stage
  from public.advance_conversation_intake(
    '02400000-0000-0000-0000-000000000033'::uuid, 1, 'complaint_collection', null,
    '{"reported_safety_signals": {"seizure": true}}'::jsonb
  ) advanced;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000033', 'inbound', 'stuck message Z2', 'wamid.DLQ.Z2');

-- Pending: never claimed at all before its primary-consumer job exhausted.
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.Z2', 'hash-z2', 'processed', 'pending');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000033'::uuid, 'wamid.DLQ.Z2');
  if v_result <> 'handed_off' then
    raise exception 'expected handed_off for conv Z (pending), got %', v_result;
  end if;

  if not exists (
    select 1 from public.staff_work_items
    where clinic_id = '02400000-0000-0000-0000-000000000001' and conversation_id = '02400000-0000-0000-0000-000000000033'
      and kind = 'human_handoff' and priority = 'urgent' and reason = 'emergency_handoff' and status = 'open'
  ) then
    raise exception 'expected an urgent/emergency_handoff staff work item for conv Z';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 4: a conversation already at the terminal completed stage must
-- only complete the event -- never regress the conversation or create a
-- false staff item.
-- =========================================================================

set local role service_role;
do $$
declare
  v_version integer := 1;
  v_stage text;
  v_advanced_stage text;
  v_advanced_version integer;
  -- Task 036: intake_confirmation sits between complaint_collection and
  -- safety_check; this walk must list every rank in order or it trips the
  -- one-step-forward rule.
  v_stages text[] := array['complaint_collection', 'intake_confirmation', 'safety_check', 'ready_for_triage', 'appointment_offer', 'appointment_selection', 'appointment_confirmation', 'completed'];
begin
  foreach v_stage in array v_stages loop
    select advanced.intake_stage, advanced.state_version into v_advanced_stage, v_advanced_version
    from public.advance_conversation_intake(
      '02400000-0000-0000-0000-000000000032'::uuid, v_version, v_stage, null, '{"note": "seed-w"}'::jsonb
    ) advanced;
    if v_advanced_stage <> v_stage then
      raise exception 'expected conv W to reach %, got %', v_stage, v_advanced_stage;
    end if;
    v_version := v_advanced_version;
  end loop;
  if v_version <> 9 then
    raise exception 'expected conv W final state_version 9, got %', v_version;
  end if;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000032', 'inbound', 'stuck message W2', 'wamid.DLQ.W2');

insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status, intake_claim_token, intake_lease_until)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.W2', 'hash-w2', 'processed', 'processing', gen_random_uuid(), now() + interval '2 minutes');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000032'::uuid, 'wamid.DLQ.W2');
  if v_result <> 'already_terminal' then
    raise exception 'expected already_terminal for conv W, got %', v_result;
  end if;

  if (select intake_stage from public.conversations where id = '02400000-0000-0000-0000-000000000032') <> 'completed'
    or (select state_version from public.conversations where id = '02400000-0000-0000-0000-000000000032') <> 9 then
    raise exception 'already_terminal must never regress or advance conv W';
  end if;

  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.W2') <> 'completed'
    or (select intake_completed_at from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.W2') is null then
    raise exception 'expected the W2 event to still be marked completed';
  end if;

  if exists (select 1 from public.staff_work_items where clinic_id = '02400000-0000-0000-0000-000000000001' and conversation_id = '02400000-0000-0000-0000-000000000032') then
    raise exception 'already_terminal must never create a staff work item';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 5: fail-closed on absent/mismatched/outbound/cross-tenant input,
-- with zero partial mutation in every case.
-- =========================================================================

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000034', 'inbound', 'mismatch probe', 'wamid.DLQ.MISMATCH');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.MISMATCH', 'hash-mismatch', 'processed', 'pending');

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000031', 'outbound', 'outbound probe', 'wamid.DLQ.OUT');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.OUT', 'hash-out', 'processed', 'pending');

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000002', '02400000-0000-0000-0000-000000000041', 'inbound', 'cross tenant probe', 'wamid.DLQ.CROSS');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000002', 'wamid.DLQ.CROSS', 'hash-cross', 'processed', 'pending');

set local role service_role;
do $$
declare
  v_result text;
begin
  -- Absent pair entirely.
  select result into v_result from public.finalize_intake_dead_letter(gen_random_uuid(), 'wamid.DLQ.NOPE');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an absent pair, got %', v_result;
  end if;

  -- Conversation and provider_message_id that do not belong to each other.
  select result into v_result from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000031'::uuid, 'wamid.DLQ.MISMATCH');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a mismatched conversation/message pair, got %', v_result;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.MISMATCH') <> 'pending' then
    raise exception 'a mismatched pair must leave the unrelated event untouched';
  end if;

  -- Outbound message reusing the target conversation.
  select result into v_result from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000031'::uuid, 'wamid.DLQ.OUT');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an outbound message, got %', v_result;
  end if;

  -- Cross-tenant: clinic A conversation against clinic B's provider id.
  select result into v_result from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000031'::uuid, 'wamid.DLQ.CROSS');
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-tenant provider id, got %', v_result;
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000002' and provider_event_id = 'wamid.DLQ.CROSS') <> 'pending' then
    raise exception 'a cross-tenant probe must leave the other clinic''s event untouched';
  end if;
end;
$$;
reset role;

-- Invalid UUID text fails closed at the call boundary with zero mutation.
set local role service_role;
do $$
declare
  v_rejected boolean := false;
begin
  begin
    perform result from public.finalize_intake_dead_letter('not-a-uuid'::uuid, 'wamid.DLQ.BADUUID');
  exception
    when invalid_text_representation then
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected an invalid UUID literal to be rejected before any mutation';
  end if;
end;
$$;
reset role;

-- anon and authenticated must not be able to execute the RPC at all.
set local role authenticated;
do $$
begin
  begin
    perform result from public.finalize_intake_dead_letter(gen_random_uuid(), 'wamid.DLQ.AUTH_DENIED');
    raise exception 'authenticated role unexpectedly executed finalize_intake_dead_letter';
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
    perform result from public.finalize_intake_dead_letter(gen_random_uuid(), 'wamid.DLQ.ANON_DENIED');
    raise exception 'anon role unexpectedly executed finalize_intake_dead_letter';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 6: an induced failure after the conversation advances must roll
-- back the conversation update, the trigger-created staff item, and the
-- event completion together -- nothing partial survives.
-- =========================================================================

set local role service_role;
do $$
begin
  perform advanced.intake_stage
  from public.advance_conversation_intake(
    '02400000-0000-0000-0000-000000000035'::uuid, 1, 'complaint_collection', null, '{"note": "seed-u"}'::jsonb
  ) advanced;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000035', 'inbound', 'stuck message U2', 'wamid.DLQ.U2');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('02400000-0000-0000-0000-000000000001', 'wamid.DLQ.U2', 'hash-u2', 'processed', 'pending');

create function pg_temp.induce_test_failure() returns trigger
language plpgsql as $$
begin
  raise exception 'induced_test_failure';
end;
$$;

create trigger induce_failure_before_insert
  before insert on public.staff_work_items
  for each row
  when (new.conversation_id = '02400000-0000-0000-0000-000000000035'::uuid)
  execute function pg_temp.induce_test_failure();

set local role service_role;
do $$
declare
  v_rejected boolean := false;
begin
  begin
    perform result from public.finalize_intake_dead_letter('02400000-0000-0000-0000-000000000035'::uuid, 'wamid.DLQ.U2');
    raise exception 'expected the induced trigger failure to abort finalize_intake_dead_letter';
  exception
    when others then
      if sqlerrm <> 'induced_test_failure' then
        raise;
      end if;
      v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'induced failure probe did not run as expected';
  end if;
end;
$$;
reset role;

drop trigger induce_failure_before_insert on public.staff_work_items;

do $$
begin
  if (select intake_stage from public.conversations where id = '02400000-0000-0000-0000-000000000035') <> 'complaint_collection'
    or (select state_version from public.conversations where id = '02400000-0000-0000-0000-000000000035') <> 2 then
    raise exception 'an induced downstream failure must not partially advance the conversation';
  end if;
  if (select intake_status from public.webhook_events where clinic_id = '02400000-0000-0000-0000-000000000001' and provider_event_id = 'wamid.DLQ.U2') <> 'pending' then
    raise exception 'an induced downstream failure must not partially complete the event';
  end if;
  if exists (select 1 from public.staff_work_items where conversation_id = '02400000-0000-0000-0000-000000000035') then
    raise exception 'an induced downstream failure must not leave a partial staff work item';
  end if;
end;
$$;

-- =========================================================================
-- Owner/account/source/clinic erasure cascades remain intact: this
-- migration adds no new table or FK, verified defensively.
-- =========================================================================

delete from public.clinics where id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002');

do $$
begin
  if exists (select 1 from public.owners where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002'))
    or exists (select 1 from public.conversations where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002'))
    or exists (select 1 from public.messages where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002'))
    or exists (select 1 from public.webhook_events where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002'))
    or exists (select 1 from public.staff_work_items where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) then
    raise exception 'expected clinic deletion to cascade through owners/conversations/messages/webhook_events/staff_work_items unchanged';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_clinics,
  (select count(*) from public.owners where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_owners,
  (select count(*) from public.conversations where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_messages,
  (select count(*) from public.webhook_events where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_webhook_events,
  (select count(*) from public.staff_work_items where clinic_id in ('02400000-0000-0000-0000-000000000001', '02400000-0000-0000-0000-000000000002')) as remaining_test_staff_work_items;
