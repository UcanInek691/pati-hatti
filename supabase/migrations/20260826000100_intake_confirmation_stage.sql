-- Task 036, Maya's decision 1 (2026-08-26): the pet confirmation stops living
-- inside `pet_identification` and gets its own stage.
--
-- Design is fixed in `CURRENT_TASK.md`, "Stage model redesign". In short:
-- `intake_confirmation` is inserted between `complaint_collection` and
-- `safety_check`, so everything the bot has collected (pet name, species,
-- complaint) is put to the owner in one combined message, and the
-- `public.pets` row is written when that one message is confirmed.
--
-- Why a migration rather than reusing `pet_identification`: deferring the
-- confirmation until the complaint is known would otherwise mean collecting
-- complaints inside a stage named for pet identification. Maya rejected that
-- explicitly; the stage name has to describe what the stage does.
--
-- Verified against the real migration history on 2026-08-26:
--   * `public.conversations.intake_stage`'s CHECK constraint was created by
--     `20260806000200_conversation_intake_state.sql` and never altered since,
--     so the drop below targets the only definition.
--   * `public.advance_conversation_intake` was last defined in that same file;
--     nothing after it redefines the function, so the body below is that
--     file's body plus the rank-map change and nothing else.
--   * `public.finalize_intake_queue_job` was last defined in
--     `20260825000100_pet_registration.sql` in its 11-argument form; the body
--     below is that file's body plus the two allowlist additions and nothing
--     else.
--   * `public.outbound_message_outbox.reply_category`'s CHECK was created by
--     `20260809000100_intake_reply_outbox.sql` and last replaced by
--     `20260810000200_whatsapp_appointment_flow.sql`; the drop/re-add below
--     follows that same precedent.
--
-- No backfill. Stage ranks are computed inside `advance_conversation_intake`
-- from a local constant and are never stored on a row, so renumbering is free
-- for conversations already in flight. The one intended behavioral change for
-- them: a conversation parked in `complaint_collection` when this lands now
-- advances to `intake_confirmation` next instead of `safety_check`.

-- =========================================================================
-- 1. The stage vocabulary itself.
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
      'completed'
    )
  );

-- =========================================================================
-- 2. The rank map. Every rank stays consecutive, so the one-forward-step rule
--    below is unchanged in force — only its graph is longer by one node. That
--    rule is what makes an intake stage sequence auditable after the fact
--    (Task 035 criterion 4 was closed on exactly this guarantee); it must not
--    be weakened to let a stage be skipped.
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
  if p_next_stage is null or not (v_stage_rank ? p_next_stage) and p_next_stage <> 'human_handoff' then
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
    if v_current_stage in ('human_handoff', 'completed') then
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
-- 3. The reply category for the combined confirmation.
--
-- A message that confirms the pet's name, its species AND the complaint in one
-- breath is not `pet_identity`, and calling it that would leave the outbox
-- lying about what was sent. It gets its own value, following the drop/re-add
-- precedent from `20260810000200_whatsapp_appointment_flow.sql`.
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
      'appointment_unavailable'
    )
  );

-- =========================================================================
-- 4. The finalize RPC learns the new stage and the new category. Everything
--    else in this function — the lease checks, the automation-mode
--    suppression, the AI-path-only duplicate guard, the atomicity of pet
--    creation with the stage advance and the outbox insert — is byte-for-byte
--    the Task 035 body.
-- =========================================================================

drop function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text, text, text);

create function public.finalize_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb,
  p_reply_category text default null,
  p_reply_text text default null,
  p_create_pet_name text default null,
  p_create_pet_species text default null
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
  v_advance_stage text;
  v_advance_version integer;
  v_complete_result text;
  v_created_pet_id uuid;
  v_effective_pet_id uuid;
