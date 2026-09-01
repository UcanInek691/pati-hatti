-- Task 044: rollback-only proof for clinic schedule and appointment-slot
-- self-service. Not run against any database by the implementer; Codex later
-- ran it successfully only on disposable vetai-test on 2026-09-01.
--
-- Property numbers in section headers below match CURRENT_TASK.md's
-- "SQL rollback fixture" list (Task 044 -> Previous task 043 section).

begin;

-- =========================================================================
-- 0. Fixture setup: clinics, staff, owner/pet/conversations, target dates.
-- =========================================================================

create table pg_temp.fixture_dates (key text primary key, value date not null);

do $$
declare
  v_today date := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;
  v_offset int := (8 - extract(isodow from v_today)::int) % 7;
begin
  if v_offset = 0 then
    v_offset := 7;
  end if;

  insert into pg_temp.fixture_dates (key, value) values
    ('today', v_today),
    ('monday', v_today + v_offset + 7),
    ('tuesday', v_today + v_offset + 8),
    ('wednesday', v_today + v_offset + 9),
    ('thursday', v_today + v_offset + 10),
    ('past_date', v_today - 1),
    ('far_future', v_today + 367);

  if extract(isodow from (v_today + v_offset + 7)) <> 1 then
    raise exception 'fixture Monday is not actually a Monday';
  end if;
end;
$$;

insert into auth.users (id, aud, role, email, created_at, updated_at) values
  ('44000000-0000-0000-1000-000000000001', 'authenticated', 'authenticated', 'sched-044-admin-a@example.invalid', now(), now()),
  ('44000000-0000-0000-1000-000000000002', 'authenticated', 'authenticated', 'sched-044-vet-a@example.invalid', now(), now()),
  ('44000000-0000-0000-1000-000000000003', 'authenticated', 'authenticated', 'sched-044-recept-a@example.invalid', now(), now()),
  ('44000000-0000-0000-1000-000000000004', 'authenticated', 'authenticated', 'sched-044-admin-b@example.invalid', now(), now()),
  ('44000000-0000-0000-1000-000000000005', 'authenticated', 'authenticated', 'sched-044-admin-c@example.invalid', now(), now()),
  ('44000000-0000-0000-1000-000000000006', 'authenticated', 'authenticated', 'sched-044-admin-d@example.invalid', now(), now());

insert into public.clinics (id, name, operational_status, suspended_at, offboarding_started_at, offboarding_token) values
  ('44000000-0000-0000-2000-000000000001', 'Schedule Clinic A', 'active', null, null, null),
  ('44000000-0000-0000-2000-000000000002', 'Schedule Clinic B', 'active', null, null, null),
  ('44000000-0000-0000-2000-000000000003', 'Schedule Clinic C (suspended)', 'suspended', now(), null, null),
  ('44000000-0000-0000-2000-000000000004', 'Schedule Clinic D (offboarding)', 'offboarding', null, now(), gen_random_uuid());

insert into public.clinic_staff (clinic_id, user_id, role) values
  ('44000000-0000-0000-2000-000000000001', '44000000-0000-0000-1000-000000000001', 'admin'),
  ('44000000-0000-0000-2000-000000000001', '44000000-0000-0000-1000-000000000002', 'veterinarian'),
  ('44000000-0000-0000-2000-000000000001', '44000000-0000-0000-1000-000000000003', 'receptionist'),
  ('44000000-0000-0000-2000-000000000002', '44000000-0000-0000-1000-000000000004', 'admin'),
  ('44000000-0000-0000-2000-000000000003', '44000000-0000-0000-1000-000000000005', 'admin'),
  ('44000000-0000-0000-2000-000000000004', '44000000-0000-0000-1000-000000000006', 'admin');

insert into public.owners (id, clinic_id, full_name, phone_e164) values
  ('44000000-0000-0000-3000-000000000001', '44000000-0000-0000-2000-000000000001', 'Schedule Owner A', '+15550440001');

