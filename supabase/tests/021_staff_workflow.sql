-- Rollback-only proof for public.resolve_staff_work_item (Task 021).
-- Never run this fixture script against a real clinic database.
--
-- Single-session limit: this fixture proves one authorized resolve, one
-- replay, and cross-tenant/unauthorized denial inside one PostgreSQL
-- session. True two-session concurrent resolution is not exercised
-- directly; the serializing "for update" row lock is instead verified from
-- the stored function definition.

begin;

-- =========================================================================
-- Fixtures: two staffed clinics, one authenticated user with no clinic
-- membership, and open work items produced by the unchanged Task 020
-- trigger.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('99700000-0000-0000-0000-000000000001', 'Staff Workflow Test Clinic A'),
  ('99700000-0000-0000-0000-000000000002', 'Staff Workflow Test Clinic B');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('99710000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'sw-a@example.invalid', now(), now()),
  ('99710000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'sw-b@example.invalid', now(), now()),
  ('99710000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'sw-nostaff@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('99700000-0000-0000-0000-000000000001', '99710000-0000-0000-0000-000000000001', 'admin'),
  ('99700000-0000-0000-0000-000000000002', '99710000-0000-0000-0000-000000000002', 'admin');
-- 99710000-...-000003 intentionally has no clinic_staff row.

create table pg_temp.item_ids (key text primary key, value uuid not null);
grant select on pg_temp.item_ids to authenticated;

do $$
declare
  v_owner_a1 uuid;
  v_owner_a_urgent uuid;
  v_owner_a_fresh uuid;
  v_owner_b uuid;
  v_conv_a1 uuid := '99730000-0000-0000-0000-000000000001';
  v_conv_a_urgent uuid := '99730000-0000-0000-0000-000000000002';
  v_conv_a_fresh uuid := '99730000-0000-0000-0000-000000000003';
  v_conv_b uuid := '99730000-0000-0000-0000-000000000004';
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99720000-0000-0000-0000-000000000001', '99700000-0000-0000-0000-000000000001', 'A1 Owner', '+15559920001')
  returning id into v_owner_a1;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_a1, '99700000-0000-0000-0000-000000000001', v_owner_a1);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_a1;

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99720000-0000-0000-0000-000000000002', '99700000-0000-0000-0000-000000000001', 'A Urgent Owner', '+15559920002')
  returning id into v_owner_a_urgent;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_a_urgent, '99700000-0000-0000-0000-000000000001', v_owner_a_urgent);
  update public.conversations
    set intake_stage = 'human_handoff',
        intake_data = '{"reported_safety_signals": {"sig": true}}'::jsonb
    where id = v_conv_a_urgent;

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99720000-0000-0000-0000-000000000003', '99700000-0000-0000-0000-000000000001', 'A Fresh Owner', '+15559920003')
  returning id into v_owner_a_fresh;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_a_fresh, '99700000-0000-0000-0000-000000000001', v_owner_a_fresh);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_a_fresh;

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99720000-0000-0000-0000-000000000004', '99700000-0000-0000-0000-000000000002', 'B Owner', '+15559920004')
  returning id into v_owner_b;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_b, '99700000-0000-0000-0000-000000000002', v_owner_b);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_b;

  insert into pg_temp.item_ids (key, value)
  select 'item_a1', id from public.staff_work_items where conversation_id = v_conv_a1
  union all
  select 'item_a_urgent', id from public.staff_work_items where conversation_id = v_conv_a_urgent
  union all
  select 'item_a_fresh', id from public.staff_work_items where conversation_id = v_conv_a_fresh
  union all
  select 'item_b', id from public.staff_work_items where conversation_id = v_conv_b;
end;
$$;

-- Regression check: a later handoff update carrying no true safety signal
-- must not downgrade the already-urgent item (unchanged Task 020 trigger
-- behavior, re-verified after this migration is applied on top of it).
update public.conversations set intake_data = '{"note": "later message"}'::jsonb where id = '99730000-0000-0000-0000-000000000002';

do $$
declare
  v_item record;
begin
  select * into v_item from public.staff_work_items where id = (select value from pg_temp.item_ids where key = 'item_a_urgent');
  if not found or v_item.priority <> 'urgent' or v_item.reason <> 'emergency_handoff' or v_item.status <> 'open' then
    raise exception 'expected the urgent handoff item to remain urgent/emergency_handoff/open, got %', to_json(v_item);
  end if;
end;
$$;

-- =========================================================================
-- Fixture 0: function shape (security definer / volatile / empty
-- search_path / row lock) and grants are exactly as specified; the existing
-- one-policy table RLS shape is unchanged.
-- =========================================================================
do $$
declare
  v_proc record;
  v_def text;
  v_grantees text[];
