-- Rollback-only proof for the Task 022 appointment booking engine: the
-- public.appointment_slots table and public.list_available_appointment_slots
-- / public.hold_appointment_slot / public.confirm_appointment_slot RPCs.
-- Never run this fixture script against a real clinic database.
--
-- Single-session limit: this fixture proves stored function/table shapes
-- (SECURITY INVOKER, volatility, empty search_path, service-role-only
-- grants, deterministic ascending-id lock order in hold_appointment_slot's
-- source text) and a sequential hold/switch/reclaim/confirm timeline inside
-- one PostgreSQL session. True two-session concurrent locking/blocking is
-- not exercised directly; only the stored `for update` lock order is
-- asserted from the function definitions.

begin;

-- =========================================================================
-- Fixture times: one base timestamp per named slot, computed once so every
-- later statement in this transaction sees identical values (pg_catalog.now()
-- is stable for the whole transaction).
-- =========================================================================

create table pg_temp.fixture_times (key text primary key, value timestamptz not null);

insert into pg_temp.fixture_times (key, value)
values
  ('t0', date_trunc('hour', pg_catalog.now()) + interval '3 hours'),
  ('t1', date_trunc('hour', pg_catalog.now()) + interval '3 hours 30 minutes'),
  ('t2', date_trunc('hour', pg_catalog.now()) + interval '4 hours'),
  ('t3', date_trunc('hour', pg_catalog.now()) + interval '4 hours 30 minutes'),
  ('t4', date_trunc('hour', pg_catalog.now()) + interval '5 hours'),
  ('t5', date_trunc('hour', pg_catalog.now()) + interval '5 hours 30 minutes'),
  ('t6', date_trunc('hour', pg_catalog.now()) + interval '6 hours'),
  ('t_confirm', date_trunc('hour', pg_catalog.now()) + interval '6 hours 30 minutes'),
  ('t_rejected', date_trunc('hour', pg_catalog.now()) + interval '7 hours'),
  ('t_started', date_trunc('hour', pg_catalog.now()) - interval '2 hours'),
  ('t_past', date_trunc('hour', pg_catalog.now()) - interval '3 hours'),
  ('t_outside', date_trunc('hour', pg_catalog.now()) + interval '9 days');

grant select on pg_temp.fixture_times to service_role;

-- =========================================================================
-- Fixtures: two clinics, one owner/pet/conversation set per clinic plus
-- several deliberately-not-ready conversations, and a matching set of
-- pre-seeded slots covering every listing/hold/confirm branch.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('99800000-0000-0000-0000-000000000001', 'Appointment Engine Test Clinic A'),
  ('99800000-0000-0000-0000-000000000002', 'Appointment Engine Test Clinic B');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('99810000-0000-0000-0000-000000000001', '99800000-0000-0000-0000-000000000001', 'Owner A', '+15559980001'),
  ('99810000-0000-0000-0000-000000000002', '99800000-0000-0000-0000-000000000001', 'Owner A2', '+15559980002'),
  ('99810000-0000-0000-0000-000000000003', '99800000-0000-0000-0000-000000000001', 'Owner A3', '+15559980003'),
  ('99810000-0000-0000-0000-000000000004', '99800000-0000-0000-0000-000000000001', 'Owner A4', '+15559980004'),
  ('99810000-0000-0000-0000-000000000005', '99800000-0000-0000-0000-000000000001', 'Owner A5', '+15559980005'),
  ('99810000-0000-0000-0000-000000000006', '99800000-0000-0000-0000-000000000001', 'Owner A6', '+15559980006'),
  ('99810000-0000-0000-0000-000000000007', '99800000-0000-0000-0000-000000000002', 'Owner B', '+15559980007'),
  ('99810000-0000-0000-0000-000000000008', '99800000-0000-0000-0000-000000000001', 'Owner A8', '+15559980008');

