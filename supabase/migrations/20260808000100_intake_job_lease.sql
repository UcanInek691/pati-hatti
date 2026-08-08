-- Fail-closed idempotency/lease boundary for the future Cloudflare Queue
-- intake consumer. Validated in the disposable `vetai-test` project with
-- supabase/tests/012_intake_job_lease.sql on 2026-08-08; production still
-- requires the managed migration workflow. See docs/inbound-queue.md and
-- docs/database-schema.md.

alter table public.webhook_events
  add column intake_status text not null default 'pending'
    check (intake_status in ('pending', 'processing', 'completed')),
  add column intake_claim_token uuid,
  add column intake_lease_until timestamptz,
  add column intake_completed_at timestamptz;

alter table public.webhook_events
  add constraint webhook_events_intake_state_check check (
    (intake_status = 'pending'
      and intake_claim_token is null
      and intake_lease_until is null
      and intake_completed_at is null)
    or (intake_status = 'processing'
      and intake_claim_token is not null
      and intake_lease_until is not null
      and intake_completed_at is null)
    or (intake_status = 'completed'
      and intake_claim_token is null
      and intake_lease_until is null
      and intake_completed_at is not null)
  );

-- ponytail: a fixed 120-second lease with no configurable duration, retry
-- counter, or cleanup job is the CURRENT_TASK.md-mandated ceiling for this
-- step; revisit only if a later task needs a different lease policy.
create function public.claim_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text
)
returns table (result text, claim_token uuid, message_text text)
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
  select we.id, m.content, we.intake_status, we.intake_claim_token, we.intake_lease_until
    into v_event_id, v_message_content, v_intake_status, v_intake_claim_token, v_intake_lease_until
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
    return query select 'not_found'::text, null::uuid, null::text;
    return;
  end if;

  if v_intake_status = 'completed' then
    return query select 'completed'::text, null::uuid, null::text;
    return;
  end if;

  if v_intake_status = 'processing' and v_intake_lease_until > pg_catalog.now() then
    return query select 'busy'::text, null::uuid, null::text;
    return;
  end if;

  -- Pending, or an expired processing lease: claimable with a fresh token.
  v_new_token := pg_catalog.gen_random_uuid();

  update public.webhook_events
    set intake_status = 'processing',
        intake_claim_token = v_new_token,
        intake_lease_until = pg_catalog.now() + interval '120 seconds'
    where id = v_event_id;

  return query select 'claimed'::text, v_new_token, v_message_content;
  return;
end;
$$;

revoke all on function public.claim_intake_queue_job(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_intake_queue_job(uuid, text) to service_role;

create function public.complete_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid
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
  v_intake_claim_token uuid;
begin
  if p_conversation_id is null then
    raise exception 'complete_intake_queue_job: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'complete_intake_queue_job: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'complete_intake_queue_job: invalid claim_token';
  end if;

  select we.id, we.intake_status, we.intake_claim_token
    into v_event_id, v_intake_status, v_intake_claim_token
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = p_provider_message_id
  where m.conversation_id = p_conversation_id
    and m.whatsapp_message_id = p_provider_message_id
    and m.direction = 'inbound'
    and we.processing_status = 'processed'
  for update of we;

  -- Missing job, already completed, still pending, or owned by a
  -- different/newer token all collapse to the same `stale` result: a stale
  -- worker must never complete a lease it does not currently hold.
  if v_event_id is null
    or v_intake_status is distinct from 'processing'
    or v_intake_claim_token is distinct from p_claim_token then
    return query select 'stale'::text;
    return;
  end if;

  update public.webhook_events
    set intake_status = 'completed',
        intake_claim_token = null,
        intake_lease_until = null,
        intake_completed_at = pg_catalog.now()
    where id = v_event_id;

  return query select 'completed'::text;
  return;
end;
$$;

revoke all on function public.complete_intake_queue_job(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.complete_intake_queue_job(uuid, text, uuid) to service_role;
