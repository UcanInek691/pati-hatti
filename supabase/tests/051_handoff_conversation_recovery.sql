-- Rollback-only, behavioral proof for Task 051 (safe terminal-handoff
-- recovery). Never run this fixture script against a real clinic database.
--
-- Single-session limit: this fixture proves the documented row-state
-- contract inside one PostgreSQL session using sequential calls, matching
-- Task 032's own fixture. It does not and cannot execute true two-session
-- lock contention; the "for key share of cl" / "for no key update" /
-- "for key share of cs" / "for update" lock order (CURRENT_TASK.md's
-- 6-step order) is instead
-- verified from the stored function definition, and the
-- "identity changed during lock acquisition" guard (step 5) is not directly
-- exercised for the same reason.
--
-- Role-switch convention (matches supabase/tests/032_staff_assignment_and_alerts.sql
-- and 049_route_resolver_volatility.sql): "set local role" / "select
-- set_config(...)" / "reset role" always run as bare top-level statements
-- bracketing a "do $$ ... $$" block, never inside one. All other setup runs
-- under the session's own unrestricted role, same as those two fixtures.
--
-- Codex must run this fixture only on disposable vetai-test, with zero
-- residue, before any staging activation. See CURRENT_TASK.md and
-- docs/staff-workflow.md.

begin;

-- =========================================================================
-- 1. Function catalog: exact identity, VOLATILE, SECURITY DEFINER, empty
--    search_path, unchanged public result shape, no dynamic SQL, and the
--    four lock-order markers present in the stored definition.
-- =========================================================================

do $$
declare
  v_count int;
  v_provolatile "char";
  v_prosecdef boolean;
  v_search_path text;
  v_result_shape text;
  v_definition text;
  v_definition_code text;
  v_owner oid;
  v_claim_owner oid;
begin
  select count(*) into v_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_staff_work_item';
  if v_count <> 1 then
    raise exception 'expected exactly one public.resolve_staff_work_item, found %', v_count;
  end if;

  select p.provolatile, p.prosecdef, p.proowner,
         (select o.option_value from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path'),
         pg_get_function_result(p.oid),
         pg_get_functiondef(p.oid)
    into v_provolatile, v_prosecdef, v_owner, v_search_path, v_result_shape, v_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_staff_work_item'
    and pg_get_function_identity_arguments(p.oid) = 'p_work_item_id uuid';

  if not found then
    raise exception 'resolve_staff_work_item signature drifted from (p_work_item_id uuid)';
  end if;
  if v_provolatile <> 'v' then
    raise exception 'resolve_staff_work_item must be VOLATILE, found %', v_provolatile;
  end if;
  if not v_prosecdef then
    raise exception 'resolve_staff_work_item must stay SECURITY DEFINER';
  end if;
  if v_search_path is distinct from '""' then
    raise exception 'resolve_staff_work_item must keep empty search_path, found %', v_search_path;
  end if;
  if v_result_shape <> 'TABLE(result text)' then
    raise exception 'resolve_staff_work_item public result shape changed: %', v_result_shape;
  end if;
  select p.proowner into v_claim_owner
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'claim_staff_work_item'
    and pg_get_function_identity_arguments(p.oid) = 'p_work_item_id uuid';
  if not found or v_owner is distinct from v_claim_owner then
    raise exception 'resolve_staff_work_item owner must match claim_staff_work_item owner';
  end if;

  v_definition_code := pg_catalog.regexp_replace(v_definition, '--[^\n]*', '', 'g');
  if v_definition_code ~* '\mexecute\M' then
    raise exception 'resolve_staff_work_item must stay dynamic-SQL-free';
  end if;
  if v_definition_code !~* 'for key share of cl' then
    raise exception 'resolve_staff_work_item lost the clinic row lock (step 2)';
  end if;
  if v_definition_code !~* 'for key share of cs' then
    raise exception 'resolve_staff_work_item lost the membership row lock (step 3)';
  end if;
  if v_definition_code !~* 'for no key update' then
    raise exception 'resolve_staff_work_item lost the conversation row lock (step 4)';
  end if;
  if v_definition_code !~* 'for update' then
    raise exception 'resolve_staff_work_item lost the work item row lock (step 5)';
  end if;
  if not (
    pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for key share of cl')
      < pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for key share of cs')
    and pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for key share of cs')
      < pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for no key update')
    and pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for no key update')
      < pg_catalog.strpos(pg_catalog.lower(v_definition_code), 'for update')
  ) then
    raise exception 'resolve_staff_work_item lock order drifted';
  end if;
end;
$$;

-- =========================================================================
-- 2. Grants: PUBLIC/anon/service_role denied, authenticated retained.
-- =========================================================================

do $$
begin
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'resolve_staff_work_item'
      and grantee in ('PUBLIC', 'anon', 'service_role') and privilege_type = 'EXECUTE'
  ) then
    raise exception 'resolve_staff_work_item must not be executable by PUBLIC, anon or service_role';
  end if;
  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'resolve_staff_work_item'
      and grantee = 'authenticated' and privilege_type = 'EXECUTE'
  ) then
    raise exception 'authenticated must retain execute on resolve_staff_work_item';
  end if;
