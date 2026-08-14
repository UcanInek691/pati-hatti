-- Rollback-only proof for Task 031 clinic operations: the new public.clinics
-- contact/address columns, public.clinic_weekly_hours,
-- public.clinic_closure_dates, and
-- public.get_conversation_clinic_operational_context. Never run this
-- fixture script against a real clinic database.
--
-- Europe/Istanbul has used a fixed UTC+3 offset with no daylight-saving
-- change since 2016, so every timestamptz literal below is written as
-- (intended local time - 3 hours). 2026-08-17 is a Monday (iso_weekday 1)
-- and 2026-08-18 is a Tuesday (iso_weekday 2).
--
-- Single-session limitation: this fixture proves the documented constraint,
-- RLS, and time-window contract inside one PostgreSQL session; it does not
-- itself exercise concurrent access.
--
-- Codex ran this fixture on disposable vetai-test on 2026-08-14: PASS with
-- zero remaining test clinics, users, weekly-hours rows, or closure rows.

begin;

-- =========================================================================
-- Fixtures: four clinics (A configured with an address, B configured with a
-- null address for nullability coherence, C left unconfigured, D a
-- throwaway clinic for the erasure-cascade case), one owner/conversation
-- per clinic, and staff accounts for A and B to exercise same-clinic RLS.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('03100000-0000-0000-0000-000000000001', 'Clinic Ops Test Clinic A'),
  ('03100000-0000-0000-0000-000000000002', 'Clinic Ops Test Clinic B'),
  ('03100000-0000-0000-0000-000000000003', 'Clinic Ops Test Clinic C'),
  ('03100000-0000-0000-0000-000000000004', 'Clinic Ops Test Clinic D');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('03110000-0000-0000-0000-000000000001', '03100000-0000-0000-0000-000000000001', 'A Owner', '+15559970001'),
  ('03110000-0000-0000-0000-000000000002', '03100000-0000-0000-0000-000000000002', 'B Owner', '+15559970002'),
  ('03110000-0000-0000-0000-000000000003', '03100000-0000-0000-0000-000000000003', 'C Owner', '+15559970003'),
  ('03110000-0000-0000-0000-000000000004', '03100000-0000-0000-0000-000000000004', 'D Owner', '+15559970004');

