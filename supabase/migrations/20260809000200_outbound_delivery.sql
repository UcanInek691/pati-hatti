-- Outbound WhatsApp delivery lifecycle for VetAI: claim, send, accept, and
-- retry state for rows already persisted into `outbound_message_outbox` by
-- Task 017. Validated on disposable `vetai-test` with
-- supabase/tests/018_outbound_delivery.sql on 2026-08-09; production still
-- requires the managed migration workflow. See docs/outbound-delivery.md,
-- docs/database-schema.md, and docs/intake-replies.md.

-- =========================================================================
-- Delivery state columns
-- =========================================================================

alter table public.outbound_message_outbox
  add column delivery_status text not null default 'pending',
  add column delivery_claim_token uuid,
  add column delivery_lease_until timestamptz,
  add column delivery_attempt_count integer not null default 0,
  -- DEFAULT now() makes Task 017-created rows immediately due without a
  -- separate UPDATE, and every future plain INSERT from
  -- finalize_intake_queue_job (unchanged here) is due immediately too.
  add column next_attempt_at timestamptz default now(),
  add column provider_message_id text check (char_length(provider_message_id) between 1 and 512),
  add column accepted_at timestamptz,
  add column failed_at timestamptz,
  add column failure_reason text;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_delivery_status_check
  check (delivery_status in ('pending', 'processing', 'accepted', 'failed'));

-- Closed per-status shape: exactly the fields a status implies are non-null,
-- every other delivery field is null, and attempt bounds hold everywhere.
alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_delivery_state_check check (
    (delivery_status = 'pending'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is not null
      and provider_message_id is null
      and accepted_at is null
      and failed_at is null
      and failure_reason is null
      and delivery_attempt_count between 0 and 2)
    or (delivery_status = 'processing'
      and delivery_claim_token is not null
      and delivery_lease_until is not null
      and next_attempt_at is null
      and provider_message_id is null
      and accepted_at is null
      and failed_at is null
      and failure_reason is null
      and delivery_attempt_count between 1 and 3)
    or (delivery_status = 'accepted'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and provider_message_id is not null
      and accepted_at is not null
      and failed_at is null
      and failure_reason is null
      and delivery_attempt_count between 1 and 3)
    or (delivery_status = 'failed'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and provider_message_id is null
      and accepted_at is null
      and failed_at is not null
      and failure_reason = 'attempts_exhausted'
      and delivery_attempt_count = 3)
  );

drop index public.outbound_message_outbox_created_at_id_idx;

-- ponytail: one composite index covering status plus both due-time columns
-- (pending uses next_attempt_at, processing uses delivery_lease_until) plus
-- the (created_at, id) tiebreak; a dedicated partial index per status is
-- unnecessary at the 10-row-per-minute cap this task's Cron enforces.
create index outbound_message_outbox_claim_idx
  on public.outbound_message_outbox (delivery_status, next_attempt_at, delivery_lease_until, created_at, id);

-- =========================================================================
-- Claim RPC
-- =========================================================================

