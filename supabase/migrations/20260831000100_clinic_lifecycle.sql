-- Task 041: safe clinic provisioning and offboarding.
--
-- Adds a closed clinic.operational_status lifecycle (active | suspended |
-- offboarding), five service-role-only RPCs that move a clinic through it,
-- and a runtime suspension boundary so a non-active clinic's WhatsApp
-- traffic stops flowing without deleting anything until an operator
-- explicitly finalizes offboarding with the one token minted for that
-- clinic. Pre-existing clinics are backfilled to 'active' so every already
-- applied fixture keeps its current behavior; only newly provisioned
-- clinics start 'suspended'.
--
-- vetai_private.effective_contact_automation_mode and
-- public.claim_outbound_message_v2 are already-applied functions; per the
-- forward-only migration rule they are recreated here (drop + create) with
-- the added clinic-status gate, byte-identical otherwise. Not run against
-- any database by the implementer; see
-- supabase/tests/041_clinic_lifecycle.sql and docs/clinic-lifecycle.md.

-- =========================================================================
-- 1. Clinic lifecycle columns (add with a safe default, backfill existing
--    rows, then constrain -- constraints added before backfill would reject
--    every pre-existing row still holding the new default).
-- =========================================================================

alter table public.clinics
  add column operational_status text not null default 'suspended',
  add column suspended_at timestamptz default now(),
  add column offboarding_started_at timestamptz,
  add column offboarding_token uuid;

update public.clinics
  set operational_status = 'active',
      suspended_at = null
  where operational_status = 'suspended';

alter table public.clinics
  add constraint clinics_operational_status_check
    check (operational_status in ('active', 'suspended', 'offboarding')),
  add constraint clinics_suspension_coherence_check
    check ((operational_status = 'suspended') = (suspended_at is not null)),
  add constraint clinics_offboarding_coherence_check
    check (
      (operational_status = 'offboarding')
      = (offboarding_started_at is not null)
      and (operational_status = 'offboarding') = (offboarding_token is not null)
    );

-- =========================================================================
-- 2. Offboarding receipts: a permanent, backend-only, PII-free audit trail.
--    No foreign key to clinics -- the row must survive the clinic's own
--    cascade delete inside finalize_clinic_offboarding_v1, both as a
--    permanent record and to support an idempotent post-delete replay.
-- =========================================================================

create table public.clinic_offboarding_receipts (
  clinic_id uuid not null,
  offboarding_token_hash text not null,
  action text not null,
  offboarded_at timestamptz not null default now(),
  constraint clinic_offboarding_receipts_action_check check (action = 'offboarded'),
  unique (clinic_id)
);

alter table public.clinic_offboarding_receipts enable row level security;

-- No anon/authenticated policy is created, so with RLS enabled those roles
-- get zero rows/writes by default; only service_role (which bypasses RLS)
-- can touch this table -- same pattern as public.webhook_events.
revoke all on public.clinic_offboarding_receipts from anon, authenticated, public;
grant all on public.clinic_offboarding_receipts to service_role;

-- =========================================================================
-- 3. Runtime suspension boundary, part 1: the single shared resolver that
--    every automation-sensitive call path routes through (directly or via
--    vetai_private.lock_owner_and_resolve_automation) already receives a
--    valid whatsapp_account_id from its caller, so gating here alone covers
--    resolve_whatsapp_contact_automation, ingest_whatsapp_text_message,
--    claim_intake_queue_job and all three finalizers with zero changes to
--    any of them.
-- =========================================================================

drop function vetai_private.effective_contact_automation_mode(uuid, text);

create function vetai_private.effective_contact_automation_mode(
  p_whatsapp_account_id uuid,
  p_contact_e164 text
)
returns text
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_clinic_status text;
  v_mode text;
begin
  select cl.operational_status into v_clinic_status
  from public.whatsapp_accounts wa
  join public.clinics cl on cl.id = wa.clinic_id
  where wa.id = p_whatsapp_account_id
  for key share of cl;

  if v_clinic_status is distinct from 'active' then
    return 'personal';
  end if;

  select r.mode into v_mode
  from public.whatsapp_contact_routes r
  where r.whatsapp_account_id = p_whatsapp_account_id
    and r.contact_e164 = p_contact_e164;

  if v_mode is not null then
    return v_mode;
  end if;

  select wa.automation_default into v_mode
  from public.whatsapp_accounts wa
  where wa.id = p_whatsapp_account_id;

  return v_mode;
end;
$$;