insert into public.conversations (id, clinic_id, owner_id)
values
  ('03120000-0000-0000-0000-000000000001', '03100000-0000-0000-0000-000000000001', '03110000-0000-0000-0000-000000000001'),
  ('03120000-0000-0000-0000-000000000002', '03100000-0000-0000-0000-000000000002', '03110000-0000-0000-0000-000000000002'),
  ('03120000-0000-0000-0000-000000000003', '03100000-0000-0000-0000-000000000003', '03110000-0000-0000-0000-000000000003'),
  ('03120000-0000-0000-0000-000000000004', '03100000-0000-0000-0000-000000000004', '03110000-0000-0000-0000-000000000004');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('03130000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'clinic-ops-a@example.invalid', now(), now()),
  ('03130000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'clinic-ops-b@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('03100000-0000-0000-0000-000000000001', '03130000-0000-0000-0000-000000000001', 'admin'),
  ('03100000-0000-0000-0000-000000000002', '03130000-0000-0000-0000-000000000002', 'admin');

-- =========================================================================
-- Column/table constraint proofs, run before clinic A is made configured.
-- =========================================================================

do $$
begin
  begin
    update public.clinics set contact_phone_e164 = '5551234567' where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected a phone without a leading + to be rejected';
  exception when check_violation then null;
  end;

  begin
    update public.clinics set contact_phone_e164 = '+0123456789' where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected a phone with a leading zero national digit to be rejected';
  exception when check_violation then null;
  end;

  begin
    update public.clinics set public_address = ' Leading space address' where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected an untrimmed address to be rejected';
  exception when check_violation then null;
  end;

  begin
    update public.clinics set public_address = '' where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected an empty address to be rejected';
  exception when check_violation then null;
  end;

  begin
    update public.clinics set public_address = repeat('x', 501) where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected a 501-character address to be rejected';
  exception when check_violation then null;
  end;

  begin
    update public.clinics set public_address = E'Line one\nLine two' where id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected an address containing a control character to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
    values ('03100000-0000-0000-0000-000000000001', 0, '09:00', '17:00');
    raise exception 'expected iso_weekday 0 to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
    values ('03100000-0000-0000-0000-000000000001', 8, '09:00', '17:00');
    raise exception 'expected iso_weekday 8 to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
    values ('03100000-0000-0000-0000-000000000001', 1, '17:00', '09:00');
    raise exception 'expected opens_at >= closes_at to be rejected';
  exception when check_violation then null;
  end;

  if exists (select 1 from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000001') then
    raise exception 'expected zero partial mutation from the rejected weekly-hours proofs above';
  end if;
end;
$$;

-- =========================================================================
-- Make clinic A and clinic B configured; clinic C stays unconfigured (a
-- valid name/phone but zero weekly-hours rows).
-- =========================================================================

update public.clinics set contact_phone_e164 = '+15559980001', public_address = 'A Test Street 1' where id = '03100000-0000-0000-0000-000000000001';
update public.clinics set contact_phone_e164 = '+15559980002', public_address = null where id = '03100000-0000-0000-0000-000000000002';
update public.clinics set contact_phone_e164 = '+15559980003' where id = '03100000-0000-0000-0000-000000000003';

insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
values
  ('03100000-0000-0000-0000-000000000001', 1, '09:00', '17:00'),
  ('03100000-0000-0000-0000-000000000002', 1, '09:00', '17:00'),
  ('03100000-0000-0000-0000-000000000004', 1, '09:00', '17:00');

insert into public.clinic_closure_dates (clinic_id, closed_on)
values ('03100000-0000-0000-0000-000000000004', date '2026-08-17');

-- =========================================================================
-- Behavioral proofs, as service_role: open/closed/unconfigured/not_found,
-- cross-tenant isolation, and null-input rejection.
-- =========================================================================

set local role service_role;

do $$
declare
  v_result text;
  v_name text;
  v_phone text;
  v_address text;
  v_is_open boolean;
  v_bad_name text;
begin
  -- Exact opens_at (09:00 local -> 06:00 UTC) is included.
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 06:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> true then
    raise exception 'expected clinic A to be open exactly at opens_at, got %/%', v_result, v_is_open;
  end if;

  -- Inside [09:00, 17:00) local -> 07:00 UTC.
  select result, clinic_name, contact_phone_e164, public_address, is_open
    into v_result, v_name, v_phone, v_address, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'configured' or v_name <> 'Clinic Ops Test Clinic A' or v_phone <> '+15559980001'
     or v_address <> 'A Test Street 1' or v_is_open <> true then
    raise exception 'expected clinic A to be open inside its interval, got %/%/%/%/%', v_result, v_name, v_phone, v_address, v_is_open;
  end if;

  -- Exactly at closes_at (17:00 local -> 14:00 UTC): half-open interval excludes it.
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 14:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> false then
    raise exception 'expected clinic A to be closed exactly at closes_at, got %/%', v_result, v_is_open;
  end if;

  -- Before opening (08:00 local -> 05:00 UTC).
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 05:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> false then
    raise exception 'expected clinic A to be closed before opening, got %/%', v_result, v_is_open;
  end if;

  -- Unscheduled weekday (Tuesday 2026-08-18, 10:00 local -> 07:00 UTC).
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-18 07:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> false then
    raise exception 'expected clinic A to be closed on an unscheduled weekday, got %/%', v_result, v_is_open;
  end if;

  -- Cross-tenant isolation: clinic A's conversation never returns clinic B's profile.
  select result, clinic_name, contact_phone_e164 into v_result, v_name, v_phone
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_name = 'Clinic Ops Test Clinic B' or v_phone = '+15559980002' then
    raise exception 'expected clinic A conversation to never return clinic B profile';
  end if;

  -- Clinic B: configured with a null address (nullability coherence).
  select result, clinic_name, contact_phone_e164, public_address, is_open
    into v_result, v_name, v_phone, v_address, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000002', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'configured' or v_name <> 'Clinic Ops Test Clinic B' or v_phone <> '+15559980002'
     or v_address is not null or v_is_open <> true then
    raise exception 'expected clinic B configured with a null address, got %/%/%/%/%', v_result, v_name, v_phone, v_address, v_is_open;
  end if;

  -- Clinic C: valid name/phone but zero weekly-hours rows -> unconfigured with four nulls.
  select result, clinic_name, contact_phone_e164, public_address, is_open
    into v_result, v_name, v_phone, v_address, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000003', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'unconfigured' or v_name is not null or v_phone is not null or v_address is not null or v_is_open is not null then
    raise exception 'expected clinic C to be unconfigured with four null payload fields, got %/%/%/%/%', v_result, v_name, v_phone, v_address, v_is_open;
  end if;

  -- Invalid clinic names cannot be exposed as configured even when phone and
  -- weekly hours are otherwise complete.
  foreach v_bad_name in array array[' Clinic Ops Test Clinic B', repeat('x', 121), 'Clinic' || chr(7)] loop
    update public.clinics set name = v_bad_name where id = '03100000-0000-0000-0000-000000000002';
    select result, clinic_name, contact_phone_e164, public_address, is_open
      into v_result, v_name, v_phone, v_address, v_is_open
    from public.get_conversation_clinic_operational_context(
      '03120000-0000-0000-0000-000000000002', timestamptz '2026-08-17 07:00:00+00'
    );
    if v_result <> 'unconfigured' or v_name is not null or v_phone is not null or v_address is not null or v_is_open is not null then
      raise exception 'expected an invalid clinic name to fail closed as unconfigured, got %/%/%/%/%', v_result, v_name, v_phone, v_address, v_is_open;
    end if;
  end loop;
  update public.clinics set name = 'Clinic Ops Test Clinic B' where id = '03100000-0000-0000-0000-000000000002';

  -- Missing conversation -> not_found with four nulls.
  select result, clinic_name, contact_phone_e164, public_address, is_open
    into v_result, v_name, v_phone, v_address, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000099', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'not_found' or v_name is not null or v_phone is not null or v_address is not null or v_is_open is not null then
    raise exception 'expected an unknown conversation to be not_found with four null payload fields, got %/%/%/%/%', v_result, v_name, v_phone, v_address, v_is_open;
  end if;

  -- Null required input raises before reading data.
  begin
    perform 1 from public.get_conversation_clinic_operational_context(null, timestamptz '2026-08-17 07:00:00+00');
    raise exception 'expected a null conversation id to raise';
  exception when others then
    if sqlerrm not like '%invalid input%' then raise; end if;
  end;
  begin
    perform 1 from public.get_conversation_clinic_operational_context('03120000-0000-0000-0000-000000000001', null);
    raise exception 'expected a null timestamp to raise';
  exception when others then
    if sqlerrm not like '%invalid input%' then raise; end if;
  end;
end;
$$;

reset role;

-- =========================================================================
-- Closure-date precedence: the same in-interval instant flips to closed once
-- a matching full-day closure exists for clinic A.
-- =========================================================================

set local role service_role;
do $$
declare
  v_result text;
  v_is_open boolean;
begin
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> true then
    raise exception 'expected clinic A still open before its closure date is added, got %/%', v_result, v_is_open;
  end if;
end;
$$;
reset role;

insert into public.clinic_closure_dates (clinic_id, closed_on)
values ('03100000-0000-0000-0000-000000000001', date '2026-08-17');

set local role service_role;
do $$
declare
  v_result text;
  v_is_open boolean;
begin
  select result, is_open into v_result, v_is_open
  from public.get_conversation_clinic_operational_context(
    '03120000-0000-0000-0000-000000000001', timestamptz '2026-08-17 07:00:00+00'
  );
  if v_result <> 'configured' or v_is_open <> false then
    raise exception 'expected a full-day closure to override an otherwise-open interval, got %/%', v_result, v_is_open;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- RPC execute privileges: only service_role may call it.
-- =========================================================================

set local role authenticated;
do $$
begin
  begin
    perform 1 from public.get_conversation_clinic_operational_context('03120000-0000-0000-0000-000000000001');
    raise exception 'authenticated role unexpectedly executed get_conversation_clinic_operational_context';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from public.get_conversation_clinic_operational_context('03120000-0000-0000-0000-000000000001');
    raise exception 'anon role unexpectedly executed get_conversation_clinic_operational_context';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Table RLS/privileges: authenticated staff read only their own clinic's
-- rows and cannot write; anon has no access at all.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '03130000-0000-0000-0000-000000000001', true);
do $$
begin
  if (select count(*) from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000001') = 0 then
    raise exception 'expected clinic A staff to see clinic A weekly hours';
  end if;
  if (select count(*) from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000002') <> 0 then
    raise exception 'expected clinic A staff to see zero clinic B weekly hours';
  end if;
  if (select count(*) from public.clinic_closure_dates where clinic_id = '03100000-0000-0000-0000-000000000001') = 0 then
    raise exception 'expected clinic A staff to see clinic A closure dates';
  end if;

  begin
    insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
    values ('03100000-0000-0000-0000-000000000001', 2, '09:00', '17:00');
    raise exception 'expected authenticated insert on clinic_weekly_hours to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.clinic_weekly_hours set closes_at = '18:00' where clinic_id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected authenticated update on clinic_weekly_hours to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000001';
    raise exception 'expected authenticated delete on clinic_weekly_hours to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.clinic_closure_dates (clinic_id, closed_on) values ('03100000-0000-0000-0000-000000000001', date '2026-09-01');
    raise exception 'expected authenticated insert on clinic_closure_dates to be denied';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '03130000-0000-0000-0000-000000000002', true);
do $$
begin
  if (select count(*) from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000001') <> 0 then
    raise exception 'expected clinic B staff to see zero clinic A weekly hours';
  end if;
  if (select count(*) from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000002') = 0 then
    raise exception 'expected clinic B staff to see clinic B weekly hours';
  end if;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from public.clinic_weekly_hours limit 1;
    raise exception 'expected anon to be denied clinic_weekly_hours table access';
  exception when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.clinic_closure_dates limit 1;
    raise exception 'expected anon to be denied clinic_closure_dates table access';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Erasure cascade: deleting a clinic removes both schedule tables' rows.
-- =========================================================================

do $$
declare
  v_hours_count integer;
  v_closure_count integer;
begin
  select count(*) into v_hours_count from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000004';
  select count(*) into v_closure_count from public.clinic_closure_dates where clinic_id = '03100000-0000-0000-0000-000000000004';
  if v_hours_count = 0 or v_closure_count = 0 then
    raise exception 'expected clinic D to have weekly-hours and closure rows before the erasure test';
  end if;

  delete from public.clinics where id = '03100000-0000-0000-0000-000000000004';

  if exists (select 1 from public.clinic_weekly_hours where clinic_id = '03100000-0000-0000-0000-000000000004') then
    raise exception 'expected clinic erasure to cascade to clinic_weekly_hours';
  end if;
  if exists (select 1 from public.clinic_closure_dates where clinic_id = '03100000-0000-0000-0000-000000000004') then
    raise exception 'expected clinic erasure to cascade to clinic_closure_dates';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '03100000-0000-0000-0000-000000000001', '03100000-0000-0000-0000-000000000002',
    '03100000-0000-0000-0000-000000000003', '03100000-0000-0000-0000-000000000004'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '03130000-0000-0000-0000-000000000001', '03130000-0000-0000-0000-000000000002'
  )) as remaining_test_users,
  (select count(*) from public.clinic_weekly_hours where clinic_id in (
    '03100000-0000-0000-0000-000000000001', '03100000-0000-0000-0000-000000000002',
    '03100000-0000-0000-0000-000000000003', '03100000-0000-0000-0000-000000000004'
  )) as remaining_test_hours,
  (select count(*) from public.clinic_closure_dates where clinic_id in (
    '03100000-0000-0000-0000-000000000001', '03100000-0000-0000-0000-000000000002',
    '03100000-0000-0000-0000-000000000003', '03100000-0000-0000-0000-000000000004'
  )) as remaining_test_closures;
