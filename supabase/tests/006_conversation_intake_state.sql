begin;

insert into public.clinics (id, name)
values
  ('60100000-0000-0000-0000-000000000001', 'Intake Test Clinic A'),
  ('60100000-0000-0000-0000-000000000009', 'Intake Test Clinic B');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('60100000-0000-0000-0000-000000000002', '60100000-0000-0000-0000-000000000001', 'Owner One', '+15550011111'),
  ('60100000-0000-0000-0000-000000000003', '60100000-0000-0000-0000-000000000001', 'Owner Two', '+15550022222'),
  ('60100000-0000-0000-0000-000000000015', '60100000-0000-0000-0000-000000000001', 'Handoff Owner', '+15550044444'),
  ('60100000-0000-0000-0000-000000000016', '60100000-0000-0000-0000-000000000001', 'Completed Owner', '+15550055555'),
  ('60100000-0000-0000-0000-000000000010', '60100000-0000-0000-0000-000000000009', 'Owner Clinic B', '+15550033333');

insert into public.pets (id, clinic_id, owner_id, name, species, created_at)
values
  ('60100000-0000-0000-0000-000000000004', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000002', 'Waffles', 'dog', '2026-01-02T00:00:00Z'),
  ('60100000-0000-0000-0000-000000000007', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000002', 'Ash', 'cat', '2026-01-01T00:00:00Z'),
  ('60100000-0000-0000-0000-000000000005', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000003', 'CrossOwner', 'dog', '2026-01-01T00:00:00Z'),
  ('60100000-0000-0000-0000-000000000011', '60100000-0000-0000-0000-000000000009', '60100000-0000-0000-0000-000000000010', 'CrossClinic', 'dog', '2026-01-01T00:00:00Z');

-- Main conversation under test: default intake columns must apply on insert.
insert into public.conversations (id, clinic_id, owner_id, status)
values ('60100000-0000-0000-0000-000000000006', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000002', 'active');

-- A second, unrelated conversation/owner's data must never leak into the first's context.
insert into public.conversations (id, clinic_id, owner_id, status)
values ('60100000-0000-0000-0000-000000000012', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000003', 'active');
insert into public.messages (clinic_id, conversation_id, direction, content, created_at)
values ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000012', 'inbound', 'someone else''s message', '2026-01-01T00:00:00Z');

-- 13 messages so only the latest 12, in chronological order, must be returned.
do $$
declare
  i integer;
begin
  for i in 1..13 loop
    insert into public.messages (clinic_id, conversation_id, direction, content, created_at)
    values (
      '60100000-0000-0000-0000-000000000001',
      '60100000-0000-0000-0000-000000000006',
      case when i % 2 = 0 then 'outbound' else 'inbound' end,
      'msg-' || i,
      timestamptz '2026-02-01T00:00:00Z' + (i || ' minutes')::interval
    );
  end loop;
end;
$$;

-- Defaults: a freshly inserted conversation gets the documented intake defaults.
do $$
declare
  v_stage text;
  v_data jsonb;
  v_version integer;
begin
  select intake_stage, intake_data, state_version
    into v_stage, v_data, v_version
  from public.conversations
  where id = '60100000-0000-0000-0000-000000000006';

  if v_stage <> 'pet_identification' then
    raise exception 'expected default intake_stage pet_identification, got %', v_stage;
  end if;
  if v_data <> '{}'::jsonb then
    raise exception 'expected default intake_data {}, got %', v_data;
  end if;
  if v_version <> 1 then
    raise exception 'expected default state_version 1, got %', v_version;
  end if;
end;
$$;

-- Constraint: an invalid intake_stage must be rejected.
do $$
begin
  begin
    update public.conversations set intake_stage = 'not_a_real_stage' where id = '60100000-0000-0000-0000-000000000006';
    raise exception 'expected check constraint violation for invalid intake_stage';
  exception
    when check_violation then null;
  end;
end;
$$;

-- Context RPC: exactly the target owner/clinic, ordered pets, latest 12 messages chronologically, no cross-tenant leakage.
do $$
declare
  v_row record;
begin
  select * into v_row from public.get_conversation_intake_context('60100000-0000-0000-0000-000000000006');

  if v_row.owner_name <> 'Owner One' then
    raise exception 'expected owner_name Owner One, got %', v_row.owner_name;
  end if;
  if v_row.pets <> '[
    {"id": "60100000-0000-0000-0000-000000000007", "name": "Ash", "species": "cat"},
    {"id": "60100000-0000-0000-0000-000000000004", "name": "Waffles", "species": "dog"}
  ]'::jsonb then
    raise exception 'pets not returned in created_at order without cross-owner leakage: %', v_row.pets;
  end if;
  if jsonb_array_length(v_row.recent_messages) <> 12 then
    raise exception 'expected 12 recent messages, got %', jsonb_array_length(v_row.recent_messages);
  end if;
  if v_row.recent_messages -> 0 ->> 'content' <> 'msg-2' then
    raise exception 'expected oldest of the latest 12 to be msg-2, got %', v_row.recent_messages -> 0 ->> 'content';
  end if;
  if v_row.recent_messages -> 11 ->> 'content' <> 'msg-13' then
    raise exception 'expected newest message to be msg-13, got %', v_row.recent_messages -> 11 ->> 'content';
  end if;
  if exists (select 1 from jsonb_array_elements(v_row.recent_messages) m where m ->> 'content' = 'someone else''s message') then
    raise exception 'context leaked a message from another conversation';
  end if;
end;
$$;

-- Unknown conversation: zero rows.
do $$
begin
  if (select count(*) from public.get_conversation_intake_context('60100000-0000-0000-0000-000000000099')) <> 0 then
    raise exception 'expected zero rows for an unknown conversation';
  end if;
end;
$$;

-- Valid forward transition increments the version exactly once.
do $$
declare
  v_stage text;
  v_version integer;
begin
  select intake_stage, state_version into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 1,
    p_next_stage => 'complaint_collection',
    p_pet_id => null,
    p_intake_data => '{"note": "first"}'::jsonb
  );
  if v_stage <> 'complaint_collection' or v_version <> 2 then
    raise exception 'expected complaint_collection/2, got %/%', v_stage, v_version;
  end if;
end;
$$;

-- Same-stage refresh also increments the version exactly once.
do $$
declare
  v_stage text;
  v_version integer;
begin
  select intake_stage, state_version into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 2,
    p_next_stage => 'complaint_collection',
    p_pet_id => null,
    p_intake_data => '{"note": "second"}'::jsonb
  );
  if v_stage <> 'complaint_collection' or v_version <> 3 then
    raise exception 'expected complaint_collection/3, got %/%', v_stage, v_version;
  end if;
  if (select intake_data from public.conversations where id = '60100000-0000-0000-0000-000000000006') <> '{"note": "second"}'::jsonb then
    raise exception 'same-stage refresh did not replace intake_data';
  end if;
end;
$$;

-- Stale update: zero rows, no mutation.
do $$
declare
  v_count integer;
  v_version_before integer;
  v_version_after integer;
begin
  select state_version into v_version_before from public.conversations where id = '60100000-0000-0000-0000-000000000006';

  select count(*) into v_count from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 2,
    -- Task 036: must stay a legal one-step transition from
    -- complaint_collection, so that this test fails on the stale version
    -- rather than on the transition check (which runs first).
    p_next_stage => 'intake_confirmation',
    p_pet_id => null,
    p_intake_data => '{"note": "stale"}'::jsonb
  );
  if v_count <> 0 then
    raise exception 'expected zero rows for a stale expected_version';
  end if;

  select state_version into v_version_after from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_version_after <> v_version_before then
    raise exception 'stale update mutated state_version';
  end if;
end;
$$;

-- Skipped-stage transition must fail and not mutate.
do $$
declare
  v_version_before integer;
  v_version_after integer;
begin
  select state_version into v_version_before from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'ready_for_triage',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected a skipped-stage transition to raise';
  exception
    when others then
      if sqlerrm not like '%illegal transition%' then
        raise;
      end if;
  end;
  select state_version into v_version_after from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_version_after <> v_version_before then
    raise exception 'rejected skipped-stage transition mutated the conversation';
  end if;
end;
$$;

-- Backward transition must fail and not mutate.
do $$
declare
  v_version_before integer;
  v_version_after integer;
begin
  select state_version into v_version_before from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'pet_identification',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected a backward transition to raise';
  exception
    when others then
      if sqlerrm not like '%illegal transition%' then
        raise;
      end if;
  end;
  select state_version into v_version_after from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_version_after <> v_version_before then
    raise exception 'rejected backward transition mutated the conversation';
  end if;
end;
$$;

-- Cross-owner pet assignment must fail and not mutate.
do $$
declare
  v_version_before integer;
  v_version_after integer;
begin
  select state_version into v_version_before from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'complaint_collection',
      p_pet_id => '60100000-0000-0000-0000-000000000005',
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected cross-owner pet assignment to raise';
  exception
    when others then
      if sqlerrm not like '%pet does not belong%' then
        raise;
      end if;
  end;
  select state_version into v_version_after from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_version_after <> v_version_before then
    raise exception 'rejected cross-owner pet assignment mutated the conversation';
  end if;
end;
$$;

-- Cross-clinic pet assignment must fail and not mutate.
do $$
declare
  v_version_before integer;
  v_version_after integer;
begin
  select state_version into v_version_before from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'complaint_collection',
      p_pet_id => '60100000-0000-0000-0000-000000000011',
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected cross-clinic pet assignment to raise';
  exception
    when others then
      if sqlerrm not like '%pet does not belong%' then
        raise;
      end if;
  end;
  select state_version into v_version_after from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_version_after <> v_version_before then
    raise exception 'rejected cross-clinic pet assignment mutated the conversation';
  end if;
end;
$$;

-- Invalid intake_data (not a JSON object) must fail and not mutate.
do $$
begin
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'complaint_collection',
      p_pet_id => null,
      p_intake_data => '[1, 2, 3]'::jsonb
    );
    raise exception 'expected non-object intake_data to raise';
  exception
    when others then
      if sqlerrm not like '%invalid intake_data%' then
        raise;
      end if;
  end;
