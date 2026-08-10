-- Wires the reviewed Task 022 appointment engine into the intake Queue
-- consumer: two atomic finalizers compose the existing one-step
-- advance/list/hold/confirm/lease-completion RPCs so a single-slot
-- EVET/HAYIR confirmation flow stays coherent with Queue claim, conversation
-- state, slot mutation, outbox reply, and lease completion. Not applied to
-- any database by Sonnet; Codex alone validates this on disposable
-- vetai-test. See docs/whatsapp-appointment-flow.md, docs/database-schema.md,
-- and docs/appointment-booking-engine.md.

-- =========================================================================
-- Reply categories: extend the existing outbox CHECK
-- =========================================================================

-- Forward-only replacement of the six-value CHECK from
-- 20260809000100_intake_reply_outbox.sql; the six existing values are
-- preserved exactly and four appointment-flow values are added. No other
-- outbox table privilege, RLS, delivery-state, index, routing, or erasure
-- behavior changes.
alter table public.outbound_message_outbox
  drop constraint outbound_message_outbox_reply_category_check;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_reply_category_check
  check (reply_category in (
    'emergency_handoff',
    'human_handoff',
    'safety_questions',
    'pet_identity',
    'complaint',
    'intake_received',
    'appointment_offer',
    'appointment_confirmed',
    'appointment_declined',
    'appointment_unavailable'
  ));

-- =========================================================================
-- RPC 1: offer the earliest eligible slot atomically
-- =========================================================================