end;
$$;

-- =========================================================================
-- Synthetic fixtures: two clinics, four Auth users, one WhatsApp account.
-- All setup below runs under the session's own unrestricted role, exactly
-- like supabase/tests/032_staff_assignment_and_alerts.sql.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('05100000-0000-0000-0000-000000000001', 'Task 051 Test Clinic A'),
  ('05100000-0000-0000-0000-000000000002', 'Task 051 Test Clinic B');

-- Task 041: clinics default to suspended; activate for the ingest-driven
-- scenarios below (Fixture points 4 and 7 need a real inbound-message path).
update public.clinics set operational_status = 'active', suspended_at = null
where id in ('05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('05100000-0000-0000-0000-000000000101', 'authenticated', 'authenticated', 't051-a1@example.invalid', now(), now()),
  ('05100000-0000-0000-0000-000000000102', 'authenticated', 'authenticated', 't051-a2@example.invalid', now(), now()),
  ('05100000-0000-0000-0000-000000000103', 'authenticated', 'authenticated', 't051-b1@example.invalid', now(), now()),
  ('05100000-0000-0000-0000-000000000104', 'authenticated', 'authenticated', 't051-nostaff@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000101', 'admin'),
  ('05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000102', 'admin'),
  ('05100000-0000-0000-0000-000000000002', '05100000-0000-0000-0000-000000000103', 'admin');
-- ...104 intentionally has no clinic_staff row (non-member).

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('05100000-0000-0000-0000-000000000011', '05100000-0000-0000-0000-000000000001', '951000001');

-- The repository default is deliberately fail-closed (`personal`). These
-- exact synthetic contacts are the only ones that must traverse the real
-- ingest path in scenarios 01 and 09.
insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values
  ('05100000-0000-0000-0000-000000000011', '05100000-0000-0000-0000-000000000001', '+15559970001', 'ai'),
  ('05100000-0000-0000-0000-000000000011', '05100000-0000-0000-0000-000000000001', '+15559970009', 'ai');

-- Local helper: creates one owner/conversation and drives it into the exact
-- paired human_handoff state (status = 'handoff', intake_stage =
-- 'human_handoff'), through the unchanged Task 020/032 trigger. Unlike Task
-- 032's own make_handoff_item (which left status untouched), this also sets
-- status = 'handoff' to match what public.advance_conversation_intake does
-- in real usage, since Task 051 decision 9 branches on the exact
-- (status, intake_stage) pairing.
create function pg_temp.make_handoff_item(
  p_clinic_id uuid, p_owner_id uuid, p_owner_name text, p_owner_phone text, p_conv_id uuid,
  p_intake_data jsonb default '{}'::jsonb
) returns uuid
language plpgsql
as $$
declare
  v_item_id uuid;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values (p_owner_id, p_clinic_id, p_owner_name, p_owner_phone);
  insert into public.conversations (id, clinic_id, owner_id) values (p_conv_id, p_clinic_id, p_owner_id);
  update public.conversations
    set intake_stage = 'human_handoff', status = 'handoff', intake_data = p_intake_data,
        state_version = state_version + 1
    where id = p_conv_id;
  select id into v_item_id from public.staff_work_items where conversation_id = p_conv_id;
  if v_item_id is null then
    raise exception 'make_handoff_item: trigger did not create a work item for conversation %', p_conv_id;
  end if;
  return v_item_id;
end;
$$;

-- Local helper: runs the already-reviewed ingest -> claim -> finalize path to
-- produce one real, atomically-persisted pending outbox row. Copied from
-- supabase/tests/032_staff_assignment_and_alerts.sql.
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
    p_provider_timestamp => now()
  );

  select conversation_id into v_conversation_id
  from public.messages
  where whatsapp_message_id = p_provider_message_id;

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, p_provider_message_id);
  if v_claim_result <> 'claimed' then
    raise exception 'make_outbox_row: expected claimed for %, got %', p_provider_message_id, v_claim_result;
  end if;

  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, p_provider_message_id, v_token, 1, 'complaint_collection', null,
    '{"note": "fixture"}'::jsonb, p_reply_category, p_reply_text
  );
  if v_finalize_result <> 'applied' then
    raise exception 'make_outbox_row: expected applied for %, got %', p_provider_message_id, v_finalize_result;
  end if;

  select id into v_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  return v_outbox_id;
