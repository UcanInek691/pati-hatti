-- Atomic dead-letter handoff for the future Cloudflare Queue DLQ intake
-- consumer. Validated on disposable `vetai-test` on 2026-08-10; not applied
-- to production or recorded in production migration history. See
-- docs/inbound-queue.md and docs/database-schema.md.

-- ponytail: reuses advance_conversation_intake for the state transition and
-- the existing sync_human_handoff_work_item trigger for staff visibility,
-- exactly like finalize_intake_queue_job; no new table/column/trigger.
create function public.finalize_intake_dead_letter(
  p_conversation_id uuid,
  p_provider_message_id text
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_intake_status text;
  v_conv_stage text;
  v_conv_version integer;
  v_conv_intake_data jsonb;
  v_effective_intake_data jsonb;
  v_conv_pet_id uuid;
  v_advance_stage text;
begin
  if p_conversation_id is null then
    raise exception 'finalize_intake_dead_letter: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512
    or p_provider_message_id <> btrim(p_provider_message_id) then
    raise exception 'finalize_intake_dead_letter: invalid provider_message_id';
  end if;

  -- Tenant safety comes from the message row itself (its own clinic_id),
  -- never from a caller-supplied clinic id: the join ties the event to
  -- exactly the message's own clinic. Lock the webhook event before the
  -- conversation, matching the sibling lease finalizer's lock order.
  select we.id, we.intake_status
    into v_event_id, v_intake_status
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
    return query select 'not_found'::text;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'already_completed'::text;
    return;
  end if;

  select c.intake_stage, c.state_version, c.intake_data, c.pet_id
    into v_conv_stage, v_conv_version, v_conv_intake_data, v_conv_pet_id
  from public.conversations c
  where c.id = p_conversation_id
  for update;

  if v_conv_stage is null then
    raise exception 'finalize_intake_dead_letter: unknown conversation_id';
  end if;

  if v_conv_stage = 'completed' then
    update public.webhook_events
      set intake_status = 'completed',
          intake_claim_token = null,
          intake_lease_until = null,
          intake_completed_at = pg_catalog.now()
      where id = v_event_id;

    return query select 'already_terminal'::text;
    return;
  end if;

  -- A conversation whose first intake attempts all failed still has the core
  -- schema's empty default document, which advance_conversation_intake
  -- intentionally rejects. Persist a fixed, non-sensitive terminal marker in
  -- only that case so the DLQ itself cannot become poison. A later message on
  -- the handoff conversation is handled by the existing poison-snapshot
  -- fallback and replaces it with a validated current-turn snapshot.
  v_effective_intake_data := case
    when v_conv_intake_data = '{}'::jsonb
      then pg_catalog.jsonb_build_object('dead_letter_handoff', true)
    else v_conv_intake_data
  end;

  -- Same-stage or forward-to-human_handoff transitions are always allowed by
  -- advance_conversation_intake regardless of the current non-terminal
  -- stage, so this single call both moves and keeps a conversation at
  -- human_handoff; the row lock above guarantees v_conv_version cannot be
  -- stale, so a null result here means the callee's own invariants broke.
  select advanced.intake_stage
    into v_advance_stage
  from public.advance_conversation_intake(
    p_conversation_id, v_conv_version, 'human_handoff', v_conv_pet_id, v_effective_intake_data
  ) advanced;

  if v_advance_stage is distinct from 'human_handoff' then
    raise exception 'finalize_intake_dead_letter: unexpected state advance result';
  end if;

  update public.webhook_events
    set intake_status = 'completed',
        intake_claim_token = null,
        intake_lease_until = null,
        intake_completed_at = pg_catalog.now()
    where id = v_event_id;

  return query select 'handed_off'::text;
  return;
end;
$$;

revoke all on function public.finalize_intake_dead_letter(uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_intake_dead_letter(uuid, text)
  to service_role;
