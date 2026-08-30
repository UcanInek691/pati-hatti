-- Task 039 Part A + Part B: per-pet appointment integrity and owner-initiated
-- cancellation.
--
-- Part A adds a pet-scoped (not merely conversation-scoped) guard against a
-- second active appointment for the same pet. It is enforced entirely by
-- locked-RPC logic, never by a unique index: a partial unique index cannot
-- depend on volatile now(), so it cannot express "no future confirmed slot"
-- or "no unexpired hold" without also permanently blocking the pet after any
-- past appointment.
--
-- Lock order (identical across every RPC touched by this migration that
-- checks or changes an appointment for a pet): conversation row, then the
-- tenant-scoped pet row, then appointment_slots row(s). Two different
-- conversations for the same pet always lock their own (distinct)
-- conversation row first, so they only ever contend on the shared pet lock,
-- never deadlock.
--
-- Part B adds one closed stage (appointment_cancel_confirmation), a
-- backend-only cancellation-audit table, and two new finalize RPCs that
-- mirror the existing appointment offer/decision RPCs' claim-validation and
-- suppression-check template exactly.

-- =========================================================================
-- Pet-scoped lookup index (non-unique: a lookup aid only, never the
-- invariant itself -- see the note above).
-- =========================================================================

create index appointment_slots_active_pet_idx
  on public.appointment_slots (pet_id)
  where status in ('held', 'confirmed');

-- Refuse to advertise the new invariant over legacy data that already
-- violates it. The regular CREATE INDEX above keeps appointment-slot writes
-- blocked until this migration commits, so the validation and the function
-- replacements below form one safe cut-over.
do $$
begin
  if exists (
    select 1
    from public.appointment_slots s
    where s.pet_id is not null
      and (
        (s.status = 'confirmed' and s.starts_at > pg_catalog.now())
        or (s.status = 'held' and s.hold_until > pg_catalog.now())
      )
    group by s.clinic_id, s.pet_id
    having count(*) > 1
  ) then
    raise exception 'Task 039: existing pet has more than one upcoming active appointment';
  end if;
end;
$$;

-- =========================================================================
-- Stage vocabulary: add appointment_cancel_confirmation.
-- =========================================================================

alter table public.conversations
  drop constraint conversations_intake_stage_check;

alter table public.conversations
  add constraint conversations_intake_stage_check check (
    intake_stage in (
      'pet_identification',
      'complaint_collection',
      'intake_confirmation',
      'safety_check',
      'ready_for_triage',
      'appointment_offer',
      'appointment_selection',
      'appointment_confirmation',
      'human_handoff',
      'completed',
      'appointment_cancel_confirmation'
    )
  );

-- =========================================================================
-- Reply category vocabulary: add the four cancellation-flow categories.
-- =========================================================================

alter table public.outbound_message_outbox
  drop constraint outbound_message_outbox_reply_category_check;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_reply_category_check check (
    reply_category in (
      'emergency_handoff',
      'human_handoff',
      'safety_questions',
      'pet_identity',
      'intake_confirmation',
      'complaint',
      'intake_received',
      'appointment_offer',
      'appointment_confirmed',
      'appointment_declined',
      'appointment_unavailable',
      'appointment_cancel_offer',
      'appointment_cancelled',
      'appointment_cancel_declined',
      'appointment_cancel_unavailable'
    )
  );

-- =========================================================================
-- advance_conversation_intake: two new special-cased edges, mirroring the
-- existing human_handoff special case.
--
--   1. (any stage except human_handoff) -> appointment_cancel_confirmation,
--      INCLUDING from the terminal `completed` stage -- a booked
--      appointment is normally cancelled well after the original intake
--      conversation already reached `completed`. This is a deliberate,
--      narrow carve-out of the "human_handoff/completed are terminal" rule;
--      no other stage gains a new way out of `completed`.
--   2. appointment_cancel_confirmation -> completed, once EVET/HAYIR/repeat
--      has been resolved (mirrors how the booking decision RPC always ends
--      at `completed` whether confirmed or declined).
--   3. appointment_offer -> completed when the pet-wide guard proves a
--      future confirmed appointment already exists and no new hold is made.
--
-- Everything else (rank map, human_handoff special case, same-stage
-- repeats) is unchanged.
-- =========================================================================

