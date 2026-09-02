-- Task 047: rollback-only proof for platform-admin clinic lifecycle
-- controls. Not run against any database by the implementer; Codex applies
-- this only on disposable vetai-test after review.
--
-- Every authenticated role block sets `request.jwt.claims` as one synthetic
-- JSON blob (never the per-key `request.jwt.claim.sub` GUC also used
-- elsewhere in this repo) so both auth.uid() and auth.jwt() resolve
-- `sub`/`aal` from the same real JWT-claim read the RPCs perform in
-- production.
--
-- Honest concurrency note: this fixture runs everything serially in one
-- session/transaction. It proves the single-session replay/mismatch/lock
-- logic (a lock taken and released within one transaction) but cannot prove
-- real overlapping advisory-lock contention across two concurrent database
-- sessions -- that needs a genuine two-session test outside this file.

begin;

-- =========================================================================
-- 0. Fixture Auth users and clinics.
-- =========================================================================

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('47000000-0000-0000-1000-000000000001', 'authenticated', 'authenticated', 'admin-047-admin@example.invalid', now(), now()),
  ('47000000-0000-0000-1000-000000000002', 'authenticated', 'authenticated', 'admin-047-other@example.invalid', now(), now()),
  ('47000000-0000-0000-1000-000000000003', 'authenticated', 'authenticated', 'admin-047-owner@example.invalid', now(), now());

do $$
declare
  v_result text;
begin
  set local role service_role;
  select result into v_result from public.set_platform_admin_v1('47000000-0000-0000-1000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected enabled, got %', v_result; end if;
  reset role;
end;
$$;

-- Clinic B: pre-existing active clinic, used for suspend/resume proofs.
insert into public.clinics (id, name, operational_status, suspended_at)
values ('47000000-0000-0000-2000-000000000002', 'Existing Active Clinic 047', 'active', null);

-- Clinic C: moved to 'offboarding' through the existing service-role-only
-- runbook function, used only to prove suspend/resume cannot reach or
-- escape offboarding through the new grant.
insert into public.clinics (id, name, operational_status, suspended_at)
values ('47000000-0000-0000-2000-000000000003', 'Offboarding Clinic 047', 'active', null);

do $$
declare
  v_result text;
begin
  set local role service_role;
  select result into v_result from public.prepare_clinic_offboarding_v1('47000000-0000-0000-2000-000000000003');
  if v_result <> 'prepared' then raise exception 'expected prepared, got %', v_result; end if;
  reset role;
end;
$$;

-- =========================================================================
-- 1. anon and service_role cannot execute any of the three new RPCs; only
-- authenticated holds the grant. No audit row exists yet.
-- =========================================================================

do $$
begin
  set local role anon;
  begin
    perform * from public.platform_provision_clinic_v1(
      '47000000-0000-0000-4000-000000000090', '47000000-0000-0000-2000-000000000099',
      'Anon Clinic', '47000000-0000-0000-1000-000000000003', 'admin',
      '47000000-0000-0000-3000-000000000099', '900000001', null
    );
    raise exception 'anon unexpectedly executed platform_provision_clinic_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.platform_suspend_clinic_v1('47000000-0000-0000-4000-000000000091', '47000000-0000-0000-2000-000000000002');
    raise exception 'anon unexpectedly executed platform_suspend_clinic_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.platform_resume_clinic_v1('47000000-0000-0000-4000-000000000092', '47000000-0000-0000-2000-000000000002');
    raise exception 'anon unexpectedly executed platform_resume_clinic_v1';
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
    perform * from public.platform_provision_clinic_v1(
      '47000000-0000-0000-4000-000000000093', '47000000-0000-0000-2000-000000000099',
      'Service Role Clinic', '47000000-0000-0000-1000-000000000003', 'admin',
      '47000000-0000-0000-3000-000000000098', '900000002', null
    );
    raise exception 'service_role unexpectedly executed platform_provision_clinic_v1';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform * from public.platform_suspend_clinic_v1('47000000-0000-0000-4000-000000000094', '47000000-0000-0000-2000-000000000002');
    raise exception 'service_role unexpectedly executed platform_suspend_clinic_v1';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

do $$
begin
  if exists (select 1 from public.platform_admin_clinic_action_events) then
    raise exception 'audit table has rows before any authorized call';
  end if;
end;
$$;

-- =========================================================================
-- 2. Non-member authenticated, member-at-aal1, and every missing/malformed
-- AAL/null-caller shape are forbidden and write no audit row -- proven
-- against the provision RPC, which exercises the shared authorization
-- helper identically to suspend/resume.
-- =========================================================================

do $$
declare
  v_claims text[] := array[
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000002', 'aal', 'aal2')::text, -- aal2 but not a member
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal1')::text,  -- member but aal1
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001')::text,                 -- missing aal key
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', null)::text,    -- explicit JSON null
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 2)::text,       -- number
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal3')::text,  -- unknown string
    jsonb_build_object('aal', 'aal2')::text,                                                 -- null caller (no sub)
    '{}'::text                                                                                -- both missing
  ];
  v_claim text;
  r record;
  v_row_count integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  foreach v_claim in array v_claims loop
    perform set_config('request.jwt.claims', v_claim, true);
    v_row_count := 0;
    for r in select * from public.platform_provision_clinic_v1(
      '47000000-0000-0000-4000-000000000001', '47000000-0000-0000-2000-000000000098',
      'Forbidden Clinic', '47000000-0000-0000-1000-000000000003', 'admin',
      '47000000-0000-0000-3000-000000000097', '900000003', null
    ) loop
      v_row_count := v_row_count + 1;
      if r.result is distinct from 'forbidden' then
        raise exception 'claim % expected forbidden, got %', v_claim, r.result;
      end if;
    end loop;
    if v_row_count <> 1 then
      raise exception 'claim % expected exactly one row, got %', v_claim, v_row_count;
    end if;
  end loop;
  reset role;
