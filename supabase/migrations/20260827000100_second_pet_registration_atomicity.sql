-- Task 037: second-pet registration and atomic pet finalization.
-- Disposable validation: APPLIED to `vetai-test` via the SQL Editor and the
-- rollback fixture passed on 2026-08-27. This did not add a CLI migration-
-- history row. NOT APPLIED to staging or production.
--
-- This migration touches `public.finalize_intake_queue_job` only.
-- `public.advance_conversation_intake`, the `conversations.intake_stage`
-- CHECK, and the `outbound_message_outbox.reply_category` CHECK are all
-- unchanged from `20260826000100_intake_confirmation_stage.sql` and are not
-- redefined here.
--
-- Verified against the real migration history on 2026-08-27:
--   * `public.finalize_intake_queue_job` was last defined in
--     `20260826000100_intake_confirmation_stage.sql` in its current
--     11-argument form; the body below is that file's body with exactly one
--     behavioral change (Decision 7/8 below) and nothing else. The
--     signature, result shape, grants, `SECURITY INVOKER`, volatility,
--     empty search path, selective-automation suppression, reply
--     validation, tenant derivation, duplicate guard, outbox behavior, and
--     lease completion semantics are all byte-for-byte unchanged.
--
-- Decision 7/8 (CURRENT_TASK.md, Task 037): before this migration, the
-- function inserted a pet row and only afterward called
-- `advance_conversation_intake`, discovering a stale `p_expected_version`
-- from that call's empty result. Because both statements run inside this
-- same function's transaction, that stale discovery did not roll the insert
-- back -- a plain `return` after the insert had already run left an
-- orphaned pet row committed, `conversations.pet_id` unchanged, and the
-- intake lease still processing until expiry. That defect is recorded in
-- `PROJECT_CONTEXT.md`'s Task 036 closure note and reproduced live in the
-- Task 036 smoke test.
--
-- The fix: lock the exact tenant-scoped conversation row and verify
-- `state_version = p_expected_version` before any pet insert is attempted.
-- A mismatch returns the existing closed `stale_state` result with zero
-- pet/outbox/state mutation, exactly like every other stale-version path in
-- this function. Once that lock/version check has succeeded, no concurrent
-- transaction can have changed this row before we commit, so a later
-- zero-row result from `advance_conversation_intake` is now an invariant
-- violation rather than an expected race outcome, and must raise so the
-- whole transaction (including the pet insert) rolls back.

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
  v_locked_version integer;
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

  -- Decision 7 (Task 037): lock the exact tenant-scoped conversation row and
  -- verify the expected version before any pet insert. This must run before
  -- the `p_create_pet_name` block below, not after it.
  select c.state_version into v_locked_version
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id
  for update;

  if v_locked_version is null then
    raise exception 'finalize_intake_queue_job: conversation not found for locking';
  end if;

  if v_locked_version is distinct from p_expected_version then
    return query select 'stale_state'::text, null::text, null::integer;
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
    -- Decision 8 (Task 037): the row lock and version check above already
    -- guarantee this cannot happen -- no concurrent transaction can have
    -- advanced `state_version` past our locked read before we commit or
    -- roll back. Treating it as a plain `stale_state` return here would
    -- silently commit the pet insert above under an invariant violation;
    -- raising instead rolls back this entire transaction, pet insert
    -- included.
    raise exception 'finalize_intake_queue_job: advance_conversation_intake returned no row after the version check succeeded';
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