end;
$$;

-- Empty intake_data must also fail and not mutate.
do $$
begin
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 3,
      p_next_stage => 'complaint_collection',
      p_pet_id => null,
      p_intake_data => '{}'::jsonb
    );
    raise exception 'expected empty intake_data to raise';
  exception
    when others then
      if sqlerrm not like '%invalid intake_data%' then
        raise;
      end if;
  end;
end;
$$;

-- Nonpositive expected_version must fail.
do $$
begin
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 0,
      p_next_stage => 'complaint_collection',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected nonpositive expected_version to raise';
  exception
    when others then
      if sqlerrm not like '%invalid expected_version%' then
        raise;
      end if;
  end;
end;
$$;

-- Unknown conversation must raise, not return zero rows.
do $$
begin
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000098',
      p_expected_version => 1,
      p_next_stage => 'complaint_collection',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected unknown conversation_id to raise';
  exception
    when others then
      if sqlerrm not like '%unknown conversation_id%' then
        raise;
      end if;
  end;
end;
$$;

-- A valid same-owner/same-clinic pet assignment succeeds and is persisted.
do $$
declare
  v_pet_id uuid;
begin
  perform 1 from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 3,
    p_next_stage => 'complaint_collection',
    p_pet_id => '60100000-0000-0000-0000-000000000004',
    p_intake_data => '{"note": "with pet"}'::jsonb
  );
  select pet_id into v_pet_id from public.conversations where id = '60100000-0000-0000-0000-000000000006';
  if v_pet_id <> '60100000-0000-0000-0000-000000000004' then
    raise exception 'expected pet_id to be assigned, got %', v_pet_id;
  end if;