end;
$$;

do $$
begin
  if exists (select 1 from public.platform_admin_clinic_action_events) then
    raise exception 'a forbidden call unexpectedly wrote an audit row';
  end if;
  if exists (select 1 from public.clinics where id = '47000000-0000-0000-2000-000000000098') then
    raise exception 'a forbidden call unexpectedly provisioned a clinic';
  end if;
end;
$$;

-- =========================================================================
-- 3. aal2 + allowlisted admin can provision exactly one suspended clinic
-- with the exact first-staff and WhatsApp-account rows, contact phone and
-- public address null, no new Auth user, and one minimized audit row whose
-- fingerprint matches an independently recomputed SHA-256.
-- =========================================================================

do $$
declare
  v_auth_user_count_before integer;
  v_auth_user_count_after integer;
  v_result text;
  v_expected_fingerprint text;
begin
  select count(*) into v_auth_user_count_before from auth.users;

  v_expected_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.jsonb_build_object(
        'clinic_id', '47000000-0000-0000-2000-000000000001'::uuid,
        'clinic_name', 'Provisioned Clinic 047',
        'owner_user_id', '47000000-0000-0000-1000-000000000003'::uuid,
        'staff_role', 'admin',
        'whatsapp_account_id', '47000000-0000-0000-3000-000000000001'::uuid,
        'phone_number_id', '918000101',
        'display_name', null::text
      )::text::bytea
    ),
    'hex'
  );

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  select result into v_result from public.platform_provision_clinic_v1(
    '47000000-0000-0000-4000-000000000010', '47000000-0000-0000-2000-000000000001',
    'Provisioned Clinic 047', '47000000-0000-0000-1000-000000000003', 'admin',
    '47000000-0000-0000-3000-000000000001', '918000101', null
  );
  if v_result <> 'provisioned' then raise exception 'expected provisioned, got %', v_result; end if;

  reset role;

  select count(*) into v_auth_user_count_after from auth.users;
  if v_auth_user_count_after <> v_auth_user_count_before then
    raise exception 'provisioning changed the auth.users row count';
  end if;

  if not exists (
    select 1 from public.clinics c
     where c.id = '47000000-0000-0000-2000-000000000001'
       and c.name = 'Provisioned Clinic 047'
       and c.operational_status = 'suspended'
       and c.suspended_at is not null
       and c.contact_phone_e164 is null
       and c.public_address is null
  ) then
    raise exception 'provisioned clinic row does not match the expected suspended shape';
  end if;

  if not exists (
    select 1 from public.clinic_staff cs
     where cs.clinic_id = '47000000-0000-0000-2000-000000000001'
       and cs.user_id = '47000000-0000-0000-1000-000000000003'
       and cs.role = 'admin'
  ) then
    raise exception 'expected first-staff row missing';
  end if;

  if not exists (
    select 1 from public.whatsapp_accounts wa
     where wa.id = '47000000-0000-0000-3000-000000000001'
       and wa.clinic_id = '47000000-0000-0000-2000-000000000001'
       and wa.phone_number_id = '918000101'
       and wa.display_name is null
  ) then
    raise exception 'expected WhatsApp-account row missing';
  end if;

  if (select count(*) from public.platform_admin_clinic_action_events) <> 1 then
    raise exception 'expected exactly one audit row after the first provision, got %',
      (select count(*) from public.platform_admin_clinic_action_events);
  end if;

  if not exists (
    select 1 from public.platform_admin_clinic_action_events e
     where e.request_id = '47000000-0000-0000-4000-000000000010'
       and e.actor_user_id = '47000000-0000-0000-1000-000000000001'
       and e.clinic_id = '47000000-0000-0000-2000-000000000001'
       and e.action = 'provision'
       and e.result = 'provisioned'
       and e.input_fingerprint = v_expected_fingerprint
       and e.created_at is not null
  ) then
    raise exception 'audit row does not match the expected minimized shape/fingerprint';
  end if;