insert into public.pets (id, clinic_id, owner_id, name, species)
values
  ('99820000-0000-0000-0000-000000000001', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000001', 'Pet A', 'dog'),
  ('99820000-0000-0000-0000-000000000002', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000002', 'Pet A2', 'cat'),
  ('99820000-0000-0000-0000-000000000003', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000003', 'Pet A3', 'dog'),
  ('99820000-0000-0000-0000-000000000004', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000004', 'Pet A4', 'cat'),
  ('99820000-0000-0000-0000-000000000005', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000005', 'Pet A5', 'dog'),
  ('99820000-0000-0000-0000-000000000006', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000006', 'Pet A6', 'cat'),
  ('99820000-0000-0000-0000-000000000007', '99800000-0000-0000-0000-000000000002', '99810000-0000-0000-0000-000000000007', 'Pet B', 'dog'),
  ('99820000-0000-0000-0000-000000000008', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000008', 'Pet A8', 'cat');

insert into public.conversations (id, clinic_id, owner_id, pet_id, status)
values
  ('99830000-0000-0000-0000-000000000001', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000001', 'active'),
  ('99830000-0000-0000-0000-000000000002', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000002', '99820000-0000-0000-0000-000000000002', 'active'),
  ('99830000-0000-0000-0000-000000000003', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000003', '99820000-0000-0000-0000-000000000003', 'handoff'),
  ('99830000-0000-0000-0000-000000000004', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000004', null, 'active'),
  ('99830000-0000-0000-0000-000000000005', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000005', '99820000-0000-0000-0000-000000000005', 'active'),
  ('99830000-0000-0000-0000-000000000006', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000006', '99820000-0000-0000-0000-000000000006', 'active'),
  ('99830000-0000-0000-0000-000000000007', '99800000-0000-0000-0000-000000000002', '99810000-0000-0000-0000-000000000007', '99820000-0000-0000-0000-000000000007', 'active'),
  ('99830000-0000-0000-0000-000000000008', '99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000008', '99820000-0000-0000-0000-000000000008', 'active');

update public.conversations set intake_stage = 'appointment_offer' where id = '99830000-0000-0000-0000-000000000001'; -- conv_ready
update public.conversations set intake_stage = 'appointment_selection' where id = '99830000-0000-0000-0000-000000000002'; -- conv_ready2
update public.conversations set intake_stage = 'appointment_offer' where id = '99830000-0000-0000-0000-000000000003'; -- conv_not_active (status handoff)
update public.conversations set intake_stage = 'appointment_offer' where id = '99830000-0000-0000-0000-000000000004'; -- conv_no_pet
update public.conversations set intake_stage = 'pet_identification' where id = '99830000-0000-0000-0000-000000000005'; -- conv_wrong_stage
update public.conversations set intake_stage = 'appointment_confirmation' where id = '99830000-0000-0000-0000-000000000006'; -- conv_confirm_conflict
update public.conversations set intake_stage = 'appointment_offer' where id = '99830000-0000-0000-0000-000000000007'; -- conv_b
update public.conversations set intake_stage = 'appointment_confirmation' where id = '99830000-0000-0000-0000-000000000008'; -- conv_confirm_expired

-- Pre-seeded slots. slot_expired_held and slot_confirmed_other are anchored
-- to conv_wrong_stage/conv_not_active purely as FK targets (any existing
-- conversation id + owner_id + clinic_id satisfies the composite FK); their
-- own intake_stage/status is irrelevant to that anchoring role, and each
-- anchor holds at most one active slot to respect the partial unique index.
insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status)
values
  ('99840000-0000-0000-0000-000000000001', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't0'), (select value from pg_temp.fixture_times where key = 't0') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000002', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't1'), (select value from pg_temp.fixture_times where key = 't1') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000005', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_past'), (select value from pg_temp.fixture_times where key = 't_past') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000006', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_outside'), (select value from pg_temp.fixture_times where key = 't_outside') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000007', '99800000-0000-0000-0000-000000000002', (select value from pg_temp.fixture_times where key = 't0'), (select value from pg_temp.fixture_times where key = 't0') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000008', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't4'), (select value from pg_temp.fixture_times where key = 't4') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000009', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't5'), (select value from pg_temp.fixture_times where key = 't5') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000010', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_confirm'), (select value from pg_temp.fixture_times where key = 't_confirm') + interval '30 minutes', 'available'),
  ('99840000-0000-0000-0000-000000000011', '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't6'), (select value from pg_temp.fixture_times where key = 't6') + interval '30 minutes', 'available');

insert into public.appointment_slots
  (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
values
  ('99840000-0000-0000-0000-000000000003', '99800000-0000-0000-0000-000000000001',
   (select value from pg_temp.fixture_times where key = 't2'), (select value from pg_temp.fixture_times where key = 't2') + interval '30 minutes',
   'held', '99830000-0000-0000-0000-000000000005', '99810000-0000-0000-0000-000000000005', '99820000-0000-0000-0000-000000000005',
   '99850000-0000-0000-0000-000000000099', pg_catalog.now() - interval '1 minute');

insert into public.appointment_slots
  (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, confirmed_at)
values
  ('99840000-0000-0000-0000-000000000004', '99800000-0000-0000-0000-000000000001',
   (select value from pg_temp.fixture_times where key = 't3'), (select value from pg_temp.fixture_times where key = 't3') + interval '30 minutes',
   'confirmed', '99830000-0000-0000-0000-000000000003', '99810000-0000-0000-0000-000000000003', '99820000-0000-0000-0000-000000000003',
   '99850000-0000-0000-0000-000000000098', pg_catalog.now());

-- =========================================================================
-- Fixture 0: table columns/checks/keys/RLS/grants/trigger and all three
-- function shapes are exactly as specified.
-- =========================================================================
do $$
declare
  v_check_count integer;
  v_fk_count integer;
  v_table_unique_count integer;
  v_partial_index_count integer;
  v_trigger_count integer;
  v_grantees text[];
  v_owner_name text;
  v_function_count integer;
  v_rejected boolean;
begin
  if not (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'appointment_slots'
  ) then
    raise exception 'expected RLS to be enabled on appointment_slots';
  end if;

  select pg_catalog.pg_get_userbyid(c.relowner)::text into v_owner_name
  from pg_catalog.pg_class c
  where c.oid = 'public.appointment_slots'::regclass;

  select array_agg(distinct grantee::text order by grantee::text) into v_grantees
  from information_schema.role_table_grants
  where table_schema = 'public' and table_name = 'appointment_slots';
  if not ('service_role' = any(v_grantees)) or exists (
    select 1 from unnest(v_grantees) as grantee
    where grantee not in ('service_role', v_owner_name)
  ) then
    raise exception 'expected only service_role plus the table owner to have appointment_slots table privileges, got %', v_grantees;
  end if;

  select count(*) into v_check_count
  from pg_catalog.pg_constraint
  where conrelid = 'public.appointment_slots'::regclass and contype = 'c';
  if v_check_count <> 6 then
    raise exception 'expected 6 CHECK constraints on appointment_slots (status enum, duration, alignment, available/held/confirmed state), got %', v_check_count;
  end if;

  select count(*) into v_fk_count
  from pg_catalog.pg_constraint
  where conrelid = 'public.appointment_slots'::regclass and contype = 'f';
  if v_fk_count <> 3 then
    raise exception 'expected 3 foreign keys on appointment_slots (clinic, conversation composite, pet composite), got %', v_fk_count;
  end if;

  select count(*) into v_table_unique_count
  from pg_catalog.pg_constraint
  where conrelid = 'public.appointment_slots'::regclass and contype = 'u';
  if v_table_unique_count <> 1 then
    raise exception 'expected exactly one unique constraint on appointment_slots (clinic_id, starts_at), got %', v_table_unique_count;
  end if;

  select count(*) into v_partial_index_count
  from pg_catalog.pg_index i
  join pg_catalog.pg_class c on c.oid = i.indexrelid
  where i.indrelid = 'public.appointment_slots'::regclass
    and i.indisunique
    and i.indpred is not null;
  if v_partial_index_count <> 1 then
    raise exception 'expected exactly one partial unique index on appointment_slots, got %', v_partial_index_count;
  end if;

  -- Compared as sets (both sides sorted the same way): conkey reflects
  -- declaration order, which need not match ascending attnum order.
  if not exists (
    select 1
    from pg_catalog.pg_constraint con
    where con.conrelid = 'public.conversations'::regclass
      and con.contype = 'u'
      and (select array_agg(k order by k) from unnest(con.conkey) as k) = (
        select array_agg(a.attnum order by a.attnum)
        from pg_catalog.pg_attribute a
        where a.attrelid = 'public.conversations'::regclass
          and a.attname in ('id', 'owner_id', 'clinic_id')
      )
  ) then
    raise exception 'expected a supporting unique key on conversations (id, owner_id, clinic_id)';
  end if;

  select count(*) into v_trigger_count
  from pg_catalog.pg_trigger t
  where t.tgrelid = 'public.appointment_slots'::regclass
    and not t.tgisinternal
    and t.tgfoid = 'vetai_private.set_updated_at()'::regprocedure;
  if v_trigger_count <> 1 then
    raise exception 'expected the existing set_updated_at trigger on appointment_slots, got %', v_trigger_count;
  end if;

  -- Functional proofs: invalid duration, invalid alignment, a duplicate
  -- (clinic_id, starts_at), an incoherent state, and a cross-tenant owner
  -- all fail with zero partial mutation.
  begin
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status)
    values ('99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_rejected'), (select value from pg_temp.fixture_times where key = 't_rejected') + interval '45 minutes', 'available');
    raise exception 'expected a non-30-minute duration to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status)
    values ('99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_rejected') + interval '15 minutes', (select value from pg_temp.fixture_times where key = 't_rejected') + interval '45 minutes', 'available');
    raise exception 'expected a non-aligned starts_at to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status)
    values ('99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't0'), (select value from pg_temp.fixture_times where key = 't0') + interval '30 minutes', 'available');
    raise exception 'expected a duplicate (clinic_id, starts_at) to be rejected';
  exception when unique_violation then null;
  end;

  begin
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status, conversation_id)
    values ('99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_rejected'), (select value from pg_temp.fixture_times where key = 't_rejected') + interval '30 minutes', 'held', '99830000-0000-0000-0000-000000000001');
    raise exception 'expected an incoherent held row (missing owner/pet/token/hold_until) to be rejected';
  exception when check_violation then null;
  end;

  begin
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
    values (
      '99800000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't_rejected'), (select value from pg_temp.fixture_times where key = 't_rejected') + interval '30 minutes',
      'held', '99830000-0000-0000-0000-000000000007', '99810000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000001',
      pg_catalog.gen_random_uuid(), pg_catalog.now() + interval '10 minutes'
    );
    raise exception 'expected a cross-tenant conversation/owner combination to be rejected';
  exception when foreign_key_violation then null;
  end;

  if exists (select 1 from public.appointment_slots where clinic_id = '99800000-0000-0000-0000-000000000001' and starts_at = (select value from pg_temp.fixture_times where key = 't_rejected')) then
    raise exception 'expected zero partial mutation from the rejected-insert proofs above';
  end if;

  -- Function shapes: SECURITY INVOKER, correct volatility, empty search
  -- path, and service_role-only execute privileges for all three RPCs.
  select count(*) into v_function_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in ('list_available_appointment_slots', 'hold_appointment_slot', 'confirm_appointment_slot');
  if v_function_count <> 3 then
    raise exception 'expected exactly three appointment RPCs, got %', v_function_count;
  end if;

  perform 1 from (
    select
      p.proname,
      p.prosecdef,
      p.provolatile,
      p.proconfig,
      pg_catalog.pg_get_userbyid(p.proowner)::text as owner_name
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('list_available_appointment_slots', 'hold_appointment_slot', 'confirm_appointment_slot')
  ) as fn
  where (
    (fn.proname = 'list_available_appointment_slots' and fn.provolatile <> 's')
    or (fn.proname in ('hold_appointment_slot', 'confirm_appointment_slot') and fn.provolatile <> 'v')
    or fn.prosecdef
    or fn.proconfig is null
    or not (fn.proconfig @> array['search_path=""'] or fn.proconfig @> array['search_path='])
  );
  if found then
    raise exception 'expected all three RPCs to be SECURITY INVOKER with the correct volatility and an empty search_path';
  end if;

  for v_grantees, v_owner_name in
    select array_agg(distinct rp.grantee::text order by rp.grantee::text),
           pg_catalog.pg_get_userbyid(p.proowner)::text
    from information_schema.routine_privileges rp
    join pg_catalog.pg_proc p on p.proname = rp.routine_name
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = rp.routine_schema
    where rp.routine_schema = 'public'
      and rp.routine_name in ('list_available_appointment_slots', 'hold_appointment_slot', 'confirm_appointment_slot')
    group by rp.routine_name, p.proowner
  loop
    if not ('service_role' = any(v_grantees)) or exists (
      select 1 from unnest(v_grantees) as grantee
      where grantee not in ('service_role', v_owner_name)
    ) then
      raise exception 'expected only service_role plus the function owner to have execute privileges on each appointment RPC, got %', v_grantees;
    end if;
  end loop;

  -- Deterministic lock order: hold_appointment_slot's stored source proves
  -- both rows are locked (not asserting real cross-session blocking here).
  if (
    select pg_catalog.pg_get_functiondef(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hold_appointment_slot'
  ) !~ 'v_existing_id < p_slot_id' then
    raise exception 'expected hold_appointment_slot to lock the target and existing slot in deterministic ascending-id order';
  end if;

  if (
    select pg_catalog.pg_get_functiondef(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hold_appointment_slot'
  ) !~ 'where id = v_existing_id[[:space:]]+and conversation_id = p_conversation_id[[:space:]]+and status in' then
    raise exception 'expected hold_appointment_slot to revalidate existing-slot ownership after waiting for its row lock';
  end if;

  if (
    select pg_catalog.pg_get_functiondef(p.oid)
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'hold_appointment_slot'
  ) !~ 'if v_existing_id is not null[[:space:]]+and v_target.conversation_id = p_conversation_id[[:space:]]+and v_target.status in' then
    raise exception 'expected hold_appointment_slot to revalidate same-target ownership after waiting for its row lock';
  end if;

  v_rejected := false;
  begin
    perform result from public.hold_appointment_slot(null, null);
  exception when others then
    v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected null identifiers to raise before lookup';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 1: PUBLIC/anon/authenticated cannot access the table or execute
-- any of the three RPCs; service_role exercises the successful path below.
-- =========================================================================
set local role anon;
do $$
begin
  begin
    perform 1 from public.appointment_slots limit 1;
    raise exception 'expected anon to be denied select on appointment_slots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform slot_id from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000001'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5);
    raise exception 'expected anon to be denied execute on list_available_appointment_slots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
    raise exception 'expected anon to be denied execute on hold_appointment_slot';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid, pg_catalog.gen_random_uuid());
    raise exception 'expected anon to be denied execute on confirm_appointment_slot';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
do $$
begin
  begin
    perform 1 from public.appointment_slots limit 1;
    raise exception 'expected authenticated to be denied select on appointment_slots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform slot_id from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000001'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5);
    raise exception 'expected authenticated to be denied execute on list_available_appointment_slots';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
    raise exception 'expected authenticated to be denied execute on hold_appointment_slot';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid, pg_catalog.gen_random_uuid());
    raise exception 'expected authenticated to be denied execute on confirm_appointment_slot';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 2: listing is same-clinic, future/window bounded, ordered,
-- limited, includes an expired hold, and excludes other-clinic/unexpired-
-- held/confirmed/past/out-of-window slots and non-eligible conversations.
-- =========================================================================
set local role service_role;
do $$
declare
  v_rows uuid[];
  v_rejected boolean;
begin
  select array_agg(slot_id order by starts_at)
    into v_rows
  from public.list_available_appointment_slots(
    '99830000-0000-0000-0000-000000000001'::uuid,
    pg_catalog.now(),
    (select value from pg_temp.fixture_times where key = 't3'),
    5
  );

  if v_rows is distinct from array[
    '99840000-0000-0000-0000-000000000001'::uuid,
    '99840000-0000-0000-0000-000000000002'::uuid,
    '99840000-0000-0000-0000-000000000003'::uuid
  ] then
    raise exception 'expected listing to return slot_avail_1, slot_avail_2, then the expired-held slot in starts_at order, got %', v_rows;
  end if;

  -- limit=1 truncates to the earliest slot only.
  select array_agg(slot_id) into v_rows
  from public.list_available_appointment_slots(
    '99830000-0000-0000-0000-000000000001'::uuid,
    pg_catalog.now(),
    (select value from pg_temp.fixture_times where key = 't3'),
    1
  );
  if v_rows is distinct from array['99840000-0000-0000-0000-000000000001'::uuid] then
    raise exception 'expected p_limit=1 to return exactly one row, got %', v_rows;
  end if;

  -- A window that ends before slot_outside_window's start excludes it, and
  -- the confirmed/unexpired-held/other-clinic/past rows never appear.
  if exists (
    select 1
    from public.list_available_appointment_slots(
      '99830000-0000-0000-0000-000000000001'::uuid,
      pg_catalog.now(),
      (select value from pg_temp.fixture_times where key = 't0') + interval '7 days',
      10
    )
    where slot_id in (
      '99840000-0000-0000-0000-000000000004'::uuid, -- confirmed
      '99840000-0000-0000-0000-000000000005'::uuid, -- past
      '99840000-0000-0000-0000-000000000006'::uuid, -- outside window
      '99840000-0000-0000-0000-000000000007'::uuid  -- clinic B
    )
  ) then
    raise exception 'expected listing to exclude confirmed/past/out-of-window/other-clinic slots';
  end if;

  -- Non-eligible or unknown conversations return zero rows, not an error.
  if exists (select 1 from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000003'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5)) then
    raise exception 'expected zero rows for an inactive (handoff) conversation';
  end if;
  if exists (select 1 from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000004'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5)) then
    raise exception 'expected zero rows for a conversation with no selected pet';
  end if;
  if exists (select 1 from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000005'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5)) then
    raise exception 'expected zero rows for a conversation outside the three appointment stages';
  end if;
  if exists (select 1 from public.list_available_appointment_slots('00000000-0000-0000-0000-000000000000'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 5)) then
    raise exception 'expected zero rows for an unknown conversation';
  end if;

  -- Invalid inputs raise before any row is considered.
  v_rejected := false;
  begin
    perform slot_id from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000001'::uuid, pg_catalog.now() + interval '1 day', pg_catalog.now(), 5);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected p_to <= p_from to raise'; end if;

  v_rejected := false;
  begin
    perform slot_id from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000001'::uuid, pg_catalog.now(), pg_catalog.now() + interval '32 days', 5);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a window longer than 31 days to raise'; end if;

  v_rejected := false;
  begin
    perform slot_id from public.list_available_appointment_slots('99830000-0000-0000-0000-000000000001'::uuid, pg_catalog.now(), pg_catalog.now() + interval '1 day', 11);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected p_limit > 10 to raise'; end if;
end;
$$;

-- =========================================================================
-- Fixture 3: hold_appointment_slot — not_found, not_ready, a fresh 10-minute
-- token, a non-extending exact replay, unavailable without destroying the
-- caller's existing hold, an atomic switch, reclaiming an expired hold with
-- a new token that invalidates the old one, and conflict once confirmed.
-- =========================================================================
do $$
declare
  v_result text;
  v_token uuid;
  v_token2 uuid;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_old_slot_row public.appointment_slots%rowtype;
  v_rejected boolean;
begin
  -- not_found: unknown conversation, unknown slot, cross-clinic slot.
  select result, booking_token into v_result, v_token from public.hold_appointment_slot('00000000-0000-0000-0000-000000000000'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'not_found' or v_token is not null then
    raise exception 'expected not_found for an unknown conversation, got % %', v_result, v_token;
  end if;

  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '00000000-0000-0000-0000-000000000000'::uuid);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown slot, got %', v_result;
  end if;

  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000007'::uuid);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-clinic target, got %', v_result;
  end if;

  -- not_ready: inactive, no pet, wrong stage.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000003'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'not_ready' then raise exception 'expected not_ready for an inactive conversation, got %', v_result; end if;

  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000004'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'not_ready' then raise exception 'expected not_ready for a conversation with no pet, got %', v_result; end if;

  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000005'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'not_ready' then raise exception 'expected not_ready for a conversation outside the three appointment stages, got %', v_result; end if;

  -- Successful hold: derives owner/pet from the conversation, fresh token,
  -- 10-minute lease.
  select result, booking_token, starts_at, ends_at
    into v_result, v_token, v_starts_at, v_ends_at
  from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'held' or v_token is null then
    raise exception 'expected a successful hold, got % %', v_result, v_token;
  end if;
  if not exists (
    select 1 from public.appointment_slots
    where id = '99840000-0000-0000-0000-000000000001' and status = 'held'
      and conversation_id = '99830000-0000-0000-0000-000000000001'
      and owner_id = '99810000-0000-0000-0000-000000000001'
      and pet_id = '99820000-0000-0000-0000-000000000001'
      and booking_token = v_token
      and hold_until between pg_catalog.now() + interval '9 minutes 55 seconds' and pg_catalog.now() + interval '10 minutes 5 seconds'
  ) then
    raise exception 'expected the held row to carry the conversation-derived owner/pet and a ~10-minute lease';
  end if;

  -- Exact replay of the same target does not extend the lease.
  select result, booking_token, starts_at, ends_at
    into v_result, v_token2, v_starts_at, v_ends_at
  from public.hold_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'held' or v_token2 <> v_token then
    raise exception 'expected an exact-target replay to return the same token without extending it, got % %', v_result, v_token2;
  end if;

  -- conv_ready2 cannot take conv_ready's just-established hold, and
  -- conv_ready's hold is left completely unchanged.
  select * into v_old_slot_row from public.appointment_slots where id = '99840000-0000-0000-0000-000000000001';
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000002'::uuid, '99840000-0000-0000-0000-000000000001'::uuid);
  if v_result <> 'unavailable' then
    raise exception 'expected unavailable for a slot held by another conversation, got %', v_result;
  end if;
  if exists (
    select 1 from public.appointment_slots
    where id = '99840000-0000-0000-0000-000000000001'
      and (status, conversation_id, booking_token, hold_until) is distinct from (v_old_slot_row.status, v_old_slot_row.conversation_id, v_old_slot_row.booking_token, v_old_slot_row.hold_until)
  ) then
    raise exception 'expected an unavailable target not to disturb the existing valid hold';
  end if;

  -- A confirmed target is unavailable regardless of requester.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000002'::uuid, '99840000-0000-0000-0000-000000000004'::uuid);
  if v_result <> 'unavailable' then raise exception 'expected unavailable for a confirmed target, got %', v_result; end if;

  -- A slot that no longer starts in the future is unavailable.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000002'::uuid, '99840000-0000-0000-0000-000000000005'::uuid);
  if v_result <> 'unavailable' then raise exception 'expected unavailable for a slot that no longer starts in the future, got %', v_result; end if;

  -- Switching: conv_ready2 holds slot_switch_target (8), then switches to
  -- slot_conflict_avail (9); the first is released atomically.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000002'::uuid, '99840000-0000-0000-0000-000000000008'::uuid);
  if v_result <> 'held' then raise exception 'expected conv_ready2 to hold slot 8, got %', v_result; end if;

  select result, booking_token into v_result, v_token from public.hold_appointment_slot('99830000-0000-0000-0000-000000000002'::uuid, '99840000-0000-0000-0000-000000000009'::uuid);
  if v_result <> 'held' then raise exception 'expected conv_ready2 to switch to slot 9, got %', v_result; end if;
  if not exists (
    select 1 from public.appointment_slots
    where id = '99840000-0000-0000-0000-000000000008' and status = 'available'
      and conversation_id is null and owner_id is null and pet_id is null and booking_token is null and hold_until is null
  ) then
    raise exception 'expected slot 8 to be released back to available after the switch';
  end if;
  if not exists (select 1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000009' and status = 'held' and conversation_id = '99830000-0000-0000-0000-000000000002' and booking_token = v_token) then
    raise exception 'expected slot 9 to be held by conv_ready2 with a fresh token';
  end if;

  -- Reclaiming an expired hold issues a brand-new token; the stale token
  -- from the original (now-superseded) holder cannot confirm afterward.
  select result, booking_token into v_result, v_token from public.hold_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000003'::uuid);
  if v_result <> 'held' or v_token = '99850000-0000-0000-0000-000000000099' then
    raise exception 'expected reclaiming an expired hold to issue a fresh token distinct from the stale one, got % %', v_result, v_token;
  end if;
  -- conv008 is independently eligible (active, appointment_confirmation) but
  -- never held slot 3; the stale pre-reclaim token fails against it too,
  -- proving the superseded holder lost all authority once conv006 reclaimed
  -- the slot.
  select result into v_result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000008'::uuid, '99840000-0000-0000-0000-000000000003'::uuid, '99850000-0000-0000-0000-000000000099'::uuid);
  if v_result <> 'stale' then
    raise exception 'expected the stale pre-reclaim token to be rejected as stale, got %', v_result;
  end if;

  -- Sets up the conflict proof in Fixture 4: conv_confirm_conflict holds
  -- slot 10 here, confirms it there, then a hold attempt on a different
  -- available target must return conflict.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000010'::uuid);
  if v_result <> 'held' then raise exception 'expected conv_confirm_conflict to hold slot 10, got %', v_result; end if;

  -- Null identifiers are rejected before any lookup.
  v_rejected := false;
  begin
    perform result from public.hold_appointment_slot(null, '99840000-0000-0000-0000-000000000002'::uuid);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a null conversation_id to raise'; end if;
end;
$$;

-- =========================================================================
-- Fixture 4: confirm_appointment_slot — not_found, not_ready, wrong-token/
-- expired/cross-conversation staleness, a successful confirm, and an
-- already_confirmed replay that stays idempotent after the conversation
-- advances past appointment_confirmation.
-- =========================================================================
do $$
declare
  v_result text;
  v_token10 uuid;
  v_token1 uuid;
  v_token11 uuid;
  v_starts_at timestamptz;
  v_ends_at timestamptz;
  v_slot10_before public.appointment_slots%rowtype;
  v_slot1_before public.appointment_slots%rowtype;
  v_rejected boolean;
begin
  select booking_token into v_token10 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000010';
  select booking_token into v_token1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000001';

  -- not_found: unknown conversation, unknown slot, cross-clinic slot.
  select result into v_result from public.confirm_appointment_slot('00000000-0000-0000-0000-000000000000'::uuid, '99840000-0000-0000-0000-000000000010'::uuid, v_token10);
  if v_result <> 'not_found' then raise exception 'expected not_found for an unknown conversation, got %', v_result; end if;

  select result into v_result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '00000000-0000-0000-0000-000000000000'::uuid, v_token10);
  if v_result <> 'not_found' then raise exception 'expected not_found for an unknown slot, got %', v_result; end if;

  select result into v_result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000007'::uuid, v_token10);
  if v_result <> 'not_found' then raise exception 'expected not_found for a cross-clinic target, got %', v_result; end if;

  -- not_ready: conv_ready still holds slot 1 but is at appointment_offer, not appointment_confirmation.
  select * into v_slot1_before from public.appointment_slots where id = '99840000-0000-0000-0000-000000000001';
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000001'::uuid, '99840000-0000-0000-0000-000000000001'::uuid, v_token1);
  if v_result <> 'not_ready' or v_starts_at is not null or v_ends_at is not null then
    raise exception 'expected not_ready with null times for a conversation outside appointment_confirmation, got % % %', v_result, v_starts_at, v_ends_at;
  end if;
  if exists (select 1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000001' and row(status, conversation_id, booking_token, hold_until) is distinct from row(v_slot1_before.status, v_slot1_before.conversation_id, v_slot1_before.booking_token, v_slot1_before.hold_until)) then
    raise exception 'expected a not_ready confirm attempt to leave the slot unmutated';
  end if;

  -- stale: wrong token against a conversation that does hold the slot.
  select * into v_slot10_before from public.appointment_slots where id = '99840000-0000-0000-0000-000000000010';
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000010'::uuid, pg_catalog.gen_random_uuid());
  if v_result <> 'stale' or v_starts_at is not null or v_ends_at is not null then
    raise exception 'expected stale with null times for a wrong token, got % % %', v_result, v_starts_at, v_ends_at;
  end if;
  if exists (select 1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000010' and row(status, conversation_id, booking_token, hold_until) is distinct from row(v_slot10_before.status, v_slot10_before.conversation_id, v_slot10_before.booking_token, v_slot10_before.hold_until)) then
    raise exception 'expected a stale confirm attempt to leave the slot unmutated';
  end if;

  -- stale: correct token but the wrong conversation. conv008 is
  -- independently eligible (active, appointment_confirmation) but does not
  -- hold slot 1, so this reaches the token/conversation check rather than
  -- being turned away earlier by not_ready.
  select result into v_result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000008'::uuid, '99840000-0000-0000-0000-000000000001'::uuid, v_token1);
  if v_result <> 'stale' then raise exception 'expected stale for a cross-conversation token, got %', v_result; end if;

  -- stale: a hold that has genuinely expired since it was taken.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000008'::uuid, '99840000-0000-0000-0000-000000000011'::uuid);
  if v_result <> 'held' then raise exception 'expected conv_confirm_expired to hold slot 11, got %', v_result; end if;
  select booking_token into v_token11 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000011';
  update public.appointment_slots set hold_until = pg_catalog.now() - interval '1 second' where id = '99840000-0000-0000-0000-000000000011';
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000008'::uuid, '99840000-0000-0000-0000-000000000011'::uuid, v_token11);
  if v_result <> 'stale' or v_starts_at is not null or v_ends_at is not null then
    raise exception 'expected stale with null times for an expired hold, got % % %', v_result, v_starts_at, v_ends_at;
  end if;

  -- stale: even a current hold cannot be confirmed after its slot starts.
  update public.appointment_slots
    set starts_at = (select value from pg_temp.fixture_times where key = 't_started'),
        ends_at = (select value from pg_temp.fixture_times where key = 't_started') + interval '30 minutes',
        hold_until = pg_catalog.now() + interval '1 minute'
    where id = '99840000-0000-0000-0000-000000000011';
  select * into v_slot10_before from public.appointment_slots where id = '99840000-0000-0000-0000-000000000011';
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000008'::uuid, '99840000-0000-0000-0000-000000000011'::uuid, v_token11);
  if v_result <> 'stale' or v_starts_at is not null or v_ends_at is not null then
    raise exception 'expected stale with null times for an already-started slot, got % % %', v_result, v_starts_at, v_ends_at;
  end if;
  if exists (select 1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000011' and row(status, conversation_id, booking_token, hold_until) is distinct from row(v_slot10_before.status, v_slot10_before.conversation_id, v_slot10_before.booking_token, v_slot10_before.hold_until)) then
    raise exception 'expected an already-started confirm attempt to leave the slot unmutated';
  end if;

  -- Successful confirm: exact current token at appointment_confirmation.
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000010'::uuid, v_token10);
  if v_result <> 'confirmed' or v_starts_at is null or v_ends_at is null then
    raise exception 'expected a successful confirm, got % % %', v_result, v_starts_at, v_ends_at;
  end if;
  if not exists (
    select 1 from public.appointment_slots
    where id = '99840000-0000-0000-0000-000000000010' and status = 'confirmed'
      and booking_token = v_token10 and hold_until is null
      and confirmed_at between pg_catalog.now() - interval '5 seconds' and pg_catalog.now() + interval '5 seconds'
  ) then
    raise exception 'expected the confirmed slot to retain its token, clear hold_until, and stamp confirmed_at';
  end if;

  -- conflict: conv_confirm_conflict already has a confirmed slot; holding a
  -- different available target is refused without mutating it.
  select result into v_result from public.hold_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000002'::uuid);
  if v_result <> 'conflict' then raise exception 'expected conflict once the conversation already has a confirmed slot, got %', v_result; end if;
  if not exists (select 1 from public.appointment_slots where id = '99840000-0000-0000-0000-000000000002' and status = 'available' and conversation_id is null) then
    raise exception 'expected the conflict attempt to leave the untouched target slot available';
  end if;

  -- already_confirmed: exact replay stays idempotent even after the
  -- conversation advances past appointment_confirmation.
  update public.conversations set status = 'completed' where id = '99830000-0000-0000-0000-000000000006';
  select result, starts_at, ends_at into v_result, v_starts_at, v_ends_at
    from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000010'::uuid, v_token10);
  if v_result <> 'already_confirmed' or v_starts_at is null or v_ends_at is null then
    raise exception 'expected an idempotent already_confirmed replay, got % % %', v_result, v_starts_at, v_ends_at;
  end if;

  -- Null identifiers/token are rejected before any lookup.
  v_rejected := false;
  begin
    perform result from public.confirm_appointment_slot('99830000-0000-0000-0000-000000000006'::uuid, '99840000-0000-0000-0000-000000000010'::uuid, null);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a null booking_token to raise'; end if;
end;
$$;

-- =========================================================================
-- Fixture 5: erasure cascades. Each sub-case uses its own small, independent
-- clinic/owner/pet/conversation/slot trio so deleting one source row proves
-- exactly its own cascade path without disturbing the others.
-- =========================================================================
do $$
declare
  v_count integer;
begin
  -- Pet erasure cascades a confirmed slot.
  insert into public.clinics (id, name) values ('99850000-0000-0000-0000-000000000001', 'Erasure Clinic 1');
  insert into public.owners (id, clinic_id, full_name, phone_e164) values ('99850000-0000-0000-0000-000000000002', '99850000-0000-0000-0000-000000000001', 'Erasure Owner 1', '+15559980101');
  insert into public.pets (id, clinic_id, owner_id, name, species) values ('99850000-0000-0000-0000-000000000003', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000002', 'Erasure Pet 1', 'dog');
  -- The anchor conversation deliberately leaves pet_id null: conversations
  -- carries an ON DELETE NO ACTION foreign key to pets (unlike
  -- appointment_slots' own ON DELETE CASCADE pet FK), so a conversation that
  -- still pointed at this pet would block deleting it directly.
  insert into public.conversations (id, clinic_id, owner_id, pet_id, status) values ('99850000-0000-0000-0000-000000000004', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000002', null, 'active');
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, confirmed_at)
  values ('99850000-0000-0000-0000-000000000005', '99850000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't0'), (select value from pg_temp.fixture_times where key = 't0') + interval '30 minutes', 'confirmed', '99850000-0000-0000-0000-000000000004', '99850000-0000-0000-0000-000000000002', '99850000-0000-0000-0000-000000000003', pg_catalog.gen_random_uuid(), pg_catalog.now());

  delete from public.pets where id = '99850000-0000-0000-0000-000000000003';
  if exists (select 1 from public.appointment_slots where id = '99850000-0000-0000-0000-000000000005') then
    raise exception 'expected pet erasure to cascade its confirmed appointment_slots row';
  end if;

  -- Conversation erasure cascades a held slot.
  insert into public.owners (id, clinic_id, full_name, phone_e164) values ('99850000-0000-0000-0000-000000000006', '99850000-0000-0000-0000-000000000001', 'Erasure Owner 2', '+15559980102');
  insert into public.pets (id, clinic_id, owner_id, name, species) values ('99850000-0000-0000-0000-000000000007', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000006', 'Erasure Pet 2', 'cat');
  insert into public.conversations (id, clinic_id, owner_id, pet_id, status) values ('99850000-0000-0000-0000-000000000008', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000006', '99850000-0000-0000-0000-000000000007', 'active');
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values ('99850000-0000-0000-0000-000000000009', '99850000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't1'), (select value from pg_temp.fixture_times where key = 't1') + interval '30 minutes', 'held', '99850000-0000-0000-0000-000000000008', '99850000-0000-0000-0000-000000000006', '99850000-0000-0000-0000-000000000007', pg_catalog.gen_random_uuid(), pg_catalog.now() + interval '10 minutes');

  delete from public.conversations where id = '99850000-0000-0000-0000-000000000008';
  if exists (select 1 from public.appointment_slots where id = '99850000-0000-0000-0000-000000000009') then
    raise exception 'expected conversation erasure to cascade its held appointment_slots row';
  end if;

  -- Owner erasure cascades a confirmed slot transitively through both the
  -- owner->pet and owner->conversation paths in one statement. The anchor
  -- conversation leaves pet_id null for the same NO ACTION reason as the
  -- pet-erasure sub-case above, so neither cascade path can block the other.
  insert into public.owners (id, clinic_id, full_name, phone_e164) values ('99850000-0000-0000-0000-000000000010', '99850000-0000-0000-0000-000000000001', 'Erasure Owner 3', '+15559980103');
  insert into public.pets (id, clinic_id, owner_id, name, species) values ('99850000-0000-0000-0000-000000000011', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000010', 'Erasure Pet 3', 'dog');
  insert into public.conversations (id, clinic_id, owner_id, pet_id, status) values ('99850000-0000-0000-0000-000000000012', '99850000-0000-0000-0000-000000000001', '99850000-0000-0000-0000-000000000010', null, 'active');
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, confirmed_at)
  values ('99850000-0000-0000-0000-000000000013', '99850000-0000-0000-0000-000000000001', (select value from pg_temp.fixture_times where key = 't2'), (select value from pg_temp.fixture_times where key = 't2') + interval '30 minutes', 'confirmed', '99850000-0000-0000-0000-000000000012', '99850000-0000-0000-0000-000000000010', '99850000-0000-0000-0000-000000000011', pg_catalog.gen_random_uuid(), pg_catalog.now());

  delete from public.owners where id = '99850000-0000-0000-0000-000000000010';
  select count(*) into v_count from public.appointment_slots where id = '99850000-0000-0000-0000-000000000013';
  select count(*) + v_count into v_count from public.conversations where id = '99850000-0000-0000-0000-000000000012';
  select count(*) + v_count into v_count from public.pets where id = '99850000-0000-0000-0000-000000000011';
  if v_count <> 0 then
    raise exception 'expected owner erasure to cascade its pet, conversation, and confirmed appointment_slots row';
  end if;

  -- Clinic erasure cascades a held slot, using a wholly separate clinic so
  -- it does not disturb the sub-cases above. The anchor conversation again
  -- leaves pet_id null for the same NO ACTION reason as the sub-cases above.
  insert into public.clinics (id, name) values ('99850000-0000-0000-0000-000000000020', 'Erasure Clinic 2');
  insert into public.owners (id, clinic_id, full_name, phone_e164) values ('99850000-0000-0000-0000-000000000021', '99850000-0000-0000-0000-000000000020', 'Erasure Owner 4', '+15559980104');
  insert into public.pets (id, clinic_id, owner_id, name, species) values ('99850000-0000-0000-0000-000000000022', '99850000-0000-0000-0000-000000000020', '99850000-0000-0000-0000-000000000021', 'Erasure Pet 4', 'cat');
  insert into public.conversations (id, clinic_id, owner_id, pet_id, status) values ('99850000-0000-0000-0000-000000000023', '99850000-0000-0000-0000-000000000020', '99850000-0000-0000-0000-000000000021', null, 'active');
  insert into public.appointment_slots (id, clinic_id, starts_at, ends_at, status, conversation_id, owner_id, pet_id, booking_token, hold_until)
  values ('99850000-0000-0000-0000-000000000024', '99850000-0000-0000-0000-000000000020', (select value from pg_temp.fixture_times where key = 't3'), (select value from pg_temp.fixture_times where key = 't3') + interval '30 minutes', 'held', '99850000-0000-0000-0000-000000000023', '99850000-0000-0000-0000-000000000021', '99850000-0000-0000-0000-000000000022', pg_catalog.gen_random_uuid(), pg_catalog.now() + interval '10 minutes');

  delete from public.clinics where id = '99850000-0000-0000-0000-000000000020';
  if exists (select 1 from public.appointment_slots where id = '99850000-0000-0000-0000-000000000024') then
    raise exception 'expected clinic erasure to cascade its held appointment_slots row';
  end if;
end;
$$;

reset role;

-- =========================================================================
-- Residue check: after rollback, zero fixture rows from this script survive
-- in any table.
-- =========================================================================
rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id::text like '998%') as remaining_clinics,
  (select count(*) from public.owners where id::text like '998%') as remaining_owners,
  (select count(*) from public.pets where id::text like '998%') as remaining_pets,
  (select count(*) from public.conversations where id::text like '998%') as remaining_conversations,
  (select count(*) from public.appointment_slots where id::text like '998%') as remaining_slots;
