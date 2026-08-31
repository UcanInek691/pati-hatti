-- Task 043: rollback-only proof for the platform-admin metadata overview.
-- Not run against any database by the implementer; Codex applies this only
-- on disposable vetai-test after review.

begin;

-- =========================================================================
-- 0. The clinic-name shape assumed by the browser is a database invariant.
-- =========================================================================

do $$
declare
  v_name text;
  v_test_id constant uuid := '43000000-0000-0000-2000-000000000099';
begin
  if not exists (
    select 1
      from pg_catalog.pg_constraint c
      join pg_catalog.pg_class t on t.oid = c.conrelid
      join pg_catalog.pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = 'clinics'
       and c.conname = 'clinics_name_shape_check'
       and c.contype = 'c'
       and c.convalidated
  ) then
    raise exception 'clinics_name_shape_check is missing or unvalidated';
  end if;

  foreach v_name in array array['Trailing space ', repeat('x', 201), E'Control\ncharacter'] loop
    begin
      insert into public.clinics (id, name) values (v_test_id, v_name);
      raise exception 'clinics_name_shape_check accepted invalid name';
    exception
      when check_violation then null;
    end;
  end loop;

  if exists (select 1 from public.clinics where id = v_test_id) then
    raise exception 'invalid clinic-name proof left a row behind';
  end if;
end;
$$;

-- =========================================================================
-- 1. platform_admins: RLS enabled, no policy, no direct grant.
-- =========================================================================

do $$
declare
  v_has_rls boolean;
  v_policy_count integer;
begin
  select c.relrowsecurity into v_has_rls
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'platform_admins';
  if not v_has_rls then
    raise exception 'platform_admins does not have RLS enabled';
  end if;

  select count(*) into v_policy_count
    from pg_catalog.pg_policies
   where schemaname = 'public' and tablename = 'platform_admins';
  if v_policy_count <> 0 then
    raise exception 'platform_admins unexpectedly has % policies', v_policy_count;
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'platform_admins'
       and grantee in ('anon', 'authenticated', 'service_role')
  ) then
    raise exception 'platform_admins has a direct grant for a runtime role';
  end if;
end;
$$;

do $$
begin
  set local role anon;
  begin
    perform 1 from public.platform_admins;
    raise exception 'anon unexpectedly read platform_admins';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- 6. Closed result-set proof: get_platform_admin_overview_v1's OUT columns
-- are exactly the fixed projection -- no phone, owner, pet, conversation,
-- message, provider, account, work-item, hash or token-secret column exists.
do $$
declare
  v_columns text[];
  v_expected constant text[] := array[
    'result', 'clinic_id', 'clinic_name', 'operational_status',
    'whatsapp_account_count', 'open_work_item_count', 'urgent_work_item_count',
    'pending_outbound_count', 'processing_outbound_count', 'failed_outbound_count',
    'last_inbound_at', 'last_outbound_at', 'period_start', 'period_end',
    'ai_turn_count', 'ai_touched_conversation_count',
    'input_tokens', 'output_tokens', 'total_tokens', 'missing_token_usage_count'
  ];
begin
  select array_agg(p.parameter_name order by p.ordinal_position)
    into v_columns
    from information_schema.parameters p
   where p.specific_schema = 'public'
     and p.specific_name = (
       select r.specific_name from information_schema.routines r
        where r.routine_schema = 'public' and r.routine_name = 'get_platform_admin_overview_v1'
     )
     and p.parameter_mode = 'OUT';
  if v_columns is distinct from v_expected then
    raise exception 'get_platform_admin_overview_v1 result columns changed: %', v_columns;
  end if;

  if (
    select p.proowner from pg_catalog.pg_proc p
     where p.oid = 'public.get_platform_admin_overview_v1(date)'::pg_catalog.regprocedure
  ) is distinct from (
    select p.proowner from pg_catalog.pg_proc p
     where p.oid = 'public.get_clinic_monthly_usage_v1(uuid,date)'::pg_catalog.regprocedure
  ) then
    raise exception 'overview and monthly-usage RPC owners differ';
  end if;
end;
$$;

-- =========================================================================
-- 2. set_platform_admin_v1: service-role-only, nonexistent user, idempotent.
-- =========================================================================

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('43000000-0000-0000-1000-000000000001', 'authenticated', 'authenticated', 'admin-043-admin@example.invalid', now(), now()),
  ('43000000-0000-0000-1000-000000000002', 'authenticated', 'authenticated', 'admin-043-staff@example.invalid', now(), now());

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000002', true);
  begin
    perform * from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', true);
    raise exception 'authenticated role unexpectedly executed set_platform_admin_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
