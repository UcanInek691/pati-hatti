-- Appointment booking database engine for VetAI: one backend-only
-- appointment_slots table plus three service-role-only RPCs (list/hold/
-- confirm) that make the database, not prompts or Worker timing, the single
-- authority preventing a slot from being confirmed twice. Validated by Codex
-- on disposable vetai-test on 2026-08-10; not applied to production or
-- recorded in migration history. See docs/appointment-booking-engine.md and
-- docs/database-schema.md.

-- =========================================================================
-- Supporting unique key
-- =========================================================================

-- Lets the composite FK below prove a slot's owner_id is exactly that
-- conversation's owner (and, transitively with the clinic_id column, the
-- same clinic), matching the (id, clinic_id)/(id, owner_id, clinic_id)
-- pattern already used by owners/pets/outbound_message_outbox.
alter table public.conversations
  add unique (id, owner_id, clinic_id);

-- =========================================================================
-- Table
-- =========================================================================

create table public.appointment_slots (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'available' check (status in ('available', 'held', 'confirmed')),
  conversation_id uuid,
  owner_id uuid,
  pet_id uuid,
  booking_token uuid,
  hold_until timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Proves the held/confirmed conversation belongs to this slot's clinic
  -- and owner; KVKK erasure of the conversation takes precedence over
  -- preserving an immutable booking record.
  foreign key (conversation_id, owner_id, clinic_id)
    references public.conversations (id, owner_id, clinic_id) on delete cascade,
  -- Proves the held/confirmed pet belongs to that same owner and clinic.
  foreign key (pet_id, owner_id, clinic_id)
    references public.pets (id, owner_id, clinic_id) on delete cascade,

  constraint appointment_slots_duration_check
    check (ends_at = starts_at + interval '30 minutes'),
  -- Pinned to UTC rather than the session timezone GUC so alignment is
  -- deterministic regardless of caller session settings; Europe/Istanbul has
  -- had a fixed UTC+3 offset since 2016, so a UTC half-hour boundary is also
  -- an Istanbul half-hour boundary.
  constraint appointment_slots_alignment_check
    check (
      extract(minute from (starts_at at time zone 'UTC')) in (0, 30)
      and extract(second from (starts_at at time zone 'UTC')) = 0
    ),
  constraint appointment_slots_available_state_check
    check (
      status <> 'available'
      or (
        conversation_id is null and owner_id is null and pet_id is null
        and booking_token is null and hold_until is null and confirmed_at is null
      )
    ),
  constraint appointment_slots_held_state_check
    check (
      status <> 'held'
      or (
        conversation_id is not null and owner_id is not null and pet_id is not null
        and booking_token is not null and hold_until is not null
        and confirmed_at is null
      )
    ),
  constraint appointment_slots_confirmed_state_check
    check (
      status <> 'confirmed'
      or (
        conversation_id is not null and owner_id is not null and pet_id is not null
        and booking_token is not null and confirmed_at is not null
        and hold_until is null
      )
    ),

  -- Fixed, aligned 30-minute slots cannot overlap within a clinic; this
  -- unique index also serves as the clinic/time availability listing index,
  -- so no separate index is added.
  unique (clinic_id, starts_at)
);

-- At most one active (held or confirmed) slot per conversation; the final
-- defense against two active slots for one conversation under a race, since
-- the RPCs below cannot themselves prevent every concurrent interleaving.
create unique index appointment_slots_active_conversation_uniq
  on public.appointment_slots (conversation_id)
  where status in ('held', 'confirmed');

create trigger set_updated_at before update on public.appointment_slots
  for each row execute function vetai_private.set_updated_at();

-- =========================================================================
-- RLS and privileges
-- =========================================================================

alter table public.appointment_slots enable row level security;

-- Backend-only in this task: no browser or authenticated-staff access, no
-- policy. With RLS enabled and no policy, every non-service_role role gets
-- zero rows/writes by default.
revoke all on public.appointment_slots from public, anon, authenticated;
grant all on public.appointment_slots to service_role;

-- =========================================================================
-- RPC 1: list availability
-- =========================================================================

