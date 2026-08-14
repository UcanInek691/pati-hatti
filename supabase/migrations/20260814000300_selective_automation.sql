-- Selective WhatsApp automation and manual takeover for VetAI (Task 033).
-- Codex applied this migration and validated its rollback fixture on
-- disposable `vetai-test` on 2026-08-14. Not applied to production. See docs/selective-automation.md,
-- docs/database-schema.md, and docs/inbound-queue.md.

-- =========================================================================
-- Account default and per-contact route table
-- =========================================================================

alter table public.whatsapp_accounts
  add column automation_default text not null default 'manual'
    check (automation_default in ('ai', 'manual'));

-- Backend-only, service-role-only table plus a same-clinic read policy for
-- /staff. No audit/history table: the current row is the whole model.
create table public.whatsapp_contact_routes (
  whatsapp_account_id uuid not null,
  clinic_id uuid not null,
  contact_e164 text not null check (contact_e164 ~ '^\+[1-9]\d{1,14}$'),
  mode text not null check (mode in ('ai', 'manual', 'personal')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (whatsapp_account_id, contact_e164),
  foreign key (whatsapp_account_id, clinic_id)
    references public.whatsapp_accounts (id, clinic_id) on delete cascade
);

create trigger set_updated_at before update on public.whatsapp_contact_routes
  for each row execute function vetai_private.set_updated_at();

alter table public.whatsapp_contact_routes enable row level security;

revoke all on public.whatsapp_contact_routes from anon, authenticated, public;
grant select on public.whatsapp_contact_routes to authenticated;
grant all on public.whatsapp_contact_routes to service_role;

create policy whatsapp_contact_routes_select on public.whatsapp_contact_routes
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

-- =========================================================================
-- Route resolution helpers (private; no direct authenticated/anon access)
-- =========================================================================

-- Pure override-or-default lookup; takes no lock. Used by the read-only
-- resolve RPC and by ingest, which first locks the exact account row.
create function vetai_private.effective_contact_automation_mode(
  p_whatsapp_account_id uuid,
  p_contact_e164 text
)
returns text
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_mode text;
begin
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

-- ponytail: the one shared locking helper Task 033 asks for, reused by
-- claim_intake_queue_job and all three finalizers below; revisit only if a
-- future task needs a different lock target than the conversation's owner.
create function vetai_private.lock_owner_and_resolve_automation(
  p_clinic_id uuid,
  p_whatsapp_account_id uuid,
  p_owner_id uuid
)
returns text
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_phone_e164 text;
begin
  select o.phone_e164 into v_phone_e164
  from public.owners o
  where o.id = p_owner_id and o.clinic_id = p_clinic_id
  for update;

  if v_phone_e164 is null then
    raise exception 'lock_owner_and_resolve_automation: owner not found';
  end if;

  return vetai_private.effective_contact_automation_mode(p_whatsapp_account_id, v_phone_e164);
end;
$$;

revoke all on function vetai_private.lock_owner_and_resolve_automation(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function vetai_private.lock_owner_and_resolve_automation(uuid, uuid, uuid)
  to service_role;

-- =========================================================================
-- Route lookup RPC for the inbound webhook (service-role only)
-- =========================================================================

create function public.resolve_whatsapp_contact_automation(
  p_phone_number_id text,
  p_contact_e164 text
)
returns table (result text)
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_account_id uuid;
  v_mode text;
begin
  if p_phone_number_id is null or char_length(p_phone_number_id) < 1 or char_length(p_phone_number_id) > 512 then
    raise exception 'resolve_whatsapp_contact_automation: invalid phone_number_id';
  end if;
  if p_contact_e164 is null or p_contact_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'resolve_whatsapp_contact_automation: invalid contact_e164';
  end if;

  select wa.id into v_account_id
  from public.whatsapp_accounts wa
  where wa.phone_number_id = p_phone_number_id;

  if v_account_id is null then
    return query select 'unknown_account'::text;
    return;
  end if;

  v_mode := vetai_private.effective_contact_automation_mode(v_account_id, p_contact_e164);

  return query select v_mode;
  return;
end;
$$;

revoke all on function public.resolve_whatsapp_contact_automation(text, text)
  from public, anon, authenticated;
grant execute on function public.resolve_whatsapp_contact_automation(text, text)
  to service_role;

-- =========================================================================
-- Authenticated route mutation RPC
-- =========================================================================

-- SECURITY DEFINER because it is called directly by authenticated staff
-- sessions and must authorize the target clinic itself (is_clinic_staff),
-- matching the one other authenticated-write pattern this schema already
-- has (staff work-item RPCs); every other RPC touched by this task stays
-- SECURITY INVOKER because only service_role ever calls it.
create function public.set_whatsapp_contact_route(
  p_whatsapp_account_id uuid,
  p_contact_e164 text,
  p_mode text
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_default_mode text;
  v_owner_id uuid;
  v_existing_mode text;
  v_deleted_count integer;
  v_final_mode text;
  v_result text;
begin
  if p_whatsapp_account_id is null then
    raise exception 'set_whatsapp_contact_route: invalid whatsapp_account_id';
  end if;
  if p_contact_e164 is null or p_contact_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'set_whatsapp_contact_route: invalid contact_e164';
  end if;
  if p_mode is null or p_mode not in ('ai', 'manual', 'personal', 'inherit') then
    raise exception 'set_whatsapp_contact_route: invalid mode';
  end if;

  -- Cross-tenant and absent accounts are indistinguishable: both fall
  -- through to not_found below.
  select wa.clinic_id, wa.automation_default into v_clinic_id, v_default_mode
  from public.whatsapp_accounts wa
  where wa.id = p_whatsapp_account_id
  for update;

  if v_clinic_id is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
  end if;

  -- Lock the owner row (if it already exists) before changing the route, so
  -- an in-flight finalizer that resolves the same owner via
  -- lock_owner_and_resolve_automation cannot insert a new pending outbox
  -- row after the cleanup below has already run.
  select o.id into v_owner_id
  from public.owners o
  where o.clinic_id = v_clinic_id and o.phone_e164 = p_contact_e164
  for update;

  if p_mode = 'inherit' then
    delete from public.whatsapp_contact_routes
      where whatsapp_account_id = p_whatsapp_account_id
        and contact_e164 = p_contact_e164;
    get diagnostics v_deleted_count = row_count;

    v_final_mode := v_default_mode;

    if v_deleted_count = 0 then
      v_result := 'unchanged';
    else
      v_result := 'updated';
    end if;
  else
    select r.mode into v_existing_mode
    from public.whatsapp_contact_routes r
    where r.whatsapp_account_id = p_whatsapp_account_id
      and r.contact_e164 = p_contact_e164;

    v_final_mode := p_mode;

    if v_existing_mode = p_mode then
      v_result := 'unchanged';
    else
      insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
      values (p_whatsapp_account_id, v_clinic_id, p_contact_e164, p_mode)
      on conflict (whatsapp_account_id, contact_e164) do update
        set mode = excluded.mode;

      v_result := 'updated';
    end if;
  end if;

  -- Only still-pending automated replies for this exact account/owner are
  -- removed; processing/accepted/failed rows are never touched, and a
  -- processing row may already be leaving the system and cannot be recalled.
  if v_final_mode in ('manual', 'personal') and v_owner_id is not null then
    delete from public.outbound_message_outbox oo
    using public.conversations c
    where oo.conversation_id = c.id
      and c.owner_id = v_owner_id
      and c.clinic_id = v_clinic_id
      and oo.whatsapp_account_id = p_whatsapp_account_id
      and oo.delivery_status = 'pending';
  end if;

  return query select v_result;
  return;
end;
$$;

revoke all on function public.set_whatsapp_contact_route(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_whatsapp_contact_route(uuid, text, text)
  to authenticated;

-- =========================================================================
-- ingest_whatsapp_text_message: recheck the route before any write
-- =========================================================================

-- Forward-only replacement of the Task 017 function; signature and
-- two-column return shape stay the same, AI-path validation/idempotency/
-- tenant behavior stays the same, and two new closed results (`ignored`,
-- `manual`) are added.
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
  v_mode text;
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
  where wa.phone_number_id = p_phone_number_id
  for key share;

  if v_clinic_id is null then
    return query select 'unknown_account'::text, null::uuid;
    return;
  end if;

  -- Recheck the route inside this transaction, before any event/owner/
  -- conversation/message write: closes the race between the caller's
  -- pre-route envelope check and this write.
  v_mode := vetai_private.effective_contact_automation_mode(v_account_id, p_sender_e164);

  if v_mode = 'personal' then
    return query select 'ignored'::text, null::uuid;
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

      return query select case when v_mode = 'manual' then 'manual' else 'duplicate' end, v_conversation_id;
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

  if v_mode = 'manual' then
    -- Persisted like an AI event, but the intake lease is never opened:
    -- terminally completed at write time so it can never be claimed.
    update public.webhook_events
      set processing_status = 'processed', processed_at = pg_catalog.now(),
          intake_status = 'completed', intake_completed_at = pg_catalog.now()
      where id = v_event_id;

    return query select 'manual'::text, v_conversation_id;
    return;
  end if;

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
-- claim_intake_queue_job: return the current automation mode
-- =========================================================================

-- Forward-only replacement of the Task 012 function; the return shape grows
-- by one column, so the old signature must be dropped before recreating it.
drop function public.claim_intake_queue_job(uuid, text);

create function public.claim_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text
)
returns table (result text, claim_token uuid, message_text text, automation_mode text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_message_content text;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_intake_lease_until timestamptz;
  v_new_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_mode text;
begin
  if p_conversation_id is null then
    raise exception 'claim_intake_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'claim_intake_queue_job: invalid provider_message_id';
  end if;

  -- Tenant safety comes from the message row itself (its own clinic_id),
  -- never from a caller-supplied clinic id: the join ties the event to
  -- exactly the message's own clinic.
  select we.id, m.content, we.intake_status, we.intake_claim_token, we.intake_lease_until,
      we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_message_content, v_intake_status, v_intake_claim_token, v_intake_lease_until,
      v_clinic_id, v_account_id
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
    return query select 'not_found'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'completed'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_intake_status = 'processing' and v_intake_lease_until > pg_catalog.now() then
    return query select 'busy'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_account_id is null then
    raise exception 'claim_intake_queue_job: inbound event has no linked whatsapp_account_id';
  end if;

  select c.owner_id into v_owner_id
  from public.conversations c
  where c.id = p_conversation_id and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'claim_intake_queue_job: conversation owner not found';
  end if;

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  -- Pending, or an expired processing lease: claimable with a fresh token.
  v_new_token := pg_catalog.gen_random_uuid();

  update public.webhook_events
    set intake_status = 'processing',
        intake_claim_token = v_new_token,
        intake_lease_until = pg_catalog.now() + interval '120 seconds'
    where id = v_event_id;

  if v_mode is distinct from 'ai' then
    return query select 'claimed'::text, v_new_token, null::text, v_mode;
    return;
  end if;

  return query select 'claimed'::text, v_new_token, v_message_content, v_mode;
  return;
end;
$$;

revoke all on function public.claim_intake_queue_job(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_intake_queue_job(uuid, text) to service_role;

-- =========================================================================
-- Finalizers: recheck the route before any conversation/slot/outbox write
-- =========================================================================

-- Forward-only replacement of the Task 017 function; signature and return
-- shape stay the same, one new closed `suppressed` result is added.
drop function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text);

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
  v_mode text;
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

revoke all on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text)
  from public, anon, authenticated;
grant execute on function public.finalize_intake_queue_job(uuid, text, uuid, integer, text, uuid, jsonb, text, text)
  to service_role;

-- Forward-only replacement of the Task 022 function; signature and return
-- shape stay the same, one new closed `suppressed` result is added.
drop function public.finalize_appointment_offer_queue_job(uuid, text, uuid, integer, text, uuid, jsonb);

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
  v_mode text;
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

-- Forward-only replacement of the Task 022 function; signature and return
-- shape stay the same, one new closed `suppressed` result is added.
drop function public.finalize_appointment_decision_queue_job(uuid, text, uuid, integer, text, uuid, jsonb);

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
  v_mode text;
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

  v_mode := vetai_private.lock_owner_and_resolve_automation(v_clinic_id, v_account_id, v_owner_id);

  if v_mode is distinct from 'ai' then
    select completed.result into v_complete_result
    from public.complete_intake_queue_job(p_conversation_id, p_provider_message_id, p_claim_token) completed;

    if v_complete_result is distinct from 'completed' then
      raise exception 'finalize_appointment_decision_queue_job: lease completion unexpectedly failed after suppression';
    end if;

    return query select 'suppressed'::text, null::text, null::integer;
    return;
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
      'Ayrılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.'
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
