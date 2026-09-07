-- Task 056: rollback-only proof for the clinic-wide alert gate and staff
-- personal alert preference (clinic_alert_settings, clinic_alert_gate_audit,
-- get_my_clinic_alert_preferences, set_my_clinic_alert_preference,
-- get_platform_clinic_alert_gates, set_platform_clinic_alert_gate, and the
-- Task 053 predicate recreations). Sonnet does NOT run this file against
-- any database; Codex alone applies the paired migration and this fixture
-- on disposable vetai-test, with zero residue, before any staging
-- activation. Never run this fixture script against a real clinic
-- database.
-- See docs/operational-alerting.md, docs/staff-workflow.md,
-- docs/platform-admin-overview.md, docs/database-schema.md.
--
-- Single-session limit: like 020/047/049/053, this proves claim/lease/dedup
-- and lock-order logic within one session and cannot itself exercise true
-- cross-session `for update skip locked` contention or deadlock detection;
-- lock order is additionally reviewed statically (clinics before
-- clinic_alert_settings; clinics before clinic_staff (FOR NO KEY UPDATE) before
-- clinic_alert_recipients,
-- unchanged from Task 053) rather than exercised as live concurrency here.

begin;

-- =========================================================================
-- 0. Fixture: two clinics, staff (one confirmed e-mail, one unconfirmed,
-- one to be removed for tenant-isolation proof), a non-admin authenticated
-- user, a platform admin, and enough of the conversation chain for four
-- distinct work items.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('56000000-0000-0000-1000-000000000001', 'Alert Pref Test Clinic A'),
  ('56000000-0000-0000-1000-000000000002', 'Alert Pref Test Clinic B');

update public.clinics set operational_status = 'active', suspended_at = null
where id in (
  '56000000-0000-0000-1000-000000000001',
  '56000000-0000-0000-1000-000000000002'
);