end;
$$;

-- =========================================================================
-- 4. Exact request replay returns the original result and creates no
-- second audit row; a mismatched replay of the same request_id raises and
-- performs no additional mutation.
-- =========================================================================

do $$
declare
  v_result text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  select result into v_result from public.platform_provision_clinic_v1(
    '47000000-0000-0000-4000-000000000010', '47000000-0000-0000-2000-000000000001',
    'Provisioned Clinic 047', '47000000-0000-0000-1000-000000000003', 'admin',
    '47000000-0000-0000-3000-000000000001', '918000101', null
  );
  if v_result <> 'provisioned' then raise exception 'exact replay expected provisioned, got %', v_result; end if;

  reset role;

  if (select count(*) from public.platform_admin_clinic_action_events) <> 1 then
    raise exception 'exact replay unexpectedly wrote a second audit row';
  end if;
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  begin
    perform * from public.platform_provision_clinic_v1(
      '47000000-0000-0000-4000-000000000010', '47000000-0000-0000-2000-000000000001',
      'Different Clinic Name', '47000000-0000-0000-1000-000000000003', 'admin',
      '47000000-0000-0000-3000-000000000001', '918000101', null
    );
    raise exception 'mismatched replay unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like 'platform_admin_check_replay_v1:%' then raise; end if;
  end;

  reset role;

  if (select count(*) from public.platform_admin_clinic_action_events) <> 1 then
    raise exception 'mismatched replay unexpectedly mutated the audit table';
  end if;
end;
$$;

-- =========================================================================
-- 5. Suspend preserves Task 041's closed results and tenant targeting:
-- suspend an active clinic, replay it, suspend an already-suspended clinic,
-- suspend a nonexistent clinic, and confirm suspend cannot be used to touch
-- the offboarding clinic (it raises, exactly like the underlying Task 041
-- function, and writes no audit row).
-- =========================================================================

do $$
declare
  v_result text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  select result into v_result from public.platform_suspend_clinic_v1(
    '47000000-0000-0000-4000-000000000020', '47000000-0000-0000-2000-000000000002'
  );
  if v_result <> 'suspended' then raise exception 'expected suspended, got %', v_result; end if;

  -- exact replay
  select result into v_result from public.platform_suspend_clinic_v1(
    '47000000-0000-0000-4000-000000000020', '47000000-0000-0000-2000-000000000002'
  );
  if v_result <> 'suspended' then raise exception 'suspend replay expected suspended, got %', v_result; end if;

  -- fresh request against an already-suspended clinic
  select result into v_result from public.platform_suspend_clinic_v1(
    '47000000-0000-0000-4000-000000000021', '47000000-0000-0000-2000-000000000002'
  );
  if v_result <> 'already_suspended' then raise exception 'expected already_suspended, got %', v_result; end if;

  -- nonexistent clinic
  select result into v_result from public.platform_suspend_clinic_v1(
    '47000000-0000-0000-4000-000000000022', '47000000-0000-0000-2000-000000000999'
  );
  if v_result <> 'not_found' then raise exception 'expected not_found, got %', v_result; end if;

  reset role;

  if (select count(*) from public.platform_admin_clinic_action_events where action = 'suspend') <> 3 then
    raise exception 'expected exactly three suspend audit rows (suspended, already_suspended, not_found), got %',
      (select count(*) from public.platform_admin_clinic_action_events where action = 'suspend');
  end if;
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  begin
    perform * from public.platform_suspend_clinic_v1(
      '47000000-0000-0000-4000-000000000023', '47000000-0000-0000-2000-000000000003'
    );
    raise exception 'suspend of an offboarding clinic unexpectedly succeeded';
  exception
    when others then
      if sqlerrm not like 'suspend_clinic_v1:%' then raise; end if;
  end;

  reset role;

  if exists (
    select 1 from public.platform_admin_clinic_action_events
     where request_id = '47000000-0000-0000-4000-000000000023'
  ) then
    raise exception 'suspend of an offboarding clinic unexpectedly wrote an audit row';
  end if;
  if not exists (
    select 1 from public.clinics where id = '47000000-0000-0000-2000-000000000003' and operational_status = 'offboarding'
  ) then
    raise exception 'offboarding clinic was unexpectedly mutated by a failed suspend attempt';
  end if;