end;
$$;

-- =========================================================================
-- 3. anon/service_role are denied at the grant layer (never reach the
--    body), regardless of the work item id supplied.
-- =========================================================================

set local role anon;
do $$
begin
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000');
    raise exception 'anon role unexpectedly executed resolve_staff_work_item';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
begin
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000');
    raise exception 'service_role unexpectedly executed resolve_staff_work_item';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Scenario 01 setup: an ordinary paired human_handoff conversation.
-- =========================================================================

do $$
begin
  perform pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000201',
    'Normal Handoff Owner', '+15559970001', '05100000-0000-0000-0000-000000000301',
    '{"fixture_note":"preserve-me"}'::jsonb
  );

  insert into public.pets (id, clinic_id, owner_id, name, species)
  values (
    '05100000-0000-0000-0000-000000000401', '05100000-0000-0000-0000-000000000001',
    '05100000-0000-0000-0000-000000000201', 'Pamuk', 'cat'
  );
  update public.conversations
  set pet_id = '05100000-0000-0000-0000-000000000401'
  where id = '05100000-0000-0000-0000-000000000301';
  insert into public.messages (id, clinic_id, conversation_id, direction, content)
  values (
    '05100000-0000-0000-0000-000000000501', '05100000-0000-0000-0000-000000000001',
    '05100000-0000-0000-0000-000000000301', 'system', 'Task 051 preserved message'
  );
  insert into public.appointment_slots (
    id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id,
    booking_token, confirmed_at
  ) values (
    '05100000-0000-0000-0000-000000000601', '05100000-0000-0000-0000-000000000001',
    '2099-01-05 09:00:00+03', '2099-01-05 09:30:00+03', 'confirmed',
    '05100000-0000-0000-0000-000000000301', '05100000-0000-0000-0000-000000000201',
    '05100000-0000-0000-0000-000000000401', '05100000-0000-0000-0000-000000000701', now()
  );

  create temporary table scenario01_preserved_before (
    entity text primary key,
    snapshot jsonb not null
  ) on commit drop;
  insert into scenario01_preserved_before (entity, snapshot)
  select 'owner', to_jsonb(o) from public.owners o
    where o.id = '05100000-0000-0000-0000-000000000201'
  union all
  select 'pet', to_jsonb(p) from public.pets p
    where p.id = '05100000-0000-0000-0000-000000000401'
  union all
  select 'message', to_jsonb(m) from public.messages m
    where m.id = '05100000-0000-0000-0000-000000000501'
  union all
  select 'appointment', to_jsonb(s) from public.appointment_slots s
    where s.id = '05100000-0000-0000-0000-000000000601';
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000301' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'scenario 01 setup: expected handoff/human_handoff';
  end if;
end;
$$;

-- Scenario 01: normal human_handoff success and an already_resolved replay
-- (fixture points 3 and 4), as the assigned staff member.

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_conv01 uuid := '05100000-0000-0000-0000-000000000301';
  v_item01 uuid;
  v_result text;
  v_version_before int;
  v_version_after int;
  v_pet_id_before uuid;
  v_intake_data_before jsonb;
begin
  select id into v_item01 from public.staff_work_items where conversation_id = v_conv01;
  select state_version, pet_id, intake_data
    into v_version_before, v_pet_id_before, v_intake_data_before
  from public.conversations where id = v_conv01;

  select result into v_result from public.claim_staff_work_item(v_item01);
  if v_result <> 'claimed' then
    raise exception 'scenario 01: expected claimed, got %', v_result;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item01);
  if v_result <> 'resolved' then
    raise exception 'scenario 01: expected resolved, got %', v_result;
  end if;

  select state_version into v_version_after from public.conversations where id = v_conv01;
  if not exists (
    select 1 from public.conversations where id = v_conv01 and status = 'completed' and intake_stage = 'completed'
  ) then
    raise exception 'scenario 01: expected conversation completed/completed';
  end if;
  if v_version_after <> v_version_before + 1 then
    raise exception 'scenario 01: expected exactly one version increment, % -> %', v_version_before, v_version_after;
  end if;
  if not exists (
    select 1 from public.conversations
    where id = v_conv01 and pet_id is not distinct from v_pet_id_before
      and intake_data is not distinct from v_intake_data_before
  ) then
    raise exception 'scenario 01: pet_id or intake_data changed during resolution';
  end if;
  if not exists (
    select 1 from public.staff_work_items
    where id = v_item01 and status = 'resolved' and resolved_by = '05100000-0000-0000-0000-000000000101' and resolved_at is not null
  ) then
    raise exception 'scenario 01: expected work item resolved with resolver audit set';
  end if;

  -- Already_resolved replay: no further mutation.
  select result into v_result from public.resolve_staff_work_item(v_item01);
  if v_result <> 'already_resolved' then
    raise exception 'scenario 01: expected already_resolved on replay, got %', v_result;
  end if;
  if not exists (
    select 1 from public.conversations
    where id = v_conv01 and status = 'completed' and intake_stage = 'completed' and state_version = v_version_after
  ) then
    raise exception 'scenario 01: already_resolved replay must not mutate the conversation again';
  end if;