insert into auth.users (id, aud, role, email, email_confirmed_at, created_at, updated_at)
values
  ('56000000-0000-0000-2000-000000000001', 'authenticated', 'authenticated', 'PREF-056-A1@Example.invalid', now(), now(), now()),
  ('56000000-0000-0000-2000-000000000002', 'authenticated', 'authenticated', 'pref-056-a2-unconfirmed@example.invalid', null, now(), now()),
  ('56000000-0000-0000-2000-000000000003', 'authenticated', 'authenticated', 'pref-056-a3-removed@example.invalid', now(), now(), now()),
  ('56000000-0000-0000-2000-000000000004', 'authenticated', 'authenticated', 'pref-056-nonadmin@example.invalid', now(), now(), now()),
  ('56000000-0000-0000-2000-000000000005', 'authenticated', 'authenticated', 'pref-056-platformadmin@example.invalid', now(), now(), now()),
  ('56000000-0000-0000-2000-000000000006', 'authenticated', 'authenticated', 'pref-056-b1@example.invalid', now(), now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-2000-000000000001', 'veterinarian'),
  ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-2000-000000000002', 'receptionist'),
  ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-2000-000000000003', 'receptionist'),
  ('56000000-0000-0000-1000-000000000002', '56000000-0000-0000-2000-000000000006', 'admin');

set local role service_role;
select result from public.set_platform_admin_v1('56000000-0000-0000-2000-000000000005', true);
reset role;

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('56000000-0000-0000-3000-000000000001', '56000000-0000-0000-1000-000000000001', 'Pref Owner 1', '+15556000001'),
  ('56000000-0000-0000-3000-000000000002', '56000000-0000-0000-1000-000000000001', 'Pref Owner 2', '+15556000002'),
  ('56000000-0000-0000-3000-000000000003', '56000000-0000-0000-1000-000000000001', 'Pref Owner 3', '+15556000003'),
  ('56000000-0000-0000-3000-000000000004', '56000000-0000-0000-1000-000000000001', 'Pref Owner 4', '+15556000004'),
  ('56000000-0000-0000-3000-000000000005', '56000000-0000-0000-1000-000000000001', 'Pref Owner 5', '+15556000005');

insert into public.conversations (id, clinic_id, owner_id, status)
values
  ('56000000-0000-0000-4000-000000000001', '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-3000-000000000001', 'handoff'),
  ('56000000-0000-0000-4000-000000000002', '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-3000-000000000002', 'handoff'),
  ('56000000-0000-0000-4000-000000000003', '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-3000-000000000003', 'handoff'),
  ('56000000-0000-0000-4000-000000000004', '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-3000-000000000004', 'handoff'),
  ('56000000-0000-0000-4000-000000000005', '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-3000-000000000005', 'handoff');

-- =========================================================================
-- 1. Function metadata: SECURITY DEFINER, correct volatility, empty
-- search_path, and grants restricted to exactly the intended role for
-- every new/recreated function.
-- =========================================================================

do $$
declare
  v_fn record;
  v_proc record;
  v_role text;
  v_has_grant boolean;
begin
  for v_fn in
    select * from (values
      ('public.get_my_clinic_alert_preferences()', 's', true, 'authenticated'),
      ('public.set_my_clinic_alert_preference(uuid, boolean)', 'v', true, 'authenticated'),
      ('public.get_platform_clinic_alert_gates()', 's', true, 'authenticated'),
      ('public.set_platform_clinic_alert_gate(uuid, boolean)', 'v', true, 'authenticated'),
      ('public.sync_alert_delivery_candidates()', 'v', false, 'service_role'),
      ('public.claim_alert_delivery()', 'v', false, 'service_role'),
      ('public.schedule_alert_repeat_notifications()', 'v', false, 'service_role')
    ) as t(fn_name, expected_volatility, expected_definer, expected_grantee)
  loop
    select p.prosecdef, p.provolatile, p.proconfig
      into v_proc
      from pg_catalog.pg_proc p
      where p.oid = v_fn.fn_name::regprocedure;

    if v_proc.prosecdef is distinct from v_fn.expected_definer then
      raise exception '% has unexpected SECURITY DEFINER state %', v_fn.fn_name, v_proc.prosecdef;
    end if;
    if v_proc.provolatile <> v_fn.expected_volatility then
      raise exception '% has unexpected volatility %', v_fn.fn_name, v_proc.provolatile;
    end if;
    if v_proc.proconfig is null or not (
      v_proc.proconfig @> array['search_path=']
      or v_proc.proconfig @> array['search_path=""']
    ) then
      raise exception '% is missing an empty search_path', v_fn.fn_name;
    end if;

    foreach v_role in array array['PUBLIC', 'anon', 'authenticated', 'service_role'] loop
      select exists (
        select 1 from information_schema.routine_privileges rp
        where rp.routine_schema = split_part(v_fn.fn_name, '.', 1)
          and rp.routine_name = regexp_replace(split_part(v_fn.fn_name, '.', 2), '\(.*', '')
          and rp.privilege_type = 'EXECUTE'
          and rp.grantee = v_role
      ) into v_has_grant;
      if v_has_grant is distinct from (v_role = v_fn.expected_grantee) then
        raise exception '% has unexpected EXECUTE grant state for %', v_fn.fn_name, v_role;
      end if;
    end loop;
  end loop;
end;
$$;

do $$
begin
  -- sync/claim/repeat-schedule must reference the new clinic gate in their
  -- clinic-scope predicates; recreation must not have silently dropped it.
  if pg_catalog.pg_get_functiondef('public.sync_alert_delivery_candidates()'::regprocedure)
       not like '%clinic_alert_settings%' then
    raise exception 'sync_alert_delivery_candidates no longer checks the clinic gate';
  end if;
  if pg_catalog.pg_get_functiondef('public.claim_alert_delivery()'::regprocedure)
       not like '%clinic_alert_settings%' then
    raise exception 'claim_alert_delivery no longer checks the clinic gate';
  end if;
  if pg_catalog.pg_get_functiondef('public.schedule_alert_repeat_notifications()'::regprocedure)
       not like '%clinic_alert_settings%' then
    raise exception 'schedule_alert_repeat_notifications no longer checks the clinic gate';
  end if;
  if pg_catalog.pg_get_functiondef('public.claim_alert_delivery()'::regprocedure)
       not like '%d.created_at >= r.enabled_at%' then
    raise exception 'claim_alert_delivery no longer checks the recipient activation epoch';
  end if;
  if pg_catalog.pg_get_functiondef('public.set_my_clinic_alert_preference(uuid, boolean)'::regprocedure)
       not like '%for no key update of cs%' then
    raise exception 'self-service mutation no longer serializes concurrent toggles on the membership row';
  end if;
  if position('for key share of c' in pg_catalog.pg_get_functiondef(
       'public.set_my_clinic_alert_preference(uuid, boolean)'::regprocedure)) = 0
     or position('for key share of c' in pg_catalog.pg_get_functiondef(
       'public.set_my_clinic_alert_preference(uuid, boolean)'::regprocedure)) >=
        position('for no key update of cs' in pg_catalog.pg_get_functiondef(
       'public.set_my_clinic_alert_preference(uuid, boolean)'::regprocedure)) then
    raise exception 'self-service mutation no longer locks clinic before membership';
  end if;
  -- Platform fanout/branches must be untouched byte-for-byte.
  if pg_catalog.pg_get_functiondef('public.sync_alert_delivery_candidates()'::regprocedure)
       not like '%cross join public.platform_alert_recipients r%where r.enabled%' then
    raise exception 'sync_alert_delivery_candidates platform fanout was unexpectedly changed';
  end if;
  if pg_catalog.pg_get_functiondef('public.claim_alert_delivery()'::regprocedure)
       not like '%recipient_scope = ''platform'' and exists (%select 1 from public.platform_alert_recipients r%'
  then
    raise exception 'claim_alert_delivery platform branch was unexpectedly changed';
  end if;
end;
$$;

-- Direct table access to both new tables remains closed to browser roles.
do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name in ('clinic_alert_settings', 'clinic_alert_gate_audit')
      and grantee in ('PUBLIC', 'anon', 'authenticated')
  ) then
    raise exception 'clinic_alert_settings/clinic_alert_gate_audit unexpectedly grant a browser role direct access';
  end if;
  if (
    select count(*) from pg_catalog.pg_policies
    where schemaname = 'public' and tablename in ('clinic_alert_settings', 'clinic_alert_gate_audit')
  ) <> 0 then
    raise exception 'clinic_alert_settings/clinic_alert_gate_audit unexpectedly define an RLS policy';
  end if;
  if (
    select count(*) from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('clinic_alert_settings', 'clinic_alert_gate_audit')
      and c.relrowsecurity
  ) <> 2 then
    raise exception 'both clinic alert tables must keep RLS enabled';
  end if;
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'clinic_alert_gate_audit' and grantee = 'service_role'
  ) then
    raise exception 'clinic_alert_gate_audit unexpectedly grants service_role -- only the owning SECURITY DEFINER function should ever write to it';
  end if;