insert into public.pets (id, clinic_id, owner_id, name, species) values
  ('44000000-0000-0000-4000-000000000001', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', 'Schedule Pet A', 'dog');

-- Five distinct completed intake conversations: appointment_slots_active_
-- conversation_uniq allows only one held/confirmed slot per conversation_id,
-- while conversations_one_open_per_owner_idx allows only one active/handoff
-- conversation for this owner. Completed conversations satisfy both real
-- invariants and may still back confirmed appointment history.
insert into public.conversations (id, clinic_id, owner_id, pet_id, status) values
  ('44000000-0000-0000-5000-000000000001', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', '44000000-0000-0000-4000-000000000001', 'completed'),
  ('44000000-0000-0000-5000-000000000002', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', '44000000-0000-0000-4000-000000000001', 'completed'),
  ('44000000-0000-0000-5000-000000000003', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', '44000000-0000-0000-4000-000000000001', 'completed'),
  ('44000000-0000-0000-5000-000000000004', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', '44000000-0000-0000-4000-000000000001', 'completed'),
  ('44000000-0000-0000-5000-000000000005', '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-3000-000000000001', '44000000-0000-0000-4000-000000000001', 'completed');

-- =========================================================================
-- Shared rule + property 4/5 (part 1): invalid input raises before any
-- mutation. Uses Wednesday (isodow 3), which no scenario below configures,
-- so a leftover row here would be unambiguous.
-- =========================================================================

do $$
declare
  v_raised boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  v_raised := false;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:15', '10:00');
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected misaligned opens_at to raise'; end if;

  v_raised := false;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '10:00', '09:00');
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected opens_at >= closes_at to raise'; end if;

  v_raised := false;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '24:00');
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected 24:00 closes_at to raise'; end if;

  v_raised := false;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, null, null);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected enabled day with null hours to raise'; end if;

  v_raised := false;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, false, '09:00', null);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected disabled day with a non-null hour to raise'; end if;

  reset role;
end;
$$;

-- A legacy/service-role row may still carry 24:00 because the original table
-- constraint predates this browser mutation surface. Narrowing it must delete
-- a 23:30-00:00 available slot by comparing full local timestamps, not only
-- the end time-of-day (00:00).
do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_wednesday constant date := (select value from pg_temp.fixture_dates where key = 'wednesday');
  v_result text;
  v_removed integer;
  v_preserved integer;
begin
  insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
  values (v_clinic, 3, time '09:00', time '24:00');

  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
  values (
    '44000000-0000-0000-6000-000000000002',
    v_clinic,
    (v_wednesday + time '23:30') at time zone 'Europe/Istanbul',
    (v_wednesday + 1)::timestamp at time zone 'Europe/Istanbul',
    'available'
  );

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 3::smallint, true, '09:00', '18:00');
  if v_result <> 'updated' or v_removed <> 1 or v_preserved <> 0 then
    raise exception 'legacy midnight cleanup: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  perform * from public.set_clinic_weekly_hours_v1(v_clinic, 3::smallint, false, null, null);
  reset role;

  if exists (select 1 from public.appointment_slots where id = '44000000-0000-0000-6000-000000000002')
     or exists (select 1 from public.clinic_weekly_hours where clinic_id = v_clinic and iso_weekday = 3) then
    raise exception 'legacy midnight cleanup left fixture state behind';
  end if;
end;
$$;

do $$
begin
  if exists (select 1 from public.clinic_weekly_hours where clinic_id = '44000000-0000-0000-2000-000000000001' and iso_weekday = 3) then
    raise exception 'invalid weekly-hours input left a row behind';
  end if;
end;
$$;

-- =========================================================================
-- 4, 6, 7 (part 1). Monday: weekly-hours create/replay/narrow/remove,
-- generation/replay, and held/confirmed survival with exact counts.
-- =========================================================================

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_monday constant date := (select value from pg_temp.fixture_dates where key = 'monday');
  v_result text;
  v_removed integer;
  v_preserved integer;
  v_candidates integer;
  v_created integer;
  v_existing integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  -- Create: 09:00-11:30 -> five 30-minute candidates.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 1::smallint, true, '09:00', '11:30');
  if v_result <> 'updated' or v_removed <> 0 or v_preserved <> 0 then
    raise exception 'Monday hours create: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Exact replay is idempotent.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 1::smallint, true, '09:00', '11:30');
  if v_result <> 'unchanged' or v_removed <> 0 or v_preserved <> 0 then
    raise exception 'Monday hours replay: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Generate: five candidates, five created.
  select result, candidate_count, created_count, existing_count
    into v_result, v_candidates, v_created, v_existing
    from public.generate_clinic_appointment_slots_v1(v_clinic, v_monday);
  if v_result <> 'generated' or v_candidates <> 5 or v_created <> 5 or v_existing <> 0 then
    raise exception 'Monday generate: got %/%/%/%', v_result, v_candidates, v_created, v_existing;
  end if;

  -- Replay generate: same five candidates, none newly created (uniqueness).
  select result, candidate_count, created_count, existing_count
    into v_result, v_candidates, v_created, v_existing
    from public.generate_clinic_appointment_slots_v1(v_clinic, v_monday);
  if v_result <> 'unchanged' or v_candidates <> 5 or v_created <> 0 or v_existing <> 5 then
    raise exception 'Monday generate replay: got %/%/%/%', v_result, v_candidates, v_created, v_existing;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_monday constant date := (select value from pg_temp.fixture_dates where key = 'monday');
