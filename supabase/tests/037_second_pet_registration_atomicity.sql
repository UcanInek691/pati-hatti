-- Rollback-only proof for Task 037 (second-pet registration + atomic
-- pet finalization). Exercises the real
-- `public.finalize_intake_queue_job` defined by
-- `supabase/migrations/20260827000100_second_pet_registration_atomicity.sql`
-- as `service_role`, the same way `035_pet_registration.sql` exercises its
-- migration. That migration must be applied to the target database first.
--
-- Run status: PASSED on disposable `vetai-test` via the SQL Editor on
-- 2026-08-27, after the Task 037 migration was applied there. Every block
-- completed with `Success. No rows returned`; an independent post-rollback
-- query returned `fixture_clinics = 0`. NOT RUN on staging or production.
--
-- Coverage:
--   Fixture 1 -- an owner with one pre-existing pet and an unbound
--     conversation (pet_id is null) registers a distinct second pet
--     (Decision 1/goal item 1).
--   Fixture 2 -- a finalize call carrying create parameters but a stale
--     `p_expected_version` leaves zero pet rows, zero outbox rows, the
--     conversation's link/stage/version untouched, and the same lease current;
--     retrying that exact event/token with the real version then succeeds.
--   Fixture 3 -- the exact-event retry created one pet, linked it, and
--     completed the original intake event normally.
--   Fixture 4 -- duplicate refusal against the pre-existing first pet's
--     name stays intact on the second-pet path (Task 035's guard,
--     unchanged by Task 037).
--   Fixture 5 -- tenant isolation: a second clinic's unrelated owner
--     registers a pet under the same name with no cross-tenant effect.
--
-- This is a single-session fixture: it proves the version check runs
-- before the pet insert and rolls back atomically together, not that two
-- real concurrent transactions block each other under load.
--
-- Everything below is wrapped in BEGIN/ROLLBACK. Nothing is committed.

begin;

insert into public.clinics (id, name) values
  ('37000000-0000-0000-0000-000000000001', 'Second Pet Test Clinic 1'),
  ('37000000-0000-0000-0000-000000000002', 'Second Pet Test Clinic 2');

-- Task 041: clinics default to suspended; activate this fixture's clinics so
-- the existing AI/ingest/outbound assertions below stay unchanged.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id) values
  ('37000000-0000-0000-0000-000000000011', '37000000-0000-0000-0000-000000000001', '937000001'),
  ('37000000-0000-0000-0000-000000000012', '37000000-0000-0000-0000-000000000002', '937000002');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode) values
  ('37000000-0000-0000-0000-000000000011', '37000000-0000-0000-0000-000000000001', '+15553700001', 'ai'),
  ('37000000-0000-0000-0000-000000000012', '37000000-0000-0000-0000-000000000002', '+15553700002', 'ai');

set local role service_role;

-- Boot one conversation per clinic. Each conversation starts at
-- `pet_identification` with `pet_id is null` and stays that way until a
-- fixture below advances it.
do $$
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '937000001',
    p_provider_message_id => 'wamid.SECONDPET-BOOT1',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15553700001',
    p_owner_name => 'Second Pet Fixture Owner 1',
    p_message_text => 'Merhaba',
    p_provider_timestamp => pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '937000002',
    p_provider_message_id => 'wamid.SECONDPET-BOOT2',
    p_payload_hash => repeat('c', 64),
    p_sender_e164 => '+15553700002',
    p_owner_name => 'Second Pet Fixture Owner 2',
    p_message_text => 'Merhaba',
    p_provider_timestamp => pg_catalog.now()
  );
end;
$$;

reset role;

-- A pre-existing pet for clinic 1's owner, simulating a registration this
-- conversation has no memory of. The boot conversation above is untouched:
-- still `pet_identification` / `pet_id is null`.
insert into public.pets (clinic_id, owner_id, name, species)
select '37000000-0000-0000-0000-000000000001', c.owner_id, 'Karamel', 'kedi'
from public.conversations c
where c.clinic_id = '37000000-0000-0000-0000-000000000001';

set local role service_role;