begin
  if p_conversation_id is null then
    raise exception 'finalize_intake_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'finalize_intake_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'finalize_intake_queue_job: invalid claim_token';
  end if;
  if p_expected_version is null or p_expected_version < 1 then
    raise exception 'finalize_intake_queue_job: invalid expected_version';
  end if;
  if p_next_stage is null or p_next_stage not in (
    'pet_identification',
    'complaint_collection',
    'intake_confirmation',
    'safety_check',
    'ready_for_triage',
    'appointment_offer',
    'appointment_selection',
    'appointment_confirmation',
    'human_handoff',
    'completed'
  ) then
    raise exception 'finalize_intake_queue_job: invalid next_stage';
  end if;
  if p_intake_data is null
    or jsonb_typeof(p_intake_data) <> 'object'
    or p_intake_data = '{}'::jsonb then
    raise exception 'finalize_intake_queue_job: invalid intake_data';
  end if;
  if (p_reply_category is null) <> (p_reply_text is null) then
    raise exception 'finalize_intake_queue_job: reply_category and reply_text must both be null or both be non-null';
  end if;
  if p_reply_category is not null and p_reply_category not in (
    'emergency_handoff', 'human_handoff', 'safety_questions', 'pet_identity',
    'intake_confirmation', 'complaint', 'intake_received'
  ) then
    raise exception 'finalize_intake_queue_job: invalid reply_category';
  end if;
  if p_reply_text is not null and (char_length(p_reply_text) < 1 or char_length(p_reply_text) > 4096) then
    raise exception 'finalize_intake_queue_job: invalid reply_text';
  end if;
  if p_create_pet_name is not null and (char_length(btrim(p_create_pet_name)) < 1 or char_length(p_create_pet_name) > 200) then
    raise exception 'finalize_intake_queue_job: invalid create_pet_name';
  end if;
  if p_create_pet_species is not null and p_create_pet_name is null then
    raise exception 'finalize_intake_queue_job: create_pet_species requires create_pet_name';
  end if;
  if p_create_pet_species is not null and (char_length(p_create_pet_species) < 1 or char_length(p_create_pet_species) > 100) then
    raise exception 'finalize_intake_queue_job: invalid create_pet_species';
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
    raise exception 'finalize_intake_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'finalize_intake_queue_job: conversation owner not found';
  end if;

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  if v_mode is distinct from 'ai' then
    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_intake_queue_job: lease completion unexpectedly failed after suppression';
    end if;

    return query select 'suppressed'::text, null::text, null::integer;
    return;
  end if;

  v_effective_pet_id := p_pet_id;

  if p_create_pet_name is not null then
    -- Decision 2 (amended, Task 035): application-level duplicate guard, AI
    -- path only. See `20260825000100_pet_registration.sql` for the full
    -- reasoning and the recorded concurrency ceiling; unchanged here.
    insert into public.pets (clinic_id, owner_id, name, species)
    select v_clinic_id, v_owner_id, btrim(p_create_pet_name), p_create_pet_species
    where not exists (
      select 1
      from public.pets existing
      where existing.owner_id = v_owner_id
        and lower(btrim(existing.name)) = lower(btrim(p_create_pet_name))
    )
    returning id into v_created_pet_id;

    if v_created_pet_id is null then
      return query select 'duplicate_pet_name'::text, null::text, null::integer;
      return;
    end if;

    v_effective_pet_id := v_created_pet_id;
  end if;

  select advanced.intake_stage, advanced.state_version
    into v_advance_stage, v_advance_version
  from public.advance_conversation_intake(
    p_conversation_id, p_expected_version, p_next_stage, v_effective_pet_id, p_intake_data
  ) advanced;

  if v_advance_stage is null then
    -- Task 035 closure note, still open and deliberately unchanged here: a
    -- plain `return` does not roll back an already-committed pet insert. That
    -- defect is tracked in `PROJECT_CONTEXT.md` and belongs to its own task —
    -- fixing it inside this migration would mix an unrelated behavior change
    -- into a stage-model migration.
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  if p_reply_category is not null then
    select o.phone_e164 into v_recipient_e164
    from public.owners o
    where o.id = v_owner_id and o.clinic_id = v_clinic_id;

    if v_recipient_e164 is null then
      raise exception 'finalize_intake_queue_job: conversation owner has no recipient phone number';
    end if;

    -- Plain constraint failure must raise (no ON CONFLICT DO NOTHING):
    -- silently accepting an existing mismatched reply would hide corruption.
    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
      recipient_e164, reply_category, content
    ) values (
      v_clinic_id, p_conversation_id, v_account_id, p_provider_message_id,
      v_recipient_e164, p_reply_category, p_reply_text
    );
  end if;

  select completed.result into v_complete_result
  from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

  if v_complete_result is distinct from 'completed' then
    raise exception 'finalize_intake_queue_job: lease completion unexpectedly failed after state advance';
  end if;

  return query select 'applied'::text, v_advance_stage, v_advance_version;
  return;
end;
$$;

revoke all on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text, text, text)
  to service_role;
