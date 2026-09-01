-- Task 045: rollback-only proof for the platform-admin TOTP MFA boundary.
-- Not run against any database by the implementer; Codex applies this only
-- on disposable vetai-test after review.
--
-- Every role block below sets `request.jwt.claims` as one synthetic JSON
-- blob (never the per-key `request.jwt.claim.sub` GUC also used elsewhere in
-- this repo) so both auth.uid() and auth.jwt() resolve `sub`/`aal` from the
-- same real JWT-claim read the function performs in production, not a
-- test-only branch or text search of the function definition.

begin;

-- =========================================================================
-- 0. Fixture Auth users: one allowlisted platform admin, one ordinary
-- authenticated user who is never allowlisted.
-- =========================================================================

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('45000000-0000-0000-1000-000000000001', 'authenticated', 'authenticated', 'admin-045-admin@example.invalid', now(), now()),
  ('45000000-0000-0000-1000-000000000002', 'authenticated', 'authenticated', 'admin-045-other@example.invalid', now(), now());

do $$
declare
  v_result text;
begin
  set local role service_role;
  select result into v_result from public.set_platform_admin_v1('45000000-0000-0000-1000-000000000001', true);
  if v_result <> 'enabled' then raise exception 'expected enabled, got %', v_result; end if;
  reset role;
end;
$$;

-- =========================================================================
-- 1. Empty sentinel still requires aal2, exercised only while public.clinics
-- is genuinely empty (a shared test database may already hold unrelated
-- clinics from other fixtures that ran and committed before this one).
-- =========================================================================

do $$
declare
  r record;
  v_row_count integer := 0;
begin
  if exists (select 1 from public.clinics) then
    return;
  end if;

  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result is distinct from 'empty' then
      raise exception 'aal2 admin against an empty database expected empty, got %', r.result;
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one empty sentinel row, got %', v_row_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- Fixture: one clinic so the `reported` branch has a real row to return.
-- =========================================================================

insert into public.clinics (id, name, operational_status, suspended_at)
values ('45000000-0000-0000-2000-000000000001', 'MFA Boundary Clinic', 'active', null);

-- =========================================================================
-- 2. aal2 + allowlisted admin: `reported`, same shape/behavior as Task 043.
-- =========================================================================

do $$
declare
  r record;
  v_fixture_row_count integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    if r.result is distinct from 'reported' then
      raise exception 'aal2 admin expected reported, got %', r.result;
    end if;
    if r.clinic_id <> '45000000-0000-0000-2000-000000000001' then
      continue;
    end if;
    v_fixture_row_count := v_fixture_row_count + 1;
    if r.clinic_name is null or r.operational_status is null
      or r.whatsapp_account_count is null or r.open_work_item_count is null
      or r.urgent_work_item_count is null or r.pending_outbound_count is null
      or r.processing_outbound_count is null or r.failed_outbound_count is null
      or r.ai_turn_count is null or r.ai_touched_conversation_count is null
      or r.input_tokens is null or r.output_tokens is null or r.total_tokens is null
      or r.missing_token_usage_count is null then
      raise exception 'reported row for clinic % carried a null aggregate field', r.clinic_id;
    end if;
  end loop;
  if v_fixture_row_count <> 1 then
    raise exception 'expected exactly one fixture-clinic row, got %', v_fixture_row_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- 3. aal1 + allowlisted admin: exactly one closed forbidden sentinel, no
-- clinic/usage metadata, even though membership is genuinely valid.
-- =========================================================================