end;
$$;

-- =========================================================================
-- 6. Resume preserves Task 041's closed results and tenant targeting:
-- resume the now-suspended clinic, resume an already-active clinic, resume
-- a nonexistent clinic, and confirm resume on the offboarding clinic
-- returns the ordinary refused_offboarding result without mutating it.
-- =========================================================================

do $$
declare
  v_result text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  select result into v_result from public.platform_resume_clinic_v1(
    '47000000-0000-0000-4000-000000000030', '47000000-0000-0000-2000-000000000002'
  );
  if v_result <> 'resumed' then raise exception 'expected resumed, got %', v_result; end if;

  select result into v_result from public.platform_resume_clinic_v1(
    '47000000-0000-0000-4000-000000000031', '47000000-0000-0000-2000-000000000002'
  );
  if v_result <> 'already_active' then raise exception 'expected already_active, got %', v_result; end if;

  select result into v_result from public.platform_resume_clinic_v1(
    '47000000-0000-0000-4000-000000000032', '47000000-0000-0000-2000-000000000999'
  );
  if v_result <> 'not_found' then raise exception 'expected not_found, got %', v_result; end if;

  select result into v_result from public.platform_resume_clinic_v1(
    '47000000-0000-0000-4000-000000000033', '47000000-0000-0000-2000-000000000003'
  );
  if v_result <> 'refused_offboarding' then raise exception 'expected refused_offboarding, got %', v_result; end if;

  reset role;

  if not exists (
    select 1 from public.clinics where id = '47000000-0000-0000-2000-000000000003' and operational_status = 'offboarding'
  ) then
    raise exception 'offboarding clinic was unexpectedly resumed';
  end if;
  if (select count(*) from public.platform_admin_clinic_action_events where action = 'resume') <> 4 then
    raise exception 'expected exactly four resume audit rows, got %',
      (select count(*) from public.platform_admin_clinic_action_events where action = 'resume');
  end if;
end;
$$;

-- =========================================================================
-- 7. Offboarding cannot be initiated or finalized through any new grant,
-- and every Task 041 lifecycle function keeps its original service-role-only
-- grant untouched.
-- =========================================================================

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'provision_clinic_v1', 'suspend_clinic_v1', 'resume_clinic_v1',
    'prepare_clinic_offboarding_v1', 'finalize_clinic_offboarding_v1'
  ] loop
    if exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = v_name
        and grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception 'Task 041 lifecycle function % is executable by a browser role', v_name;
    end if;
    if not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = v_name
        and grantee = 'service_role'
    ) then
      raise exception 'Task 041 lifecycle function % is missing its service_role grant', v_name;
    end if;
  end loop;
end;
$$;

-- =========================================================================
-- 8. The three new RPCs are granted only to authenticated.
-- =========================================================================

do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'platform_provision_clinic_v1', 'platform_suspend_clinic_v1', 'platform_resume_clinic_v1'
  ] loop
    if exists (
      select 1 from information_schema.role_routine_grants
       where routine_schema = 'public' and routine_name = v_name and grantee in ('anon', 'service_role', 'public')
    ) then
      raise exception '% is executable by anon, service_role or public', v_name;
    end if;
    if not exists (
      select 1 from information_schema.role_routine_grants
       where routine_schema = 'public' and routine_name = v_name and grantee = 'authenticated'
    ) then
      raise exception '% is missing its authenticated grant', v_name;
    end if;
  end loop;
end;
$$;

-- =========================================================================
-- 9. Audit table shape, RLS, and absence of any browser (or service_role)
-- table access: catalog- and behavior-checked, not just grant-checked.
-- =========================================================================