end;
$$;

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'clinic_alert_recipients'
      and column_name = 'enabled_at' and is_nullable = 'YES'
  ) then
    raise exception 'clinic_alert_recipients.enabled_at is missing or unexpectedly NOT NULL';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_trigger t
    where t.tgrelid = 'public.clinic_alert_recipients'::regclass
      and t.tgname = 'set_clinic_alert_recipient_enabled_at'
      and not t.tgisinternal
  ) then
    raise exception 'recipient activation-epoch trigger is missing';
  end if;
end;
$$;

-- No RPC accepts a target user id, e-mail, actor, or free-form reason from
-- the browser: structural proof via each function's exact parameter list.
do $$
begin
  if pg_catalog.pg_get_function_identity_arguments('public.set_my_clinic_alert_preference(uuid, boolean)'::regprocedure)
       <> 'p_clinic_id uuid, p_enabled boolean' then
    raise exception 'set_my_clinic_alert_preference must accept only clinic id and desired boolean';
  end if;
  if pg_catalog.pg_get_function_identity_arguments('public.set_platform_clinic_alert_gate(uuid, boolean)'::regprocedure)
       <> 'p_clinic_id uuid, p_enabled boolean' then
    raise exception 'set_platform_clinic_alert_gate must accept only clinic id and desired boolean';
  end if;
  if pg_catalog.pg_get_function_result('public.get_my_clinic_alert_preferences()'::regprocedure) ilike '%email%' then
    raise exception 'get_my_clinic_alert_preferences must never return an e-mail column';
  end if;
  if pg_catalog.pg_get_function_result('public.get_platform_clinic_alert_gates()'::regprocedure) <> 'TABLE(clinic_id uuid, enabled boolean)' then
    raise exception 'get_platform_clinic_alert_gates must return only clinic id and gate state';
  end if;
end;
$$;

-- =========================================================================
-- 2. Migration applies with the gate defaulting off: no clinic_alert_settings
-- row exists yet, and both read RPCs report the gate as disabled.
-- =========================================================================

do $$
declare
  v_row record;
begin
  if exists (select 1 from public.clinic_alert_settings) then
    raise exception 'clinic_alert_settings must start empty -- applying the migration must not enable any clinic';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select * into v_row from public.get_my_clinic_alert_preferences()
    where clinic_id = '56000000-0000-0000-1000-000000000001';
  reset role;

  if v_row.clinic_gate_enabled or v_row.my_preference_enabled or v_row.effective_enabled then
    raise exception 'a brand-new clinic must read as gate-off, no personal preference, effective off';
  end if;
end;
$$;

do $$
declare
  v_row record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  select * into v_row from public.get_platform_clinic_alert_gates()
    where clinic_id = '56000000-0000-0000-1000-000000000001';
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if v_row.enabled then
    raise exception 'a brand-new clinic must read as gate-off from the platform read RPC too';
  end if;
end;
$$;

-- =========================================================================
-- 3. Staff self-service preference: confirmed-e-mail requirement,
-- idempotent no-ops, audit-only-on-change, and tenant isolation.
-- =========================================================================

do $$
declare
  v_result text;
begin
  -- A2's e-mail is unconfirmed: enabling must fail closed and store nothing.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000002', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;

  if v_result <> 'email_unconfirmed' then
    raise exception 'expected email_unconfirmed for an unconfirmed Auth e-mail, got %', v_result;
  end if;
  if exists (
    select 1 from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000002'
  ) then
    raise exception 'email_unconfirmed must not materialize a recipient row';
  end if;
end;
$$;

do $$
declare
  v_result text;
  v_audit_count integer;
