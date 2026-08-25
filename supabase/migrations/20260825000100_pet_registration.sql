-- Pet registration for first-time owners (Task 034 follow-on, "Adım 2").
--
-- Verified against the real migration history on 2026-08-25 (this file was
-- originally drafted in a sandboxed working copy that could only see 3
-- migrations, and carried its inferences as an explicit caveat; that caveat
-- is now resolved, not merely deleted):
--   * `public.finalize_intake_queue_job` was last defined in
--     `20260814000300_selective_automation.sql`; nothing after it — including
--     `20260822000100_strict_ai_allowlist.sql` — redefines it, so the drop
--     below targets the correct 9-argument signature and the body here is
--     that file's body plus the pet additions and nothing else.
--   * `public.conversations.intake_stage` / `intake_data` / `state_version`
--     exist as direct columns, added by
--     `20260806000200_conversation_intake_state.sql`.
--   * `public.advance_conversation_intake` and
--     `public.get_conversation_intake_context` exist with the parameter and
--     return shapes this file calls.
--   * `public.pets` carries the `pets_all` staff RLS policy
--     (`20260806000000_core_tenant_schema.sql`), which is why the
--     duplicate-name rule below is enforced in this RPC and not on the table.
--
-- Design (`CURRENT_TASK.md`, "Candidate follow-on task — pet onboarding"):
-- owner confirms the exact name (and species, if extracted) in one combined
-- message before any row is written (decision 1+3); a guard inside this RPC
-- blocks the AI path from creating a duplicate name for the same owner
-- (decision 2, as amended by Maya on 2026-08-25 — see below); the
-- bounded-attempt count for repeated pet-identification turns is derived at
-- read time from already-loaded recent messages, not persisted here
-- (decision 4) — no `schema_version` bump, no new column for that part.

-- =========================================================================
-- Decision 2, as amended by Maya on 2026-08-25: the duplicate-name guard is
-- NOT table-wide. An earlier draft of this migration created
--
--   create unique index pets_owner_normalized_name_key
--     on public.pets (owner_id, (lower(btrim(name))));
--
-- That index would also have applied to clinic staff inserting directly
-- through the existing `pets_all` RLS policy, turning a legitimate
-- real-world registration (two same-named pets for one owner) into an
-- unexplained `23505` in a code path that never asked for this rule. The
-- rule exists to stop the AI from silently creating a second row for a pet
-- the owner already registered, so it is enforced only on the AI write
-- path — inside `finalize_intake_queue_job`, below. Staff writes are
-- untouched by this migration.
--
-- `lower(btrim(name))` is a plain, immutable normalization — NOT a full
-- mirror of `intakeExtraction.ts`'s `normalizeForComparison` (NFKC +
-- Turkish-locale lowercasing). Two names that only differ under Turkish
-- dotted/dotless "I" casing rules still both pass this guard; the
-- application-level `resolvePet` check (unchanged, still exact-match only)
-- remains the authoritative match for reads.
-- =========================================================================

-- =========================================================================
-- Decision 1+2+3: extend the existing atomic finalize RPC (forward-only
-- replacement, same technique already used in
-- `20260814000300_selective_automation.sql` to add the `suppressed` result
-- to this same function) with two new, optional, default-null parameters.
-- When `p_create_pet_name` is supplied, the pet is inserted using the
-- already-tenant-resolved `v_clinic_id`/`v_owner_id` locals (unchanged from
-- the existing function body) before `advance_conversation_intake` is
-- called, so pet creation, the intake-stage advance, the reply-outbox
-- insert, and lease completion all remain one atomic call — no new
-- transaction boundary, no new RPC, no change to the existing
-- `p_reply_category` closed set (pet creation reuses the existing
-- `pet_identity` category for the confirmation ask/re-ask and the existing
-- `complaint` category for the turn immediately after a successful
-- creation, exactly as an already-registered pet's first turn does today).
-- =========================================================================

drop function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text);

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
    'emergency_handoff', 'human_handoff', 'safety_questions', 'pet_identity', 'complaint', 'intake_received'
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
    -- Decision 2 (amended): application-level duplicate guard, AI path only.
    -- A pre-existing same-name pet for this owner is an expected,
    -- non-exceptional outcome (the owner, or a clinic staff member, already
    -- registered that name), so the insert is made conditional rather than
    -- letting a constraint raise. Nothing here constrains staff writes.
    --
    -- Recorded ceiling: `where not exists` is a read-then-write check inside
    -- one transaction, not a constraint. Two finalize calls for the SAME
    -- owner running concurrently in two different conversations can both see
    -- no match and both insert. The per-conversation intake lease already
    -- serializes the ordinary case (one owner, one conversation, one claimed
    -- job at a time), and the residual window is accepted for the pilot. If
    -- duplicates are ever observed in practice, the upgrade path is a
    -- PARTIAL unique index covering only AI-created rows (which needs a
    -- provenance column on `public.pets` first) — never a table-wide one,
    -- for the reason recorded above.
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