do $$
declare
  v_columns text[];
  v_expected constant text[] := array[
    'id', 'request_id', 'actor_user_id', 'clinic_id', 'action', 'result', 'input_fingerprint', 'created_at'
  ];
  v_rls boolean;
begin
  select array_agg(c.column_name order by c.ordinal_position) into v_columns
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = 'platform_admin_clinic_action_events';
  if v_columns is distinct from v_expected then
    raise exception 'audit table columns changed: %', v_columns;
  end if;

  select cl.relrowsecurity into v_rls
    from pg_catalog.pg_class cl
    join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
   where n.nspname = 'public' and cl.relname = 'platform_admin_clinic_action_events';
  if not v_rls then
    raise exception 'audit table does not have RLS enabled';
  end if;

  if exists (
    select 1 from pg_catalog.pg_policy p
    join pg_catalog.pg_class cl on cl.oid = p.polrelid
    join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
     where n.nspname = 'public' and cl.relname = 'platform_admin_clinic_action_events'
  ) then
    raise exception 'audit table unexpectedly has an RLS policy';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants g
     where g.table_schema = 'public' and g.table_name = 'platform_admin_clinic_action_events'
       and g.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')
  ) then
    raise exception 'audit table is directly grantable to a browser or service_role';
  end if;
end;
$$;

do $$
begin
  begin
    insert into public.platform_admin_clinic_action_events
      (request_id, actor_user_id, clinic_id, action, result, input_fingerprint)
    values (
      '47000000-0000-0000-4000-000000000080',
      '47000000-0000-0000-1000-000000000001',
      '47000000-0000-0000-2000-000000000002',
      'provision', 'resumed', repeat('a', 64)
    );
    raise exception 'audit action/result mismatch unexpectedly passed its constraint';
  exception
    when check_violation then null;
  end;

  if exists (
    select 1 from public.platform_admin_clinic_action_events
    where request_id = '47000000-0000-0000-4000-000000000080'
  ) then
    raise exception 'failed audit coherence insert left a row';
  end if;
end;
$$;

-- The wrappers rely on PostgreSQL's implicit owner EXECUTE to call the
-- service-role-only Task 041 functions. Prove that each wrapper and its
-- underlying function actually share an owner in this applied schema.
do $$
begin
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.platform_provision_clinic_v1(uuid,uuid,text,uuid,text,uuid,text,text)'::regprocedure)
     is distinct from
     (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.provision_clinic_v1(uuid,text,text,text,uuid,text,uuid,text,text)'::regprocedure)
  then
    raise exception 'platform provision wrapper and Task 041 provision function owners differ';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.platform_suspend_clinic_v1(uuid,uuid)'::regprocedure)
     is distinct from
     (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.suspend_clinic_v1(uuid)'::regprocedure)
  then
    raise exception 'platform suspend wrapper and Task 041 suspend function owners differ';
  end if;
  if (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.platform_resume_clinic_v1(uuid,uuid)'::regprocedure)
     is distinct from
     (select p.proowner from pg_catalog.pg_proc p where p.oid = 'public.resume_clinic_v1(uuid)'::regprocedure)
  then
    raise exception 'platform resume wrapper and Task 041 resume function owners differ';
  end if;
end;
$$;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '47000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);
  begin
    perform * from public.platform_admin_clinic_action_events;
    raise exception 'authenticated unexpectedly read the audit table directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.platform_admin_clinic_action_events set result = 'suspended' where true;
    raise exception 'authenticated unexpectedly updated the audit table directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    delete from public.platform_admin_clinic_action_events where true;
    raise exception 'authenticated unexpectedly deleted from the audit table directly';
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
    perform * from public.platform_admin_clinic_action_events;
    raise exception 'service_role unexpectedly read the audit table directly';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- =========================================================================
-- 10. No residue: fixture rows are present right before rollback discards
-- this entire transaction.
-- =========================================================================

do $$
begin
  if not exists (select 1 from public.clinics where id = '47000000-0000-0000-2000-000000000001') then
    raise exception 'provisioned fixture clinic missing before rollback';
  end if;
  if not exists (select 1 from public.platform_admin_clinic_action_events) then
    raise exception 'fixture audit rows missing before rollback';
  end if;
  if not exists (select 1 from public.platform_admins where user_id = '47000000-0000-0000-1000-000000000001') then
    raise exception 'fixture admin membership missing before rollback';
  end if;
end;
$$;

rollback;
