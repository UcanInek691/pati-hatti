-- Task 039 Part C: bounded multi-message user turns.
--
-- Uses Cloudflare Queue's native per-message `delaySeconds: 3` (already set
-- on every intake enqueue) instead of a dependency, timer service or
-- Durable Object: a message queued for a given inbound text always fires
-- its job ~3 seconds after that text was received, so any message that
-- arrives within that window is already visible in the database by the
-- time the job runs.
--
-- `webhook_events.ai_burst_eligible` is written exactly once, at ingest, by
-- `ingest_whatsapp_text_message`; nothing in this migration ever updates it
-- afterward. Only a direct text message admitted under exact `ai` mode is
-- eligible; manual mode and the unsupported-media marker are always false.
-- Personal/group content is never persisted at all, so it never reaches
-- this column either way.
--
-- `claim_intake_queue_job` uses each eligible message's own
-- `webhook_events.received_at` (server receipt time, not the WhatsApp
-- client-supplied `messages.created_at`) to order and window a burst, since
-- the provider timestamp is only second-granular and two quick messages can
-- share the same value.

alter table public.webhook_events
  add column ai_burst_eligible boolean not null default false;

-- =========================================================================
-- ingest_whatsapp_text_message: stamp ai_burst_eligible at ingest, forever
-- immutable afterward.
-- =========================================================================

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
  -- only one wins the insert. Task 039 Part C: eligible for a burst only
  -- when the model will actually see this exact text under `ai` mode -- the
  -- unsupported-media marker is real text but must never be coalesced with
  -- a neighboring message, so it is excluded by name here rather than left
  -- to whatever the consumer later decides to do with it.
  insert into public.webhook_events (
    clinic_id, provider_event_id, payload_hash, processing_status, whatsapp_account_id, ai_burst_eligible
  )
  values (
    v_clinic_id, p_provider_message_id, p_payload_hash, 'received', v_account_id,
    v_mode = 'ai' and p_message_text <> '__vetai_unsupported_media__'
  )
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
-- claim_intake_queue_job: bound and aggregate an eligible burst instead of
-- always claiming exactly one message.
-- =========================================================================

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
  v_current_received_at timestamptz;
  v_current_burst_eligible boolean;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_intake_lease_until timestamptz;
  v_new_token uuid;
  v_clinic_id uuid;
  v_account_id uuid;
  v_owner_id uuid;
  v_mode text;
  v_intake_stage text;
  v_last_outbound_at timestamptz;
  v_group_start timestamptz;
  v_first_group_start timestamptz;
  v_newest_at timestamptz;
  v_newest_provider_id text;
  v_window_count integer;
  v_assembled_text text;
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
  select we.id, m.content, we.received_at, we.ai_burst_eligible,
      we.intake_status, we.intake_claim_token, we.intake_lease_until,
      we.clinic_id, we.whatsapp_account_id
    into v_event_id, v_message_content, v_current_received_at, v_current_burst_eligible,
      v_intake_status, v_intake_claim_token, v_intake_lease_until,
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

  select c.owner_id, c.intake_stage into v_owner_id, v_intake_stage
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

  -- Unsupported media and pre-migration rows are deliberately ineligible.
  -- They retain the pre-Task-039 single-message behavior; ineligible must
  -- never mean silently superseded.
  if v_current_burst_eligible is distinct from true then
    return query select 'claimed'::text, v_new_token, v_message_content, v_mode;
    return;
  end if;

  -- Exact confirmation stages must only ever see their own current raw
  -- message; never aggregate a burst underneath a deterministic
  -- EVET/HAYIR grammar or a terminal stage.
  if v_intake_stage in (
    'intake_confirmation', 'appointment_selection',
    'appointment_cancel_confirmation', 'human_handoff', 'completed'
  ) then
    return query select 'claimed'::text, v_new_token, v_message_content, v_mode;
    return;
  end if;

  select pg_catalog.max(m3.created_at) into v_last_outbound_at
  from public.messages m3
  where m3.clinic_id = v_clinic_id
    and m3.conversation_id = p_conversation_id
    and m3.direction = 'outbound';

  -- Partition current-turn eligible messages into disjoint, deterministic
  -- windows anchored at each window's first message. A superseded completed
  -- sibling stays visible until the next outbound; any still-incomplete
  -- event stays visible even if a prior window has since written an outbound.
  -- Using only outbound timestamps would drop that later fixed window if its
  -- Queue job happened to run first. This
  -- prevents a transitive chain (t=0s, 2s, 4s) from superseding the 0s
  -- message and then assembling only the 2s+4s tail. Every window spans at
  -- most three seconds, and ties are stable by webhook-event id.
  with recursive ordered as materialized (
    select we2.id, we2.provider_event_id, we2.received_at,
      row_number() over (order by we2.received_at, we2.id) as rn
    from public.webhook_events we2
    join public.messages m2
      on m2.clinic_id = we2.clinic_id and m2.whatsapp_message_id = we2.provider_event_id
    where we2.clinic_id = v_clinic_id
      and m2.conversation_id = p_conversation_id
      and m2.direction = 'inbound'
      and we2.ai_burst_eligible = true
      and (
        we2.received_at > coalesce(v_last_outbound_at, '-infinity'::timestamptz)
        or we2.intake_status <> 'completed'
      )
  ), grouped as (
    select o.id, o.provider_event_id, o.received_at, o.rn, o.received_at as group_start
    from ordered o where o.rn = 1
    union all
    select o.id, o.provider_event_id, o.received_at, o.rn,
      case
        when o.received_at <= g.group_start + interval '3 seconds' then g.group_start
        else o.received_at
      end
    from grouped g
    join ordered o on o.rn = g.rn + 1
  )
  select
    pg_catalog.max(g.group_start) filter (where g.provider_event_id = p_provider_message_id),
    pg_catalog.min(g.group_start)
    into v_group_start, v_first_group_start
  from grouped g;

  if v_group_start is null then
    raise exception 'claim_intake_queue_job: eligible message was not assigned to a burst window';
  end if;

  -- A later fixed window cannot overtake an earlier incomplete one. Return
  -- this event to pending so Cloudflare's bounded retry can try it after the
  -- earlier window has either finalized or exhausted its own lease.
  if v_group_start > v_first_group_start then
    update public.webhook_events
      set intake_status = 'pending', intake_claim_token = null,
          intake_lease_until = null, intake_completed_at = null
      where id = v_event_id;
    return query select 'busy'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select we2.received_at, we2.provider_event_id
    into v_newest_at, v_newest_provider_id
  from public.webhook_events we2
  join public.messages m2
    on m2.clinic_id = we2.clinic_id and m2.whatsapp_message_id = we2.provider_event_id
  where we2.clinic_id = v_clinic_id
    and m2.conversation_id = p_conversation_id
    and m2.direction = 'inbound'
    and we2.ai_burst_eligible = true
    and (
      we2.received_at > coalesce(v_last_outbound_at, '-infinity'::timestamptz)
      or we2.intake_status <> 'completed'
    )
    and we2.received_at >= v_group_start
    and we2.received_at <= v_group_start + interval '3 seconds'
  order by we2.received_at desc, we2.id desc
  limit 1;

  if p_provider_message_id is distinct from v_newest_provider_id then
    -- A newer eligible message already exists in this burst: this job is
    -- superseded and must make zero OpenAI calls, cause zero state
    -- transition and send zero reply. It remains visible to the newest
    -- representative because completed events newer than the latest outbound
    -- remain part of the current turn.
    update public.webhook_events
      set intake_status = 'completed', intake_completed_at = pg_catalog.now(),
          intake_claim_token = null, intake_lease_until = null
      where id = v_event_id;

    return query select 'superseded'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- If an older sibling already owns a live lease, it may be doing paid
  -- work that did not include this message. Do not race it or claim its text
  -- was handled; put the current event back for the bounded Queue retry.
  if exists (
    select 1
    from public.webhook_events we2
    join public.messages m2
      on m2.clinic_id = we2.clinic_id and m2.whatsapp_message_id = we2.provider_event_id
    where we2.clinic_id = v_clinic_id
      and m2.conversation_id = p_conversation_id
      and m2.direction = 'inbound'
      and we2.ai_burst_eligible = true
      and we2.provider_event_id <> p_provider_message_id
      and we2.received_at >= v_group_start
      and we2.received_at <= v_group_start + interval '3 seconds'
      and we2.intake_status = 'processing'
      and we2.intake_lease_until > pg_catalog.now()
  ) then
    update public.webhook_events
      set intake_status = 'pending', intake_claim_token = null,
          intake_lease_until = null, intake_completed_at = null
      where id = v_event_id;
    return query select 'busy'::text, null::uuid, null::text, null::text;
    return;
  end if;

  -- This job's own message is the newest eligible one: assemble the bounded,
  -- ordered, explicitly labelled current-turn block. No ID, timestamp, owner
  -- name, phone or routing metadata is ever included -- only message text.
  with candidates as (
    select we2.provider_event_id, m2.content, we2.received_at
    from public.webhook_events we2
    join public.messages m2
      on m2.clinic_id = we2.clinic_id and m2.whatsapp_message_id = we2.provider_event_id
    where we2.clinic_id = v_clinic_id
      and m2.conversation_id = p_conversation_id
      and m2.direction = 'inbound'
      and we2.ai_burst_eligible = true
      and (
        we2.received_at > coalesce(v_last_outbound_at, '-infinity'::timestamptz)
        or we2.intake_status <> 'completed'
      )
      and we2.received_at >= v_group_start
      and we2.received_at <= v_group_start + interval '3 seconds'
  ),
  ordered as (
    select content, row_number() over (order by received_at, provider_event_id) as rn
    from candidates
  )
  select count(*), string_agg(format('Mesaj %s: %s', rn, content), E'\n' order by rn)
    into v_window_count, v_assembled_text
  from ordered;

  -- The representative (newest) event now owns this whole fixed window.
  -- Complete every other sibling atomically so its delayed/redelivered Queue
  -- job cannot produce a duplicate response.
  update public.webhook_events we2
    set intake_status = 'completed', intake_completed_at = pg_catalog.now(),
        intake_claim_token = null, intake_lease_until = null
  from public.messages m2
  where m2.clinic_id = we2.clinic_id
    and m2.whatsapp_message_id = we2.provider_event_id
    and we2.clinic_id = v_clinic_id
    and m2.conversation_id = p_conversation_id
    and m2.direction = 'inbound'
    and we2.ai_burst_eligible = true
    and we2.provider_event_id <> p_provider_message_id
    and we2.received_at >= v_group_start
    and we2.received_at <= v_group_start + interval '3 seconds'
    and we2.intake_status <> 'completed';

  if v_window_count > 4 or char_length(v_assembled_text) > 65536 then
    -- Never truncate away a possible emergency: make zero OpenAI calls and
    -- let the caller route this claim through the existing no-model
    -- human-handoff boundary instead.
    return query select 'overflow'::text, v_new_token, null::text, null::text;
    return;
  end if;

  return query select 'claimed'::text, v_new_token, v_assembled_text, v_mode;
  return;
end;
$$;

revoke all on function public.claim_intake_queue_job(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_intake_queue_job(uuid, text) to service_role;