begin
  set local role anon;
  begin
    perform * from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', true);
    raise exception 'anon unexpectedly executed set_platform_admin_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
declare
  v_result text;
begin
  set local role service_role;

  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000099', true);
  if v_result <> 'user_not_found' then
    raise exception 'expected user_not_found for a nonexistent Auth user, got %', v_result;
  end if;
  reset role;
  if exists (select 1 from public.platform_admins where user_id = '43000000-0000-0000-1000-000000000099') then
    raise exception 'set_platform_admin_v1 mutated membership for a nonexistent user';
  end if;

  set local role service_role;
  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected enabled, got %', v_result; end if;

  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected idempotent enabled, got %', v_result; end if;
  reset role;

  if (select count(*) from public.platform_admins where user_id = '43000000-0000-0000-1000-000000000001') <> 1 then
    raise exception 'enabling twice created more than one membership row';
  end if;
end;
$$;

-- The overview RPC's `empty` sentinel: an enabled admin, checked before any
-- clinic fixture exists, so public.clinics is genuinely empty here (no
-- migration seeds clinics, and this fixture is the first to insert one).
do $$
declare
  r record;
  v_row_count integer := 0;
begin
  -- The overview is intentionally global, so a shared test database may
  -- already contain unrelated clinics. Exercise the empty sentinel only
  -- when the database is genuinely empty; never delete or rewrite unrelated
  -- tenant rows merely to manufacture this branch.
  if exists (select 1 from public.clinics) then
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000001', true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result <> 'empty' then
      raise exception 'expected empty sentinel with zero clinics, got %', r.result;
    end if;
    if r.clinic_id is not null or r.clinic_name is not null or r.operational_status is not null
      or r.ai_turn_count is not null or r.whatsapp_account_count is not null then
      raise exception 'empty sentinel carried a non-null clinic/aggregate field';
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one empty sentinel row, got %', v_row_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- Fixture: two clinics, one data-rich and one deliberately empty, plus the
-- same-clinic staff (clinic-admin) user who must never be treated as a
-- platform admin.
-- =========================================================================

insert into public.clinics (id, name, operational_status, suspended_at)
values
  ('43000000-0000-0000-2000-000000000001', 'Admin Overview Clinic A', 'active', null),
  ('43000000-0000-0000-2000-000000000002', 'Admin Overview Clinic B (empty)', 'suspended', now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-1000-000000000002', 'admin');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values
  ('43000000-0000-0000-3000-000000000001', '43000000-0000-0000-2000-000000000001', '430000001'),
  ('43000000-0000-0000-3000-000000000002', '43000000-0000-0000-2000-000000000001', '430000002');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('43000000-0000-0000-4000-000000000001', '43000000-0000-0000-2000-000000000001', 'Overview Owner A', '+15550430001');

insert into public.conversations (id, clinic_id, owner_id, pet_id, status)
values
  ('43000000-0000-0000-5000-000000000001', '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-4000-000000000001', null, 'active'),
  ('43000000-0000-0000-5000-000000000002', '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-4000-000000000001', null, 'completed');

insert into public.messages (clinic_id, conversation_id, direction, content, created_at)
values
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001', 'inbound', 'first inbound', '2026-06-01T08:00:00+00'),
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001', 'outbound', 'reply', '2026-06-20T08:00:00+00'),
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001', 'inbound', 'last inbound', '2026-06-25T08:00:00+00');

insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status)
values
  ('43000000-0000-0000-2000-000000000001', 'wh-043-outbox-1', repeat('a', 64), 'processed'),
  ('43000000-0000-0000-2000-000000000001', 'wh-043-outbox-2', repeat('a', 64), 'processed'),
  ('43000000-0000-0000-2000-000000000001', 'wh-043-outbox-3', repeat('a', 64), 'processed');

insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
  recipient_e164, reply_category, content, delivery_status,
  delivery_claim_token, delivery_lease_until, delivery_attempt_count,
  next_attempt_at, failed_at, failure_reason
)
values
  ('43000000-0000-0000-6000-000000000001', '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001',
   '43000000-0000-0000-3000-000000000001', 'wh-043-outbox-1', '+15550430001', 'intake_received', 'pending reply', 'pending',
   null, null, 0, now(), null, null),
  ('43000000-0000-0000-6000-000000000002', '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001',
   '43000000-0000-0000-3000-000000000001', 'wh-043-outbox-2', '+15550430001', 'intake_received', 'processing reply', 'processing',
   '43000000-0000-0000-7000-000000000001', now() + interval '10 minutes', 1, null, null, null),
  ('43000000-0000-0000-6000-000000000003', '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001',
   '43000000-0000-0000-3000-000000000001', 'wh-043-outbox-3', '+15550430001', 'intake_received', 'failed reply', 'failed',
   null, null, 3, null, now(), 'attempts_exhausted');

