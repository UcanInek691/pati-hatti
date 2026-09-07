begin;

-- Task 055: worker_exception platform alert signal
-- (alert_deliveries.signal_kind CHECK constraint + record_platform_signal).
-- Rollback-only -- never run by the implementer against any real database;
-- Codex runs this against the disposable vetai-test project. Mirrors the
-- catalog/grant proof style of 049_route_resolver_volatility.sql and the
-- record_platform_signal dedup/no-recipient proof of section 9 of
-- 053_operational_alerting.sql. worker_exception is platform scope only, so
-- no clinic fixture data is needed.

-- =========================================================================
-- 1. Setup: one platform admin enrolled as an enabled platform alert
-- recipient, used by every record_platform_signal call below.
-- =========================================================================
insert into auth.users (id, aud, role, email, created_at, updated_at)
values ('55000000-0000-0000-2000-000000000001', 'authenticated', 'authenticated', 'alerts-055-admin@example.invalid', now(), now());

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.set_platform_admin_v1('55000000-0000-0000-2000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected admin enabled, got %', v_result; end if;

  select result into v_result from public.set_platform_alert_recipient(
    '55000000-0000-0000-2000-000000000001', 'alerts-055-admin@example.invalid', true,
    '55000000-0000-0000-2000-000000000001', 'fixture seed'
  );
  if v_result <> 'set' then raise exception 'expected set for platform recipient seed, got %', v_result; end if;
end;
$$;
reset role;

-- =========================================================================
-- 2. record_platform_signal catalog/grant proof: still security invoker,
-- volatile, empty search_path, unchanged (p_signal_kind text, p_queue_id
-- text) signature, PUBLIC/anon/authenticated denied, service_role retains
-- EXECUTE.
-- =========================================================================
do $$
begin
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'record_platform_signal'
      and grantee in ('anon', 'authenticated', 'PUBLIC')
  ) then
    raise exception 'expected record_platform_signal revoked from anon/authenticated/public';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'record_platform_signal'
      and grantee = 'service_role' and privilege_type = 'EXECUTE'
  ) then
    raise exception 'expected record_platform_signal granted to service_role';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'record_platform_signal'
      and p.prosecdef = false
      and p.provolatile = 'v'
      and (p.proconfig @> array['search_path='] or p.proconfig @> array['search_path=""'])
      and pg_get_function_identity_arguments(p.oid) = 'p_signal_kind text, p_queue_id text'
  ) then
    raise exception 'record_platform_signal: unexpected signature, security, volatility or search_path';
  end if;
end;
$$;

-- =========================================================================
-- 3. alert_deliveries.signal_kind CHECK constraint: every legacy value plus
-- exactly worker_exception is accepted; anything else is rejected. Direct
-- inserts (not through record_platform_signal) so this fails loudly the
-- moment any legacy value silently disappears from the constraint, per
-- Task 055 acceptance criterion 6.
-- =========================================================================
set local role service_role;
do $$
declare
  v_kind text;
  v_ok_kinds text[] := array[
    'delivery_failure', 'human_handoff_urgent', 'human_handoff_normal', 'intake_dead_letter',
    'queue_backlog', 'webhook_5xx', 'webhook_401', 'openai_extraction_failure', 'worker_exception'
  ];
begin
  foreach v_kind in array v_ok_kinds loop
    begin
      insert into public.alert_deliveries (signal_kind, recipient_scope, recipient_user_id, dedup_key)
      values (v_kind, 'platform', '55000000-0000-0000-2000-000000000001', 'constraint-proof:' || v_kind);
    exception when check_violation then
      raise exception 'signal_kind % must still be accepted by the CHECK constraint', v_kind;
    end;
  end loop;

  if (select count(*) from public.alert_deliveries where dedup_key like 'constraint-proof:%') <> array_length(v_ok_kinds, 1) then
    raise exception 'expected one row per accepted legacy/new signal_kind';
  end if;

  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, recipient_user_id, dedup_key)
    values ('not_a_real_signal', 'platform', '55000000-0000-0000-2000-000000000001', 'constraint-proof:invalid');
    raise exception 'an unrecognized signal_kind must be rejected by the CHECK constraint';
  exception when check_violation then
    null;
  end;

  delete from public.alert_deliveries where dedup_key like 'constraint-proof:%';