begin
  -- A1 disabling a subscription that never existed is an idempotent no-op:
  -- no row, no audit entry, no e-mail ever resolved.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', false);
  reset role;

  if v_result <> 'already_disabled' then
    raise exception 'expected already_disabled for a missing self-subscription, got %', v_result;
  end if;
  if exists (
    select 1 from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000001'
  ) then
    raise exception 'disabling a missing self-subscription must not store a row merely to represent false';
  end if;

  select count(*) into v_audit_count from public.alert_recipient_audit
    where recipient_scope = 'clinic' and clinic_id = '56000000-0000-0000-1000-000000000001'
      and recipient_user_id = '56000000-0000-0000-2000-000000000001';
  if v_audit_count <> 0 then
    raise exception 'an idempotent no-op must not write an audit row';
  end if;
end;
$$;

do $$
declare
  v_result text;
  v_email text;
  v_enabled_at timestamptz;
  v_enabled_at_2 timestamptz;
  v_audit_count integer;
begin
  -- A1 enables: row created with the authoritative, lowercased/trimmed Auth
  -- e-mail (never a browser-supplied one -- the RPC has no e-mail parameter
  -- at all, already proven structurally above), one audit row, actor = self.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;

  if v_result <> 'enabled' then
    raise exception 'expected enabled for a first-time confirmed-e-mail subscription, got %', v_result;
  end if;

  select email, enabled_at into v_email, v_enabled_at from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000001';
  if v_email <> 'pref-056-a1@example.invalid' then
    raise exception 'expected the lowercased/trimmed confirmed Auth e-mail, got %', v_email;
  end if;

  select count(*) into v_audit_count from public.alert_recipient_audit
    where recipient_scope = 'clinic' and clinic_id = '56000000-0000-0000-1000-000000000001'
      and recipient_user_id = '56000000-0000-0000-2000-000000000001' and action = 'created'
      and actor_user_id = '56000000-0000-0000-2000-000000000001';
  if v_audit_count <> 1 then
    raise exception 'expected exactly one created audit row with the caller as actor, got %', v_audit_count;
  end if;

  -- Re-affirming the same state is idempotent: no audit row, no enabled_at
  -- bump (the activation epoch only moves on a genuine transition).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;

  if v_result <> 'already_enabled' then
    raise exception 'expected already_enabled on a redundant enable, got %', v_result;
  end if;

  select enabled_at into v_enabled_at_2 from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000001';
  if v_enabled_at_2 <> v_enabled_at then
    raise exception 'an idempotent re-enable must not bump the activation epoch';
  end if;

  select count(*) into v_audit_count from public.alert_recipient_audit
    where recipient_scope = 'clinic' and clinic_id = '56000000-0000-0000-1000-000000000001'
      and recipient_user_id = '56000000-0000-0000-2000-000000000001';
  if v_audit_count <> 1 then
    raise exception 'an idempotent re-enable must not write a second audit row, count=%', v_audit_count;
  end if;
end;
$$;

do $$
declare
  v_result text;
begin
  -- Tenant isolation: A1 cannot manage a preference under clinic B.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000002', true);
  reset role;
  if v_result <> 'forbidden' then
    raise exception 'expected forbidden for a non-member clinic id, got %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result text;
begin
  -- A3 enables, then loses membership: the composite FK cascade removes the
  -- recipient row, and a removed member immediately loses access.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000003', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;
  if v_result <> 'enabled' then
    raise exception 'expected A3 to enable successfully before membership removal, got %', v_result;
  end if;

  delete from public.clinic_staff
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000003';

  if exists (
    select 1 from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000003'
  ) then
    raise exception 'removing clinic_staff must cascade-delete the recipient row (existing composite cascade)';
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000003', true);
  select result into v_result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;
  if v_result <> 'forbidden' then
    raise exception 'a removed member must immediately lose access, got %', v_result;
  end if;
end;
$$;

-- =========================================================================
-- 4. Platform gate: exact platform_admins + aal2, idempotency, not_found,
-- and the read RPC's minimized column set.
-- =========================================================================

do $$
declare
  v_result text;
  v_row record;
  v_found boolean;
begin
  -- Non-admin authenticated caller: forbidden, and the read RPC reports
  -- nothing (fails closed, no clinic list leaked).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000004', true);
  select result into v_result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  select exists (select 1 from public.get_platform_clinic_alert_gates()) into v_found;
  reset role;

  if v_result <> 'forbidden' then
    raise exception 'expected forbidden for a non-admin caller, got %', v_result;
  end if;
  if v_found then
    raise exception 'a non-admin caller must see no clinic gate rows at all';
  end if;
end;
$$;

do $$
declare
  v_result text;
begin
  -- Platform admin without aal2 (no aal claim at all): forbidden.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005')::text, true);
  select result into v_result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if v_result <> 'forbidden' then
    raise exception 'expected forbidden for a platform admin without aal2, got %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result text;
