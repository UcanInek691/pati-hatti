-- Rollback-only proof for Task 049 (route-resolver volatility invariant).
-- Pins public.resolve_whatsapp_contact_automation(text, text) as VOLATILE in
-- pg_proc, so a database built from these migrations never regresses into
-- the 2026-09-04 staging 405 (docs/olaylar/2026-09-04-route-resolver-405.md).
-- This is a catalog and ordinary-behavior proof only: it does not reproduce
-- PostgREST's own read-only-transaction routing, which requires a real
-- Data API POST (see the staging activation gate in CURRENT_TASK.md).
-- Never run this fixture script against a real clinic database.

begin;

-- =========================================================================
-- 1. Public resolver catalog: exact identity, volatility, security mode,
--    empty search_path and unchanged result shape.
-- =========================================================================

do $$
declare
  v_count int;
  v_provolatile "char";
  v_prosecdef boolean;
  v_search_path text;
  v_result_shape text;
begin
  select count(*) into v_count
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_whatsapp_contact_automation';
  if v_count <> 1 then
    raise exception 'expected exactly one public.resolve_whatsapp_contact_automation, found %', v_count;
  end if;

  select p.provolatile, p.prosecdef,
         (select o.option_value from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path'),
         pg_get_function_result(p.oid)
    into v_provolatile, v_prosecdef, v_search_path, v_result_shape
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'resolve_whatsapp_contact_automation'
    and pg_get_function_identity_arguments(p.oid) = 'p_phone_number_id text, p_contact_e164 text';

  if not found then
    raise exception 'resolve_whatsapp_contact_automation signature drifted from (p_phone_number_id text, p_contact_e164 text)';
  end if;
  if v_provolatile <> 'v' then
    raise exception 'resolve_whatsapp_contact_automation must be VOLATILE, found %', v_provolatile;
  end if;
  if v_prosecdef then
    raise exception 'resolve_whatsapp_contact_automation must stay SECURITY INVOKER';
  end if;
  if v_search_path is distinct from '""' then
    raise exception 'resolve_whatsapp_contact_automation must keep empty search_path, found %', v_search_path;
  end if;
  if v_result_shape <> 'TABLE(result text)' then
    raise exception 'resolve_whatsapp_contact_automation result shape changed: %', v_result_shape;
  end if;
end;
$$;

-- =========================================================================
-- 2. Grants: PUBLIC/anon/authenticated denied, service_role retained.
-- =========================================================================

do $$
begin
  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'resolve_whatsapp_contact_automation'
      and grantee in ('PUBLIC', 'anon', 'authenticated')
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'resolve_whatsapp_contact_automation must not be executable by PUBLIC, anon or authenticated';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public'
      and routine_name = 'resolve_whatsapp_contact_automation'
      and grantee = 'service_role'
      and privilege_type = 'EXECUTE'
  ) then
    raise exception 'service_role must retain execute on resolve_whatsapp_contact_automation';
  end if;
end;
$$;

-- =========================================================================
-- 3. Transitively called private helper: still VOLATILE, empty search_path,
--    and still holding the Task 041 clinic lifecycle row lock.
-- =========================================================================

do $$
declare
  v_provolatile "char";
  v_search_path text;
  v_definition text;
begin
  select p.provolatile,
         (select o.option_value from pg_options_to_table(p.proconfig) o where o.option_name = 'search_path'),
         pg_get_functiondef(p.oid)
    into v_provolatile, v_search_path, v_definition
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'vetai_private'
    and p.proname = 'effective_contact_automation_mode'
    and pg_get_function_identity_arguments(p.oid) = 'p_whatsapp_account_id uuid, p_contact_e164 text';

  if not found then
    raise exception 'effective_contact_automation_mode signature drifted from (p_whatsapp_account_id uuid, p_contact_e164 text)';
  end if;
  if v_provolatile <> 'v' then
    raise exception 'effective_contact_automation_mode must stay VOLATILE, found %', v_provolatile;
  end if;
  if v_search_path is distinct from '""' then
    raise exception 'effective_contact_automation_mode must keep empty search_path, found %', v_search_path;
  end if;
  if v_definition !~* 'for key share of cl' then
    raise exception 'effective_contact_automation_mode lost the clinic lifecycle row lock';
  end if;
end;
$$;

-- =========================================================================
-- 4. Minimal synthetic active-clinic/account fixture: ordinary resolver
--    behavior (explicit route, strict personal default, unknown account,
--    tenant isolation) is unchanged by the volatility fix.
-- =========================================================================

insert into public.clinics (id, name, operational_status, suspended_at)
values ('49000000-0000-0000-0000-000000000001', 'Route Resolver Test Clinic A', 'active', null);

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('49000000-0000-0000-0000-000000000002', '49000000-0000-0000-0000-000000000001', '949000001');

insert into public.clinics (id, name, operational_status, suspended_at)
values ('49000000-0000-0000-0000-000000000003', 'Route Resolver Test Clinic B', 'active', null);

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('49000000-0000-0000-0000-000000000004', '49000000-0000-0000-0000-000000000003', '949000002');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values ('49000000-0000-0000-0000-000000000002', '49000000-0000-0000-0000-000000000001', '+15559990001', 'ai');

do $$
declare
  v_result text;
begin
  select result into v_result
  from public.resolve_whatsapp_contact_automation('949000001', '+15559990001');
  if v_result <> 'ai' then
    raise exception 'expected ai for the explicit route, got %', v_result;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('949000001', '+15559990002');
  if v_result <> 'personal' then
    raise exception 'expected the strict personal default for an unlisted contact, got %', v_result;
  end if;

  -- Same contact number under an unrelated tenant account has no override
  -- and must not inherit account A's ai route.
  select result into v_result
  from public.resolve_whatsapp_contact_automation('949000002', '+15559990001');
  if v_result <> 'personal' then
    raise exception 'expected personal for the same contact number under an unrelated account, got %', v_result;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('does-not-exist-049', '+15559990001');
  if v_result <> 'unknown_account' then
    raise exception 'expected unknown_account for an unregistered phone_number_id, got %', v_result;
  end if;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform result from public.resolve_whatsapp_contact_automation('949000001', '+15559990001');
    raise exception 'authenticated role unexpectedly executed resolve_whatsapp_contact_automation';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform result from public.resolve_whatsapp_contact_automation('949000001', '+15559990001');
    raise exception 'anon role unexpectedly executed resolve_whatsapp_contact_automation';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;

-- Zero residue: this select runs against the post-rollback state.
select
  (select count(*) from public.clinics where id in (
    '49000000-0000-0000-0000-000000000001', '49000000-0000-0000-0000-000000000003')) as clinics_left,
  (select count(*) from public.whatsapp_accounts where id in (
    '49000000-0000-0000-0000-000000000002', '49000000-0000-0000-0000-000000000004')) as accounts_left,
  (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id =
    '49000000-0000-0000-0000-000000000002') as routes_left;