begin
  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'available'
        and starts_at >= (v_monday::timestamp at time zone 'Europe/Istanbul')
        and starts_at < ((v_monday + 1)::timestamp at time zone 'Europe/Istanbul')) <> 5 then
    raise exception 'expected exactly five generated Monday slots';
  end if;

  -- Simulate two of the five candidates being booked through the existing
  -- appointment-booking engine (out of scope here): one held, one confirmed.
  update public.appointment_slots
    set status = 'held', conversation_id = '44000000-0000-0000-5000-000000000001',
        owner_id = '44000000-0000-0000-3000-000000000001', pet_id = '44000000-0000-0000-4000-000000000001',
        booking_token = gen_random_uuid(), hold_until = pg_catalog.now() + interval '10 minutes'
    where clinic_id = v_clinic and status = 'available'
      and starts_at = ((v_monday + time '10:30') at time zone 'Europe/Istanbul');

  update public.appointment_slots
    set status = 'confirmed', conversation_id = '44000000-0000-0000-5000-000000000002',
        owner_id = '44000000-0000-0000-3000-000000000001', pet_id = '44000000-0000-0000-4000-000000000001',
        booking_token = gen_random_uuid(), confirmed_at = pg_catalog.now()
    where clinic_id = v_clinic and status = 'available'
      and starts_at = ((v_monday + time '11:00') at time zone 'Europe/Istanbul');

  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'held'
        and starts_at = ((v_monday + time '10:30') at time zone 'Europe/Istanbul')) <> 1
     or (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'confirmed'
        and starts_at = ((v_monday + time '11:00') at time zone 'Europe/Istanbul')) <> 1 then
    raise exception 'expected exactly one held and one confirmed Monday slot before narrowing';
  end if;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_result text;
  v_removed integer;
  v_preserved integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  -- Narrow 09:00-11:30 -> 09:00-10:00: only the 10:00 available candidate is
  -- now out of bounds (removed=1); the held/confirmed rows at 10:30/11:00
  -- survive untouched but are counted as affected (preserved=2).
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 1::smallint, true, '09:00', '10:00');
  if v_result <> 'updated' or v_removed <> 1 or v_preserved <> 2 then
    raise exception 'Monday hours narrow: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_monday constant date := (select value from pg_temp.fixture_dates where key = 'monday');
begin
  if exists (select 1 from public.appointment_slots where clinic_id = v_clinic and status = 'available'
        and starts_at = ((v_monday + time '10:00') at time zone 'Europe/Istanbul')) then
    raise exception 'expected the 10:00 available Monday slot to be removed by narrowing';
  end if;
  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'available'
        and starts_at >= (v_monday::timestamp at time zone 'Europe/Istanbul')
        and starts_at < ((v_monday + 1)::timestamp at time zone 'Europe/Istanbul')) <> 2 then
    raise exception 'expected exactly two available Monday slots (09:00, 09:30) to remain';
  end if;
  if (select status from public.appointment_slots where clinic_id = v_clinic
        and starts_at = ((v_monday + time '10:30') at time zone 'Europe/Istanbul')) <> 'held'
     or (select status from public.appointment_slots where clinic_id = v_clinic
        and starts_at = ((v_monday + time '11:00') at time zone 'Europe/Istanbul')) <> 'confirmed' then
    raise exception 'narrowing must never change a held/confirmed slot''s status';
  end if;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_result text;
  v_removed integer;
  v_preserved integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  -- Disable the day entirely: removes the two remaining available slots;
  -- the held/confirmed rows still survive and are still counted.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 1::smallint, false, null, null);
  if v_result <> 'removed' or v_removed <> 2 or v_preserved <> 2 then
    raise exception 'Monday hours disable: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Replay disable is idempotent: the row is already gone.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 1::smallint, false, null, null);
  if v_result <> 'unchanged' or v_removed <> 0 or v_preserved <> 2 then
    raise exception 'Monday hours disable replay: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_monday constant date := (select value from pg_temp.fixture_dates where key = 'monday');
begin
  if exists (select 1 from public.clinic_weekly_hours where clinic_id = v_clinic and iso_weekday = 1) then
    raise exception 'expected the Monday weekly-hours row to be gone after disable';
  end if;
  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'available'
        and starts_at >= (v_monday::timestamp at time zone 'Europe/Istanbul')
        and starts_at < ((v_monday + 1)::timestamp at time zone 'Europe/Istanbul')) <> 0 then
    raise exception 'expected zero available Monday slots after disabling the day';
  end if;
  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status in ('held', 'confirmed')
        and starts_at >= (v_monday::timestamp at time zone 'Europe/Istanbul')
        and starts_at < ((v_monday + 1)::timestamp at time zone 'Europe/Istanbul')) <> 2 then
    raise exception 'expected the held and confirmed Monday slots to still exist';
  end if;
end;
$$;

-- =========================================================================
-- 5, 6, 7 (part 2). Tuesday: closure add/replay/remove/replay, exact
-- local-date cleanup, held survival, and closed-date generation refusal
-- followed by a non-automatic, explicit re-generation.
-- =========================================================================

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
  v_result text;
  v_removed integer;
  v_preserved integer;
  v_candidates integer;
  v_created integer;
  v_existing integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_weekly_hours_v1(v_clinic, 2::smallint, true, '09:00', '10:30');
  if v_result <> 'updated' then
    raise exception 'Tuesday hours create: got %', v_result;
  end if;

  select result, candidate_count, created_count, existing_count
    into v_result, v_candidates, v_created, v_existing
    from public.generate_clinic_appointment_slots_v1(v_clinic, v_tuesday);
  if v_result <> 'generated' or v_candidates <> 3 or v_created <> 3 then
    raise exception 'Tuesday generate: got %/%/%/%', v_result, v_candidates, v_created, v_existing;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