begin
  -- Unknown clinic id: not_found, even for a fully authorized caller.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  select result into v_result from public.set_platform_clinic_alert_gate('56000000-0000-0000-9000-000000000099', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown clinic id, got %', v_result;
  end if;
end;
$$;

do $$
declare
  v_result text;
  v_updated_at timestamptz;
  v_updated_at_2 timestamptz;
  v_audit_count integer;
  v_row record;
begin
  -- aal2 + platform_admins: enable clinic A, one gate-audit row, actor is
  -- the caller (never client-supplied).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  select result into v_result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if v_result <> 'enabled' then
    raise exception 'expected enabled for a fresh aal2 admin gate toggle, got %', v_result;
  end if;

  select count(*) into v_audit_count from public.clinic_alert_gate_audit
    where clinic_id = '56000000-0000-0000-1000-000000000001' and enabled = true
      and actor_user_id = '56000000-0000-0000-2000-000000000005';
  if v_audit_count <> 1 then
    raise exception 'expected exactly one gate-audit row with the admin as actor, got %', v_audit_count;
  end if;

  select updated_at into v_updated_at from public.clinic_alert_settings
    where clinic_id = '56000000-0000-0000-1000-000000000001';

  -- Idempotent re-enable: no new audit row, epoch unchanged.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  select result into v_result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  if v_result <> 'already_enabled' then
    raise exception 'expected already_enabled on a redundant admin gate toggle, got %', v_result;
  end if;

  select updated_at into v_updated_at_2 from public.clinic_alert_settings
    where clinic_id = '56000000-0000-0000-1000-000000000001';
  if v_updated_at_2 <> v_updated_at then
    raise exception 'an idempotent gate re-enable must not bump the activation epoch';
  end if;

  select count(*) into v_audit_count from public.clinic_alert_gate_audit
    where clinic_id = '56000000-0000-0000-1000-000000000001';
  if v_audit_count <> 1 then
    raise exception 'an idempotent gate re-enable must not write a second audit row, count=%', v_audit_count;
  end if;

  -- Read RPC: clinic A on, clinic B off, no clinic name / e-mail / recipient
  -- count columns exist to expose (already proven structurally above).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  select * into v_row from public.get_platform_clinic_alert_gates() where clinic_id = '56000000-0000-0000-1000-000000000001';
  if not v_row.enabled then
    raise exception 'expected clinic A to read as enabled from the platform read RPC';
  end if;
  select * into v_row from public.get_platform_clinic_alert_gates() where clinic_id = '56000000-0000-0000-1000-000000000002';
  reset role;
  if v_row.enabled then
    raise exception 'expected clinic B to still read as disabled from the platform read RPC';
  end if;
end;
$$;

-- =========================================================================
-- 5. Two independent controls: effective delivery requires BOTH the
-- clinic-wide gate and the personal preference on; either one off is
-- enough to keep the effective state off.
-- =========================================================================

do $$
declare
  v_row record;
begin
  -- At this point: clinic A gate = on (section 4), A1 personal pref = on
  -- (section 3). Effective must read true.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select * into v_row from public.get_my_clinic_alert_preferences() where clinic_id = '56000000-0000-0000-1000-000000000001';
  reset role;
  if not (v_row.clinic_gate_enabled and v_row.my_preference_enabled and v_row.effective_enabled) then
    raise exception 'expected gate on, personal pref on, effective on -- got gate=%, pref=%, effective=%',
      v_row.clinic_gate_enabled, v_row.my_preference_enabled, v_row.effective_enabled;
  end if;

  -- Platform admin turns the clinic gate off: effective must drop to false
  -- even though A1's own preference is untouched and still reads on.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', false);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  select * into v_row from public.get_my_clinic_alert_preferences() where clinic_id = '56000000-0000-0000-1000-000000000001';
  reset role;
  if v_row.clinic_gate_enabled or not v_row.my_preference_enabled or v_row.effective_enabled then
    raise exception 'expected gate off, personal pref still on, effective off -- got gate=%, pref=%, effective=%',
      v_row.clinic_gate_enabled, v_row.my_preference_enabled, v_row.effective_enabled;
  end if;
end;
$$;

-- =========================================================================
-- 6. Stale-delivery / activation-epoch proof. This is the core "re-enabling
-- a gate never resends old stale deliveries" scenario.
-- =========================================================================

do $$
declare
  v_result text;
  v_wi1 uuid;
  v_delivery1_id uuid;
  v_delivery1_created timestamptz;
  v_gate_updated_at timestamptz;
  v_claimed record;
  v_wi2 uuid;