create or replace function public.advance_conversation_intake(
  p_conversation_id uuid,
  p_expected_version integer,
  p_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (
  intake_stage text,
  state_version integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_owner_id uuid;
  v_current_stage text;
  v_current_status text;
  v_next_status text;
  v_updated_stage text;
  v_updated_version integer;
  v_stage_rank constant jsonb := '{
    "pet_identification": 0,
    "complaint_collection": 1,
    "intake_confirmation": 2,
    "safety_check": 3,
    "ready_for_triage": 4,
    "appointment_offer": 5,
    "appointment_selection": 6,
    "appointment_confirmation": 7,
    "completed": 8
  }'::jsonb;
begin
  if p_conversation_id is null then
    raise exception 'advance_conversation_intake: invalid conversation_id';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'advance_conversation_intake: invalid expected_version';
  end if;
  if p_next_stage is null
    or (
      not (v_stage_rank ? p_next_stage)
      and p_next_stage <> 'human_handoff'
      and p_next_stage <> 'appointment_cancel_confirmation'
    )
  then
    raise exception 'advance_conversation_intake: invalid next_stage';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'advance_conversation_intake: invalid intake_data';
  end if;

  select c.clinic_id, c.owner_id, c.intake_stage, c.status
    into v_clinic_id, v_owner_id, v_current_stage, v_current_status
  from public.conversations c
  where c.id = p_conversation_id;

  if v_clinic_id is null then
    raise exception 'advance_conversation_intake: unknown conversation_id';
  end if;

  if p_pet_id is not null and not exists (
    select 1 from public.pets p
    where p.id = p_pet_id and p.owner_id = v_owner_id and p.clinic_id = v_clinic_id
  ) then
    raise exception 'advance_conversation_intake: pet does not belong to the conversation owner/clinic';
  end if;

  if p_next_stage <> v_current_stage then
    if p_next_stage = 'appointment_cancel_confirmation' and v_current_stage <> 'human_handoff' then
      null; -- Task 039 Part B: cancellation is reachable from any stage,
            -- including the terminal `completed` stage, except human_handoff.
    elsif v_current_stage = 'completed' and p_next_stage = 'human_handoff' then
      null; -- a cancellation turn carrying a safety/human signal must keep
            -- deterministic handoff precedence over the cancellation flow.
    elsif v_current_stage = 'appointment_cancel_confirmation' and p_next_stage = 'completed' then
      null; -- Task 039 Part B: cancellation always resolves back to completed.
    elsif v_current_stage = 'appointment_offer' and p_next_stage = 'completed' then
      null; -- pet-wide guard: an existing confirmed appointment closes the offer.
    elsif v_current_stage in ('human_handoff', 'completed') then
      raise exception 'advance_conversation_intake: % is terminal', v_current_stage;
    elsif p_next_stage = 'human_handoff' then
      null; -- any non-terminal stage may hand off
    elsif (v_stage_rank -> p_next_stage)::integer = (v_stage_rank -> v_current_stage)::integer + 1 then
      null; -- exactly one forward step in the fixed graph
    else
      raise exception 'advance_conversation_intake: illegal transition from % to %', v_current_stage, p_next_stage;
    end if;
  end if;

  v_next_status := v_current_status;
  if p_next_stage = 'human_handoff' then
    v_next_status := 'handoff';
  elsif p_next_stage = 'completed' then
    v_next_status := 'completed';
  elsif p_next_stage = 'appointment_cancel_confirmation' then
    v_next_status := 'active'; -- re-engages a possibly already-`completed` conversation
  end if;

  update public.conversations c
    set intake_stage = p_next_stage,
        intake_data = p_intake_data,
        pet_id = coalesce(p_pet_id, c.pet_id),
        state_version = c.state_version + 1,
        status = v_next_status
    where c.id = p_conversation_id
      and c.state_version = p_expected_version
  returning c.intake_stage, c.state_version into v_updated_stage, v_updated_version;

  if not found then
    return;
  end if;

  intake_stage := v_updated_stage;
  state_version := v_updated_version;
  return next;
end;
$$;

revoke all on function public.advance_conversation_intake(uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.advance_conversation_intake(uuid, integer, text, uuid, jsonb)
  to service_role;

-- =========================================================================
-- hold_appointment_slot: add the pet-scoped guard. Return shape is
-- unchanged -- 'existing_confirmed' and 'in_progress' reuse the existing
-- starts_at/ends_at columns (null for in_progress, since that outcome never
-- discloses another conversation's hold time).
-- =========================================================================

create or replace function public.hold_appointment_slot(
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
  v_pet public.pets%rowtype;
  v_existing_id uuid;
  v_target public.appointment_slots%rowtype;
  v_existing public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_new_token uuid;
  v_pet_confirmed_starts timestamptz;
  v_pet_confirmed_ends timestamptz;
begin
  if p_conversation_id is null or p_slot_id is null then
    raise exception 'hold_appointment_slot: missing required input';
  end if;

  -- Lock order (Task 039 Part A item 2): conversation, then pet, then
  -- appointment_slots. Locking the conversation first also serializes every
  -- hold/confirm call for the same conversation behind this one row lock.
  select * into v_conv
  from public.conversations
  where id = p_conversation_id
  for update;

  if not found then
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

  select * into v_pet
  from public.pets
  where id = v_conv.pet_id and owner_id = v_conv.owner_id and clinic_id = v_conv.clinic_id
  for update;

  if v_pet.id is null then
    raise exception 'hold_appointment_slot: conversation pet_id does not resolve to a tenant-scoped pet';
  end if;

  -- Part A items 1 and 3: a future confirmed appointment for this pet --
  -- under any conversation, including this one -- always wins. Past
  -- confirmed slots never block a new booking. No hold is created; the
  -- caller must report only this pet's existing date/time, never claim a
  -- new booking or staff notification.
  select s.starts_at, s.ends_at into v_pet_confirmed_starts, v_pet_confirmed_ends
  from public.appointment_slots s
  where s.pet_id = v_pet.id
    and s.clinic_id = v_conv.clinic_id
    and s.status = 'confirmed'
    and s.starts_at > v_now
  order by s.starts_at
  limit 1;

  if v_pet_confirmed_starts is not null then
    return query select 'existing_confirmed'::text, null::uuid, v_pet_confirmed_starts, v_pet_confirmed_ends;
    return;
  end if;

  -- Part A item 4: an unexpired hold owned by a *different* conversation
  -- blocks a new hold. It is never described as confirmed, and its
  -- date/time is never disclosed to a conversation that does not own it.
  if exists (
    select 1 from public.appointment_slots s
    where s.pet_id = v_pet.id
      and s.clinic_id = v_conv.clinic_id
      and s.status = 'held'
      and s.hold_until > v_now
      and s.conversation_id <> p_conversation_id
  ) then
    return query select 'in_progress'::text, null::uuid, null::timestamptz, null::timestamptz;
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
-- confirm_appointment_slot: use the same conversation -> tenant-scoped pet
-- -> slot lock order as hold/cancel. Without the pet lock, a confirmation at
-- the exact hold-expiry boundary can race a second conversation reclaiming a
-- different slot and leave one confirmed appointment plus a second hold.
-- =========================================================================

create or replace function public.confirm_appointment_slot(
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
  v_pet public.pets%rowtype;
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

  if v_conv.pet_id is null then
    return query select 'not_ready'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  select * into v_pet
  from public.pets p
  where p.id = v_conv.pet_id
    and p.owner_id = v_conv.owner_id
    and p.clinic_id = v_conv.clinic_id
  for update;

  if v_pet.id is null then
    raise exception 'confirm_appointment_slot: conversation pet_id does not resolve to a tenant-scoped pet';
  end if;

  select * into v_slot
  from public.appointment_slots
  where id = p_slot_id
  for update;

  if v_slot.id is null or v_slot.clinic_id <> v_conv.clinic_id then
    return query select 'not_found'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_slot.status = 'confirmed'
    and v_slot.conversation_id = p_conversation_id
    and v_slot.pet_id = v_pet.id
    and v_slot.booking_token = p_booking_token
  then
    return query select 'already_confirmed'::text, v_slot.starts_at, v_slot.ends_at;
    return;
  end if;

  if v_conv.status <> 'active' or v_conv.intake_stage <> 'appointment_confirmation' then
    return query select 'not_ready'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_slot.status <> 'held'
    or v_slot.conversation_id <> p_conversation_id
    or v_slot.pet_id <> v_pet.id
    or v_slot.booking_token <> p_booking_token
    or v_slot.hold_until is null
    or v_slot.hold_until <= v_now
    or v_slot.starts_at <= v_now
  then
    return query select 'stale'::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- The pet row is still held here, so no other conversation can pass the
  -- pet-wide active-appointment check until this confirmation commits.
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

-- The Task 033 decision finalizer pre-locks its held slot before calling
-- confirm_appointment_slot. Keep its reviewed body intact but move it behind
-- a public wrapper that establishes the complete event -> owner ->
-- conversation -> pet lock prefix first. The private body then re-enters
-- those already-held locks and takes the slot last. PostgREST exposes only
-- the public wrapper, so the runtime cannot bypass the pet lock.
alter function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  rename to finalize_appointment_decision_queue_job_locked_body;
alter function public.finalize_appointment_decision_queue_job_locked_body(uuid, text, uuid, integer, text, uuid, jsonb)
  set schema vetai_private;

revoke all on function vetai_private.finalize_appointment_decision_queue_job_locked_body(uuid, text, uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function vetai_private.finalize_appointment_decision_queue_job_locked_body(uuid, text, uuid, integer, text, uuid, jsonb)
  to service_role;

create function public.finalize_appointment_decision_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_decision text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (result text, intake_stage text, state_version integer)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_conversation_pet_id uuid;
  v_locked_pet_id uuid;
begin
  -- The private body remains the authority for input/result behavior. This
  -- prefix only establishes locks when the current claim resolves cleanly.
  select we.id, we.intake_status, we.intake_claim_token, we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_intake_status, v_intake_claim_token, v_clinic_id, v_account_id
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = p_provider_message_id
  where m.conversation_id = p_conversation_id
    and m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound'
    and we.processing_status = 'processed'
  for update of we;

  if v_event_id is not null
    and v_intake_status = 'processing'
    and v_intake_claim_token is not distinct from p_claim_token
    and v_account_id is not null
  then
    select c.owner_id into v_owner_id
    from public.conversations c
    where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

    if v_owner_id is not null then
      perform vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

      select c.pet_id into v_conversation_pet_id
      from public.conversations c
      where c.id = p_conversation_id
        and c.clinic_id = v_clinic_id
        and c.owner_id = v_owner_id
      for update;

      if v_conversation_pet_id is null or v_conversation_pet_id is distinct from p_pet_id then
        raise exception 'finalize_appointment_decision_queue_job: pet does not match the selected conversation pet';
      end if;

      select p.id into v_locked_pet_id
      from public.pets p
      where p.id = p_pet_id
        and p.owner_id = v_owner_id
        and p.clinic_id = v_clinic_id
      for update;

      if v_locked_pet_id is null then
        raise exception 'finalize_appointment_decision_queue_job: pet does not resolve to a tenant-scoped pet';
      end if;
    end if;
  end if;

  return query
  select f.result, f.intake_stage, f.state_version
  from vetai_private.finalize_appointment_decision_queue_job_locked_body(
    p_conversation_id, p_provider_message_id, p_claim_token, p_expected_version,
    p_decision, p_pet_id, p_intake_data
  ) f;
end;
$$;

revoke all on function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  to service_role;

-- =========================================================================
-- finalize_appointment_offer_queue_job: handle hold_appointment_slot's two
-- new result kinds. Signature/return shape unchanged.
-- =========================================================================

create or replace function public.finalize_appointment_offer_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_planned_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (
  result text,
  intake_stage text,
  state_version integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_recipient_e164 text;
  v_mode text;
  v_stage text;
  v_version integer;
  v_slot_id uuid;
  v_hold_result text;
  v_hold_token uuid;
  v_hold_starts_at timestamptz;
  v_hold_ends_at timestamptz;
  v_pet_name text;
  v_copy text;
  v_complete_result text;
begin
  if p_conversation_id is null then
    raise exception 'finalize_appointment_offer_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'finalize_appointment_offer_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'finalize_appointment_offer_queue_job: invalid claim_token';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'finalize_appointment_offer_queue_job: invalid expected_version';
  end if;
  if p_planned_next_stage is null or p_planned_next_stage not in ('ready_for_triage', 'appointment_offer') then
    raise exception 'finalize_appointment_offer_queue_job: invalid planned_next_stage';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'finalize_appointment_offer_queue_job: invalid intake_data';
  end if;
  if p_pet_id is null then
    raise exception 'finalize_appointment_offer_queue_job: invalid pet_id';
  end if;

  select we.id, we.intake_status, we.intake_claim_token, we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_intake_status, v_intake_claim_token, v_clinic_id, v_account_id
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = p_provider_message_id
  where m.conversation_id = p_conversation_id
    and m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound'
    and we.processing_status = 'processed'
  for update of we;

  if v_event_id is null then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'already_completed'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status is distinct from 'processing'
    or v_intake_claim_token is distinct from p_claim_token then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  -- Routing data is fixed for this event regardless of which branch below
  -- fires; resolved once, never from caller input.
  if v_account_id is null then
    raise exception 'finalize_appointment_offer_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'finalize_appointment_offer_queue_job: conversation owner not found';
  end if;

  select o.phone_e164 into v_recipient_e164
  from public.owners o
  where o.id = v_owner_id and o.clinic_id = v_clinic_id;

  if v_recipient_e164 is null then
    raise exception 'finalize_appointment_offer_queue_job: conversation owner has no recipient phone number';
  end if;

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  if v_mode is distinct from 'ai' then
    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_offer_queue_job: lease completion unexpectedly failed after suppression';
    end if;

    return query select 'suppressed'::text, null::text, null::integer;
    return;
  end if;

  -- Step 1: apply the planner's validated next stage/pet/data at the
  -- expected version.
  select advanced.intake_stage, advanced.state_version
    into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id, p_expected_version, p_planned_next_stage, p_pet_id, p_intake_data
  ) advanced;

  if v_stage is null then
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  -- Step 2: advance one step at a time until appointment_offer; never skip
  -- by a direct conversation update.
  if v_stage = 'ready_for_triage' then
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'appointment_offer', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_offer_queue_job: unexpected stale_state advancing to appointment_offer';
    end if;
  end if;

  if v_stage <> 'appointment_offer' then
    raise exception 'finalize_appointment_offer_queue_job: unexpected intake_stage % after advance', v_stage;
  end if;

  -- Step 3: select only the earliest eligible slot for the conversation's
  -- own clinic in the next 31 days. Advisory only: may lose a race below.
  select s.slot_id into v_slot_id
  from public.list_available_appointment_slots(
    p_conversation_id, pg_catalog.now(), pg_catalog.now() + interval '31 days', 1
  ) s;

  if v_slot_id is null then
    -- Step 5: no eligible slot -> human_handoff + truthful no-slot copy.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'human_handoff', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_offer_queue_job: unexpected stale_state advancing to human_handoff';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_unavailable',
      'Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen kliniğimizi telefonla arayın.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_offer_queue_job: lease completion unexpectedly failed after handoff';
    end if;

    return query select 'unavailable'::text, v_stage, v_version;
    return;
  end if;

  -- Step 3 (cont'd): attempt the hold through the reviewed RPC.
  select h.result, h.booking_token, h.starts_at, h.ends_at
    into v_hold_result, v_hold_token, v_hold_starts_at, v_hold_ends_at
  from public.hold_appointment_slot(p_conversation_id, v_slot_id) h;

  if v_hold_result = 'existing_confirmed' then
    -- Part A item 3: this pet already has a future confirmed appointment.
    -- No hold was created; advance straight to completed with a fixed,
    -- truthful reply naming only the pet and its existing date/time.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'completed', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_offer_queue_job: unexpected stale_state advancing to completed (existing_confirmed)';
    end if;

    select p.name into v_pet_name
    from public.pets p
    where p.id = p_pet_id and p.clinic_id = v_clinic_id;

    v_copy := coalesce(v_pet_name, 'Dostunuzun') || ' için zaten '
      || to_char(v_hold_starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || ' tarihinde onaylanmış bir randevu bulunuyor.';

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_unavailable', v_copy
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_offer_queue_job: lease completion unexpectedly failed after existing_confirmed';
    end if;

    return query select 'existing_confirmed'::text, v_stage, v_version;
    return;
  end if;

  if v_hold_result = 'in_progress' then
    -- Part A item 4: a different conversation holds an unexpired slot for
    -- this same pet. No second hold is created and its time is never
    -- disclosed.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'human_handoff', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_offer_queue_job: unexpected stale_state advancing to human_handoff (in_progress)';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_unavailable',
      'Bu randevu şu anda başka bir görüşmede işleme alınıyor. Lütfen kliniğimizi telefonla arayın.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_offer_queue_job: lease completion unexpectedly failed after in_progress';
    end if;

    return query select 'in_progress'::text, v_stage, v_version;
    return;
  end if;

  -- Step 6: any other non-held outcome (the advisory list lost the race,
  -- etc.) -> raise so the whole transaction rolls back for Queue retry;
  -- never commit a stage without a matching hold/reply.
  if v_hold_result <> 'held' then
    raise exception 'finalize_appointment_offer_queue_job: could not hold slot % (result %)', v_slot_id, v_hold_result;
  end if;

  -- Step 4: advance to appointment_selection and persist the offer reply
  -- with the exact held slot time.
  select advanced.intake_stage, advanced.state_version
    into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id, v_version, 'appointment_selection', null, p_intake_data
  ) advanced;

  if v_stage is null then
    raise exception 'finalize_appointment_offer_queue_job: unexpected stale_state advancing to appointment_selection';
  end if;

  v_copy := 'En erken uygun randevu saati: '
    || to_char(v_hold_starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
    || '. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.';

  insert into public.outbound_message_outbox (
    clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
    recipient_e164, reply_category, content
  ) values (
    v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
    v_recipient_e164, 'appointment_offer', v_copy
  );

  select completed.result into v_complete_result
  from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

  if v_complete_result is distinct from 'completed' then
    raise exception 'finalize_appointment_offer_queue_job: lease completion unexpectedly failed after offer';
  end if;

  return query select 'offered'::text, v_stage, v_version;
  return;
end;
$$;

revoke all on function public.finalize_appointment_offer_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_offer_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  to service_role;

-- =========================================================================
-- Backend-only cancellation-audit table (Part B item 7). Stores only
-- identifiers and appointment/cancellation timestamps -- no phone, message
-- body, complaint, model output, or provider payload. Every FK cascades so
-- owner/pet/clinic erasure removes this record too.
-- =========================================================================

create table public.appointment_cancellations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  appointment_slot_id uuid not null references public.appointment_slots (id) on delete cascade,
  owner_id uuid not null,
  pet_id uuid not null,
  conversation_id uuid not null,
  appointment_starts_at timestamptz not null,
  appointment_ends_at timestamptz not null,
  cancelled_at timestamptz not null default pg_catalog.now(),
  created_at timestamptz not null default pg_catalog.now(),

  foreign key (owner_id, clinic_id) references public.owners (id, clinic_id) on delete cascade,
  foreign key (pet_id, owner_id, clinic_id) references public.pets (id, owner_id, clinic_id) on delete cascade,
  foreign key (conversation_id, owner_id, clinic_id) references public.conversations (id, owner_id, clinic_id) on delete cascade
);

alter table public.appointment_cancellations enable row level security;
revoke all on public.appointment_cancellations from public, anon, authenticated;
grant all on public.appointment_cancellations to service_role;

-- =========================================================================
-- finalize_appointment_cancel_offer_queue_job: enters
-- appointment_cancel_confirmation. Looks up exactly one future confirmed
-- appointment for the resolved pet, writes no cancellation, and pins the
-- exact slot id into intake_data (`pending_cancel_slot_id`) so the decision
-- RPC below re-validates that exact appointment rather than any replacement
-- that might exist by the time EVET/HAYIR arrives.
-- =========================================================================

create function public.finalize_appointment_cancel_offer_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (
  result text,
  intake_stage text,
  state_version integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_recipient_e164 text;
  v_mode text;
  v_stage text;
  v_version integer;
  v_pet public.pets%rowtype;
  v_slot public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_pinned_data jsonb;
  v_copy text;
  v_complete_result text;
begin
  if p_conversation_id is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid claim_token';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid expected_version';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid intake_data';
  end if;
  if p_pet_id is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: invalid pet_id';
  end if;

  select we.id, we.intake_status, we.intake_claim_token, we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_intake_status, v_intake_claim_token, v_clinic_id, v_account_id
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = p_provider_message_id
  where m.conversation_id = p_conversation_id
    and m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound'
    and we.processing_status = 'processed'
  for update of we;

  if v_event_id is null then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'already_completed'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status is distinct from 'processing'
    or v_intake_claim_token is distinct from p_claim_token then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  if v_account_id is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: conversation owner not found';
  end if;

  select o.phone_e164 into v_recipient_e164
  from public.owners o
  where o.id = v_owner_id and o.clinic_id = v_clinic_id;

  if v_recipient_e164 is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: conversation owner has no recipient phone number';
  end if;

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  if v_mode is distinct from 'ai' then
    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_offer_queue_job: lease completion unexpectedly failed after suppression';
    end if;

    return query select 'suppressed'::text, null::text, null::integer;
    return;
  end if;

  -- Lock order (Task 039 Part A item 2): conversation, then pet, then
  -- appointment_slots -- identical to hold_appointment_slot.
  select advanced.intake_stage, advanced.state_version
    into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id, p_expected_version, 'appointment_cancel_confirmation', p_pet_id, p_intake_data
  ) advanced;

  if v_stage is null then
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  select * into v_pet
  from public.pets
  where id = p_pet_id and owner_id = v_owner_id and clinic_id = v_clinic_id
  for update;

  if v_pet.id is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: pet does not resolve to a tenant-scoped pet';
  end if;

  select * into v_slot
  from public.appointment_slots
  where pet_id = v_pet.id
    and clinic_id = v_clinic_id
    and status = 'confirmed'
    and starts_at > v_now
  order by starts_at
  limit 1
  for update;

  if v_slot.id is null then
    -- Part B item 6 (entry case): nothing to cancel -- truthful, no mutation.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'completed', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_cancel_offer_queue_job: unexpected stale_state advancing to completed (no_appointment)';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_cancel_unavailable',
      'Kaydınızda iptal edilebilecek onaylanmış bir randevu bulamadım. Lütfen kliniğimizi telefonla arayın.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_offer_queue_job: lease completion unexpectedly failed after no_appointment';
    end if;

    return query select 'no_appointment'::text, v_stage, v_version;
    return;
  end if;

  v_pinned_data := p_intake_data || jsonb_build_object('pending_cancel_slot_id', v_slot.id::text);

  select advanced.intake_stage, advanced.state_version
    into v_stage, v_version
  from public.advance_conversation_intake(
    p_conversation_id, v_version, 'appointment_cancel_confirmation', p_pet_id, v_pinned_data
  ) advanced;

  if v_stage is null then
    raise exception 'finalize_appointment_cancel_offer_queue_job: unexpected stale_state pinning pending_cancel_slot_id';
  end if;

  v_copy := 'Randevunuz: '
    || to_char(v_slot.starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
    || '. Bu randevuyu iptal etmek istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.';

  insert into public.outbound_message_outbox (
    clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
    recipient_e164, reply_category, content
  ) values (
    v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
    v_recipient_e164, 'appointment_cancel_offer', v_copy
  );

  select completed.result into v_complete_result
  from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

  if v_complete_result is distinct from 'completed' then
    raise exception 'finalize_appointment_cancel_offer_queue_job: lease completion unexpectedly failed after offer';
  end if;

  return query select 'offered'::text, v_stage, v_version;
  return;
end;
$$;

revoke all on function public.finalize_appointment_cancel_offer_queue_job(uuid, text, uuid, integer, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_cancel_offer_queue_job(uuid, text, uuid, integer, uuid, jsonb)
  to service_role;

-- =========================================================================
-- finalize_appointment_cancel_decision_queue_job: resolves the pinned
-- appointment with exact-text EVET ('cancel') / HAYIR ('keep') / anything
-- else ('repeat') discipline, mirroring finalize_appointment_decision_queue_job.
-- =========================================================================

create function public.finalize_appointment_cancel_decision_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_decision text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table (
  result text,
  intake_stage text,
  state_version integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_recipient_e164 text;
  v_mode text;
  v_conv_status text;
  v_conv_stage text;
  v_conv_version integer;
  v_pet public.pets%rowtype;
  v_pending_slot_id uuid;
  v_slot public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_still_valid boolean;
  v_stage text;
  v_version integer;
  v_copy text;
  v_complete_result text;
begin
  if p_conversation_id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid claim_token';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid expected_version';
  end if;
  if p_decision is null or p_decision not in ('cancel', 'keep', 'repeat') then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid decision';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid intake_data';
  end if;
  if p_pet_id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: invalid pet_id';
  end if;

  select we.id, we.intake_status, we.intake_claim_token, we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_intake_status, v_intake_claim_token, v_clinic_id, v_account_id
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = p_provider_message_id
  where m.conversation_id = p_conversation_id
    and m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound'
    and we.processing_status = 'processed'
  for update of we;

  if v_event_id is null then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'already_completed'::text, null::text, null::integer;
    return;
  end if;

  if v_intake_status is distinct from 'processing'
    or v_intake_claim_token is distinct from p_claim_token then
    return query select 'stale_claim'::text, null::text, null::integer;
    return;
  end if;

  if v_account_id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: conversation owner not found';
  end if;

  select o.phone_e164 into v_recipient_e164
  from public.owners o
  where o.id = v_owner_id and o.clinic_id = v_clinic_id;

  if v_recipient_e164 is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: conversation owner has no recipient phone number';
  end if;

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  if v_mode is distinct from 'ai' then
    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_decision_queue_job: lease completion unexpectedly failed after suppression';
    end if;

    return query select 'suppressed'::text, null::text, null::integer;
    return;
  end if;

  -- Lock order (Task 039 Part A item 2): conversation, then pet, then the
  -- pinned appointment_slots row.
  select c.status, c.intake_stage, c.state_version
    into v_conv_status, v_conv_stage, v_conv_version
  from public.conversations c
  where c.id = p_conversation_id
  for update;

  if v_conv_stage is distinct from 'appointment_cancel_confirmation'
    or v_conv_version is distinct from p_expected_version then
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  select * into v_pet
  from public.pets
  where id = p_pet_id and owner_id = v_owner_id and clinic_id = v_clinic_id
  for update;

  if v_pet.id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: pet does not resolve to a tenant-scoped pet';
  end if;

  v_pending_slot_id := nullif(p_intake_data ->> 'pending_cancel_slot_id', '')::uuid;

  if v_pending_slot_id is null then
    raise exception 'finalize_appointment_cancel_decision_queue_job: missing pending_cancel_slot_id';
  end if;

  -- Part B item 6: re-validate the exact pinned appointment -- never cancel
  -- a replacement. It must still be this pet's, still confirmed, and still
  -- in the future.
  select * into v_slot
  from public.appointment_slots
  where id = v_pending_slot_id
    and clinic_id = v_clinic_id
    and pet_id = v_pet.id
  for update;

  v_still_valid := v_slot.id is not null
    and v_slot.status = 'confirmed'
    and v_slot.starts_at > v_now;

  if not v_still_valid then
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'completed', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_cancel_decision_queue_job: unexpected stale_state advancing to completed (stale_appointment)';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_cancel_unavailable',
      'Bu randevu artık mevcut değil ya da daha önce iptal edilmiş görünüyor. Lütfen kliniğimizi telefonla arayın.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_decision_queue_job: lease completion unexpectedly failed after stale_appointment';
    end if;

    return query select 'stale_appointment'::text, v_stage, v_version;
    return;

  elsif p_decision = 'cancel' then
    insert into public.appointment_cancellations (
      clinic_id, appointment_slot_id, owner_id, pet_id, conversation_id,
      appointment_starts_at, appointment_ends_at, cancelled_at
    ) values (
      v_clinic_id, v_slot.id, v_owner_id, v_pet.id, p_conversation_id,
      v_slot.starts_at, v_slot.ends_at, v_now
    );

    update public.appointment_slots
      set status = 'available',
          conversation_id = null,
          owner_id = null,
          pet_id = null,
          booking_token = null,
          hold_until = null,
          confirmed_at = null
      where id = v_slot.id;

    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'completed', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_cancel_decision_queue_job: unexpected stale_state advancing to completed (cancel)';
    end if;

    v_copy := 'Randevunuz '
      || to_char(v_slot.starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || ' iptal edildi.';

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_cancelled', v_copy
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_decision_queue_job: lease completion unexpectedly failed after cancel';
    end if;

    return query select 'cancelled'::text, v_stage, v_version;
    return;

  elsif p_decision = 'keep' then
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'completed', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_cancel_decision_queue_job: unexpected stale_state advancing to completed (keep)';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_cancel_declined',
      'Randevunuz iptal edilmedi, mevcut haliyle geçerliliğini koruyor.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_decision_queue_job: lease completion unexpectedly failed after keep';
    end if;

    return query select 'kept'::text, v_stage, v_version;
    return;

  else
    -- repeat with a still-valid appointment: never mutate, same-stage
    -- advance only, repeat the exact confirmation question unchanged.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'appointment_cancel_confirmation', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_cancel_decision_queue_job: unexpected stale_state on repeat';
    end if;

    v_copy := 'Randevunuz: '
      || to_char(v_slot.starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || '. Bu randevuyu iptal etmek istediğinize emin misiniz? Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.';

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_cancel_offer', v_copy
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_cancel_decision_queue_job: lease completion unexpectedly failed after repeat';
    end if;

    return query select 'repeated'::text, v_stage, v_version;
    return;
  end if;
end;
$$;

revoke all on function public.finalize_appointment_cancel_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_cancel_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  to service_role;
