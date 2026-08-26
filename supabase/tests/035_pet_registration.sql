-- Rollback-only proof for Task 035 (pet onboarding for first-time owners):
-- `finalize_intake_queue_job`'s new `p_create_pet_name` / `p_create_pet_species`
-- parameters, its new `duplicate_pet_name` result, and — the point of Maya's
-- 2026-08-25 decision (b) — the fact that the duplicate-name rule binds the AI
-- write path ONLY, leaving clinic staff free to insert a same-named pet
-- directly through the `pets_all` RLS policy. Never run this fixture script
-- against a real clinic database.
--
-- Run status: PASSED, 2026-08-25, on the disposable `vetai-test` project
-- (ref `cyjpiapxvalqltcsywam`). Executed by Maya together with Claude Sonnet
-- through the Supabase dashboard SQL Editor -- not from the repository
-- session, which still has no database access (no DB password, no `psql`, no
-- Docker daemon). The migration was already applied there beforehand. The
-- script ran with no error through to its `rollback`; the last visible result
-- row was fixture 3's `set_config`, the rest being silent `do` blocks. All six
-- fixtures passed.
--
-- The migration `supabase/migrations/20260825000100_pet_registration.sql` must
-- be applied before this proof.

begin;

insert into public.clinics (id, name)
values ('35000000-0000-0000-0000-000000000001', 'Pet Registration Test Clinic');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('35000000-0000-0000-0000-000000000002', '35000000-0000-0000-0000-000000000001', '935000001');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values ('35100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'pet-reg@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values ('35000000-0000-0000-0000-000000000001', '35100000-0000-0000-0000-000000000001', 'admin');

-- Strict allowlist (Task 033/034): only this fixture's contact is automated.
insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values ('35000000-0000-0000-0000-000000000002', '35000000-0000-0000-0000-000000000001', '+15553500001', 'ai');

-- Local helper: drive one real inbound turn through ingest -> claim ->
-- atomic finalize, exactly as the Worker does, and hand back the result plus
-- the conversation it happened on. Lives only in pg_temp.
create function pg_temp.run_pet_turn(
  p_provider_message_id text,
  p_message_text text,
  p_next_stage text,
  p_create_pet_name text,
  p_create_pet_species text,
  -- Task 036 added 'intake_confirmation' to the reply-category allowlist;
  -- default keeps every pre-036 call site unchanged.
  p_reply_category text default 'complaint',
  out o_result text,
  out o_conversation_id uuid,
  out o_state_version integer
)
language plpgsql
as $$
declare
  v_claim_result text;
  v_claim_token uuid;
  v_version integer;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '935000001',
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat('b', 64),
    p_sender_e164 => '+15553500001',
    p_owner_name => 'Pet Registration Fixture Owner',
    p_message_text => p_message_text,
    p_provider_timestamp => pg_catalog.now()
  );

  select m.conversation_id into o_conversation_id
  from public.messages m
  where m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound';

  if o_conversation_id is null then
    raise exception 'run_pet_turn: ingest did not create an inbound message for %', p_provider_message_id;
  end if;

  select claimed.result, claimed.claim_token
    into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(o_conversation_id, p_provider_message_id) claimed;

  if v_claim_result <> 'claimed' then
    raise exception 'run_pet_turn: expected claimed, got %', v_claim_result;
  end if;

  select c.state_version into v_version
  from public.conversations c
  where c.id = o_conversation_id;

  select finalized.result, finalized.state_version
    into o_result, o_state_version
  from public.finalize_intake_queue_job(
    o_conversation_id,
    p_provider_message_id,
    v_claim_token,
    v_version,
    p_next_stage,
    null,
    jsonb_build_object('pet_name', p_create_pet_name),
    p_reply_category,
    'Synthetic pet-registration fixture reply',
    p_create_pet_name,
    p_create_pet_species
  ) finalized;
end;
$$;

-- =========================================================================
-- Fixture 1: the AI path creates the first-time owner's pet inside the same
-- atomic finalize, and the conversation is bound to the created pet.
-- =========================================================================
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_version integer;
  v_owner_id uuid;
  v_pet_count integer;
  v_pet_name text;
  v_pet_species text;
  v_conversation_pet_id uuid;
  v_created_pet_id uuid;
