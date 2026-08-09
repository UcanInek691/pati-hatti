-- Atomic intake reply outbox and exact inbound WhatsApp account preservation
-- for VetAI. Validated in disposable `vetai-test` with
-- supabase/tests/017_intake_reply_outbox.sql on 2026-08-09; production still
-- requires the managed migration workflow. See docs/database-schema.md,
-- docs/inbound-queue.md, and docs/intake-replies.md.

-- =========================================================================
-- Preserve the inbound WhatsApp account
-- =========================================================================

-- Lets composite tenant-safe foreign keys target the exact account used for
-- an inbound event, matching the (id, clinic_id) pattern already used by
-- owners/pets/conversations.
alter table public.whatsapp_accounts
  add unique (id, clinic_id);

-- Nullable only for rows written before this migration; every new webhook
-- event persists both the clinic and the exact account.
alter table public.webhook_events
  add column whatsapp_account_id uuid;

alter table public.webhook_events
  add foreign key (whatsapp_account_id, clinic_id)
  references public.whatsapp_accounts (id, clinic_id);

-- Forward-only replacement of the Task 010 function; only the body changes
-- (resolve + persist the exact account), the signature and two-column return
-- shape stay the same.
drop function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz);

create function public.ingest_whatsapp_text_message(
  p_phone_number_id text,
  p_provider_message_id text,
  p_payload_hash text,
  p_sender_e164 text,
  p_owner_name text,
  p_message_text text,
  p_provider_timestamp timestamptz
)
returns table (result text, conversation_id uuid)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_conversation_id uuid;
  v_event_id uuid;
  v_existing_hash text;
  v_existing_account_id uuid;
begin
  if p_phone_number_id is null or char_length(p_phone_number_id) < 1 or char_length(p_phone_number_id) > 512 then
    raise exception 'ingest_whatsapp_text_message: invalid phone_number_id';
  end if;
  if p_provider_message_id is null or char_length(p_provider_message_id) < 1 or char_length(p_provider_message_id) > 512 then
    raise exception 'ingest_whatsapp_text_message: invalid provider_message_id';
  end if;
  if p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'ingest_whatsapp_text_message: invalid payload_hash';
  end if;
  if p_sender_e164 is null or p_sender_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'ingest_whatsapp_text_message: invalid sender_e164';
  end if;
  if p_owner_name is null or char_length(p_owner_name) < 1 or char_length(p_owner_name) > 200 then
    raise exception 'ingest_whatsapp_text_message: invalid owner_name';
  end if;
  if p_message_text is null or char_length(p_message_text) < 1 or char_length(p_message_text) > 65536 then
    raise exception 'ingest_whatsapp_text_message: invalid message_text';
  end if;
  if p_provider_timestamp is null then
    raise exception 'ingest_whatsapp_text_message: invalid provider_timestamp';
  end if;

  -- Resolve tenant and exact account before writing anything; an unknown
  -- account writes nothing.
  select wa.id, wa.clinic_id into v_account_id, v_clinic_id
  from public.whatsapp_accounts wa
  where wa.phone_number_id = p_phone_number_id;

  if v_clinic_id is null then
    return query select 'unknown_account'::text, null::uuid;
    return;
  end if;

  -- Claim idempotency first: concurrent duplicate deliveries race here, and
  -- only one wins the insert.
  insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, whatsapp_account_id)
  values (v_clinic_id, p_provider_message_id, p_payload_hash, 'received', v_account_id)
  on conflict (clinic_id, provider_event_id) do nothing
  returning id into v_event_id;

  if v_event_id is null then
    select we.payload_hash, we.whatsapp_account_id into v_existing_hash, v_existing_account_id
    from public.webhook_events we
    where we.clinic_id = v_clinic_id
      and we.provider_event_id = p_provider_message_id
    for update;

    if v_existing_hash = p_payload_hash then
      -- Backfill a legacy null account link; a conflicting non-null account
      -- means the redelivery arrived through a different account than the
      -- one originally recorded, which must never be silently accepted.
      if v_existing_account_id is null then
        update public.webhook_events
          set whatsapp_account_id = v_account_id
          where clinic_id = v_clinic_id
            and provider_event_id = p_provider_message_id
            and whatsapp_account_id is null;
      elsif v_existing_account_id <> v_account_id then
        raise exception 'ingest_whatsapp_text_message: conflicting whatsapp_account_id for provider_event_id %', p_provider_message_id;
      end if;

      -- Always tenant-scoped: the provider message ID alone is not unique
      -- across clinics, so it must never be searched without clinic_id.
      select m.conversation_id into v_conversation_id
      from public.messages m
      where m.clinic_id = v_clinic_id
        and m.whatsapp_message_id = p_provider_message_id;

      if v_conversation_id is null then
        raise exception 'ingest_whatsapp_text_message: duplicate event has no persisted message for provider_event_id %', p_provider_message_id;
      end if;

      return query select 'duplicate'::text, v_conversation_id;
      return;
    end if;

    raise exception 'ingest_whatsapp_text_message: payload_hash mismatch for provider_event_id %', p_provider_message_id;
  end if;

  -- Upsert-then-touch: a plain no-op DO UPDATE always returns the row via
  -- RETURNING, unlike a conditional DO UPDATE ... WHERE, which returns no
  -- row at all when its condition is false.
  insert into public.owners (clinic_id, phone_e164, full_name)
  values (v_clinic_id, p_sender_e164, p_owner_name)
  on conflict (clinic_id, phone_e164) do update
    set clinic_id = excluded.clinic_id
  returning id into v_owner_id;

  -- Only replace the fallback placeholder name; never overwrite a real one.
  update public.owners
    set full_name = p_owner_name
    where id = v_owner_id
      and full_name = 'WhatsApp user'
      and p_owner_name <> 'WhatsApp user';

  insert into public.conversations (clinic_id, owner_id, status)
  values (v_clinic_id, v_owner_id, 'active')
  on conflict (clinic_id, owner_id) where status in ('active', 'handoff') do update
    set clinic_id = excluded.clinic_id
  returning id into v_conversation_id;

  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic_id, v_conversation_id, 'inbound', p_message_text, p_provider_message_id, p_provider_timestamp);

  update public.webhook_events
    set processing_status = 'processed', processed_at = pg_catalog.now()
    where id = v_event_id;

  return query select 'processed'::text, v_conversation_id;
  return;