-- Mirrors `035_pet_registration.sql`'s `run_pet_turn`, plus an explicit
-- version override so the stale-version fixture can pass a deliberately
-- wrong `p_expected_version` instead of the conversation's real one.
create function pg_temp.run_second_pet_turn(
  p_phone_number_id text,
  p_sender_e164 text,
  p_provider_message_id text,
  p_message_text text,
  p_next_stage text,
  p_create_pet_name text,
  p_create_pet_species text,
  p_expected_version_override integer default null,
  out o_result text,
  out o_conversation_id uuid,
  out o_state_version integer,
  out o_claim_token uuid,
  out o_lease_until timestamptz
)
language plpgsql
as $$
declare
  v_claim_result text;
  v_real_version integer;
  v_expected_version integer;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => p_phone_number_id,
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat('d', 64),
    p_sender_e164 => p_sender_e164,
    p_owner_name => 'Second Pet Fixture Owner',
    p_message_text => p_message_text,
    p_provider_timestamp => pg_catalog.now()
  );

  select m.conversation_id into o_conversation_id
  from public.messages m
  where m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound';

  if o_conversation_id is null then
    raise exception 'run_second_pet_turn: ingest did not create an inbound message for %', p_provider_message_id;
  end if;

  select claimed.result, claimed.claim_token
    into v_claim_result, o_claim_token
  from public.claim_intake_queue_job(o_conversation_id, p_provider_message_id) claimed;

  if v_claim_result <> 'claimed' then
    raise exception 'run_second_pet_turn: expected claimed, got %', v_claim_result;
  end if;

  select we.intake_lease_until into o_lease_until
  from public.webhook_events we
  where we.clinic_id = (
      select c.clinic_id from public.conversations c where c.id = o_conversation_id
    )
    and we.provider_event_id = p_provider_message_id;

  select c.state_version into v_real_version
  from public.conversations c
  where c.id = o_conversation_id;

  v_expected_version := coalesce(p_expected_version_override, v_real_version);

  select finalized.result, finalized.state_version
    into o_result, o_state_version
  from public.finalize_intake_queue_job(
    o_conversation_id,
    p_provider_message_id,
    o_claim_token,
    v_expected_version,
    p_next_stage,
    null,
    jsonb_build_object('pet_name', p_create_pet_name),
     'intake_confirmation',
    'Synthetic second-pet fixture reply',
    p_create_pet_name,
    p_create_pet_species
  ) finalized;
end;
$$;

-- =========================================================================
-- Fixture 1: an owner with one registered pet and an unbound conversation
-- registers a distinct second pet. Stage advances one hop at a time
-- (pet_identification -> complaint_collection -> intake_confirmation ->
-- safety_check), matching advance_conversation_intake's rank check.
-- =========================================================================
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_owner_id uuid;
  v_pet_count integer;
  v_conversation_pet_id uuid;
  v_second_pet_id uuid;