begin
  select t.o_result, t.o_conversation_id, t.o_state_version
    into v_result, v_conversation_id, v_version
  from pg_temp.run_pet_turn('wamid.PETREG1', 'Kedim Pamuk', 'complaint_collection', 'Pamuk', 'kedi') t;

  if v_result <> 'applied' then
    raise exception 'fixture 1: expected applied, got %', v_result;
  end if;

  select c.owner_id, c.pet_id into v_owner_id, v_conversation_pet_id
  from public.conversations c
  where c.id = v_conversation_id;

  select count(*) into v_pet_count
  from public.pets p
  where p.owner_id = v_owner_id;

  if v_pet_count <> 1 then
    raise exception 'fixture 1: expected exactly one pet for the owner, got %', v_pet_count;
  end if;

  select p.id, p.name, p.species into v_created_pet_id, v_pet_name, v_pet_species
  from public.pets p
  where p.owner_id = v_owner_id;

  if v_pet_name <> 'Pamuk' then
    raise exception 'fixture 1: expected the confirmed name Pamuk, got %', v_pet_name;
  end if;

  if v_pet_species is distinct from 'kedi' then
    raise exception 'fixture 1: expected species kedi, got %', v_pet_species;
  end if;

  if v_conversation_pet_id is distinct from v_created_pet_id then
    raise exception 'fixture 1: conversation was not bound to the created pet';
  end if;

  if v_version is null then
    raise exception 'fixture 1: applied result did not return a state version';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: a second AI turn that tries to create the same name again --
-- differing only by case and surrounding whitespace -- is refused with
-- `duplicate_pet_name`, writes no pet, and leaves the conversation state and
-- the reply outbox untouched.
-- =========================================================================
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_owner_id uuid;
  v_pet_count integer;
  v_version_before integer;
  v_version_after integer;
  v_outbox_before integer;
  v_outbox_after integer;
begin
  select c.id, c.owner_id, c.state_version
    into v_conversation_id, v_owner_id, v_version_before
  from public.conversations c
  where c.clinic_id = '35000000-0000-0000-0000-000000000001';

  select count(*) into v_outbox_before
  from public.outbound_message_outbox o
  where o.clinic_id = '35000000-0000-0000-0000-000000000001';

  select t.o_result into v_result
  from pg_temp.run_pet_turn('wamid.PETREG2', 'Pamuk', 'complaint_collection', '  pAMUK  ', 'kedi') t;

  if v_result <> 'duplicate_pet_name' then
    raise exception 'fixture 2: expected duplicate_pet_name, got %', v_result;
  end if;

  select count(*) into v_pet_count
  from public.pets p
  where p.owner_id = v_owner_id;

  if v_pet_count <> 1 then
    raise exception 'fixture 2: the refused turn still wrote a pet (count %)', v_pet_count;
  end if;

  select c.state_version into v_version_after
  from public.conversations c
  where c.id = v_conversation_id;

  if v_version_after is distinct from v_version_before then
    raise exception 'fixture 2: a refused turn advanced state_version from % to %', v_version_before, v_version_after;
  end if;

  select count(*) into v_outbox_after
  from public.outbound_message_outbox o
  where o.clinic_id = '35000000-0000-0000-0000-000000000001';

  if v_outbox_after is distinct from v_outbox_before then
    raise exception 'fixture 2: a refused turn queued an outbound reply';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3 (Maya's decision (b), 2026-08-25): clinic staff writing directly
-- through the `pets_all` RLS policy are NOT bound by the duplicate-name
-- rule. An earlier draft of the migration enforced it with a table-wide
-- unique index, which would have failed this insert with a bare 23505 in a
-- code path that never asked for the rule. Two same-named pets for one owner
-- is a legitimate real-world registration, so staff must still record it.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '35100000-0000-0000-0000-000000000001', true);

do $$
declare
  v_owner_id uuid;
  v_staff_pet_id uuid;
begin
  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '35000000-0000-0000-0000-000000000001';

  if v_owner_id is null then
    raise exception 'fixture 3: staff cannot see the owner created by the AI path';
  end if;

  -- The exact insert the removed unique index would have rejected: same
  -- owner, same name under `lower(btrim(name))`.
  insert into public.pets (clinic_id, owner_id, name, species)
  values ('35000000-0000-0000-0000-000000000001', v_owner_id, 'pamuk', 'kedi')
  returning id into v_staff_pet_id;

  if v_staff_pet_id is null then
    raise exception 'fixture 3: staff duplicate-name insert was rejected';
  end if;
end;
$$;

reset role;

-- =========================================================================
-- Fixture 4: the guard reads every pet the owner has, not only AI-created
-- ones. After the staff insert above, a third AI turn is still refused --
-- confirming the rule moved to the AI path rather than being weakened.
-- =========================================================================
do $$
declare
  v_result text;
  v_owner_id uuid;
  v_pet_count integer;
begin
  select t.o_result into v_result
  from pg_temp.run_pet_turn('wamid.PETREG3', 'Pamuk', 'complaint_collection', 'PAMUK', null) t;

  if v_result <> 'duplicate_pet_name' then
    raise exception 'fixture 4: expected duplicate_pet_name after the staff insert, got %', v_result;
  end if;

  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '35000000-0000-0000-0000-000000000001';

  select count(*) into v_pet_count
  from public.pets p
  where p.owner_id = v_owner_id;

  if v_pet_count <> 2 then
    raise exception 'fixture 4: expected the AI pet plus the staff pet, got %', v_pet_count;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 5: a distinct name is still created, species may be null, and the