insert into public.staff_work_items (
  clinic_id, conversation_id, kind, priority, reason, status,
  first_seen_at, first_seen_by, resolved_at
)
values
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001', 'human_handoff', 'urgent', 'emergency_handoff', 'open', null, null, null),
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000002', 'human_handoff', 'normal', 'human_handoff', 'seen', now(), '43000000-0000-0000-1000-000000000002', null),
  ('43000000-0000-0000-2000-000000000001', '43000000-0000-0000-5000-000000000001', 'human_handoff', 'normal', 'human_handoff', 'resolved', null, null, now());

-- Task 042 usage ledger rows: two turns inside the reported month, one
-- outside it (must be excluded), inserted directly since the ledger has no
-- direct grant even for service_role -- this fixture writes as the database
-- owner exactly as the contract's fixture note allows for protected
-- aggregate seed rows.
insert into public.clinic_ai_usage_events (
  clinic_id, event_kind, source_event_hash, conversation_hash, model, prompt_version,
  input_tokens, output_tokens, total_tokens, occurred_at
)
values
  ('43000000-0000-0000-2000-000000000001', 'intake_ai_turn', repeat('b', 64), repeat('c', 64), 'gpt-test', 'v1',
   10, 20, 30, '2026-06-10T08:00:00+00'),
  ('43000000-0000-0000-2000-000000000001', 'intake_ai_turn', repeat('b', 63) || 'd', repeat('c', 64), 'gpt-test', 'v1',
   null, null, null, '2026-06-15T08:00:00+00'),
  ('43000000-0000-0000-2000-000000000001', 'intake_ai_turn', repeat('e', 64), repeat('f', 64), 'gpt-test', 'v1',
   1, 2, 3, '2026-07-05T08:00:00+00');

-- =========================================================================
-- 3-4. Overview RPC: anon/service_role cannot execute; authenticated
-- non-admin (including a same-clinic staff/clinic-admin) sees only
-- `forbidden`; an enabled platform admin sees both clinics.
-- =========================================================================

do $$
begin
  set local role anon;
  begin
    perform * from public.get_platform_admin_overview_v1('2026-06-01'::date);
    raise exception 'anon unexpectedly executed get_platform_admin_overview_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
begin
  set local role service_role;
  begin
    perform * from public.get_platform_admin_overview_v1('2026-06-01'::date);
    raise exception 'service_role unexpectedly executed get_platform_admin_overview_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
declare
  r record;
  v_row_count integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000002', true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result <> 'forbidden' then
      raise exception 'same-clinic staff/clinic-admin got result %, expected forbidden', r.result;
    end if;
    if r.clinic_id is not null or r.clinic_name is not null or r.operational_status is not null
      or r.whatsapp_account_count is not null or r.open_work_item_count is not null
      or r.urgent_work_item_count is not null or r.pending_outbound_count is not null
      or r.processing_outbound_count is not null or r.failed_outbound_count is not null
      or r.last_inbound_at is not null or r.last_outbound_at is not null
      or r.ai_turn_count is not null or r.ai_touched_conversation_count is not null
      or r.input_tokens is not null or r.output_tokens is not null or r.total_tokens is not null
      or r.missing_token_usage_count is not null then
      raise exception 'forbidden sentinel carried a non-null clinic/aggregate field';
    end if;
    if r.period_start <> '2026-06-01'::date or r.period_end <> '2026-07-01'::date then
      raise exception 'forbidden sentinel did not echo the requested period';
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one forbidden sentinel row, got %', v_row_count;
  end if;

  reset role;
end;
$$;