begin
  -- Clinic gate is currently off (section 5), A1's personal pref is on.
  -- Re-enable the gate so a candidate can be created and claimed once.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-4000-000000000001', 'human_handoff', 'urgent', 'emergency_handoff', 'open')
  returning id into v_wi1;

  set local role service_role;
  perform inserted_count from public.sync_alert_delivery_candidates();
  reset role;

  select id, created_at into v_delivery1_id, v_delivery1_created
    from public.alert_deliveries
    where work_item_id = v_wi1 and recipient_scope = 'clinic' and recipient_user_id = '56000000-0000-0000-2000-000000000001';
  if v_delivery1_id is null then
    raise exception 'expected a clinic-scope candidate delivery for the urgent handoff while the gate is on';
  end if;

  -- PostgreSQL now() is fixed for this entire rollback-only transaction.
  -- Backdate the candidate to model a delivery created before the later
  -- disable/re-enable calls, which are separate transactions in production.
  update public.alert_deliveries
    set created_at = pg_catalog.now() - interval '1 second'
    where id = v_delivery1_id;
  select created_at into v_delivery1_created
    from public.alert_deliveries where id = v_delivery1_id;

  -- Disable the gate: the pending candidate must not be claimable.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', false);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role service_role;
  select * into v_claimed from public.claim_alert_delivery() where id = v_delivery1_id;
  reset role;
  if found then
    raise exception 'a pending delivery must not be claimable while the clinic gate is off';
  end if;

  -- Re-enable the gate: this delivery predates the re-enable epoch and must
  -- stay permanently stale (acceptance criterion 6: pre-toggle in-flight
  -- sends are irreversible).
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  select updated_at into v_gate_updated_at from public.clinic_alert_settings where clinic_id = '56000000-0000-0000-1000-000000000001';
  if v_gate_updated_at <= v_delivery1_created then
    raise exception 'test setup error: the re-enable epoch must be after the stale delivery''s created_at';
  end if;

  set local role service_role;
  select * into v_claimed from public.claim_alert_delivery() where id = v_delivery1_id;
  reset role;
  if found then
    raise exception 'a pre-toggle delivery must remain permanently unclaimable after a disable/re-enable cycle';
  end if;

  if (select delivery_status from public.alert_deliveries where id = v_delivery1_id) <> 'pending' then
    raise exception 'the stale delivery must remain pending, never silently marked failed or claimed';
  end if;

  -- A brand-new work item created after the re-enable must still produce a
  -- fresh, claimable candidate.
  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-4000-000000000002', 'human_handoff', 'urgent', 'emergency_handoff', 'open')
  returning id into v_wi2;

  set local role service_role;
  perform inserted_count from public.sync_alert_delivery_candidates();
  select * into v_claimed from public.claim_alert_delivery()
    where work_item_id = v_wi2 and recipient_user_id = '56000000-0000-0000-2000-000000000001';
  reset role;
  if not found then
    raise exception 'a new post-enable work item must still produce a claimable candidate';
  end if;

  perform set_config('vetai.task056.post_reenable_delivery_id', v_claimed.id::text, false);
end;
$$;

do $$
declare
  v_result text;
  v_wi3 uuid;
  v_delivery_id uuid;
  v_delivery_created timestamptz;
  v_recipient_enabled_at timestamptz;
  v_claimed record;
begin
  -- Same proof, but for the personal-preference epoch instead of the
  -- clinic gate: gate stays on throughout.
  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-4000-000000000003', 'human_handoff', 'urgent', 'emergency_handoff', 'open')
  returning id into v_wi3;

  set local role service_role;
  perform inserted_count from public.sync_alert_delivery_candidates();
  reset role;

  select id, created_at into v_delivery_id, v_delivery_created
    from public.alert_deliveries
    where work_item_id = v_wi3 and recipient_scope = 'clinic' and recipient_user_id = '56000000-0000-0000-2000-000000000001';
  if v_delivery_id is null then
    raise exception 'expected a clinic-scope candidate delivery for the third urgent handoff';
  end if;


  -- Model the pre-toggle ordering explicitly; now() does not advance inside
  -- this fixture's single transaction.
  update public.alert_deliveries
    set created_at = pg_catalog.now() - interval '1 second'
    where id = v_delivery_id;
  select created_at into v_delivery_created
    from public.alert_deliveries where id = v_delivery_id;

  -- A1 disables, then re-enables their own preference.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '56000000-0000-0000-2000-000000000001', true);
  perform result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', false);
  perform result from public.set_my_clinic_alert_preference('56000000-0000-0000-1000-000000000001', true);
  reset role;

  select enabled_at into v_recipient_enabled_at from public.clinic_alert_recipients
    where clinic_id = '56000000-0000-0000-1000-000000000001' and user_id = '56000000-0000-0000-2000-000000000001';
  if v_recipient_enabled_at <= v_delivery_created then
    raise exception 'test setup error: the recipient re-enable epoch must be after the delivery''s created_at';
  end if;

  set local role service_role;
  select * into v_claimed from public.claim_alert_delivery() where id = v_delivery_id;
  reset role;
  if found then
    raise exception 'a delivery predating a personal-preference disable/re-enable cycle must remain unclaimable';
  end if;
end;
$$;