end;
$$;

revoke all on function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.ingest_whatsapp_text_message(text, text, text, text, text, text, timestamptz)
  to service_role;

-- =========================================================================
-- Pending outbound reply outbox
-- =========================================================================

-- Backend-only, service-role-only table: represents one planned reply not
-- yet sent. Task 018 owns claim/send/completion and any delivered-message
-- history row; this task adds no delivery state, leases, attempts, or
-- provider response data.
create table public.outbound_message_outbox (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null,
  conversation_id uuid not null,
  whatsapp_account_id uuid not null,
  source_provider_message_id text not null check (char_length(source_provider_message_id) between 1 and 512),
  recipient_e164 text not null check (recipient_e164 ~ '^\+[1-9]\d{1,14}$'),
  reply_category text not null check (reply_category in (
    'emergency_handoff', 'human_handoff', 'safety_questions', 'pet_identity', 'complaint', 'intake_received'
  )),
  content text not null check (char_length(content) between 1 and 4096),
  created_at timestamptz not null default now(),
  foreign key (conversation_id, clinic_id)
    references public.conversations (id, clinic_id) on delete cascade,
  foreign key (whatsapp_account_id, clinic_id)
    references public.whatsapp_accounts (id, clinic_id) on delete cascade,
  foreign key (clinic_id, source_provider_message_id)
    references public.webhook_events (clinic_id, provider_event_id) on delete cascade,
  -- At most one planned reply per inbound event inside a tenant.
  unique (clinic_id, source_provider_message_id)
);

create index outbound_message_outbox_created_at_id_idx
  on public.outbound_message_outbox (created_at, id);

alter table public.outbound_message_outbox enable row level security;

-- No policy is created: with RLS enabled and no matching policy, anon and
-- authenticated get zero rows/writes by default. Staff must not see
-- recipient phone numbers through this backend-only table.
revoke all on public.outbound_message_outbox from anon, authenticated, public;
grant all on public.outbound_message_outbox to service_role;

-- =========================================================================
-- Extend atomic finalization with the pending reply
-- =========================================================================

-- Forward-only replacement of the Task 013 function; the parameter list
-- grows (return shape does not), so the old signature must be dropped
-- before recreating it.
drop function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb);

-- ponytail: derives clinic/account/owner/recipient inside the function from
-- already-tenant-safe rows instead of accepting them as input, so a caller
-- can never pass a mismatched routing value; revisit only if a future task
-- needs routing data the locked event/conversation/owner rows can't supply.
create function public.finalize_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb,
  p_reply_category text default null,
  p_reply_text text default null
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
  v_advance_stage text;
  v_advance_version integer;
  v_complete_result text;
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

  select advanced.intake_stage, advanced.state_version
    into v_advance_stage, v_advance_version
  from public.advance_conversation_intake(
    p_conversation_id, p_expected_version, p_next_stage, p_pet_id, p_intake_data
  ) advanced;

  if v_advance_stage is null then
    return query select 'stale_state'::text, null::text, null::integer;
    return;
  end if;

  if p_reply_category is not null then
    if v_account_id is null then
      raise exception 'finalize_intake_queue_job: inbound event has no linked whatsapp_account_id';
    end if;

    select c.owner_id into v_owner_id
    from public.conversations c
    where c.id = p_conversation_id
      and c.clinic_id = v_clinic_id;

    if v_owner_id is null then
      raise exception 'finalize_intake_queue_job: conversation owner not found';
    end if;

    select o.phone_e164 into v_recipient_e164
    from public.owners o
    where o.id = v_owner_id
      and o.clinic_id = v_clinic_id;

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

revoke all on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text)
  to service_role;