do $$
declare
  r record;
  v_row_count integer := 0;
  v_seen_a boolean := false;
  v_seen_b boolean := false;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000001', true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) order by clinic_name loop
    v_row_count := v_row_count + 1;
    if r.result <> 'reported' then
      raise exception 'enabled platform admin got result %, expected reported', r.result;
    end if;
    if r.clinic_id is null or r.clinic_name is null or r.operational_status is null
      or r.whatsapp_account_count is null or r.open_work_item_count is null
      or r.urgent_work_item_count is null or r.pending_outbound_count is null
      or r.processing_outbound_count is null or r.failed_outbound_count is null
      or r.ai_turn_count is null or r.ai_touched_conversation_count is null
      or r.input_tokens is null or r.output_tokens is null or r.total_tokens is null
      or r.missing_token_usage_count is null then
      raise exception 'reported row for clinic % carried a null aggregate field', r.clinic_id;
    end if;
    if r.period_start <> '2026-06-01'::date or r.period_end <> '2026-07-01'::date then
      raise exception 'reported row for clinic % did not echo the requested period', r.clinic_id;
    end if;

    if r.clinic_id = '43000000-0000-0000-2000-000000000001' then
      v_seen_a := true;
      if r.clinic_name <> 'Admin Overview Clinic A' or r.operational_status <> 'active' then
        raise exception 'clinic A metadata mismatch: name=%, status=%', r.clinic_name, r.operational_status;
      end if;
      if r.whatsapp_account_count <> 2 then
        raise exception 'clinic A expected 2 whatsapp accounts, got %', r.whatsapp_account_count;
      end if;
      if r.open_work_item_count <> 2 or r.urgent_work_item_count <> 1 then
        raise exception 'clinic A work item counts wrong: open=%, urgent=%', r.open_work_item_count, r.urgent_work_item_count;
      end if;
      if r.pending_outbound_count <> 1 or r.processing_outbound_count <> 1 or r.failed_outbound_count <> 1 then
        raise exception 'clinic A outbound counts wrong: pending=%, processing=%, failed=%',
          r.pending_outbound_count, r.processing_outbound_count, r.failed_outbound_count;
      end if;
      if r.last_inbound_at <> '2026-06-25T08:00:00+00'::timestamptz
        or r.last_outbound_at <> '2026-06-20T08:00:00+00'::timestamptz then
        raise exception 'clinic A last message timestamps wrong: inbound=%, outbound=%', r.last_inbound_at, r.last_outbound_at;
      end if;
      if r.ai_turn_count <> 2 or r.ai_touched_conversation_count <> 1
        or r.input_tokens <> 10 or r.output_tokens <> 20 or r.total_tokens <> 30
        or r.missing_token_usage_count <> 1 then
        raise exception 'clinic A monthly usage aggregate wrong: turns=%, touched=%, in=%, out=%, total=%, missing=%',
          r.ai_turn_count, r.ai_touched_conversation_count, r.input_tokens, r.output_tokens, r.total_tokens, r.missing_token_usage_count;
      end if;
    elsif r.clinic_id = '43000000-0000-0000-2000-000000000002' then
      v_seen_b := true;
      if r.clinic_name <> 'Admin Overview Clinic B (empty)' or r.operational_status <> 'suspended' then
        raise exception 'clinic B metadata mismatch: name=%, status=%', r.clinic_name, r.operational_status;
      end if;
      if r.whatsapp_account_count <> 0 or r.open_work_item_count <> 0 or r.urgent_work_item_count <> 0
        or r.pending_outbound_count <> 0 or r.processing_outbound_count <> 0 or r.failed_outbound_count <> 0 then
        raise exception 'clinic B (known-empty) expected all-zero operational counts';
      end if;
      if r.last_inbound_at is not null or r.last_outbound_at is not null then
        raise exception 'clinic B (known-empty) expected null last message timestamps';
      end if;
      if r.ai_turn_count <> 0 or r.ai_touched_conversation_count <> 0
        or r.input_tokens <> 0 or r.output_tokens <> 0 or r.total_tokens <> 0
        or r.missing_token_usage_count <> 0 then
        raise exception 'clinic B (known-empty) expected all-zero monthly usage aggregate';
      end if;
    end if;
  end loop;

  if not v_seen_a or not v_seen_b then
    raise exception 'did not see both fixture clinics: a=%, b=%', v_seen_a, v_seen_b;
  end if;

  reset role;
end;
$$;

-- A month with zero AI usage for clinic A proves the reused
-- get_clinic_monthly_usage_v1 boundary, not a duplicated one, drives the
-- zero case too.
do $$
declare
  v_ai_turn_count bigint;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000001', true);

  select ai_turn_count into v_ai_turn_count
    from public.get_platform_admin_overview_v1('2026-01-01'::date)
   where clinic_id = '43000000-0000-0000-2000-000000000001';
  if v_ai_turn_count <> 0 then
    raise exception 'expected zero AI usage for an out-of-range month, got %', v_ai_turn_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- 7. Disabling membership immediately forbids; deleting the Auth user
-- cascades platform_admins membership.
-- =========================================================================