begin
  select p.prosecdef, p.provolatile, p.proconfig,
         pg_catalog.pg_get_userbyid(p.proowner)::text as owner_name
    into v_proc
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_staff_work_item';

  if not v_proc.prosecdef then
    raise exception 'expected resolve_staff_work_item to be SECURITY DEFINER';
  end if;
  if v_proc.provolatile <> 'v' then
    raise exception 'expected resolve_staff_work_item to be VOLATILE, got %', v_proc.provolatile;
  end if;
  if v_proc.proconfig is null or not (
    v_proc.proconfig @> array['search_path=']
    or v_proc.proconfig @> array['search_path=""']
  ) then
    raise exception 'expected resolve_staff_work_item to SET search_path = '''', got %', v_proc.proconfig;
  end if;

  select pg_catalog.pg_get_functiondef(p.oid) into v_def
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'resolve_staff_work_item';

  if v_def !~* 'for update' then
    raise exception 'expected resolve_staff_work_item to lock the row with FOR UPDATE';
  end if;

  select array_agg(distinct grantee::text order by grantee::text)
    into v_grantees
  from information_schema.routine_privileges
  where routine_schema = 'public' and routine_name = 'resolve_staff_work_item';

  if not ('authenticated' = any(v_grantees)) or exists (
    select 1
    from unnest(v_grantees) as grantee
    where grantee not in ('authenticated', v_proc.owner_name)
  ) then
    raise exception 'expected only authenticated plus the function owner to have resolve_staff_work_item privileges, got %', v_grantees;
  end if;

  if not (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'staff_work_items'
  ) then
    raise exception 'expected RLS to remain enabled on staff_work_items';
  end if;

  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'staff_work_items') <> 1 then
    raise exception 'expected exactly one unchanged policy on staff_work_items';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 1: unauthorized execution is denied outright.
-- =========================================================================
set local role anon;
do $$
begin
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected anon to be denied execute on resolve_staff_work_item';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
begin
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected service_role to be denied execute on resolve_staff_work_item';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 2: same-clinic staff resolves one open item; a replay is
-- already_resolved with no timestamp rewrite; another clinic's item and an
-- unknown id both return not_found with zero mutation; null input fails
-- before any mutation; direct table UPDATE stays denied.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99710000-0000-0000-0000-000000000001', true);

do $$
declare
  v_item_a1 uuid := (select value from pg_temp.item_ids where key = 'item_a1');
  v_item_b uuid := (select value from pg_temp.item_ids where key = 'item_b');
  v_expected_resolved_at timestamptz;
  v_result text;
  v_resolved_at_1 timestamptz;
  v_resolved_at_2 timestamptz;
  v_b_status text;
  v_b_resolved_at timestamptz;
  v_null_rejected boolean := false;
begin
  v_expected_resolved_at := pg_catalog.now();
  select result into v_result from public.resolve_staff_work_item(v_item_a1);
  if v_result <> 'resolved' then
    raise exception 'expected resolved for an authorized open item, got %', v_result;
  end if;

  select resolved_at into v_resolved_at_1 from public.staff_work_items where id = v_item_a1;
  if v_resolved_at_1 is distinct from v_expected_resolved_at then
    raise exception 'expected resolved_at to use the current transaction timestamp %, got %', v_expected_resolved_at, v_resolved_at_1;
  end if;

  -- Replay by the same authorized staff.
  select result into v_result from public.resolve_staff_work_item(v_item_a1);
  if v_result <> 'already_resolved' then
    raise exception 'expected already_resolved on replay, got %', v_result;
  end if;
  select resolved_at into v_resolved_at_2 from public.staff_work_items where id = v_item_a1;
  if v_resolved_at_2 <> v_resolved_at_1 then
    raise exception 'expected replay not to rewrite resolved_at, before % after %', v_resolved_at_1, v_resolved_at_2;
  end if;

  -- Another clinic's item: not_found with zero mutation.
  select status, resolved_at into v_b_status, v_b_resolved_at from public.staff_work_items where id = v_item_b;
  select result into v_result from public.resolve_staff_work_item(v_item_b);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-clinic item, got %', v_result;
  end if;
  if exists (
    select 1 from public.staff_work_items
    where id = v_item_b and (status is distinct from v_b_status or resolved_at is distinct from v_b_resolved_at)
  ) then
    raise exception 'expected zero mutation of another clinic''s item';
  end if;

  -- Unknown id: not_found.
  select result into v_result from public.resolve_staff_work_item('99790000-0000-0000-0000-000000000099'::uuid);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown id, got %', v_result;
  end if;

  -- Null input fails before mutation.
  begin
    perform result from public.resolve_staff_work_item(null);
  exception when others then
    v_null_rejected := true;
  end;
  if not v_null_rejected then
    raise exception 'expected null work_item_id to raise before mutation';
  end if;

  -- Direct table UPDATE remains denied for authenticated.
  begin
    update public.staff_work_items set status = 'resolved', resolved_at = now() where id = v_item_a1;
    raise exception 'expected authenticated direct UPDATE on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 3: an authenticated caller with no clinic membership receives
-- not_found with zero mutation, even for an otherwise-valid open item.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99710000-0000-0000-0000-000000000003', true);

do $$
declare
  v_item_a_fresh uuid := (select value from pg_temp.item_ids where key = 'item_a_fresh');
  v_result text;
begin
  select result into v_result from public.resolve_staff_work_item(v_item_a_fresh);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a caller with no clinic membership, got %', v_result;
  end if;
  if exists (select 1 from public.staff_work_items where id = v_item_a_fresh and status <> 'open') then
    raise exception 'expected zero mutation for a caller with no clinic membership';
  end if;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '99700000-0000-0000-0000-000000000001',
    '99700000-0000-0000-0000-000000000002'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '99710000-0000-0000-0000-000000000001',
    '99710000-0000-0000-0000-000000000002',
    '99710000-0000-0000-0000-000000000003'
  )) as remaining_test_users,
  (select count(*) from public.staff_work_items where clinic_id in (
    '99700000-0000-0000-0000-000000000001',
    '99700000-0000-0000-0000-000000000002'
  )) as remaining_test_items;