create function public.list_available_appointment_slots(
  p_conversation_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 5
)
returns table (slot_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status text;
  v_pet_id uuid;
  v_intake_stage text;
begin
  if p_conversation_id is null then
    raise exception 'list_available_appointment_slots: invalid conversation_id';
  end if;
  if p_from is null or p_to is null then
    raise exception 'list_available_appointment_slots: invalid time window';
  end if;
  if p_to <= p_from or p_to > p_from + interval '31 days' then
    raise exception 'list_available_appointment_slots: invalid time window';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 10 then
    raise exception 'list_available_appointment_slots: invalid limit';
  end if;

  -- Tenant/eligibility routing comes only from the conversation's own
  -- persisted state, never from a caller-supplied clinic id.
  select c.clinic_id, c.status, c.pet_id, c.intake_stage
    into v_clinic_id, v_status, v_pet_id, v_intake_stage
  from public.conversations c
  where c.id = p_conversation_id;

  if v_clinic_id is null
    or v_status <> 'active'
    or v_pet_id is null
    or v_intake_stage not in ('appointment_offer', 'appointment_selection', 'appointment_confirmation')
  then
    return;
  end if;

  -- Advisory only: a listed slot is not reserved and may lose a race to
  -- hold_appointment_slot before the caller acts on it.
  return query
  select s.id, s.starts_at, s.ends_at
  from public.appointment_slots s
  where s.clinic_id = v_clinic_id
    and s.starts_at >= p_from
    and s.starts_at >= pg_catalog.now()
    and s.starts_at < p_to
    and (
      s.status = 'available'
      or (s.status = 'held' and s.hold_until <= pg_catalog.now())
    )
  order by s.starts_at, s.id
  limit p_limit;
end;
$$;

revoke all on function public.list_available_appointment_slots(uuid, timestamptz, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.list_available_appointment_slots(uuid, timestamptz, timestamptz, integer) to service_role;

-- =========================================================================
-- RPC 2: hold/switch a slot
-- =========================================================================

create function public.hold_appointment_slot(
  p_conversation_id uuid,
  p_slot_id uuid
)
returns table (
  result text,
  booking_token uuid,
  starts_at timestamptz,
  ends_at timestamptz
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_existing_id uuid;
  v_target public.appointment_slots%rowtype;
  v_existing public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_new_token uuid;
begin
  if p_conversation_id is null or p_slot_id is null then
    raise exception 'hold_appointment_slot: missing required input';
  end if;

  -- Locking the conversation first serializes every hold/confirm call for
  -- the same conversation behind this one row lock.
  select * into v_conv
  from public.conversations
  where id = p_conversation_id
  for update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select s.id into v_existing_id
  from public.appointment_slots s
  where s.conversation_id = p_conversation_id
    and s.status in ('held', 'confirmed');

  -- Lock the target and any distinct existing active slot in deterministic
  -- ascending-id order to avoid a cross-conversation deadlock.
  if v_existing_id is null or v_existing_id = p_slot_id then
    select * into v_target from public.appointment_slots where id = p_slot_id for update;
    if v_existing_id is not null
      and v_target.conversation_id = p_conversation_id
      and v_target.status in ('held', 'confirmed')
    then
      v_existing := v_target;
    end if;
  elsif v_existing_id < p_slot_id then
    select * into v_existing
    from public.appointment_slots
    where id = v_existing_id
      and conversation_id = p_conversation_id
      and status in ('held', 'confirmed')
    for update;
    select * into v_target from public.appointment_slots where id = p_slot_id for update;
  else
    select * into v_target from public.appointment_slots where id = p_slot_id for update;
    select * into v_existing
    from public.appointment_slots
    where id = v_existing_id
      and conversation_id = p_conversation_id
      and status in ('held', 'confirmed')
    for update;
  end if;

  if v_target.id is null or v_target.clinic_id <> v_conv.clinic_id then
    return query select 'not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_conv.status <> 'active'
    or v_conv.pet_id is null
    or v_conv.intake_stage not in ('appointment_offer', 'appointment_selection', 'appointment_confirmation')
  then
    return query select 'not_ready'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Fires regardless of which target was requested: once a conversation has
  -- a confirmed slot, it cannot hold a different one through this RPC.
  if v_existing.id is not null and v_existing.status = 'confirmed' then
    return query select 'conflict'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_target.status = 'confirmed'
    or (v_target.status = 'held' and v_target.conversation_id <> p_conversation_id and v_target.hold_until > v_now)
    or v_target.starts_at <= v_now
  then
    return query select 'unavailable'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Exact replay of the current unexpired hold: identity only, no extension.
  if v_target.id = v_existing.id and v_target.status = 'held' and v_target.hold_until > v_now then
    return query select 'held'::text, v_target.booking_token, v_target.starts_at, v_target.ends_at;
    return;
  end if;

  -- Switching targets: release the conversation's other held slot first so
  -- the partial unique index on (conversation_id) where held/confirmed is
  -- never violated mid-transaction.
  if v_existing.id is not null and v_existing.id <> v_target.id then
    update public.appointment_slots
      set status = 'available',
          conversation_id = null,
          owner_id = null,
          pet_id = null,
          booking_token = null,
          hold_until = null,
          confirmed_at = null
      where id = v_existing.id;
  end if;

  v_new_token := pg_catalog.gen_random_uuid();

  update public.appointment_slots
    set status = 'held',
        conversation_id = p_conversation_id,
        owner_id = v_conv.owner_id,
        pet_id = v_conv.pet_id,
        booking_token = v_new_token,
        hold_until = v_now + interval '10 minutes',
        confirmed_at = null
    where id = v_target.id;

  return query select 'held'::text, v_new_token, v_target.starts_at, v_target.ends_at;
  return;
end;
$$;

revoke all on function public.hold_appointment_slot(uuid, uuid) from public, anon, authenticated;
grant execute on function public.hold_appointment_slot(uuid, uuid) to service_role;

-- =========================================================================
-- RPC 3: confirm the current hold
-- =========================================================================

create function public.confirm_appointment_slot(
  p_conversation_id uuid,
  p_slot_id uuid,
  p_booking_token uuid
)
returns table (result text, starts_at timestamptz, ends_at timestamptz)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_conv public.conversations%rowtype;
  v_slot public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if p_conversation_id is null or p_slot_id is null or p_booking_token is null then
    raise exception 'confirm_appointment_slot: missing required input';
  end if;

  select * into v_conv
  from public.conversations
  where id = p_conversation_id
  for update;

  if not found then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_slot
  from public.appointment_slots
  where id = p_slot_id
  for update;

  if v_slot.id is null or v_slot.clinic_id <> v_conv.clinic_id then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Exact replay of an already-confirmed slot for this conversation/token
  -- stays idempotent even if the conversation later advanced past
  -- appointment_confirmation.
  if v_slot.status = 'confirmed'
    and v_slot.conversation_id = p_conversation_id
    and v_slot.booking_token = p_booking_token
  then
    return query select 'already_confirmed'::text, v_slot.starts_at, v_slot.ends_at;
    return;
  end if;

  if v_conv.status <> 'active' or v_conv.intake_stage <> 'appointment_confirmation' then
    return query select 'not_ready'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- Any expired, already-started, released, reclaimed, wrong-token, or
  -- wrong-conversation hold collapses to the same stale result with zero
  -- mutation.
  if v_slot.status <> 'held'
    or v_slot.conversation_id <> p_conversation_id
    or v_slot.booking_token <> p_booking_token
    or v_slot.hold_until is null
    or v_slot.hold_until <= v_now
    or v_slot.starts_at <= v_now
  then
    return query select 'stale'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  update public.appointment_slots
    set status = 'confirmed',
        hold_until = null,
        confirmed_at = v_now
    where id = v_slot.id;

  return query select 'confirmed'::text, v_slot.starts_at, v_slot.ends_at;
  return;
end;
$$;

revoke all on function public.confirm_appointment_slot(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.confirm_appointment_slot(uuid, uuid, uuid) to service_role;