end;
$$;
reset role;

do $$
begin
  if (select snapshot from scenario01_preserved_before where entity = 'owner') is distinct from
     (select to_jsonb(o) from public.owners o where o.id = '05100000-0000-0000-0000-000000000201')
    or (select snapshot from scenario01_preserved_before where entity = 'pet') is distinct from
       (select to_jsonb(p) from public.pets p where p.id = '05100000-0000-0000-0000-000000000401')
    or (select snapshot from scenario01_preserved_before where entity = 'message') is distinct from
       (select to_jsonb(m) from public.messages m where m.id = '05100000-0000-0000-0000-000000000501')
    or (select snapshot from scenario01_preserved_before where entity = 'appointment') is distinct from
       (select to_jsonb(s) from public.appointment_slots s where s.id = '05100000-0000-0000-0000-000000000601')
  then
    raise exception 'scenario 01: owner, pet, message or appointment state changed during resolution';
  end if;
end;
$$;

-- Scenario 01 continued: advance_conversation_intake still refuses to move a
-- terminal conversation (fixture point 8), and a real follow-up inbound
-- message creates a different active conversation at the default intake
-- stage while the original stays completed (fixture point 7). Both run as
-- service_role, the only grantee of either function.

set local role service_role;
do $$
declare
  v_conv01 uuid := '05100000-0000-0000-0000-000000000301';
  v_version int;
begin
  select state_version into v_version from public.conversations where id = v_conv01;

  begin
    perform intake_stage from public.advance_conversation_intake(
      v_conv01, v_version, 'complaint_collection', null, '{"note": "fixture"}'::jsonb
    );
    raise exception 'scenario 01: advance_conversation_intake unexpectedly moved a completed conversation';
  exception
    when others then
      if sqlerrm !~* 'is terminal' then
        raise exception 'scenario 01: unexpected advance_conversation_intake error: %', sqlerrm;
      end if;
  end;

  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '951000001',
    p_provider_message_id => 'wamid.T051-S01-FOLLOWUP',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15559970001',
    p_owner_name => 'Normal Handoff Owner',
    p_message_text => 'Merhaba, tekrar yaziyorum.',
    p_provider_timestamp => now()
  );

  if (
    select count(*) from public.conversations c
    join public.owners o on o.id = c.owner_id
    where o.phone_e164 = '+15559970001' and o.clinic_id = '05100000-0000-0000-0000-000000000001'
  ) <> 2 then
    raise exception 'scenario 01: expected exactly two conversations for the owner after the follow-up message';
  end if;
  if not exists (
    select 1 from public.conversations c
    join public.owners o on o.id = c.owner_id
    where o.phone_e164 = '+15559970001' and o.clinic_id = '05100000-0000-0000-0000-000000000001'
      and c.id <> v_conv01 and c.status = 'active' and c.intake_stage = 'pet_identification'
  ) then
    raise exception 'scenario 01: expected a new active conversation at the default intake stage';
  end if;
  if not exists (
    select 1 from public.conversations where id = v_conv01 and status = 'completed' and intake_stage = 'completed'
  ) then
    raise exception 'scenario 01: the original conversation must remain completed after the follow-up message';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Scenario 02: reason = 'emergency_handoff' success. The two-confirmation
-- requirement is client-side /staff behavior (see test/staffPage.test.ts);
-- this proves the same atomic server-side completion applies.
-- =========================================================================

do $$
begin
  perform pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000202',
    'Emergency Handoff Owner', '+15559970002', '05100000-0000-0000-0000-000000000302',
    '{"reported_safety_signals": {"bleeding": true}}'::jsonb
  );
  if not exists (
    select 1 from public.staff_work_items
    where conversation_id = '05100000-0000-0000-0000-000000000302' and reason = 'emergency_handoff' and priority = 'urgent'
  ) then
    raise exception 'scenario 02 setup: expected an urgent emergency_handoff item';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_conv02 uuid := '05100000-0000-0000-0000-000000000302';
  v_item02 uuid;
  v_result text;
  v_version_before int;