-- =========================================================================
-- 7. Repeat-scheduling epoch: an accepted delivery's repeat cadence is
-- suppressed while the gate is off and does not resume for that specific
-- series even after re-enabling (the series' own created_at still predates
-- the new epoch) -- documented as the same irreversibility as section 6,
-- applied to repeats. A repeat row created fresh after the re-enable is
-- unaffected and schedules normally.
-- =========================================================================

do $$
declare
  v_delivery_id uuid;
  v_reopened integer;
  v_repeat_exists boolean;
  v_next_repeat_at timestamptz;
begin
  v_delivery_id := (select current_setting('vetai.task056.post_reenable_delivery_id', true))::uuid;

  update public.alert_deliveries
    set delivery_status = 'accepted',
        delivery_claim_token = null,
        delivery_lease_until = null,
        accepted_at = now(),
        next_repeat_at = now() - interval '1 second',
        created_at = now() - interval '1 second'
    where id = v_delivery_id;

  -- Disable the gate before the repeat is processed.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', false);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role service_role;
  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  reset role;
  if v_reopened <> 0 then
    raise exception 'expected 0 repeats scheduled while the clinic gate is off, got %', v_reopened;
  end if;
  if exists (select 1 from public.alert_deliveries where dedup_key like '%:repeat:1') then
    raise exception 'no repeat row may be created while the clinic gate is off';
  end if;

  -- Re-enable: this series' original row predates the new epoch, so per the
  -- same irreversibility rule as section 6, it stays suppressed even now.
  -- Known, deliberate limitation -- see delivery record for the product
  -- tradeoff this implies for a long-open ticket.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate('56000000-0000-0000-1000-000000000001', true);
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role service_role;
  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  reset role;
  if v_reopened <> 0 then
    raise exception 'expected a pre-disable repeat series to stay suppressed after re-enabling, got %', v_reopened;
  end if;

  -- Contrast: a delivery accepted fresh (after the current epoch) still
  -- gets a normal repeat.
  update public.alert_deliveries
    set delivery_status = 'accepted', accepted_at = now(), created_at = now(), next_repeat_at = now() - interval '1 second'
    where id = v_delivery_id;

  set local role service_role;
  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  reset role;
  if v_reopened <> 1 then
    raise exception 'expected exactly 1 repeat scheduled for a post-epoch accepted delivery, got %', v_reopened;
  end if;

  select exists (select 1 from public.alert_deliveries where dedup_key like '%:repeat:1') into v_repeat_exists;
  if not v_repeat_exists then
    raise exception 'expected a new :repeat:1 delivery row to have been created';
  end if;

  select next_repeat_at into v_next_repeat_at from public.alert_deliveries where id = v_delivery_id;
  if v_next_repeat_at is not null then
    raise exception 'the original row''s next_repeat_at must be cleared once its repeat is scheduled';
  end if;
end;
$$;

-- =========================================================================
-- 8. Platform alerting paths remain completely unaffected by the clinic
-- gate: a platform recipient still gets a claimable delivery for a
-- delivery_failure work item even while the clinic-scope gate is on/off.
-- =========================================================================

do $$
declare
  v_wi uuid;
  v_claimed record;
begin
  -- Turn the clinic gate off so this witness can only be emitted through the
  -- platform fanout branch.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate(
    '56000000-0000-0000-1000-000000000001', false
  );
  reset role;
  perform set_config('request.jwt.claims', '', true);

  set local role service_role;
  perform public.set_platform_alert_recipient(
    '56000000-0000-0000-2000-000000000005', 'pref-056-platform-recipient@example.invalid', true,
    '56000000-0000-0000-2000-000000000005', 'fixture setup'
  );
  reset role;

  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, provenance)
  values ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-4000-000000000004', 'human_handoff', 'normal', 'human_handoff', 'open', 'intake_dead_letter')
  returning id into v_wi;

  set local role service_role;
  perform inserted_count from public.sync_alert_delivery_candidates();
  select * into v_claimed from public.claim_alert_delivery()
    where work_item_id = v_wi and recipient_scope = 'platform' and recipient_user_id = '56000000-0000-0000-2000-000000000005';
  reset role;
  if not found then
    raise exception 'a platform-scope intake-dead-letter candidate must remain claimable regardless of any clinic gate';
  end if;

  -- Restore the gate for the following personal-epoch witness.
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '56000000-0000-0000-2000-000000000005', 'aal', 'aal2')::text, true);
  perform result from public.set_platform_clinic_alert_gate(
    '56000000-0000-0000-1000-000000000001', true
  );
  reset role;
  perform set_config('request.jwt.claims', '', true);
end;
$$;

-- =========================================================================
-- 9. The dedicated enabled_at epoch isolates eligibility from Task 053's
-- general updated_at bookkeeping. A service-role no-op can still refresh
-- updated_at, but must preserve enabled_at and must not suppress a pending
-- delivery.
-- =========================================================================

