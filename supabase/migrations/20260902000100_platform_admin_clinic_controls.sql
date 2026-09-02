-- Task 047: platform-admin clinic lifecycle controls.
--
-- Adds a minimized append-only audit table and three SECURITY DEFINER
-- wrapper RPCs so an exact platform_admins + aal2 caller can provision a
-- suspended clinic, suspend an active clinic, or resume a suspended clinic
-- from /admin. Every wrapper only calls Task 041's existing
-- service-role-only provision_clinic_v1 / suspend_clinic_v1 /
-- resume_clinic_v1 -- that migration and those functions are not modified or
-- recreated. Offboarding remains out of scope: no new grant reaches
-- prepare_clinic_offboarding_v1 or finalize_clinic_offboarding_v1.

-- =========================================================================
-- Append-only audit table
-- =========================================================================

-- Exactly the minimized field set from decision 8: no clinic name,
-- phone_number_id, display name, email, phone, address, token, message, or
-- owner/pet identifier -- and no foreign key to clinics/auth.users, so a
-- later clinic or Auth user deletion can never cascade-erase audit history.
create table public.platform_admin_clinic_action_events (
  id bigint generated always as identity primary key,
  request_id uuid not null unique,
  actor_user_id uuid not null,
  clinic_id uuid not null,
  action text not null check (action in ('provision', 'suspend', 'resume')),
  result text not null check (result in (
    'provisioned', 'already_provisioned',
    'suspended', 'already_suspended',
    'resumed', 'already_active', 'refused_offboarding',
    'not_found'
  )),
  constraint platform_admin_clinic_action_result_coherence_check check (
    (action = 'provision' and result in ('provisioned', 'already_provisioned'))
    or (action = 'suspend' and result in ('suspended', 'already_suspended', 'not_found'))
    or (action = 'resume' and result in ('resumed', 'already_active', 'refused_offboarding', 'not_found'))
  ),
  input_fingerprint text not null check (input_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default pg_catalog.now()
);

-- RLS enabled with no policy and every grant revoked (including
-- service_role): the only writer is the SECURITY DEFINER RPCs below, which
-- run as the function owner and so bypass RLS/grants the same way Task 041's
-- functions already do.
alter table public.platform_admin_clinic_action_events enable row level security;
revoke all on public.platform_admin_clinic_action_events from public, anon, authenticated, service_role;

-- =========================================================================
-- Shared authorization and replay helpers (vetai_private, never reachable by
-- a browser role -- only the owner-bypass from the SECURITY DEFINER RPCs
-- below can execute them, matching the existing vetai_private convention).
-- =========================================================================

-- Exact platform_admins + aal2 authorization, mirroring
-- get_platform_admin_overview_v1's null-safe predicate: `->>'aal'` never
-- raises on a missing/malformed claim, and `is not distinct from` avoids the
-- three-valued-logic bypass a plain `=` would allow when the claim is null.
-- Returns the caller's uuid when authorized, else null, so every RPC below
-- can fail closed with the same 'forbidden' sentinel before touching any
-- table.
create function vetai_private.platform_admin_authorized_caller_v1()
returns uuid
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid;
  v_aal text;
begin
  v_caller := auth.uid();
  v_aal := auth.jwt() ->> 'aal';

  if v_caller is not null
    and v_aal is not distinct from 'aal2'
    and exists (select 1 from public.platform_admins pa where pa.user_id = v_caller)
  then
    return v_caller;
  end if;

  return null;
end;
$$;

revoke all on function vetai_private.platform_admin_authorized_caller_v1() from public, anon, authenticated;
grant execute on function vetai_private.platform_admin_authorized_caller_v1() to service_role;

-- Serializes first-use/replay handling for one request_id behind a
-- transaction-scoped advisory lock (auto-released at commit or rollback),
-- then returns the previously recorded result for an exact replay, null for
-- a fresh request, or raises for a request_id reused with a different
-- actor/action/clinic/input. A hashtextextended collision only costs
-- harmless extra waiting on the lock -- it can never merge or authorize two
-- different requests, because the row lookup below still compares the full
-- actor/action/clinic/fingerprint tuple, not just the lock key.
create function vetai_private.platform_admin_check_replay_v1(
  p_request_id uuid,
  p_actor_user_id uuid,
  p_clinic_id uuid,
  p_action text,
  p_input_fingerprint text
)
returns text
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_row public.platform_admin_clinic_action_events%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));

  select * into v_row
  from public.platform_admin_clinic_action_events e
  where e.request_id = p_request_id;

  if not found then
    return null;
  end if;

  if v_row.actor_user_id = p_actor_user_id
    and v_row.clinic_id = p_clinic_id
    and v_row.action = p_action
    and v_row.input_fingerprint = p_input_fingerprint
  then
    return v_row.result;
  end if;

  raise exception 'platform_admin_check_replay_v1: request_id % reused with a different actor, action, clinic or input', p_request_id;
end;
$$;