begin
  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000001', '+15553700001', 'wamid.SECONDPET0', 'Minnoş miyavlıyor', 'complaint_collection', null, null
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 1: expected applied entering complaint_collection, got %', v_result;
  end if;

  select t.o_result, t.o_conversation_id into v_result, v_conversation_id
  from pg_temp.run_second_pet_turn(
    '937000001', '+15553700001', 'wamid.SECONDPET1', 'Sürekli miyavlıyor', 'intake_confirmation', null, null
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 1: expected applied entering intake_confirmation, got %', v_result;
  end if;

  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '37000000-0000-0000-0000-000000000001';

  if exists (select 1 from public.pets p where p.owner_id = v_owner_id and p.name = 'Minnoş') then
    raise exception 'fixture 1: a pet was created before confirmation';
  end if;

  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000001', '+15553700001', 'wamid.SECONDPET2', 'evet', 'safety_check', 'Minnoş', 'kedi'
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 1: expected applied on confirmation, got %', v_result;
  end if;

  select count(*) into v_pet_count from public.pets p where p.owner_id = v_owner_id;
  if v_pet_count <> 2 then
    raise exception 'fixture 1: expected Karamel plus Minnoş (2 pets), got %', v_pet_count;
  end if;

  select c.pet_id into v_conversation_pet_id
  from public.conversations c where c.id = v_conversation_id;

  select p.id into v_second_pet_id
  from public.pets p where p.owner_id = v_owner_id and p.name = 'Minnoş';

  if v_conversation_pet_id is distinct from v_second_pet_id then
    raise exception 'fixture 1: conversation was not bound to the newly created second pet';
  end if;

  if not exists (select 1 from public.pets p where p.owner_id = v_owner_id and p.name = 'Karamel') then
    raise exception 'fixture 1: the pre-existing first pet disappeared';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: the atomicity fix itself. A finalize call carrying create
-- parameters but a stale `p_expected_version` must leave zero pet rows,
-- zero outbox rows, and the conversation's link/stage/version untouched --
-- not commit the pet and then discover the stale version afterward.
-- =========================================================================
do $$
declare
  v_conversation_id uuid;
  v_owner_id uuid;
  v_real_version integer;
  v_stage_before text;
  v_pet_id_before uuid;
  v_pet_count_before integer;
  v_outbox_count_before integer;
  v_result text;
  v_stage_after text;
  v_pet_id_after uuid;
  v_pet_count_after integer;
  v_outbox_count_after integer;
  v_version_after integer;
  v_claim_token uuid;
  v_lease_until timestamptz;
  v_event_status text;
  v_event_token uuid;
  v_event_lease_until timestamptz;
  v_completed_at timestamptz;
  v_retry_result text;
begin
  select c.id, c.owner_id, c.state_version, c.intake_stage, c.pet_id
    into v_conversation_id, v_owner_id, v_real_version, v_stage_before, v_pet_id_before
  from public.conversations c
  where c.clinic_id = '37000000-0000-0000-0000-000000000001';

  select count(*) into v_pet_count_before from public.pets p where p.owner_id = v_owner_id;
  select count(*) into v_outbox_count_before
  from public.outbound_message_outbox o where o.clinic_id = '37000000-0000-0000-0000-000000000001';

  select t.o_result, t.o_claim_token, t.o_lease_until
    into v_result, v_claim_token, v_lease_until
  from pg_temp.run_second_pet_turn(
    '937000001', '+15553700001', 'wamid.SECONDPET3', 'Bir de Fındık var', 'ready_for_triage', 'Fındık', 'köpek',
    v_real_version + 1
  ) t;

  if v_result <> 'stale_state' then
    raise exception 'fixture 2: expected stale_state on a deliberately wrong expected_version, got %', v_result;
  end if;

  select c.intake_stage, c.pet_id, c.state_version into v_stage_after, v_pet_id_after, v_version_after
  from public.conversations c where c.id = v_conversation_id;

  if v_stage_after <> v_stage_before
    or v_pet_id_after is distinct from v_pet_id_before
    or v_version_after <> v_real_version then
    raise exception 'fixture 2: a stale-version call still changed the conversation link/stage/version';
  end if;

  select count(*) into v_pet_count_after from public.pets p where p.owner_id = v_owner_id;
  if v_pet_count_after <> v_pet_count_before then
    raise exception 'fixture 2: a stale-version call still committed a pet (before %, after %)', v_pet_count_before, v_pet_count_after;
  end if;

  select count(*) into v_outbox_count_after
  from public.outbound_message_outbox o where o.clinic_id = '37000000-0000-0000-0000-000000000001';
  if v_outbox_count_after <> v_outbox_count_before then
    raise exception 'fixture 2: a stale-version call still queued an outbound reply';
  end if;

  select we.intake_status, we.intake_claim_token, we.intake_lease_until, we.intake_completed_at
    into v_event_status, v_event_token, v_event_lease_until, v_completed_at
  from public.webhook_events we
  where we.clinic_id = '37000000-0000-0000-0000-000000000001'
    and we.provider_event_id = 'wamid.SECONDPET3';

  if v_event_status <> 'processing'
    or v_event_token is distinct from v_claim_token
    or v_event_lease_until is distinct from v_lease_until
    or v_completed_at is not null then
    raise exception 'fixture 2: stale_state changed the current lease';
  end if;

  -- Retry the exact same event and claim token with the now-known current
  -- version. This is the same logical turn, not a substitute new message.
  select finalized.result into v_retry_result
  from public.finalize_intake_queue_job(
    v_conversation_id,
    'wamid.SECONDPET3',
    v_claim_token,
    v_real_version,
    'ready_for_triage',
    null,
    jsonb_build_object('pet_name', 'Fındık'),
    'intake_confirmation',
    'Synthetic second-pet fixture reply',
    'Fındık',
    'köpek'
  ) finalized;

  if v_retry_result <> 'applied' then
    raise exception 'fixture 2: expected exact-event retry to apply, got %', v_retry_result;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: the exact-event retry above created exactly one pet, linked the
-- conversation, and completed that same intake event normally.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_pet_count integer;
  v_pet_id uuid;
  v_conversation_pet_id uuid;
  v_stage text;
  v_event_status text;
begin
  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '37000000-0000-0000-0000-000000000001';

  select count(*) into v_pet_count from public.pets p where p.owner_id = v_owner_id and p.name = 'Fındık';
  if v_pet_count <> 1 then
    raise exception 'fixture 3: expected exactly one Fındık row after retry, got %', v_pet_count;
  end if;

  select p.id into v_pet_id from public.pets p where p.owner_id = v_owner_id and p.name = 'Fındık';
  select c.pet_id, c.intake_stage into v_conversation_pet_id, v_stage
  from public.conversations c
  where c.clinic_id = '37000000-0000-0000-0000-000000000001';

  if v_conversation_pet_id is distinct from v_pet_id or v_stage <> 'ready_for_triage' then
    raise exception 'fixture 3: exact-event retry did not link Fındık and advance to ready_for_triage';
  end if;

  select we.intake_status into v_event_status
  from public.webhook_events we
  where we.clinic_id = '37000000-0000-0000-0000-000000000001'
    and we.provider_event_id = 'wamid.SECONDPET3';

  if v_event_status <> 'completed' then
    raise exception 'fixture 3: exact-event retry did not complete the original intake event';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: duplicate refusal against the pre-existing first pet's name --
-- Task 035's guard stays intact on the second-pet path.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_result text;
  v_pet_count_before integer;
  v_pet_count_after integer;
begin
  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '37000000-0000-0000-0000-000000000001';

  select count(*) into v_pet_count_before from public.pets p where p.owner_id = v_owner_id;

  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000001', '+15553700001', 'wamid.SECONDPET5', 'karamel', 'ready_for_triage', '  KARAMEL  ', null
  ) t;

  if v_result <> 'duplicate_pet_name' then
    raise exception 'fixture 4: expected duplicate_pet_name, got %', v_result;
  end if;

  select count(*) into v_pet_count_after from public.pets p where p.owner_id = v_owner_id;
  if v_pet_count_after <> v_pet_count_before then
    raise exception 'fixture 4: a refused duplicate still wrote a pet (before %, after %)', v_pet_count_before, v_pet_count_after;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 5: tenant isolation. Clinic 2's unrelated owner registers a pet