end;
$$;
reset role;

-- =========================================================================
-- 4. record_platform_signal('worker_exception', ...): valid positive
-- recording, same-hour dedup bump, and fail-closed no_recipients -- the
-- exact section 9 pattern from 053_operational_alerting.sql, scoped to the
-- new signal only.
-- =========================================================================
set local role service_role;
do $$
declare
  v_result text;
  v_kind text;
begin
  -- The migration recreates record_platform_signal, so prove its own
  -- narrower allow-list still accepts every legacy platform signal before
  -- exercising the new value.
  foreach v_kind in array array['queue_backlog', 'webhook_5xx', 'webhook_401', 'openai_extraction_failure'] loop
    select result into v_result from public.record_platform_signal(v_kind);
    if v_result <> 'recorded' then
      raise exception 'legacy platform signal % must still be accepted, got %', v_kind, v_result;
    end if;
  end loop;
  delete from public.alert_deliveries where signal_kind <> 'worker_exception';

  select result into v_result from public.record_platform_signal('worker_exception');
  if v_result <> 'recorded' then raise exception 'expected recorded, got %', v_result; end if;

  if (select count(*) from public.alert_deliveries where signal_kind = 'worker_exception') <> 1 then
    raise exception 'expected exactly one worker_exception delivery for the one enabled platform recipient';
  end if;
  if exists (select 1 from public.alert_deliveries where signal_kind = 'worker_exception' and occurrence_count <> 1) then
    raise exception 'expected occurrence_count 1 on first record';
  end if;

  -- Same signal within the same hour bucket bumps occurrence_count instead
  -- of inserting a second row.
  select result into v_result from public.record_platform_signal('worker_exception');
  if v_result <> 'recorded' then raise exception 'expected recorded on repeat, got %', v_result; end if;
  if (select count(*) from public.alert_deliveries where signal_kind = 'worker_exception') <> 1 then
    raise exception 'a repeat worker_exception signal within the same hour must not create a second row';
  end if;
  if exists (select 1 from public.alert_deliveries where signal_kind = 'worker_exception' and occurrence_count <> 2) then
    raise exception 'expected occurrence_count bumped to 2 on repeat';
  end if;

  -- With no enabled recipient, the signal must fail closed instead of
  -- disappearing behind a false 'recorded' result.
  perform result from public.set_platform_alert_recipient(
    '55000000-0000-0000-2000-000000000001', 'alerts-055-admin@example.invalid', false,
    '55000000-0000-0000-2000-000000000001', 'testing the no-recipient signal guard'
  );
  select result into v_result from public.record_platform_signal('worker_exception');
  if v_result <> 'no_recipients' then raise exception 'expected no_recipients, got %', v_result; end if;
  if (select count(*) from public.alert_deliveries where signal_kind = 'worker_exception') <> 1 then
    raise exception 'a no-recipient signal must not create or bump a delivery row';
  end if;
end;
$$;
reset role;

rollback;

-- Zero residue: these selects run against the post-rollback state.
select
  (select count(*) from auth.users where id = '55000000-0000-0000-2000-000000000001') as users_left,
  (select count(*) from public.platform_admins where user_id = '55000000-0000-0000-2000-000000000001') as platform_admins_left,
  (select count(*) from public.platform_alert_recipients where user_id = '55000000-0000-0000-2000-000000000001') as platform_alert_recipients_left,
  (select count(*) from public.alert_recipient_audit where actor_user_id = '55000000-0000-0000-2000-000000000001') as alert_recipient_audit_left,
  (select count(*) from public.alert_deliveries where recipient_user_id = '55000000-0000-0000-2000-000000000001') as alert_deliveries_left;