begin
  update public.appointment_slots
    set status = 'held', conversation_id = '44000000-0000-0000-5000-000000000003',
        owner_id = '44000000-0000-0000-3000-000000000001', pet_id = '44000000-0000-0000-4000-000000000001',
        booking_token = gen_random_uuid(), hold_until = pg_catalog.now() + interval '10 minutes'
    where clinic_id = v_clinic and status = 'available'
      and starts_at = ((v_tuesday + time '09:30') at time zone 'Europe/Istanbul');

  if (select count(*) from public.appointment_slots where clinic_id = v_clinic and status = 'held'
        and starts_at = ((v_tuesday + time '09:30') at time zone 'Europe/Istanbul')) <> 1 then
    raise exception 'expected the 09:30 Tuesday slot to be held before closing the date';
  end if;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
  v_result text;
  v_removed integer;
  v_preserved integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  -- Add closure: removes the two remaining available slots (09:00, 10:00);
  -- the held 09:30 slot survives and is counted.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_closure_date_v1(v_clinic, v_tuesday, true);
  if v_result <> 'updated' or v_removed <> 2 or v_preserved <> 1 then
    raise exception 'Tuesday closure add: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Replay add is idempotent; no further removal.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_closure_date_v1(v_clinic, v_tuesday, true);
  if v_result <> 'unchanged' or v_removed <> 0 or v_preserved <> 1 then
    raise exception 'Tuesday closure add replay: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Generation is refused for a closed date.
  select result into v_result from public.generate_clinic_appointment_slots_v1(v_clinic, v_tuesday);
  if v_result <> 'closed' then
    raise exception 'expected generation on a closed date to return closed, got %', v_result;
  end if;

  -- Remove closure: creates no slots automatically.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_closure_date_v1(v_clinic, v_tuesday, false);
  if v_result <> 'removed' or v_removed <> 0 or v_preserved <> 0 then
    raise exception 'Tuesday closure remove: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  -- Replay remove is idempotent.
  select result, removed_slots, preserved_active_slots
    into v_result, v_removed, v_preserved
    from public.set_clinic_closure_date_v1(v_clinic, v_tuesday, false);
  if v_result <> 'unchanged' or v_removed <> 0 or v_preserved <> 0 then
    raise exception 'Tuesday closure remove replay: got %/%/%', v_result, v_removed, v_preserved;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
begin
  if exists (select 1 from public.clinic_closure_dates where clinic_id = v_clinic and closed_on = v_tuesday) then
    raise exception 'expected the Tuesday closure row to be gone after removal';
  end if;
  -- Removing the closure did not resurrect the two deleted available slots:
  -- only the surviving held row remains until an explicit generate call.
  if (select count(*) from public.appointment_slots where clinic_id = v_clinic
        and starts_at >= (v_tuesday::timestamp at time zone 'Europe/Istanbul')
        and starts_at < ((v_tuesday + 1)::timestamp at time zone 'Europe/Istanbul')) <> 1 then
    raise exception 'removing a closure must not silently regenerate slots';
  end if;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
  v_result text;
  v_candidates integer;
  v_created integer;
  v_existing integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  -- Explicit re-generation resurrects only the two missing candidates and
  -- leaves the held row untouched (existing_count counts the conflict).
  select result, candidate_count, created_count, existing_count
    into v_result, v_candidates, v_created, v_existing
    from public.generate_clinic_appointment_slots_v1(v_clinic, v_tuesday);
  if v_result <> 'generated' or v_candidates <> 3 or v_created <> 2 or v_existing <> 1 then
    raise exception 'Tuesday re-generate: got %/%/%/%', v_result, v_candidates, v_created, v_existing;
  end if;

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_tuesday constant date := (select value from pg_temp.fixture_dates where key = 'tuesday');
begin
  if (select status from public.appointment_slots where clinic_id = v_clinic
        and starts_at = ((v_tuesday + time '09:30') at time zone 'Europe/Istanbul')) <> 'held' then
    raise exception 're-generation must never change an existing held slot';
  end if;
end;
$$;

-- =========================================================================
-- Shared rule + property 5/7 (part 2). Operator date-window bounds.
-- =========================================================================

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_past constant date := (select value from pg_temp.fixture_dates where key = 'past_date');
  v_far_future constant date := (select value from pg_temp.fixture_dates where key = 'far_future');
  v_result text;
  v_raised boolean;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  v_raised := false;
  begin
    perform * from public.set_clinic_closure_date_v1(v_clinic, v_past, true);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected a past closure date to raise'; end if;

  v_raised := false;
  begin
    perform * from public.set_clinic_closure_date_v1(v_clinic, v_far_future, true);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected a >366-day closure date to raise'; end if;

  v_raised := false;
  begin
    perform * from public.generate_clinic_appointment_slots_v1(v_clinic, v_far_future);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then raise exception 'expected a >366-day generation date to raise'; end if;

  -- A past generation date is authorized input, not a shape violation: it
  -- reaches the RPC and is refused with a closed result, not an exception.
  select result into v_result from public.generate_clinic_appointment_slots_v1(v_clinic, v_past);
  if v_result <> 'past' then
    raise exception 'expected past-date generation to return past, got %', v_result;
  end if;

  reset role;