create function public.claim_outbound_message()
returns table (
  result text,
  outbox_id uuid,
  claim_token uuid,
  phone_number_id text,
  recipient_e164 text,
  content text,
  attempt_count integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_outbox_id uuid;
  v_delivery_status text;
  v_attempt_count integer;
  v_new_token uuid;
  v_phone_number_id text;
  v_recipient_e164 text;
  v_content text;
begin
  -- Oldest due pending row or expired processing lease. Selecting both live
  -- work and exhausted leases together prevents a crashed third attempt from
  -- starving forever behind a continuous pending backlog.
  select o.id, o.delivery_status, o.delivery_attempt_count, o.recipient_e164, o.content, wa.phone_number_id
    into v_outbox_id, v_delivery_status, v_attempt_count, v_recipient_e164, v_content, v_phone_number_id
  from public.outbound_message_outbox o
  join public.whatsapp_accounts wa
    on wa.id = o.whatsapp_account_id
   and wa.clinic_id = o.clinic_id
  where (o.delivery_status = 'pending' and o.next_attempt_at <= pg_catalog.now())
     or (o.delivery_status = 'processing' and o.delivery_lease_until <= pg_catalog.now())
  order by o.created_at, o.id
  for update of o skip locked
  limit 1;

  if v_outbox_id is null then
    return query select 'empty'::text, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  if v_delivery_status = 'processing' and v_attempt_count >= 3 then
    update public.outbound_message_outbox
      set delivery_status = 'failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null,
          failed_at = pg_catalog.now(),
          failure_reason = 'attempts_exhausted'
      where id = v_outbox_id;

    return query select 'exhausted'::text, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  v_new_token := pg_catalog.gen_random_uuid();
  v_attempt_count := v_attempt_count + 1;

  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = v_new_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = v_attempt_count,
        next_attempt_at = null
    where id = v_outbox_id;

  return query select 'claimed'::text, v_outbox_id, v_new_token, v_phone_number_id, v_recipient_e164, v_content, v_attempt_count;
  return;
end;
$$;

revoke all on function public.claim_outbound_message() from public, anon, authenticated;
grant execute on function public.claim_outbound_message() to service_role;

-- =========================================================================
-- Retry RPC
-- =========================================================================

create function public.release_outbound_message(
  p_outbox_id uuid,
  p_claim_token uuid
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
  v_attempt_count integer;
begin
  if p_outbox_id is null then
    raise exception 'release_outbound_message: invalid outbox_id';
  end if;
  if p_claim_token is null then
    raise exception 'release_outbound_message: invalid claim_token';
  end if;

  select o.delivery_status, o.delivery_claim_token, o.delivery_attempt_count
    into v_status, v_token, v_attempt_count
  from public.outbound_message_outbox o
  where o.id = p_outbox_id
  for update of o;

  if v_status is distinct from 'processing' or v_token is distinct from p_claim_token then
    return query select 'stale'::text;
    return;
  end if;

  if v_attempt_count < 3 then
    update public.outbound_message_outbox
      set delivery_status = 'pending',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = pg_catalog.now() + interval '2 minutes'
      where id = p_outbox_id;

    return query select 'retry_scheduled'::text;
    return;
  end if;

  update public.outbound_message_outbox
    set delivery_status = 'failed',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        failed_at = pg_catalog.now(),
        failure_reason = 'attempts_exhausted'
    where id = p_outbox_id;

  return query select 'failed'::text;
  return;
end;
$$;

revoke all on function public.release_outbound_message(uuid, uuid) from public, anon, authenticated;
grant execute on function public.release_outbound_message(uuid, uuid) to service_role;

-- =========================================================================
-- Acceptance RPC
-- =========================================================================

create function public.accept_outbound_message(
  p_outbox_id uuid,
  p_claim_token uuid,
  p_provider_message_id text
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
  v_clinic_id uuid;
  v_conversation_id uuid;
  v_content text;
  v_existing_provider_id text;
begin
  if p_outbox_id is null then
    raise exception 'accept_outbound_message: invalid outbox_id';
  end if;
  if p_claim_token is null then
    raise exception 'accept_outbound_message: invalid claim_token';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'accept_outbound_message: invalid provider_message_id';
  end if;

  select o.delivery_status, o.delivery_claim_token, o.clinic_id, o.conversation_id, o.content, o.provider_message_id
    into v_status, v_token, v_clinic_id, v_conversation_id, v_content, v_existing_provider_id
  from public.outbound_message_outbox o
  where o.id = p_outbox_id
  for update of o;

  if v_status = 'accepted' then
    if v_existing_provider_id = p_provider_message_id then
      return query select 'already_accepted'::text;
      return;
    end if;

    -- A replay reporting a different provider ID can represent either an
    -- ambiguous at-least-once duplicate send or corrupted history. Raising
    -- preserves one authoritative provider ID instead of hiding either case.
    raise exception 'accept_outbound_message: existing provider_message_id does not match replay for outbox_id %', p_outbox_id;
  end if;

  if v_status is distinct from 'processing' or v_token is distinct from p_claim_token then
    return query select 'stale'::text;
    return;
  end if;

  -- Plain insert (no ON CONFLICT): an unexpected unique collision against
  -- another clinic-scoped outbound message must raise and roll back the
  -- whole RPC rather than silently skip the history row.
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
  values (v_clinic_id, v_conversation_id, 'outbound', v_content, p_provider_message_id);

  update public.outbound_message_outbox
    set delivery_status = 'accepted',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        provider_message_id = p_provider_message_id,
        accepted_at = pg_catalog.now()
    where id = p_outbox_id;

  return query select 'accepted'::text;
  return;
end;
$$;

revoke all on function public.accept_outbound_message(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_outbound_message(uuid, uuid, text) to service_role;