revoke all on function vetai_private.effective_contact_automation_mode(uuid, text)
  from public, anon, authenticated;
grant execute on function vetai_private.effective_contact_automation_mode(uuid, text)
  to service_role;

-- =========================================================================
-- 4. Runtime suspension boundary, part 2: V2 claim skips non-active
--    clinics. Byte-identical to the Task 040 body otherwise. V1 stays
--    untouched as the existing rollback target.
-- =========================================================================

drop function public.claim_outbound_message_v2();

create function public.claim_outbound_message_v2()
returns table (
  result text,
  outbox_id uuid,
  claim_token uuid,
  whatsapp_account_id uuid,
  phone_number_id text,
  recipient_e164 text,
  content text,
  attempt_count integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_outbox_id uuid;
  v_delivery_status text;
  v_attempt_count integer;
  v_new_token uuid;
  v_account_id uuid;
  v_phone_number_id text;
  v_recipient_e164 text;
  v_content text;
begin
  select o.id, o.delivery_status, o.delivery_attempt_count, o.recipient_e164, o.content, wa.id, wa.phone_number_id
    into v_outbox_id, v_delivery_status, v_attempt_count, v_recipient_e164, v_content, v_account_id, v_phone_number_id
  from public.outbound_message_outbox o
  join public.whatsapp_accounts wa
    on wa.id = o.whatsapp_account_id
   and wa.clinic_id = o.clinic_id
  join public.clinics cl
    on cl.id = wa.clinic_id
   and cl.operational_status = 'active'
  where (o.delivery_status = 'pending' and o.next_attempt_at <= pg_catalog.now())
     or (o.delivery_status = 'processing' and o.delivery_lease_until <= pg_catalog.now())
  order by o.created_at, o.id
  for update of o skip locked
  limit 1;

  if v_outbox_id is null then
    return query select 'empty'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  if v_delivery_status = 'processing' and v_attempt_count >= 3 then
    update public.outbound_message_outbox
      set delivery_status = 'failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null,
          failed_at = pg_catalog.now(),
          failure_reason = 'attempts_exhausted'
      where id = v_outbox_id;

    return query select 'exhausted'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  v_new_token := pg_catalog.gen_random_uuid();
  v_attempt_count := v_attempt_count + 1;

  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = v_new_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = v_attempt_count,
        next_attempt_at = null
    where id = v_outbox_id;

  return query select 'claimed'::text, v_outbox_id, v_new_token, v_account_id, v_phone_number_id, v_recipient_e164, v_content, v_attempt_count;
  return;
end;
$$;

revoke all on function public.claim_outbound_message_v2() from public, anon, authenticated;
grant execute on function public.claim_outbound_message_v2() to service_role;

-- =========================================================================
-- 5. Five lifecycle RPCs. All service-role-only, no dynamic SQL.
-- =========================================================================

-- provision_clinic_v1: creates a clinic, its first staff link and its first
-- WhatsApp account in one transaction, always starting 'suspended' so a new
-- tenant cannot receive/send a single message before an operator opts it
-- in. Exact replay (same clinic_id with identical inputs) is idempotent;
-- any partial/different reuse of clinic_id, phone_number_id or
-- whatsapp_account_id raises and rolls back rather than merging tenants. A
-- missing Auth user surfaces as the existing clinic_staff foreign key
-- violation, which also rolls back the whole attempt.
create function public.provision_clinic_v1(
  p_clinic_id uuid,
  p_clinic_name text,
  p_contact_phone_e164 text,
  p_public_address text,
  p_owner_user_id uuid,
  p_staff_role text,
  p_whatsapp_account_id uuid,
  p_phone_number_id text,
  p_display_name text
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_existing_name text;
  v_existing_phone text;
  v_existing_address text;
  v_existing_status text;
  v_replay_match boolean;
begin
  if p_clinic_id is null then
    raise exception 'provision_clinic_v1: invalid clinic_id';
  end if;
  if p_clinic_name is null or p_clinic_name <> btrim(p_clinic_name)
    or char_length(p_clinic_name) < 1 or char_length(p_clinic_name) > 200
    or p_clinic_name ~ '[[:cntrl:]]' then
    raise exception 'provision_clinic_v1: invalid clinic_name';
  end if;
  if p_contact_phone_e164 is not null and p_contact_phone_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'provision_clinic_v1: invalid contact_phone_e164';
  end if;
  if p_public_address is not null and (
    p_public_address <> btrim(p_public_address)
    or char_length(p_public_address) < 1 or char_length(p_public_address) > 500
    or p_public_address ~ '[[:cntrl:]]'
  ) then
    raise exception 'provision_clinic_v1: invalid public_address';
  end if;
  if p_owner_user_id is null then
    raise exception 'provision_clinic_v1: invalid owner_user_id';
  end if;
  if p_staff_role is null or p_staff_role not in ('admin', 'veterinarian', 'receptionist') then
    raise exception 'provision_clinic_v1: invalid staff_role';
  end if;
  if p_whatsapp_account_id is null then
    raise exception 'provision_clinic_v1: invalid whatsapp_account_id';
  end if;
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{1,64}$' then
    raise exception 'provision_clinic_v1: invalid phone_number_id';
  end if;
  if p_display_name is not null and (
    p_display_name <> btrim(p_display_name)
    or char_length(p_display_name) < 1 or char_length(p_display_name) > 200
    or p_display_name ~ '[[:cntrl:]]'
  ) then
    raise exception 'provision_clinic_v1: invalid display_name';
  end if;

  select c.name, c.contact_phone_e164, c.public_address, c.operational_status
    into v_existing_name, v_existing_phone, v_existing_address, v_existing_status
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if v_existing_status is not null then
    v_replay_match :=
      v_existing_name = p_clinic_name
      and v_existing_phone is not distinct from p_contact_phone_e164
      and v_existing_address is not distinct from p_public_address
      and v_existing_status = 'suspended'
      and exists (
        select 1 from public.whatsapp_accounts wa
        where wa.id = p_whatsapp_account_id
          and wa.clinic_id = p_clinic_id
          and wa.phone_number_id = p_phone_number_id
          and wa.display_name is not distinct from p_display_name
      )
      and exists (
        select 1 from public.clinic_staff cs
        where cs.clinic_id = p_clinic_id
          and cs.user_id = p_owner_user_id
          and cs.role = p_staff_role
      );

    if v_replay_match then
      return query select 'already_provisioned'::text;
      return;
    end if;

    raise exception 'provision_clinic_v1: clinic_id % already exists with different data', p_clinic_id;
  end if;

  insert into public.clinics (id, name, contact_phone_e164, public_address, operational_status, suspended_at)
  values (p_clinic_id, p_clinic_name, p_contact_phone_e164, p_public_address, 'suspended', pg_catalog.now());

  insert into public.clinic_staff (clinic_id, user_id, role)
  values (p_clinic_id, p_owner_user_id, p_staff_role);

  insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name)
  values (p_whatsapp_account_id, p_clinic_id, p_phone_number_id, p_display_name);

  return query select 'provisioned'::text;
  return;
end;
$$;

revoke all on function public.provision_clinic_v1(uuid, text, text, text, uuid, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.provision_clinic_v1(uuid, text, text, text, uuid, text, uuid, text, text)
  to service_role;

-- suspend_clinic_v1: moves an active clinic to 'suspended' and removes only
-- its own pending/processing outbox rows -- accepted/failed rows, other
-- clinics, staff, hours and routes are untouched. Refuses to touch an
-- offboarding clinic (offboarding only ever moves forward to finalize).
create function public.suspend_clinic_v1(p_clinic_id uuid)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_clinic_id is null then
    raise exception 'suspend_clinic_v1: invalid clinic_id';
  end if;

  select c.operational_status into v_status
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if v_status is null then
    return query select 'not_found'::text;
    return;
  end if;

  if v_status = 'suspended' then
    return query select 'already_suspended'::text;
    return;
  end if;

  if v_status = 'offboarding' then
    raise exception 'suspend_clinic_v1: clinic % is offboarding, cannot suspend', p_clinic_id;
  end if;

  update public.clinics
    set operational_status = 'suspended', suspended_at = pg_catalog.now()
    where id = p_clinic_id;

  delete from public.outbound_message_outbox
  where clinic_id = p_clinic_id
    and delivery_status in ('pending', 'processing');

  return query select 'suspended'::text;
  return;
end;
$$;

revoke all on function public.suspend_clinic_v1(uuid) from public, anon, authenticated;
grant execute on function public.suspend_clinic_v1(uuid) to service_role;

-- resume_clinic_v1: moves a suspended clinic back to 'active'. Cannot
-- escape 'offboarding' -- that state only ever finalizes or stays put. It
-- creates no route and sends nothing; it only flips the gate that
-- effective_contact_automation_mode and claim_outbound_message_v2 read.
create function public.resume_clinic_v1(p_clinic_id uuid)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_clinic_id is null then
    raise exception 'resume_clinic_v1: invalid clinic_id';
  end if;

  select c.operational_status into v_status
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if v_status is null then
    return query select 'not_found'::text;
    return;
  end if;

  if v_status = 'active' then
    return query select 'already_active'::text;
    return;
  end if;

  if v_status = 'offboarding' then
    return query select 'refused_offboarding'::text;
    return;
  end if;

  update public.clinics
    set operational_status = 'active', suspended_at = null
    where id = p_clinic_id;

  return query select 'resumed'::text;
  return;
end;
$$;

revoke all on function public.resume_clinic_v1(uuid) from public, anon, authenticated;
grant execute on function public.resume_clinic_v1(uuid) to service_role;

-- prepare_clinic_offboarding_v1: locks the clinic, moves it to
-- 'offboarding', mints a fresh token and clears its own pending/processing
-- outbox work (mirrors suspend's cleanup). Idempotent on replay -- never
-- re-mints a token for a clinic already offboarding.
create function public.prepare_clinic_offboarding_v1(p_clinic_id uuid)
returns table (result text, offboarding_token uuid)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
begin
  if p_clinic_id is null then
    raise exception 'prepare_clinic_offboarding_v1: invalid clinic_id';
  end if;

  select c.operational_status, c.offboarding_token into v_status, v_token
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if v_status is null then
    return query select 'not_found'::text, null::uuid;
    return;
  end if;

  if v_status = 'offboarding' then
    return query select 'already_offboarding'::text, v_token;
    return;
  end if;

  v_token := pg_catalog.gen_random_uuid();

  update public.clinics
    set operational_status = 'offboarding',
        offboarding_started_at = pg_catalog.now(),
        offboarding_token = v_token,
        suspended_at = null
    where id = p_clinic_id;

  delete from public.outbound_message_outbox
  where clinic_id = p_clinic_id
    and delivery_status in ('pending', 'processing');

  return query select 'prepared'::text, v_token;
  return;
end;
$$;

revoke all on function public.prepare_clinic_offboarding_v1(uuid) from public, anon, authenticated;
grant execute on function public.prepare_clinic_offboarding_v1(uuid) to service_role;

-- finalize_clinic_offboarding_v1: destructive, two-step-workflow terminus.
-- Accepts only the current token for a clinic actually in 'offboarding';
-- anything else (missing clinic, wrong state, wrong/stale token) fails
-- closed. On success it writes a one-way hash of the token (never the raw
-- token) to a receipt row with no foreign key to clinics, then deletes the
-- clinic, which cascades through every existing tenant-scoped table. An
-- exact replay after the clinic is already gone hashes the supplied token
-- and, if it matches the surviving receipt, returns 'already_offboarded'
-- instead of 'not_found'.
create function public.finalize_clinic_offboarding_v1(
  p_clinic_id uuid,
  p_offboarding_token uuid
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
  v_hash text;
  v_existing_hash text;
begin
  if p_clinic_id is null then
    raise exception 'finalize_clinic_offboarding_v1: invalid clinic_id';
  end if;
  if p_offboarding_token is null then
    raise exception 'finalize_clinic_offboarding_v1: invalid offboarding_token';
  end if;

  v_hash := pg_catalog.encode(pg_catalog.sha256(p_offboarding_token::text::bytea), 'hex');

  select c.operational_status, c.offboarding_token into v_status, v_token
  from public.clinics c
  where c.id = p_clinic_id
  for update;

  if v_status is null then
    select r.offboarding_token_hash into v_existing_hash
    from public.clinic_offboarding_receipts r
    where r.clinic_id = p_clinic_id;

    if v_existing_hash is not null and v_existing_hash = v_hash then
      return query select 'already_offboarded'::text;
      return;
    end if;

    return query select 'not_found'::text;
    return;
  end if;

  if v_status <> 'offboarding' or v_token is distinct from p_offboarding_token then
    raise exception 'finalize_clinic_offboarding_v1: invalid or stale offboarding_token for clinic %', p_clinic_id;
  end if;

  insert into public.clinic_offboarding_receipts (clinic_id, offboarding_token_hash, action)
  values (p_clinic_id, v_hash, 'offboarded');

  delete from public.clinics where id = p_clinic_id;

  return query select 'finalized'::text;
  return;
end;
$$;

revoke all on function public.finalize_clinic_offboarding_v1(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.finalize_clinic_offboarding_v1(uuid, uuid)
  to service_role;