begin
  select id into v_item02 from public.staff_work_items where conversation_id = v_conv02;
  select state_version into v_version_before from public.conversations where id = v_conv02;

  select result into v_result from public.claim_staff_work_item(v_item02);
  if v_result <> 'claimed' then
    raise exception 'scenario 02: expected claimed, got %', v_result;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item02);
  if v_result <> 'resolved' then
    raise exception 'scenario 02: expected resolved, got %', v_result;
  end if;

  if not exists (
    select 1 from public.conversations
    where id = v_conv02 and status = 'completed' and intake_stage = 'completed' and state_version = v_version_before + 1
  ) then
    raise exception 'scenario 02: expected the emergency conversation completed with exactly one version increment';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Scenario 03: conversation already exactly completed/completed tolerates
-- resolving the still-assigned handoff item without a second version
-- increment (decision 9, second branch).
-- =========================================================================

do $$
begin
  perform pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000203',
    'Already Completed Owner', '+15559970003', '05100000-0000-0000-0000-000000000303'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_item03 uuid;
  v_result text;
begin
  select id into v_item03 from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000303';
  select result into v_result from public.claim_staff_work_item(v_item03);
  if v_result <> 'claimed' then
    raise exception 'scenario 03: expected claimed, got %', v_result;
  end if;
end;
$$;
reset role;

-- Simulate the conversation already reaching completed/completed by the
-- time the item is resolved (decision 9's tolerated race), without
-- touching state_version, so the test can prove no double increment.
update public.conversations
  set status = 'completed', intake_stage = 'completed'
  where id = '05100000-0000-0000-0000-000000000303';

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_conv03 uuid := '05100000-0000-0000-0000-000000000303';
  v_item03 uuid;
  v_result text;
  v_version_before int;
begin
  select id into v_item03 from public.staff_work_items where conversation_id = v_conv03;
  select state_version into v_version_before from public.conversations where id = v_conv03;

  select result into v_result from public.resolve_staff_work_item(v_item03);
  if v_result <> 'resolved' then
    raise exception 'scenario 03: expected resolved, got %', v_result;
  end if;

  if not exists (
    select 1 from public.conversations
    where id = v_conv03 and status = 'completed' and intake_stage = 'completed' and state_version = v_version_before
  ) then
    raise exception 'scenario 03: expected no additional version increment for an already-terminal conversation';
  end if;
  if not exists (select 1 from public.staff_work_items where id = v_item03 and status = 'resolved') then
    raise exception 'scenario 03: expected the handoff item resolved';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Scenario 04: any other (status, intake_stage) pairing fails closed with
-- an exception and zero mutation (decision 9, else branch).
-- =========================================================================

do $$
begin
  perform pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000204',
    'Inconsistent Pairing Owner', '+15559970004', '05100000-0000-0000-0000-000000000304'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_item04 uuid;
  v_result text;
begin
  select id into v_item04 from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000304';
  select result into v_result from public.claim_staff_work_item(v_item04);
  if v_result <> 'claimed' then
    raise exception 'scenario 04: expected claimed, got %', v_result;
  end if;
end;
$$;
reset role;

-- Hand-corrupt the conversation into a pairing resolve_staff_work_item must
-- never see in practice (neither handoff/human_handoff nor
-- completed/completed), simulating an unrelated bug rather than anything
-- this migration can itself produce.
update public.conversations
  set status = 'active', intake_stage = 'pet_identification'
  where id = '05100000-0000-0000-0000-000000000304';

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_conv04 uuid := '05100000-0000-0000-0000-000000000304';
  v_item04 uuid;
  v_result text;
  v_conv_before public.conversations%rowtype;
  v_conv_after public.conversations%rowtype;
  v_item_before public.staff_work_items%rowtype;
  v_item_after public.staff_work_items%rowtype;
  v_caught boolean := false;
begin
  select id into v_item04 from public.staff_work_items where conversation_id = v_conv04;
  select * into v_conv_before from public.conversations where id = v_conv04;
  select * into v_item_before from public.staff_work_items where id = v_item04;

  begin
    select result into v_result from public.resolve_staff_work_item(v_item04);
    raise exception 'scenario 04: expected an exception for an inconsistent conversation pairing';
  exception
    when others then
      if sqlerrm ~* 'unexpected conversation' then
        v_caught := true;
      else
        raise exception 'scenario 04: unexpected error: %', sqlerrm;
      end if;
  end;

  if not v_caught then
    raise exception 'scenario 04: exception was not raised for the inconsistent pairing';
  end if;

  select * into v_conv_after from public.conversations where id = v_conv04;
  select * into v_item_after from public.staff_work_items where id = v_item04;
  if v_conv_before is distinct from v_conv_after then
    raise exception 'scenario 04: expected zero mutation to the conversation after the failed-closed exception';
  end if;
  if v_item_before is distinct from v_item_after then
    raise exception 'scenario 04: expected zero mutation to the work item after the failed-closed exception';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Scenario 05: not_claimed, null/unknown ids, unauthenticated, non-member
-- and cross-tenant callers are all indistinguishable and make zero
-- mutations (fixture point 2).
-- =========================================================================

do $$
declare
  v_item05 uuid;
  v_version05 integer;
begin
  v_item05 := pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000205',
    'Not Claimed Owner', '+15559970005', '05100000-0000-0000-0000-000000000305'
  );
  select state_version into v_version05
  from public.conversations
  where id = '05100000-0000-0000-0000-000000000305';
  perform set_config('vetai.task051.item05', v_item05::text, true);
  perform set_config('vetai.task051.version05', v_version05::text, true);
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_item05 uuid;
  v_result text;