-- ponytail: composes the existing advance/list/hold RPCs and duplicates the
-- account/owner/recipient resolution already proven in
-- finalize_intake_queue_job rather than extracting a shared helper, matching
-- this task's own "copy the smallest local finalization code necessary; do
-- not create a generic SQL execution framework" instruction.
create function public.finalize_appointment_offer_queue_job(
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
  v_stage text;
  v_version integer;
  v_slot_id uuid;
  v_hold_result text;
  v_hold_token uuid;
  v_hold_starts_at timestamptz;
  v_hold_ends_at timestamptz;
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
  -- fires (offered vs. no-slot handoff); resolved once, never from caller
  -- input.
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

  -- Step 6: the advisory list lost the race (or any other non-held
  -- outcome) -> raise so the whole transaction rolls back for Queue retry;
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
-- RPC 2: decide the current hold atomically
-- =========================================================================

create function public.finalize_appointment_decision_queue_job(
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
  v_conv_status text;
  v_conv_stage text;
  v_conv_version integer;
  v_slot public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
  v_has_valid_hold boolean;
  v_stage text;
  v_version integer;
  v_confirm_result text;
  v_confirm_starts_at timestamptz;
  v_confirm_ends_at timestamptz;
  v_copy text;
  v_complete_result text;
begin
  if p_conversation_id is null then
    raise exception 'finalize_appointment_decision_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'finalize_appointment_decision_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'finalize_appointment_decision_queue_job: invalid claim_token';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'finalize_appointment_decision_queue_job: invalid expected_version';
  end if;
  if p_decision is null or p_decision not in ('confirm', 'decline', 'repeat') then
    raise exception 'finalize_appointment_decision_queue_job: invalid decision';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'finalize_appointment_decision_queue_job: invalid intake_data';
  end if;
  if p_pet_id is null then
    raise exception 'finalize_appointment_decision_queue_job: invalid pet_id';
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
    raise exception 'finalize_appointment_decision_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'finalize_appointment_decision_queue_job: conversation owner not found';
  end if;

  select o.phone_e164 into v_recipient_e164
  from public.owners o
  where o.id = v_owner_id and o.clinic_id = v_clinic_id;

  if v_recipient_e164 is null then
    raise exception 'finalize_appointment_decision_queue_job: conversation owner has no recipient phone number';
  end if;

  -- Lock the conversation first (Task 022's own conversation-before-slot
  -- lock order), then require it to be exactly where the caller expects.
  select c.status, c.intake_stage, c.state_version
    into v_conv_status, v_conv_stage, v_conv_version
  from public.conversations c
  where c.id = p_conversation_id
  for update;

  if v_conv_status is distinct from 'active'
    or v_conv_stage is distinct from 'appointment_selection'
    or v_conv_version is distinct from p_expected_version then
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  -- Lock this conversation's single current held/confirmed slot, if any.
  select * into v_slot
  from public.appointment_slots s
  where s.conversation_id = p_conversation_id
    and s.status in ('held', 'confirmed')
  for update;

  -- A confirmed slot while still at appointment_selection can only mean
  -- corrupted state (confirmation always advances past this stage in the
  -- same transaction): raise and roll back rather than invent success.
  if v_slot.id is not null and v_slot.status = 'confirmed' then
    raise exception 'finalize_appointment_decision_queue_job: impossible confirmed slot % at appointment_selection', v_slot.id;
  end if;

  v_has_valid_hold := v_slot.id is not null
    and v_slot.status = 'held'
    and v_slot.hold_until is not null
    and v_slot.hold_until > v_now
    and v_slot.starts_at > v_now;

  if (p_decision = 'confirm' or p_decision = 'repeat') and not v_has_valid_hold then
    -- No current unexpired future hold: never confirm/repeat a replacement
    -- slot silently, route to human handoff instead.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'human_handoff', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state advancing to human_handoff';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_unavailable',
      'Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_decision_queue_job: lease completion unexpectedly failed after stale hold';
    end if;

    return query select 'stale_hold'::text, v_stage, v_version;
    return;

  elsif p_decision = 'confirm' then
    -- confirm_appointment_slot itself requires intake_stage =
    -- appointment_confirmation, so advance one step before calling it.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'appointment_confirmation', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state advancing to appointment_confirmation';
    end if;

    select r.result, r.starts_at, r.ends_at
      into v_confirm_result, v_confirm_starts_at, v_confirm_ends_at
    from public.confirm_appointment_slot(p_conversation_id, v_slot.id, v_slot.booking_token) r;

    if v_confirm_result <> 'confirmed' then
      raise exception 'finalize_appointment_decision_queue_job: confirm_appointment_slot returned unexpected result %', v_confirm_result;
    end if;

    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'completed', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state advancing to completed';
    end if;

    v_copy := 'Randevunuz '
      || to_char(v_confirm_starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
      || ' için oluşturuldu.';

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_confirmed', v_copy
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_decision_queue_job: lease completion unexpectedly failed after confirm';
    end if;

    return query select 'confirmed'::text, v_stage, v_version;
    return;

  elsif p_decision = 'decline' then
    -- Safe even if the hold already expired, or if there is no row left to
    -- release at all (v_slot.id is null): decline never creates a
    -- confirmed slot either way.
    if v_slot.id is not null then
      update public.appointment_slots
        set status = 'available',
            conversation_id = null,
            owner_id = null,
            pet_id = null,
            booking_token = null,
            hold_until = null,
            confirmed_at = null
        where id = v_slot.id;
    end if;

    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'appointment_confirmation', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state advancing to appointment_confirmation (decline)';
    end if;

    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, v_version, 'completed', null, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state advancing to completed (decline)';
    end if;

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, 'appointment_declined', 'Randevu oluşturulmadı.'
    );

    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_decision_queue_job: lease completion unexpectedly failed after decline';
    end if;

    return query select 'declined'::text, v_stage, v_version;
    return;

  else
    -- repeat with a valid hold: never mutate slot/token/lease, same-stage
    -- advance only, repeat the exact held-slot prompt unchanged.
    select advanced.intake_stage, advanced.state_version
      into v_stage, v_version
    from public.advance_conversation_intake(
      p_conversation_id, p_expected_version, 'appointment_selection', p_pet_id, p_intake_data
    ) advanced;

    if v_stage is null then
      raise exception 'finalize_appointment_decision_queue_job: unexpected stale_state on repeat';
    end if;

    v_copy := 'En erken uygun randevu saati: '
      || to_char(v_slot.starts_at at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')
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
      raise exception 'finalize_appointment_decision_queue_job: lease completion unexpectedly failed after repeat';
    end if;

    return query select 'repeated'::text, v_stage, v_version;
    return;
  end if;
end;
$$;

revoke all on function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb)
  to service_role;