do $$
declare
  r record;
  v_row_count integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 'aal1')::text, true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result is distinct from 'forbidden' then
      raise exception 'aal1 admin expected forbidden, got %', r.result;
    end if;
    if r.clinic_id is not null or r.clinic_name is not null or r.operational_status is not null
      or r.whatsapp_account_count is not null or r.open_work_item_count is not null
      or r.urgent_work_item_count is not null or r.pending_outbound_count is not null
      or r.processing_outbound_count is not null or r.failed_outbound_count is not null
      or r.last_inbound_at is not null or r.last_outbound_at is not null
      or r.ai_turn_count is not null or r.ai_touched_conversation_count is not null
      or r.input_tokens is not null or r.output_tokens is not null or r.total_tokens is not null
      or r.missing_token_usage_count is not null then
      raise exception 'aal1 forbidden sentinel carried a non-null clinic/aggregate field';
    end if;
    if r.period_start <> '2026-06-01'::date or r.period_end <> '2026-07-01'::date then
      raise exception 'aal1 forbidden sentinel did not echo the requested period';
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one forbidden row for aal1, got %', v_row_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- 4. Missing / null / non-string / unknown aal, and a null caller, all fail
-- closed to exactly one forbidden row with an allowlisted subject where
-- applicable.
-- =========================================================================

do $$
declare
  v_claims text[] := array[
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001')::text,                    -- missing aal key
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', null)::text,        -- explicit JSON null
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 2)::text,            -- number
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', true)::text,         -- boolean
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', array['aal2'])::text, -- array
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', jsonb_build_object('level', 'aal2'))::text, -- object
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 'aal3')::text,       -- unknown string
    jsonb_build_object('aal', 'aal2')::text,                                                      -- null caller (no sub)
    '{}'::text                                                                                     -- both missing
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
    for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
      v_row_count := v_row_count + 1;
      if r.result is distinct from 'forbidden' or r.clinic_id is not null then
        raise exception 'claim % expected a bare forbidden sentinel, got result=%, clinic_id=%', v_claim, r.result, r.clinic_id;
      end if;
    end loop;
    if v_row_count <> 1 then
      raise exception 'claim % expected exactly one row, got %', v_claim, v_row_count;
    end if;
  end loop;
  reset role;
end;
$$;

-- =========================================================================
-- 5. aal2 but a non-allowlisted caller is still forbidden.
-- =========================================================================

do $$
declare
  r record;
  v_row_count integer := 0;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000002', 'aal', 'aal2')::text, true);

  for r in select * from public.get_platform_admin_overview_v1('2026-06-01'::date) loop
    v_row_count := v_row_count + 1;
    if r.result is distinct from 'forbidden' then
      raise exception 'aal2 non-admin expected forbidden, got %', r.result;
    end if;
  end loop;
  if v_row_count <> 1 then
    raise exception 'expected exactly one forbidden row for a non-admin, got %', v_row_count;
  end if;

  reset role;
end;
$$;

-- =========================================================================
-- 6. anon and service_role cannot execute; authenticated retains only the
-- intended grant.
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
begin
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
-- 7. Structural proof: OUT-column projection unchanged, security mode,
-- stable volatility, empty search path, and the owner relationship with
-- get_clinic_monthly_usage_v1 all still hold.
-- =========================================================================

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
  v_security text;
  v_volatility text;
  v_search_path text;
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
-- 8. Invalid month input still raises before any authorization/data access,
-- regardless of assurance level.
-- =========================================================================

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.jwt.claims',
    jsonb_build_object('sub', '45000000-0000-0000-1000-000000000001', 'aal', 'aal2')::text, true);
  begin
    perform * from public.get_platform_admin_overview_v1('2026-06-15'::date);
    raise exception 'get_platform_admin_overview_v1 accepted a non-month-start date';
  exception
    when others then
      if sqlerrm not like 'get_platform_admin_overview_v1:%' then raise; end if;
  end;
  reset role;
end;
$$;

-- =========================================================================
-- 9. No residue: fixture rows are present right before rollback discards
-- this entire transaction; no unrelated clinic/admin row was touched.
-- =========================================================================

do $$
begin
  if not exists (select 1 from public.clinics where id = '45000000-0000-0000-2000-000000000001') then
    raise exception 'fixture clinic missing before rollback';
  end if;
  if not exists (select 1 from public.platform_admins where user_id = '45000000-0000-0000-1000-000000000001') then
    raise exception 'fixture admin membership missing before rollback';
  end if;
  if exists (select 1 from public.platform_admins where user_id = '45000000-0000-0000-1000-000000000002') then
    raise exception 'the non-admin user unexpectedly holds platform_admins membership';
  end if;
end;
$$;

rollback;