-- under the exact same name as clinic 1's second pet ("Minnoş"); the
-- owner-scoped duplicate guard and the tenant-scoped row lock in the new
-- migration must not let clinic 1's data affect clinic 2's outcome.
-- =========================================================================
do $$
declare
  v_result text;
  v_owner_id uuid;
  v_pet_count integer;
begin
  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000002', '+15553700002', 'wamid.SECONDPET6', 'Minnoş de bende var', 'complaint_collection', null, null
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 5: expected applied entering complaint_collection, got %', v_result;
  end if;

  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000002', '+15553700002', 'wamid.SECONDPET7', 'Miyavlıyor', 'intake_confirmation', null, null
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 5: expected applied entering intake_confirmation, got %', v_result;
  end if;

  select t.o_result into v_result
  from pg_temp.run_second_pet_turn(
    '937000002', '+15553700002', 'wamid.SECONDPET8', 'evet', 'safety_check', 'Minnoş', 'kedi'
  ) t;
  if v_result <> 'applied' then
    raise exception 'fixture 5: expected applied for clinic 2''s own Minnoş, got %', v_result;
  end if;

  select o.id into v_owner_id from public.owners o where o.clinic_id = '37000000-0000-0000-0000-000000000002';
  select count(*) into v_pet_count from public.pets p where p.owner_id = v_owner_id;
  if v_pet_count <> 1 then
    raise exception 'fixture 5: expected exactly one pet for clinic 2''s owner, got %', v_pet_count;
  end if;

  if not exists (
    select 1 from public.pets p
    where p.clinic_id = '37000000-0000-0000-0000-000000000002' and p.name = 'Minnoş'
  ) then
    raise exception 'fixture 5: clinic 2''s Minnoş was not recorded under clinic 2';
  end if;

  -- Clinic 1's own pet count must be unaffected by clinic 2's identical name.
  select count(*) into v_pet_count
  from public.pets p
  join public.owners o on o.id = p.owner_id
  where o.clinic_id = '37000000-0000-0000-0000-000000000001';
  if v_pet_count <> 3 then
    raise exception 'fixture 5: clinic 1''s pet count changed to %, expected 3 (Karamel, Minnoş, Fındık)', v_pet_count;
  end if;
end;
$$;

reset role;

-- Rollback-proof: nothing written by this fixture is ever committed.
rollback;