do $$
declare
  v_wi uuid;
  v_delivery_id uuid;
  v_updated_at timestamptz;
  v_updated_at_2 timestamptz;
  v_enabled_at timestamptz;
  v_enabled_at_2 timestamptz;
  v_claimed record;
  v_attempt integer;
begin
  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values ('56000000-0000-0000-1000-000000000001', '56000000-0000-0000-4000-000000000005', 'human_handoff', 'urgent', 'emergency_handoff', 'open')
  returning id into v_wi;

  set local role service_role;
  perform inserted_count from public.sync_alert_delivery_candidates();
  reset role;

  select id into v_delivery_id from public.alert_deliveries
    where work_item_id = v_wi and recipient_scope = 'clinic' and recipient_user_id = '56000000-0000-0000-2000-000000000001'
    order by created_at desc limit 1;

  select updated_at, enabled_at into v_updated_at, v_enabled_at
  from public.clinic_alert_recipients
  where clinic_id = '56000000-0000-0000-1000-000000000001'
    and user_id = '56000000-0000-0000-2000-000000000001';

  -- Admin re-supplies the exact same email/enabled state A1 already has --
  -- a true no-op from the admin's point of view.
  set local role service_role;
  perform public.set_clinic_alert_recipient(
    '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-2000-000000000001',
    'pref-056-a1@example.invalid', true,
    '56000000-0000-0000-2000-000000000005', 'fixture: verify enabled_at isolation'
  );
  select updated_at, enabled_at into v_updated_at_2, v_enabled_at_2
  from public.clinic_alert_recipients
  where clinic_id = '56000000-0000-0000-1000-000000000001'
    and user_id = '56000000-0000-0000-2000-000000000001';
  -- Earlier sections may have produced a separate eligible repeat. Drain a
  -- bounded number of unrelated candidates until this exact delivery is
  -- returned; filtering outside the set-returning function would be vacuous
  -- because claim_alert_delivery chooses before the outer WHERE runs.
  for v_attempt in 1..10 loop
    select * into v_claimed from public.claim_alert_delivery();
    exit when not found or v_claimed.id = v_delivery_id;
  end loop;
  reset role;

  if v_updated_at_2 < v_updated_at then
    raise exception 'recipient updated_at moved backwards unexpectedly';
  end if;
  if v_enabled_at_2 is distinct from v_enabled_at then
    raise exception 'an admin no-op must preserve the dedicated recipient activation epoch';
  end if;
  if v_claimed.id is distinct from v_delivery_id then
    raise exception 'an admin no-op must not make an otherwise eligible pending delivery unclaimable';
  end if;
end;
$$;

-- =========================================================================
-- 10. Fixture is tenant/fixed-ID scoped; rollback below leaves zero
-- residue. This block proves the fixture rows exist immediately before
-- the rollback that removes them.
-- =========================================================================

do $$
begin
  if not exists (select 1 from public.clinics where id in (
    '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-1000-000000000002'
  )) then
    raise exception 'fixture clinics unexpectedly missing before rollback';
  end if;
  if (select count(*) from public.clinic_alert_settings where clinic_id in (
    '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-1000-000000000002'
  )) = 0 then
    raise exception 'fixture clinic_alert_settings rows unexpectedly missing before rollback';
  end if;
end;
$$;

rollback;

do $$
begin
  if exists (select 1 from public.clinics where id in (
    '56000000-0000-0000-1000-000000000001', '56000000-0000-0000-1000-000000000002'
  )) then
    raise exception 'rollback failed to remove fixture clinics -- zero-residue guarantee violated';
  end if;
  if exists (select 1 from auth.users where id = '56000000-0000-0000-2000-000000000005') then
    raise exception 'rollback failed to remove the fixture platform admin -- zero-residue guarantee violated';
  end if;
  if exists (select 1 from auth.users where id::text like '56000000-0000-0000-2000-%')
     or exists (select 1 from public.clinic_staff where clinic_id::text like '56000000-0000-0000-1000-%')
     or exists (select 1 from public.owners where id::text like '56000000-0000-0000-3000-%')
     or exists (select 1 from public.conversations where id::text like '56000000-0000-0000-4000-%')
     or exists (select 1 from public.staff_work_items where conversation_id::text like '56000000-0000-0000-4000-%')
     or exists (select 1 from public.clinic_alert_settings where clinic_id::text like '56000000-0000-0000-1000-%')
     or exists (select 1 from public.clinic_alert_gate_audit where clinic_id::text like '56000000-0000-0000-1000-%')
     or exists (select 1 from public.clinic_alert_recipients where clinic_id::text like '56000000-0000-0000-1000-%')
     or exists (select 1 from public.alert_recipient_audit where clinic_id::text like '56000000-0000-0000-1000-%')
     or exists (select 1 from public.alert_deliveries where recipient_user_id::text like '56000000-0000-0000-2000-%') then
    raise exception 'rollback left Task 056 synthetic rows behind';
  end if;
end;
$$;