do $$
declare
  v_result text;
  r record;
  v_row_count integer := 0;
begin
  set local role service_role;
  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', false);
  if v_result <> 'disabled' then raise exception 'expected disabled, got %', v_result; end if;

  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', false);
  if v_result <> 'disabled' then raise exception 'expected idempotent disabled, got %', v_result; end if;
  reset role;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '43000000-0000-0000-1000-000000000001', true);
  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result <> 'forbidden' then
      raise exception 'disabled admin got result %, expected forbidden', r.result;
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one forbidden sentinel row after disabling, got %', v_row_count;
  end if;
  reset role;

  set local role service_role;
  select result into v_result from public.set_platform_admin_v1('43000000-0000-0000-1000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected re-enabled, got %', v_result; end if;
  reset role;
end;
$$;

do $$
begin
  delete from auth.users where id = '43000000-0000-0000-1000-000000000001';
  if exists (select 1 from public.platform_admins where user_id = '43000000-0000-0000-1000-000000000001') then
    raise exception 'deleting the Auth user did not cascade platform_admins membership';
  end if;
end;
$$;

-- =========================================================================
-- 8. Invalid input fails with zero mutation; function security mode, search
-- path and grants match the contract.
-- =========================================================================

do $$
begin
  begin
    perform * from public.set_platform_admin_v1(null, true);
    raise exception 'set_platform_admin_v1 accepted a null user_id';
  exception
    when others then
      if sqlerrm not like 'set_platform_admin_v1:%' then raise; end if;
  end;
end;
$$;

do $$
begin
  begin
    perform * from public.get_platform_admin_overview_v1('2026-06-15'::date);
    raise exception 'get_platform_admin_overview_v1 accepted a non-month-start date';
  exception
    when others then
      if sqlerrm not like 'get_platform_admin_overview_v1:%' then raise; end if;
  end;
end;
$$;

do $$
declare
  v_security text;
  v_volatility text;
  v_search_path text;
begin
  select case when p.prosecdef then 'definer' else 'invoker' end,
         p.provolatile,
         (select o.option_value from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path')
    into v_security, v_volatility, v_search_path
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'set_platform_admin_v1';
  if v_security <> 'definer' or v_volatility <> 'v' or v_search_path is distinct from '""' then
    raise exception 'set_platform_admin_v1 mode mismatch: security=%, volatility=%, search_path=%', v_security, v_volatility, v_search_path;
  end if;

  select case when p.prosecdef then 'definer' else 'invoker' end,
         p.provolatile,
         (select o.option_value from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path')
    into v_security, v_volatility, v_search_path
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'get_platform_admin_overview_v1';
  if v_security <> 'definer' or v_volatility <> 's' or v_search_path is distinct from '""' then
    raise exception 'get_platform_admin_overview_v1 mode mismatch: security=%, volatility=%, search_path=%', v_security, v_volatility, v_search_path;
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public' and routine_name = 'set_platform_admin_v1'
       and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'set_platform_admin_v1 is executable by a non-service role';
  end if;
  if not exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public' and routine_name = 'set_platform_admin_v1'
       and grantee = 'service_role'
  ) then
    raise exception 'set_platform_admin_v1 is missing its service_role grant';
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public' and routine_name = 'get_platform_admin_overview_v1'
       and grantee in ('anon', 'service_role')
  ) then
    raise exception 'get_platform_admin_overview_v1 is executable by anon or service_role';
  end if;
  if not exists (
    select 1 from information_schema.role_routine_grants
     where routine_schema = 'public' and routine_name = 'get_platform_admin_overview_v1'
       and grantee = 'authenticated'
  ) then
    raise exception 'get_platform_admin_overview_v1 is missing its authenticated grant';
  end if;
end;
$$;

-- =========================================================================
-- 9. Cascade cleanup and rollback: no residue is asserted by `rollback`
-- itself discarding every insert/update in this transaction. The explicit
-- checks below additionally prove no fixture row survives outside this
-- transaction's own inserts before the rollback runs.
-- =========================================================================

do $$
begin
  if exists (select 1 from public.platform_admins where user_id = '43000000-0000-0000-1000-000000000002') then
    raise exception 'the non-admin staff user unexpectedly holds platform_admins membership';
  end if;
  if (select count(*) from public.clinics where id in (
      '43000000-0000-0000-2000-000000000001', '43000000-0000-0000-2000-000000000002'
    )) <> 2 then
    raise exception 'fixture clinics missing before rollback';
  end if;
end;
$$;

rollback;