end;
$$;

-- human_handoff: reachable from a non-terminal stage, syncs operational status, and is terminal thereafter.
insert into public.conversations (id, clinic_id, owner_id, status, intake_stage, state_version)
values ('60100000-0000-0000-0000-000000000013', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000015', 'active', 'safety_check', 1);

do $$
declare
  v_status text;
begin
  perform 1 from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000013',
    p_expected_version => 1,
    p_next_stage => 'human_handoff',
    p_pet_id => null,
    p_intake_data => '{"test": true}'::jsonb
  );
  select status into v_status from public.conversations where id = '60100000-0000-0000-0000-000000000013';
  if v_status <> 'handoff' then
    raise exception 'expected operational status handoff, got %', v_status;
  end if;

  -- Same-stage refresh while terminal is allowed and keeps status synced.
  perform 1 from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000013',
    p_expected_version => 2,
    p_next_stage => 'human_handoff',
    p_pet_id => null,
    p_intake_data => '{"note": "still in handoff"}'::jsonb
  );
  select status into v_status from public.conversations where id = '60100000-0000-0000-0000-000000000013';
  if v_status <> 'handoff' then
    raise exception 'expected status to remain handoff after same-stage refresh, got %', v_status;
  end if;

  -- Leaving human_handoff must fail.
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000013',
      p_expected_version => 3,
      p_next_stage => 'completed',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected leaving human_handoff to raise';
  exception
    when others then
      if sqlerrm not like '%is terminal%' then
        raise;
      end if;
  end;