begin
  v_item05 := current_setting('vetai.task051.item05')::uuid;

  begin
    perform result from public.resolve_staff_work_item(null);
    raise exception 'scenario 05: expected an exception for a null work_item_id';
  exception
    when others then
      if sqlerrm !~* 'invalid work_item_id' then
        raise exception 'scenario 05: unexpected error for null work_item_id: %', sqlerrm;
      end if;
  end;

  select result into v_result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000');
  if v_result <> 'not_found' then
    raise exception 'scenario 05: expected not_found for an unknown work_item_id, got %', v_result;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item05);
  if v_result <> 'not_claimed' then
    raise exception 'scenario 05: expected not_claimed for an open item, got %', v_result;
  end if;
end;
$$;
reset role;

-- unauthenticated: authenticated role, but auth.uid() resolves to null.
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select set_config('request.jwt.claims', '{}'::jsonb::text, true);
do $$
declare
  v_item05 uuid;
  v_result text;
begin
  v_item05 := current_setting('vetai.task051.item05')::uuid;
  select result into v_result from public.resolve_staff_work_item(v_item05);
  if v_result <> 'not_found' then
    raise exception 'scenario 05: expected not_found for an unauthenticated caller, got %', v_result;
  end if;
end;
$$;
reset role;

-- non-member: authenticated, but no clinic_staff row anywhere.
set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000104', true);
do $$
declare
  v_item05 uuid;
  v_result text;
begin
  v_item05 := current_setting('vetai.task051.item05')::uuid;
  select result into v_result from public.resolve_staff_work_item(v_item05);
  if v_result <> 'not_found' then
    raise exception 'scenario 05: expected not_found for a non-member caller, got %', v_result;
  end if;
end;
$$;
reset role;

-- cross-tenant: a real staff member of a different clinic.
set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000103', true);
do $$
declare
  v_item05 uuid;
  v_result text;
begin
  v_item05 := current_setting('vetai.task051.item05')::uuid;
  select result into v_result from public.resolve_staff_work_item(v_item05);
  if v_result <> 'not_found' then
    raise exception 'scenario 05: expected not_found for a cross-tenant caller, got %', v_result;
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1 from public.staff_work_items
    where conversation_id = '05100000-0000-0000-0000-000000000305' and status <> 'open'
  ) then
    raise exception 'scenario 05: expected zero mutation across every negative-path caller';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000305'
      and status = 'handoff'
      and intake_stage = 'human_handoff'
      and state_version = current_setting('vetai.task051.version05')::integer
  ) then
    raise exception 'scenario 05: expected zero mutation to the conversation';
  end if;
end;
$$;

-- =========================================================================
-- Scenario 06: not_owner (claimed by a different same-clinic staff member).
-- =========================================================================

do $$
begin
  perform pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000206',
    'Not Owner Owner', '+15559970006', '05100000-0000-0000-0000-000000000306'
  );
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_item06 uuid;
  v_result text;
begin
  select id into v_item06 from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000306';
  select result into v_result from public.claim_staff_work_item(v_item06);
  if v_result <> 'claimed' then
    raise exception 'scenario 06: expected claimed, got %', v_result;
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000102', true);
do $$
declare
  v_item06 uuid;
  v_result text;