revoke all on function vetai_private.platform_admin_check_replay_v1(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function vetai_private.platform_admin_check_replay_v1(uuid, uuid, uuid, text, text) to service_role;

-- =========================================================================
-- Public authenticated RPCs
-- =========================================================================

-- platform_provision_clinic_v1: provisions one clinic through Task 041's
-- provision_clinic_v1, which always lands the clinic in 'suspended' -- this
-- wrapper never activates it. Contact phone and public address are fixed to
-- SQL null and are not parameters, so browser input cannot set them.
create function public.platform_provision_clinic_v1(
  p_request_id uuid,
  p_clinic_id uuid,
  p_clinic_name text,
  p_owner_user_id uuid,
  p_staff_role text,
  p_whatsapp_account_id uuid,
  p_phone_number_id text,
  p_display_name text default null
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_fingerprint text;
  v_replay_result text;
  v_lifecycle_result text;
begin
  v_caller := vetai_private.platform_admin_authorized_caller_v1();
  if v_caller is null then
    return query select 'forbidden'::text;
    return;
  end if;

  if p_request_id is null or p_clinic_id is null then
    raise exception 'platform_provision_clinic_v1: invalid request_id or clinic_id';
  end if;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(
      pg_catalog.jsonb_build_object(
        'clinic_id', p_clinic_id,
        'clinic_name', p_clinic_name,
        'owner_user_id', p_owner_user_id,
        'staff_role', p_staff_role,
        'whatsapp_account_id', p_whatsapp_account_id,
        'phone_number_id', p_phone_number_id,
        'display_name', p_display_name
      )::text::bytea
    ),
    'hex'
  );

  v_replay_result := vetai_private.platform_admin_check_replay_v1(
    p_request_id, v_caller, p_clinic_id, 'provision', v_fingerprint
  );
  if v_replay_result is not null then
    return query select v_replay_result;
    return;
  end if;

  select l.result into v_lifecycle_result
  from public.provision_clinic_v1(
    p_clinic_id, p_clinic_name, null, null, p_owner_user_id, p_staff_role,
    p_whatsapp_account_id, p_phone_number_id, p_display_name
  ) l;

  insert into public.platform_admin_clinic_action_events
    (request_id, actor_user_id, clinic_id, action, result, input_fingerprint)
  values
    (p_request_id, v_caller, p_clinic_id, 'provision', v_lifecycle_result, v_fingerprint);

  return query select v_lifecycle_result;
  return;
end;
$$;

revoke all on function public.platform_provision_clinic_v1(uuid, uuid, text, uuid, text, uuid, text, text) from public, anon, service_role;
grant execute on function public.platform_provision_clinic_v1(uuid, uuid, text, uuid, text, uuid, text, text) to authenticated;

-- platform_suspend_clinic_v1: suspends one active clinic through Task 041's
-- suspend_clinic_v1. That function raises (no row, no audit write, full
-- rollback) if the clinic is offboarding -- offboarding stays reachable only
-- through the existing operator runbook, never through this RPC.
create function public.platform_suspend_clinic_v1(
  p_request_id uuid,
  p_clinic_id uuid
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_fingerprint text;
  v_replay_result text;
  v_lifecycle_result text;
begin
  v_caller := vetai_private.platform_admin_authorized_caller_v1();
  if v_caller is null then
    return query select 'forbidden'::text;
    return;
  end if;

  if p_request_id is null or p_clinic_id is null then
    raise exception 'platform_suspend_clinic_v1: invalid request_id or clinic_id';
  end if;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.jsonb_build_object('clinic_id', p_clinic_id)::text::bytea),
    'hex'
  );

  v_replay_result := vetai_private.platform_admin_check_replay_v1(
    p_request_id, v_caller, p_clinic_id, 'suspend', v_fingerprint
  );
  if v_replay_result is not null then
    return query select v_replay_result;
    return;
  end if;

  select l.result into v_lifecycle_result from public.suspend_clinic_v1(p_clinic_id) l;

  insert into public.platform_admin_clinic_action_events
    (request_id, actor_user_id, clinic_id, action, result, input_fingerprint)
  values
    (p_request_id, v_caller, p_clinic_id, 'suspend', v_lifecycle_result, v_fingerprint);

  return query select v_lifecycle_result;
  return;
end;
$$;

revoke all on function public.platform_suspend_clinic_v1(uuid, uuid) from public, anon, service_role;
grant execute on function public.platform_suspend_clinic_v1(uuid, uuid) to authenticated;

-- platform_resume_clinic_v1: resumes one suspended clinic through Task 041's
-- resume_clinic_v1. Unlike suspend, an offboarding clinic here returns the
-- ordinary 'refused_offboarding' result row (no raise) -- forwarded as-is.
create function public.platform_resume_clinic_v1(
  p_request_id uuid,
  p_clinic_id uuid
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_fingerprint text;
  v_replay_result text;
  v_lifecycle_result text;
begin
  v_caller := vetai_private.platform_admin_authorized_caller_v1();
  if v_caller is null then
    return query select 'forbidden'::text;
    return;
  end if;

  if p_request_id is null or p_clinic_id is null then
    raise exception 'platform_resume_clinic_v1: invalid request_id or clinic_id';
  end if;

  v_fingerprint := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.jsonb_build_object('clinic_id', p_clinic_id)::text::bytea),
    'hex'
  );

  v_replay_result := vetai_private.platform_admin_check_replay_v1(
    p_request_id, v_caller, p_clinic_id, 'resume', v_fingerprint
  );
  if v_replay_result is not null then
    return query select v_replay_result;
    return;
  end if;

  select l.result into v_lifecycle_result from public.resume_clinic_v1(p_clinic_id) l;

  insert into public.platform_admin_clinic_action_events
    (request_id, actor_user_id, clinic_id, action, result, input_fingerprint)
  values
    (p_request_id, v_caller, p_clinic_id, 'resume', v_lifecycle_result, v_fingerprint);

  return query select v_lifecycle_result;
  return;
end;
$$;

revoke all on function public.platform_resume_clinic_v1(uuid, uuid) from public, anon, service_role;
grant execute on function public.platform_resume_clinic_v1(uuid, uuid) to authenticated;