end;
$$;

do $$
begin
  if exists (select 1 from public.clinic_closure_dates where clinic_id = '44000000-0000-0000-2000-000000000001'
        and closed_on in ((select value from pg_temp.fixture_dates where key = 'past_date'),
                          (select value from pg_temp.fixture_dates where key = 'far_future'))) then
    raise exception 'out-of-window closure input left a row behind';
  end if;
end;
$$;

-- =========================================================================
-- 8. Thursday: slot deletion across available/held/confirmed/past/absent/
-- cross-tenant, without changing any booking relation.
-- =========================================================================

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_thursday constant date := (select value from pg_temp.fixture_dates where key = 'thursday');
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  perform * from public.set_clinic_weekly_hours_v1(v_clinic, 4::smallint, true, '09:00', '11:00');
  perform * from public.generate_clinic_appointment_slots_v1(v_clinic, v_thursday);

  reset role;
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_thursday constant date := (select value from pg_temp.fixture_dates where key = 'thursday');
begin
  update public.appointment_slots
    set status = 'held', conversation_id = '44000000-0000-0000-5000-000000000004',
        owner_id = '44000000-0000-0000-3000-000000000001', pet_id = '44000000-0000-0000-4000-000000000001',
        booking_token = gen_random_uuid(), hold_until = pg_catalog.now() + interval '10 minutes'
    where clinic_id = v_clinic and status = 'available'
      and starts_at = ((v_thursday + time '10:00') at time zone 'Europe/Istanbul');

  update public.appointment_slots
    set status = 'confirmed', conversation_id = '44000000-0000-0000-5000-000000000005',
        owner_id = '44000000-0000-0000-3000-000000000001', pet_id = '44000000-0000-0000-4000-000000000001',
        booking_token = gen_random_uuid(), confirmed_at = pg_catalog.now()
    where clinic_id = v_clinic and status = 'available'
      and starts_at = ((v_thursday + time '10:30') at time zone 'Europe/Istanbul');

  -- A slot that has already started: inserted directly, since the RPC only
  -- ever generates future candidates. Aligned to a whole hour, which is
  -- always a UTC :00 boundary regardless of session timezone.
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
  values (
    '44000000-0000-0000-6000-000000000001', v_clinic,
    date_trunc('hour', pg_catalog.now()) - interval '3 hours',
    date_trunc('hour', pg_catalog.now()) - interval '3 hours' + interval '30 minutes',
    'available'
  );
end;
$$;

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_other_clinic constant uuid := '44000000-0000-0000-2000-000000000002';
  v_thursday constant date := (select value from pg_temp.fixture_dates where key = 'thursday');
  v_held_id uuid;
  v_confirmed_id uuid;
  v_available_id uuid;
  v_result text;
begin
  select id into v_held_id from public.appointment_slots
    where clinic_id = v_clinic and starts_at = ((v_thursday + time '10:00') at time zone 'Europe/Istanbul');
  select id into v_confirmed_id from public.appointment_slots
    where clinic_id = v_clinic and starts_at = ((v_thursday + time '10:30') at time zone 'Europe/Istanbul');
  select id into v_available_id from public.appointment_slots
    where clinic_id = v_clinic and starts_at = ((v_thursday + time '09:00') at time zone 'Europe/Istanbul');

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, v_held_id);
  if v_result <> 'in_use' then
    raise exception 'expected deleting a held slot to return in_use, got %', v_result;
  end if;

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, v_confirmed_id);
  if v_result <> 'in_use' then
    raise exception 'expected deleting a confirmed slot to return in_use, got %', v_result;
  end if;

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, '44000000-0000-0000-6000-000000000001');
  if v_result <> 'past' then
    raise exception 'expected deleting a started slot to return past, got %', v_result;
  end if;

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, gen_random_uuid());
  if v_result <> 'not_found' then
    raise exception 'expected deleting an absent slot to return not_found, got %', v_result;
  end if;

  reset role;

  -- Cross-tenant: clinic B's admin is not staff of clinic A.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000004', true);

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, v_available_id);
  if v_result <> 'not_found' then
    raise exception 'expected a cross-tenant delete to return not_found, got %', v_result;
  end if;

  reset role;

  -- Finally, the legitimate admin deletes the untouched available slot.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000001', true);

  select result into v_result from public.delete_clinic_appointment_slot_v1(v_clinic, v_available_id);
  if v_result <> 'deleted' then
    raise exception 'expected deleting a future available slot to succeed, got %', v_result;
  end if;

  reset role;

  if exists (select 1 from public.appointment_slots where id = v_available_id) then
    raise exception 'expected the deleted slot to be gone';
  end if;
  if (select status from public.appointment_slots where id = v_held_id) <> 'held'
     or (select status from public.appointment_slots where id = v_confirmed_id) <> 'confirmed'
     or (select status from public.appointment_slots where id = '44000000-0000-0000-6000-000000000001') <> 'available' then
    raise exception 'deletion attempts must never change another slot''s status';
  end if;
  if (select count(*) from public.conversations where id in (
        '44000000-0000-0000-5000-000000000004', '44000000-0000-0000-5000-000000000005'
      ) and status = 'completed') <> 2 then
    raise exception 'deletion attempts must never touch a conversation row';
  end if;