begin
  select id into v_item06 from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000306';
  select result into v_result from public.resolve_staff_work_item(v_item06);
  if v_result <> 'not_owner' then
    raise exception 'scenario 06: expected not_owner for a different same-clinic staff member, got %', v_result;
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1 from public.staff_work_items
    where conversation_id = '05100000-0000-0000-0000-000000000306' and status <> 'in_progress'
  ) then
    raise exception 'scenario 06: expected zero mutation for a not_owner caller';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000306' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'scenario 06: expected zero mutation to the conversation';
  end if;
end;
$$;

-- =========================================================================
-- Scenario 07/08: historical-repair setup (decision 10). Scenario 07 leaves
-- exactly one resolved human_handoff item and no non-resolved one: eligible.
-- Scenario 08 additionally re-opens a second human_handoff item on the same
-- conversation: ineligible, must never be closed.
-- =========================================================================

do $$
declare
  v_item07 uuid;
  v_item08a uuid;
begin
  -- Scenario 07: exactly what the pre-051 bug left behind, i.e. the work
  -- item hand-resolved (as the old resolve_staff_work_item would have left
  -- it) without ever completing the conversation.
  v_item07 := pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000207',
    'Repair Eligible Owner', '+15559970007', '05100000-0000-0000-0000-000000000307'
  );
  update public.staff_work_items
    set status = 'resolved', resolved_at = pg_catalog.now(), resolved_by = '05100000-0000-0000-0000-000000000101'
    where id = v_item07;

  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000307' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'scenario 07 setup: expected the pre-repair conversation to still be stuck in handoff/human_handoff';
  end if;

  -- Scenario 08: same corrupted-history shape, plus a second, still-open
  -- human_handoff item on the same conversation (re-fired after the first
  -- one is resolved, since the partial unique index only blocks a second
  -- non-resolved row).
  v_item08a := pg_temp.make_handoff_item(
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000208',
    'Repair Ineligible Owner', '+15559970008', '05100000-0000-0000-0000-000000000308'
  );
  update public.staff_work_items
    set status = 'resolved', resolved_at = pg_catalog.now(), resolved_by = '05100000-0000-0000-0000-000000000101'
    where id = v_item08a;
  update public.conversations
    set intake_stage = 'human_handoff', status = 'handoff', state_version = state_version + 1
    where id = '05100000-0000-0000-0000-000000000308';

  if (select count(*) from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000308' and kind = 'human_handoff') <> 2 then
    raise exception 'scenario 08 setup: expected two human_handoff items (one resolved, one freshly reopened)';
  end if;
  if (select count(*) from public.staff_work_items where conversation_id = '05100000-0000-0000-0000-000000000308' and kind = 'human_handoff' and status <> 'resolved') <> 1 then
    raise exception 'scenario 08 setup: expected exactly one non-resolved human_handoff item';
  end if;
end;
$$;

-- =========================================================================
-- Scenario 09: resolving a kind = 'delivery_failure' item leaves the linked
-- conversation byte-for-byte unchanged (fixture point 5), proven through
-- the real RPC path rather than the automatic provider-status trigger.
-- =========================================================================

do $$
declare
  v_outbox09 uuid;
begin
  v_outbox09 := pg_temp.make_outbox_row(
    '951000001', 'wamid.T051-S09', 'b', '+15559970009', 'Delivery Failure Owner', 'intake_received', 'Bilgileri aldik.'
  );

  -- delivery_status = 'failed' (send never accepted by the provider) always
  -- creates reason = 'send_attempts_exhausted', which the automatic
  -- provider-status trigger never auto-resolves (unlike 'provider_failed'),
  -- so only the manual RPC path can resolve it.
  update public.outbound_message_outbox
    set delivery_status = 'failed',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        provider_message_id = null,
        accepted_at = null,
        failed_at = pg_catalog.now(),
        failure_reason = 'attempts_exhausted',
        delivery_attempt_count = 3
    where id = v_outbox09;

  if not exists (
    select 1 from public.staff_work_items
    where source_outbox_id = v_outbox09 and kind = 'delivery_failure' and reason = 'send_attempts_exhausted' and status = 'open'
  ) then
    raise exception 'scenario 09 setup: expected an open send_attempts_exhausted item';
  end if;

  -- This conversation never entered human_handoff; this setup proves the
  -- delivery-failure resolution path below, not the later backfill filter.
  if not exists (
    select 1 from public.conversations c
    join public.outbound_message_outbox o on o.conversation_id = c.id
    where o.id = v_outbox09 and c.status = 'active' and c.intake_stage = 'complaint_collection'
  ) then
    raise exception 'scenario 09 setup: expected an ordinary active conversation';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '05100000-0000-0000-0000-000000000101', true);