-- stored name is trimmed. Guards against the `where not exists` check being
-- accidentally broadened into "this owner already has any pet".
-- =========================================================================
do $$
declare
  v_result text;
  v_owner_id uuid;
  v_pet_count integer;
  v_species text;
begin
  select t.o_result into v_result
  from pg_temp.run_pet_turn('wamid.PETREG4', 'Bir de Zeytin var', 'complaint_collection', '  Zeytin  ', null) t;

  if v_result <> 'applied' then
    raise exception 'fixture 5: expected applied for a distinct name, got %', v_result;
  end if;

  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = '35000000-0000-0000-0000-000000000001';

  select count(*) into v_pet_count
  from public.pets p
  where p.owner_id = v_owner_id and p.name = 'Zeytin';

  if v_pet_count <> 1 then
    raise exception 'fixture 5: expected exactly one trimmed Zeytin row, got %', v_pet_count;
  end if;

  select p.species into v_species
  from public.pets p
  where p.owner_id = v_owner_id and p.name = 'Zeytin';

  if v_species is not null then
    raise exception 'fixture 5: expected a null species, got %', v_species;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 6: parameter validation. `create_pet_species` without
-- `create_pet_name` is a caller bug and must raise, not silently drop the
-- species.
-- =========================================================================
do $$
declare
  v_conversation_id uuid;
  v_raised boolean := false;
begin
  select c.id into v_conversation_id
  from public.conversations c
  where c.clinic_id = '35000000-0000-0000-0000-000000000001';

  begin
    perform result from public.finalize_intake_queue_job(
      v_conversation_id,
      'wamid.PETREG4',
      gen_random_uuid(),
      1,
      'complaint_collection',
      null,
      jsonb_build_object('pet_name', 'Zeytin'),
      null,
      null,
      null,
      'kedi'
    );
  exception
    when others then
      v_raised := true;
  end;

  if not v_raised then
    raise exception 'fixture 6: create_pet_species without create_pet_name did not raise';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 7 (Task 036): the real production path. Confirmation is now its own
-- stage, so the pet is created on the intake_confirmation -> safety_check
-- step, not on pet_identification -> complaint_collection. This walks both
-- new edges through the same RPC the Worker calls, and exercises the
-- 'intake_confirmation' reply category the migration added.
-- =========================================================================
do $$
declare
  v_result text;
  v_conversation_id uuid;
  v_stage text;
  v_owner_id uuid;
  v_pet_id uuid;
begin
  -- The shared fixture conversation is parked at complaint_collection.
  select t.o_result, t.o_conversation_id into v_result, v_conversation_id
  from pg_temp.run_pet_turn(
    'wamid.PETREG036A', 'Findik, topalliyor', 'intake_confirmation', null, null, 'intake_confirmation'
  ) t;

  if v_result <> 'applied' then
    raise exception 'fixture 7: expected applied entering intake_confirmation, got %', v_result;
  end if;

  select c.intake_stage into v_stage from public.conversations c where c.id = v_conversation_id;
  if v_stage <> 'intake_confirmation' then
    raise exception 'fixture 7: expected intake_confirmation, got %', v_stage;
  end if;

  -- No pet may exist under this name before the owner confirms.
  select o.id into v_owner_id from public.owners o where o.clinic_id = '35000000-0000-0000-0000-000000000001';
  if exists (select 1 from public.pets p where p.owner_id = v_owner_id and p.name = 'Findik') then
    raise exception 'fixture 7: a pet was created before confirmation';
  end if;

  -- The owner confirms: the same atomic finalize creates the pet and advances.
  select t.o_result into v_result
  from pg_temp.run_pet_turn('wamid.PETREG036B', 'evet', 'safety_check', 'Findik', 'kedi') t;

  if v_result <> 'applied' then
    raise exception 'fixture 7: expected applied on confirmation, got %', v_result;
  end if;

  select c.intake_stage, c.pet_id into v_stage, v_pet_id
  from public.conversations c where c.id = v_conversation_id;
  if v_stage <> 'safety_check' then
    raise exception 'fixture 7: expected safety_check after confirmation, got %', v_stage;
  end if;
  if v_pet_id is null then
    raise exception 'fixture 7: conversation was not bound to the created pet';
  end if;
  if (select p.name from public.pets p where p.id = v_pet_id) <> 'Findik' then
    raise exception 'fixture 7: conversation bound to the wrong pet';
  end if;
end;
$$;

-- Rollback-proof: nothing written by this fixture is ever committed.
rollback;