end;
$$;

-- =========================================================================
-- 2. Role/tenant denial matrix: veterinarian, receptionist, anon,
-- service-role and cross-clinic callers are denied with zero mutation.
-- Clinic-admin mutation success is already proven throughout sections
-- above (Monday/Tuesday/Thursday, all as clinic A's admin).
-- =========================================================================

do $$
begin
  -- Veterinarian and receptionist: same-clinic, non-admin.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000002', true);
  if (select result from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '10:00')) <> 'forbidden' then
    raise exception 'expected veterinarian mutation to be forbidden';
  end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000003', true);
  if (select result from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '10:00')) <> 'forbidden' then
    raise exception 'expected receptionist mutation to be forbidden';
  end if;
  reset role;

  -- Cross-clinic admin: clinic B's admin is not staff of clinic A, so this
  -- is indistinguishable from an absent clinic.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000004', true);
  if (select result from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '10:00')) <> 'not_found' then
    raise exception 'expected cross-clinic admin mutation to return not_found';
  end if;
  reset role;
end;
$$;

do $$
begin
  -- anon holds no grant on any of the four mutation RPCs or the read RPC.
  set local role anon;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '10:00');
    raise exception 'anon unexpectedly executed set_clinic_weekly_hours_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.set_clinic_closure_date_v1('44000000-0000-0000-2000-000000000001', (select value from pg_temp.fixture_dates where key = 'wednesday'), true);
    raise exception 'anon unexpectedly executed set_clinic_closure_date_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.generate_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000001', (select value from pg_temp.fixture_dates where key = 'wednesday'));
    raise exception 'anon unexpectedly executed generate_clinic_appointment_slots_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.delete_clinic_appointment_slot_v1('44000000-0000-0000-2000-000000000001', gen_random_uuid());
    raise exception 'anon unexpectedly executed delete_clinic_appointment_slot_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.list_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000001', (select value from pg_temp.fixture_dates where key = 'today'), (select value from pg_temp.fixture_dates where key = 'today') + 13);
    raise exception 'anon unexpectedly executed list_clinic_appointment_slots_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
begin
  -- service_role is explicitly revoked at runtime on the public surface;
  -- only vetai_private.authorize_clinic_schedule_mutation is service-role-only.
  set local role service_role;
  begin
    perform * from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000001', 3::smallint, true, '09:00', '10:00');
    raise exception 'service_role unexpectedly executed set_clinic_weekly_hours_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.list_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000001', (select value from pg_temp.fixture_dates where key = 'today'), (select value from pg_temp.fixture_dates where key = 'today') + 13);
    raise exception 'service_role unexpectedly executed list_clinic_appointment_slots_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
begin
  if exists (select 1 from public.clinic_weekly_hours where clinic_id = '44000000-0000-0000-2000-000000000001' and iso_weekday = 3)
     or exists (select 1 from public.clinic_closure_dates where clinic_id = '44000000-0000-0000-2000-000000000001' and closed_on = (select value from pg_temp.fixture_dates where key = 'wednesday')) then
    raise exception 'denied callers left a mutation behind on the Wednesday probe row';
  end if;
end;
$$;

-- =========================================================================
-- 3. Suspended/offboarding clinics: reads still work, every mutation on
-- all four RPCs fails closed with inactive and zero mutation.
-- =========================================================================

do $$
declare
  v_probe_date constant date := (select value from pg_temp.fixture_dates where key = 'wednesday');