end;
$$;

-- completed: reachable via the forward graph and synchronizes operational status.
insert into public.conversations (id, clinic_id, owner_id, status, intake_stage, state_version)
values ('60100000-0000-0000-0000-000000000014', '60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000016', 'active', 'appointment_confirmation', 1);

do $$
declare
  v_status text;
begin
  perform 1 from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000014',
    p_expected_version => 1,
    p_next_stage => 'completed',
    p_pet_id => null,
    p_intake_data => '{"test": true}'::jsonb
  );
  select status into v_status from public.conversations where id = '60100000-0000-0000-0000-000000000014';
  if v_status <> 'completed' then
    raise exception 'expected operational status completed, got %', v_status;
  end if;

  -- completed is terminal: even a move to human_handoff must fail.
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000014',
      p_expected_version => 2,
      p_next_stage => 'human_handoff',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected leaving completed to raise';
  exception
    when others then
      if sqlerrm not like '%is terminal%' then
        raise;
      end if;
  end;
end;
$$;

-- Only service_role may execute either RPC.
set local role authenticated;
do $$
begin
  begin
    perform 1 from public.get_conversation_intake_context('60100000-0000-0000-0000-000000000006');
    raise exception 'authenticated role unexpectedly executed get_conversation_intake_context';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 4,
      p_next_stage => 'safety_check',
      p_pet_id => null,
      p_intake_data => '{}'::jsonb
    );
    raise exception 'authenticated role unexpectedly executed advance_conversation_intake';
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
    perform 1 from public.get_conversation_intake_context('60100000-0000-0000-0000-000000000006');
    raise exception 'anon role unexpectedly executed get_conversation_intake_context';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 4,
      p_next_stage => 'safety_check',
      p_pet_id => null,
      p_intake_data => '{}'::jsonb
    );
    raise exception 'anon role unexpectedly executed advance_conversation_intake';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_stage text;
  v_version integer;
begin
  perform 1 from public.get_conversation_intake_context('60100000-0000-0000-0000-000000000006');
  -- Task 036 inserted intake_confirmation between complaint_collection and
  -- safety_check. Walking both steps here pins the new rank on both sides:
  -- complaint_collection -> intake_confirmation -> safety_check.
  select intake_stage, state_version into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 4,
    p_next_stage => 'intake_confirmation',
    p_pet_id => null,
    p_intake_data => '{"note": "service role"}'::jsonb
  );
  if v_stage <> 'intake_confirmation' or v_version <> 5 then
    raise exception 'service_role execution unexpectedly failed: %/%', v_stage, v_version;
  end if;

  select intake_stage, state_version into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id => '60100000-0000-0000-0000-000000000006',
    p_expected_version => 5,
    p_next_stage => 'safety_check',
    p_pet_id => null,
    p_intake_data => '{"note": "confirmed"}'::jsonb
  );
  if v_stage <> 'safety_check' or v_version <> 6 then
    raise exception 'expected safety_check/6 after confirmation, got %/%', v_stage, v_version;
  end if;

  -- And the step it replaced is now a skip, rejected like any other.
  begin
    perform 1 from public.advance_conversation_intake(
      p_conversation_id => '60100000-0000-0000-0000-000000000006',
      p_expected_version => 6,
      p_next_stage => 'appointment_offer',
      p_pet_id => null,
      p_intake_data => '{"test": true}'::jsonb
    );
    raise exception 'expected safety_check -> appointment_offer to raise';
  exception
    when others then
      if sqlerrm not like '%illegal transition%' then
        raise;
      end if;
  end;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000009')) as remaining_test_clinics,
  (select count(*) from public.owners where clinic_id in ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000009')) as remaining_test_owners,
  (select count(*) from public.pets where clinic_id in ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000009')) as remaining_test_pets,
  (select count(*) from public.conversations where clinic_id in ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000009')) as remaining_test_conversations,
  (select count(*) from public.messages where clinic_id in ('60100000-0000-0000-0000-000000000001', '60100000-0000-0000-0000-000000000009')) as remaining_test_messages;