do $$
declare
  v_item09 uuid;
  v_conv09 uuid;
  v_result text;
  v_conv_before public.conversations%rowtype;
  v_conv_after public.conversations%rowtype;
begin
  select id into v_item09 from public.staff_work_items where reason = 'send_attempts_exhausted' and status = 'open'
    and clinic_id = '05100000-0000-0000-0000-000000000001';
  select conversation_id into v_conv09 from public.staff_work_items where id = v_item09;
  select * into v_conv_before from public.conversations where id = v_conv09;

  select result into v_result from public.claim_staff_work_item(v_item09);
  if v_result <> 'claimed' then
    raise exception 'scenario 09: expected claimed, got %', v_result;
  end if;
  select result into v_result from public.resolve_staff_work_item(v_item09);
  if v_result <> 'resolved' then
    raise exception 'scenario 09: expected resolved, got %', v_result;
  end if;

  select * into v_conv_after from public.conversations where id = v_conv09;
  if v_conv_before is distinct from v_conv_after then
    raise exception 'scenario 09: resolving a delivery_failure item must never change the conversation, before % after %', to_json(v_conv_before), to_json(v_conv_after);
  end if;
  if not exists (
    select 1 from public.staff_work_items
    where id = v_item09 and status = 'resolved' and resolved_by = '05100000-0000-0000-0000-000000000101'
  ) then
    raise exception 'scenario 09: expected the delivery_failure item resolved with resolver audit set';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Decision 10 historical repair: run once, exactly as the migration states
-- it (supabase/migrations/20260904000200_handoff_conversation_recovery.sql),
-- then verify scenario 07 is repaired and every other conversation above
-- (08, 05, 06) is not.
-- This is a literal copy of migration lines 190-217; any future change to
-- either block must update the other in the same task.
-- =========================================================================

with repair_targets as materialized (
  select c.id, c.clinic_id
  from public.conversations c
  where c.status = 'handoff'
    and c.intake_stage = 'human_handoff'
    and exists (
      select 1 from public.staff_work_items w
      where w.conversation_id = c.id
        and w.clinic_id = c.clinic_id
        and w.kind = 'human_handoff'
        and w.status = 'resolved'
    )
    and not exists (
      select 1 from public.staff_work_items w
      where w.conversation_id = c.id
        and w.clinic_id = c.clinic_id
        and w.kind = 'human_handoff'
        and w.status <> 'resolved'
    )
  order by c.clinic_id, c.id
  for no key update of c
)
update public.conversations c
set status = 'completed', intake_stage = 'completed', state_version = c.state_version + 1
from repair_targets target
where c.id = target.id and c.clinic_id = target.clinic_id;

do $$
begin
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000307' and status = 'completed' and intake_stage = 'completed'
  ) then
    raise exception 'decision 10: scenario 07 (eligible) was not repaired';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000308' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'decision 10: scenario 08 (an open handoff item remains) was incorrectly repaired';
  end if;
  -- Scenarios 05/06 are still legitimately open/in_progress handoff
  -- conversations; the repair must never touch them either.
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000305' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'decision 10: scenario 05 (still open, no resolved item) was incorrectly repaired';
  end if;
  if not exists (
    select 1 from public.conversations
    where id = '05100000-0000-0000-0000-000000000306' and status = 'handoff' and intake_stage = 'human_handoff'
  ) then
    raise exception 'decision 10: scenario 06 (still in_progress) was incorrectly repaired';
  end if;
end;
$$;

rollback;

-- Zero residue: this select runs against the post-rollback state.
select
  (select count(*) from public.clinics where id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as clinics_left,
  (select count(*) from auth.users where id in (
    '05100000-0000-0000-0000-000000000101', '05100000-0000-0000-0000-000000000102',
    '05100000-0000-0000-0000-000000000103', '05100000-0000-0000-0000-000000000104')) as users_left,
  (select count(*) from public.clinic_staff where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as staff_rows_left,
  (select count(*) from public.whatsapp_accounts where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as whatsapp_accounts_left,
  (select count(*) from public.whatsapp_contact_routes where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as contact_routes_left,
  (select count(*) from public.owners where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as owners_left,
  (select count(*) from public.conversations where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as conversations_left,
  (select count(*) from public.pets where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as pets_left,
  (select count(*) from public.messages where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as messages_left,
  (select count(*) from public.webhook_events where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as webhook_events_left,
  (select count(*) from public.appointment_slots where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as appointment_slots_left,
  (select count(*) from public.staff_work_items where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as work_items_left,
  (select count(*) from public.outbound_message_outbox where clinic_id in (
    '05100000-0000-0000-0000-000000000001', '05100000-0000-0000-0000-000000000002')) as outbox_rows_left;