begin
  -- Clinic C: suspended.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000005', true);

  perform * from public.list_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000003', v_probe_date, v_probe_date + 13);

  if (select result from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000003', 1::smallint, true, '09:00', '10:00')) <> 'inactive' then
    raise exception 'expected suspended-clinic hours mutation to return inactive';
  end if;
  if (select result from public.set_clinic_closure_date_v1('44000000-0000-0000-2000-000000000003', v_probe_date, true)) <> 'inactive' then
    raise exception 'expected suspended-clinic closure mutation to return inactive';
  end if;
  if (select result from public.generate_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000003', v_probe_date)) <> 'inactive' then
    raise exception 'expected suspended-clinic generation to return inactive';
  end if;
  if (select result from public.delete_clinic_appointment_slot_v1('44000000-0000-0000-2000-000000000003', gen_random_uuid())) <> 'inactive' then
    raise exception 'expected suspended-clinic deletion to return inactive';
  end if;

  reset role;

  -- Clinic D: offboarding.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000006', true);

  perform * from public.list_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000004', v_probe_date, v_probe_date + 13);

  if (select result from public.set_clinic_weekly_hours_v1('44000000-0000-0000-2000-000000000004', 1::smallint, true, '09:00', '10:00')) <> 'inactive' then
    raise exception 'expected offboarding-clinic hours mutation to return inactive';
  end if;
  if (select result from public.set_clinic_closure_date_v1('44000000-0000-0000-2000-000000000004', v_probe_date, true)) <> 'inactive' then
    raise exception 'expected offboarding-clinic closure mutation to return inactive';
  end if;
  if (select result from public.generate_clinic_appointment_slots_v1('44000000-0000-0000-2000-000000000004', v_probe_date)) <> 'inactive' then
    raise exception 'expected offboarding-clinic generation to return inactive';
  end if;
  if (select result from public.delete_clinic_appointment_slot_v1('44000000-0000-0000-2000-000000000004', gen_random_uuid())) <> 'inactive' then
    raise exception 'expected offboarding-clinic deletion to return inactive';
  end if;

  reset role;
end;
$$;

do $$
begin
  if exists (select 1 from public.clinic_weekly_hours where clinic_id in ('44000000-0000-0000-2000-000000000003', '44000000-0000-0000-2000-000000000004'))
     or exists (select 1 from public.clinic_closure_dates where clinic_id in ('44000000-0000-0000-2000-000000000003', '44000000-0000-0000-2000-000000000004'))
     or exists (select 1 from public.appointment_slots where clinic_id in ('44000000-0000-0000-2000-000000000003', '44000000-0000-0000-2000-000000000004')) then
    raise exception 'a fail-closed lifecycle mutation left a row behind';
  end if;
end;
$$;

-- =========================================================================
-- 1. Same-clinic staff read access, cross-tenant isolation, no direct
-- table access, and no identity/content/token leakage in the projection.
-- =========================================================================

do $$
declare
  v_clinic constant uuid := '44000000-0000-0000-2000-000000000001';
  v_from constant date := (select value from pg_temp.fixture_dates where key = 'today');
  v_to constant date := v_from + 61;
  v_slot_ids uuid[];
  v_statuses text[];
  v_raised boolean := false;
begin
  -- Any same-clinic role, not just admin, may read.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000002', true);

  select array_agg(status order by starts_at) into v_statuses
    from public.list_clinic_appointment_slots_v1(v_clinic, v_from, v_to);
  if v_statuses is null or not (v_statuses @> array['held', 'confirmed']) then
    raise exception 'expected the veterinarian read to include the held/confirmed rows, got %', v_statuses;
  end if;
  if exists (select 1 from unnest(v_statuses) s where s not in ('available', 'held', 'confirmed')) then
    raise exception 'unexpected slot status in projection: %', v_statuses;
  end if;

  begin
    perform * from public.list_clinic_appointment_slots_v1(v_clinic, v_from, v_from + 62);
  exception
    when raise_exception then v_raised := true;
  end;
  if not v_raised then
    raise exception 'expected an inclusive 63-day read window to raise';
  end if;

  begin
    perform 1 from public.appointment_slots limit 1;
    raise exception 'authenticated staff unexpectedly read appointment_slots directly';
  exception
    when insufficient_privilege then null;
  end;

  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000003', true);
  select array_agg(status) into v_statuses from public.list_clinic_appointment_slots_v1(v_clinic, v_from, v_to);
  if v_statuses is null then
    raise exception 'expected the receptionist read to also succeed';
  end if;
  reset role;

  -- Cross-tenant: clinic B's admin sees no rows for clinic A.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '44000000-0000-0000-1000-000000000004', true);
  select array_agg(slot_id) into v_slot_ids from public.list_clinic_appointment_slots_v1(v_clinic, v_from, v_to);
  if v_slot_ids is not null then
    raise exception 'expected a cross-tenant read to return zero rows, got %', array_length(v_slot_ids, 1);
  end if;
  reset role;
end;
$$;

-- =========================================================================
-- 9. Security mode, search_path, grants for all five RPCs (plus the
-- service-role-only helper), and no identity/content/token/provider field
-- in the read projection.
-- =========================================================================

do $$
declare
  v_fn record;
  v_proc record;
  v_grantees text[];
begin
  for v_fn in
    select * from (values
      ('public', 'list_clinic_appointment_slots_v1', 's', array['authenticated']::text[]),
      ('public', 'set_clinic_weekly_hours_v1', 'v', array['authenticated']::text[]),
      ('public', 'set_clinic_closure_date_v1', 'v', array['authenticated']::text[]),
      ('public', 'generate_clinic_appointment_slots_v1', 'v', array['authenticated']::text[]),
      ('public', 'delete_clinic_appointment_slot_v1', 'v', array['authenticated']::text[]),
      ('vetai_private', 'authorize_clinic_schedule_mutation', 'v', array['service_role']::text[])
    ) as t(schema_name, fn_name, expected_volatility, expected_grantees)
  loop
    select p.prosecdef, p.provolatile, p.proconfig, p.proowner::regrole::text as owner
      into v_proc
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      where n.nspname = v_fn.schema_name and p.proname = v_fn.fn_name;

    if not v_proc.prosecdef then
      raise exception '% is not SECURITY DEFINER', v_fn.fn_name;
    end if;
    if v_proc.provolatile <> v_fn.expected_volatility then
      raise exception '% has unexpected volatility %', v_fn.fn_name, v_proc.provolatile;
    end if;
    if v_proc.proconfig is null or not (
      v_proc.proconfig @> array['search_path='] or v_proc.proconfig @> array['search_path=""']
    ) then
      raise exception '% does not SET search_path = '''', got %', v_fn.fn_name, v_proc.proconfig;
    end if;

    select array_agg(distinct rp.grantee order by rp.grantee)
      into v_grantees
      from information_schema.routine_privileges rp
      where rp.routine_schema = v_fn.schema_name and rp.routine_name = v_fn.fn_name
        and rp.privilege_type = 'EXECUTE'
        and rp.grantee <> v_proc.owner;

    if v_grantees is distinct from v_fn.expected_grantees then
      raise exception '% expected grantees % but got %', v_fn.fn_name, v_fn.expected_grantees, v_grantees;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_columns text[];
  v_expected constant text[] := array['slot_id', 'starts_at', 'ends_at', 'status'];
begin
  select array_agg(p.parameter_name order by p.ordinal_position)
    into v_columns
    from information_schema.parameters p
    where p.specific_schema = 'public'
      and p.specific_name = (
        select r.specific_name from information_schema.routines r
        where r.routine_schema = 'public' and r.routine_name = 'list_clinic_appointment_slots_v1'
      )
      and p.parameter_mode = 'OUT';
  if v_columns is distinct from v_expected then
    raise exception 'list_clinic_appointment_slots_v1 result columns changed: %', v_columns;
  end if;
end;
$$;

do $$
begin
  -- Direct browser-role table access to appointment_slots remains revoked and
  -- policy-free. Existing backend service_role access is intentionally
  -- unchanged.
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'appointment_slots'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'appointment_slots unexpectedly has a direct grant for a runtime role';
  end if;

  if (
    select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and tablename = 'appointment_slots'
  ) <> 0 then
    raise exception 'appointment_slots unexpectedly has an RLS policy';
  end if;

  -- The 48-row generation cap is a hard LIMIT in the function body. The
  -- public mutation RPC rejects 24:00, so a valid interval yields at most 47
  -- half-hour candidates; this assertion is structural, not a two-session or
  -- runtime blocking proof.
  if pg_catalog.pg_get_functiondef('public.generate_clinic_appointment_slots_v1(uuid, date)'::regprocedure) not like '%limit 48%' then
    raise exception 'generate_clinic_appointment_slots_v1 is missing its 48-row candidate cap';
  end if;

  if pg_catalog.pg_get_functiondef('public.set_clinic_weekly_hours_v1(uuid, smallint, boolean, time without time zone, time without time zone)'::regprocedure)
       not like '%order by s.id%for update%' then
    raise exception 'weekly-hours cleanup is missing deterministic ascending slot locking';
  end if;
  if pg_catalog.pg_get_functiondef('public.set_clinic_closure_date_v1(uuid, date, boolean)'::regprocedure)
       not like '%order by s.id%for update%' then
    raise exception 'closure cleanup is missing deterministic ascending slot locking';
  end if;

  if pg_catalog.pg_get_functiondef('vetai_private.authorize_clinic_schedule_mutation(uuid)'::regprocedure)
       not like '%for no key update%' then
    raise exception 'schedule authorization must avoid conflicting with FK key-share locks';
  end if;
end;
$$;

-- =========================================================================
-- 10. Fixture is tenant/fixed-ID scoped; rollback below leaves zero
-- residue. This block proves the fixture rows exist immediately before
-- the rollback that removes them.
-- =========================================================================

select
  (select count(*) from public.clinics where id in (
    '44000000-0000-0000-2000-000000000001', '44000000-0000-0000-2000-000000000002',
    '44000000-0000-0000-2000-000000000003', '44000000-0000-0000-2000-000000000004'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '44000000-0000-0000-1000-000000000001', '44000000-0000-0000-1000-000000000002',
    '44000000-0000-0000-1000-000000000003', '44000000-0000-0000-1000-000000000004',
    '44000000-0000-0000-1000-000000000005', '44000000-0000-0000-1000-000000000006'
  )) as remaining_test_users,
  (select count(*) from public.appointment_slots where clinic_id = '44000000-0000-0000-2000-000000000001') as remaining_test_slots;

rollback;
