-- Task 048: safe staff WhatsApp reply composer, database side. Extends the
-- existing outbound outbox/sender/status pipeline with a staff-authored
-- origin instead of adding a parallel send path. A staff reply is queued by
-- public.queue_staff_reply_v1(), reuses the same claim/accept/status
-- machinery as automation replies, and is distinguished only by
-- message_origin / staff_* columns. Forward-only: claim_outbound_message_v2,
-- accept_outbound_message and set_whatsapp_contact_route are recreated in
-- place (create or replace, same signatures/grants) to stay coherent with the
-- new columns; no already-applied migration file is edited. Not run against
-- any database by the implementer; see
-- supabase/tests/048_staff_reply_composer.sql and docs/staff-workflow.md,
-- docs/outbound-delivery.md, docs/outbound-status.md,
-- docs/selective-automation.md.

-- ---------------------------------------------------------------------------
-- outbound_message_outbox: staff origin columns
-- ---------------------------------------------------------------------------

alter table public.outbound_message_outbox
  add column message_origin text not null default 'automation',
  add column staff_request_id uuid,
  add column staff_work_item_id uuid,
  add column staff_actor_user_id uuid references auth.users (id) on delete set null,
  add column staff_window_expires_at timestamptz;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_message_origin_check
  check (message_origin in ('automation', 'staff'));

-- source_provider_message_id was declared not null in the original
-- 20260809000100 migration; a staff-origin row has no inbound provider
-- event to key off, so the column becomes nullable and the old unconditional
-- two-column unique constraint is replaced with an explicit partial index
-- that only ever applied to non-null (i.e. automation) rows in practice.
alter table public.outbound_message_outbox
  alter column source_provider_message_id drop not null;

do $$
declare
  v_conname text;
begin
  select con.conname
    into v_conname
  from pg_catalog.pg_constraint con
  join pg_catalog.pg_class rel on rel.oid = con.conrelid
  join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
  where nsp.nspname = 'public'
    and rel.relname = 'outbound_message_outbox'
    and con.contype = 'u'
    and con.conkey = (
      select array_agg(att.attnum order by att.attnum)
      from pg_catalog.pg_attribute att
      where att.attrelid = rel.oid
        and att.attname in ('clinic_id', 'source_provider_message_id')
    );

  if v_conname is null then
    raise exception 'staff_reply_composer: legacy unique constraint on outbound_message_outbox(clinic_id, source_provider_message_id) not found';
  end if;

  execute pg_catalog.format('alter table public.outbound_message_outbox drop constraint %I', v_conname);
end;
$$;

create unique index outbound_message_outbox_automation_source_key
  on public.outbound_message_outbox (clinic_id, source_provider_message_id)
  where source_provider_message_id is not null;

create unique index outbound_message_outbox_staff_request_key
  on public.outbound_message_outbox (staff_request_id)
  where staff_request_id is not null;

alter table public.outbound_message_outbox
  drop constraint outbound_message_outbox_reply_category_check;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_reply_category_check
  check (reply_category in (
    'emergency_handoff', 'human_handoff', 'safety_questions', 'pet_identity',
    'intake_confirmation', 'complaint', 'intake_received',
    'appointment_offer', 'appointment_confirmed', 'appointment_declined',
    'appointment_unavailable', 'appointment_cancel_offer',
    'appointment_cancelled', 'appointment_cancel_declined',
    'appointment_cancel_unavailable', 'staff_reply'
  ));

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_origin_coherence_check
  check (
    (
      message_origin = 'automation'
      and source_provider_message_id is not null
      and staff_request_id is null
      and staff_work_item_id is null
      and staff_window_expires_at is null
      and staff_actor_user_id is null
      and reply_category <> 'staff_reply'
    )
    or
    (
      message_origin = 'staff'
      and source_provider_message_id is null
      and staff_request_id is not null
      and staff_work_item_id is not null
      and staff_window_expires_at is not null
      and reply_category = 'staff_reply'
    )
  );

-- Extend the delivery-state shape check with the staff-window-expired
-- terminal reason. Preserve every existing branch/value untouched.
alter table public.outbound_message_outbox
  drop constraint outbound_message_outbox_delivery_state_check;

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_delivery_state_check
  check (
    (
      delivery_status = 'pending'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is not null
      and delivery_attempt_count between 0 and 2
      and provider_message_id is null
      and accepted_at is null
      and failed_at is null
      and failure_reason is null
    )
    or
    (
      delivery_status = 'processing'
      and delivery_claim_token is not null
      and delivery_lease_until is not null
      and next_attempt_at is null
      and delivery_attempt_count between 1 and 3
      and provider_message_id is null
      and accepted_at is null
      and failed_at is null
      and failure_reason is null
    )
    or
    (
      delivery_status = 'accepted'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and delivery_attempt_count between 1 and 3
      and provider_message_id is not null
      and accepted_at is not null
      and failed_at is null
      and failure_reason is null
    )
    or
    (
      delivery_status = 'failed'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and provider_message_id is null
      and accepted_at is null
      and failed_at is not null
      and (
        (failure_reason = 'attempts_exhausted' and delivery_attempt_count = 3)
        or
        (failure_reason = 'staff_window_expired'
          and delivery_attempt_count between 0 and 3
          and message_origin = 'staff')
      )
    )
  );

comment on column public.outbound_message_outbox.message_origin is
  'automation = produced by finalize_intake_queue_job; staff = produced by queue_staff_reply_v1.';

comment on column public.outbound_message_outbox.staff_work_item_id is
  'Original human-handoff work item bound to a staff request id; backend-only replay evidence, intentionally not a foreign key so work-item retention cannot delete an outbound send record.';

-- Task 032's trigger predates the new terminal staff-window reason and would
-- otherwise mislabel it as send_attempts_exhausted. Keep its existing two
-- behaviors, but create the exhaustion item only for the exhaustion reason.
create or replace function vetai_private.sync_delivery_failure_work_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.delivery_status = 'failed'
    and old.delivery_status is distinct from 'failed'
    and new.failure_reason = 'attempts_exhausted'
  then
    insert into public.staff_work_items
      (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values
      (new.clinic_id, new.conversation_id, 'delivery_failure', 'normal', 'send_attempts_exhausted', new.id, 'open')
    on conflict (clinic_id, source_outbox_id)
      where kind = 'delivery_failure' and status <> 'resolved'
    do nothing;
  end if;

  if new.provider_delivery_status = 'failed' and old.provider_delivery_status is distinct from 'failed' then
    insert into public.staff_work_items
      (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values
      (new.clinic_id, new.conversation_id, 'delivery_failure', 'normal', 'provider_failed', new.id, 'open')
    on conflict (clinic_id, source_outbox_id)
      where kind = 'delivery_failure' and status <> 'resolved'
    do nothing;
  end if;

  if old.provider_delivery_status = 'failed' and new.provider_delivery_status in ('delivered', 'read') then
    update public.staff_work_items
      set status = 'resolved', resolved_at = pg_catalog.now()
      where clinic_id = new.clinic_id
        and source_outbox_id = new.id
        and kind = 'delivery_failure'
        and reason = 'provider_failed'
        and status <> 'resolved';
  end if;

  return new;
end;
$$;

revoke all on function vetai_private.sync_delivery_failure_work_item() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- messages: durable accepted-message origin (no actor UUID surfaced in UI)
-- ---------------------------------------------------------------------------

alter table public.messages
  add column outbound_origin text,
  add column staff_actor_user_id uuid references auth.users (id) on delete set null;

update public.messages
  set outbound_origin = 'automation'
  where direction = 'outbound';

alter table public.messages
  add constraint messages_outbound_origin_value_check
  check (outbound_origin in ('automation', 'staff'));

alter table public.messages
  add constraint messages_outbound_origin_coherence_check
  check (
    (
      direction in ('inbound', 'system')
      and outbound_origin is null
      and staff_actor_user_id is null
    )
    or
    (
      direction = 'outbound'
      and outbound_origin is not null
      and (outbound_origin = 'staff' or staff_actor_user_id is null)
    )
  );

comment on column public.messages.outbound_origin is
  'Set only for direction = outbound; automation or staff. Never render staff_actor_user_id in UI queries.';

-- ---------------------------------------------------------------------------
-- accept_outbound_message: copy origin/actor into the durable message row
-- ---------------------------------------------------------------------------

create or replace function public.accept_outbound_message(
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
  v_message_origin text;
  v_staff_actor_user_id uuid;
begin
  if p_outbox_id is null then
    raise exception 'accept_outbound_message: outbox_id is required';
  end if;
  if p_claim_token is null then
    raise exception 'accept_outbound_message: claim_token is required';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'accept_outbound_message: invalid provider_message_id';
  end if;

  select o.delivery_status, o.delivery_claim_token, o.clinic_id, o.conversation_id,
         o.content, o.provider_message_id, o.message_origin, o.staff_actor_user_id
    into v_status, v_token, v_clinic_id, v_conversation_id,
         v_content, v_existing_provider_id, v_message_origin, v_staff_actor_user_id
  from public.outbound_message_outbox o
  where o.id = p_outbox_id
  for update of o;

  if v_status = 'accepted' then
    if v_existing_provider_id = p_provider_message_id then
      return query select 'already_accepted'::text;
      return;
    end if;
    raise exception 'accept_outbound_message: outbox row % already accepted with a different provider_message_id', p_outbox_id;
  end if;

  if v_status is distinct from 'processing' or v_token is distinct from p_claim_token then
    return query select 'stale'::text;
    return;
  end if;

  insert into public.messages (
    clinic_id, conversation_id, direction, content, whatsapp_message_id,
    outbound_origin, staff_actor_user_id
  )
  values (
    v_clinic_id, v_conversation_id, 'outbound', v_content, p_provider_message_id,
    v_message_origin, v_staff_actor_user_id
  );

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

-- create or replace preserves the existing signature and ACL; restated here
-- for auditability only.
revoke all on function public.accept_outbound_message(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.accept_outbound_message(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- claim_outbound_message_v2: terminalize expired staff rows before claiming
-- ---------------------------------------------------------------------------

create or replace function public.claim_outbound_message_v2()
returns table (
  result text,
  outbox_id uuid,
  claim_token uuid,
  whatsapp_account_id uuid,
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
  v_message_origin text;
  v_staff_window_expires_at timestamptz;
  v_new_token uuid;
  v_account_id uuid;
  v_phone_number_id text;
  v_recipient_e164 text;
  v_content text;
begin
  loop
    v_outbox_id := null;

    select o.id, o.delivery_status, o.delivery_attempt_count, o.recipient_e164, o.content,
           wa.id, wa.phone_number_id, o.message_origin, o.staff_window_expires_at
      into v_outbox_id, v_delivery_status, v_attempt_count, v_recipient_e164, v_content,
           v_account_id, v_phone_number_id, v_message_origin, v_staff_window_expires_at
    from public.outbound_message_outbox o
    join public.whatsapp_accounts wa
      on wa.id = o.whatsapp_account_id
     and wa.clinic_id = o.clinic_id
    join public.clinics cl
      on cl.id = wa.clinic_id
     and cl.operational_status = 'active'
    where (o.delivery_status = 'pending' and o.next_attempt_at <= pg_catalog.now())
       or (o.delivery_status = 'processing' and o.delivery_lease_until <= pg_catalog.now())
    order by o.created_at, o.id
    for update of o skip locked
    limit 1;

    if v_outbox_id is null then
      return query select 'empty'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
      return;
    end if;

    if v_message_origin = 'staff' and v_staff_window_expires_at <= pg_catalog.now() then
      update public.outbound_message_outbox
        set delivery_status = 'failed',
            delivery_claim_token = null,
            delivery_lease_until = null,
            next_attempt_at = null,
            failed_at = pg_catalog.now(),
            failure_reason = 'staff_window_expired'
        where id = v_outbox_id;

      continue;
    end if;

    exit;
  end loop;

  if v_delivery_status = 'processing' and v_attempt_count >= 3 then
    update public.outbound_message_outbox
      set delivery_status = 'failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null,
          failed_at = pg_catalog.now(),
          failure_reason = 'attempts_exhausted'
      where id = v_outbox_id;

    return query select 'exhausted'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
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

  return query select 'claimed'::text, v_outbox_id, v_new_token, v_account_id, v_phone_number_id, v_recipient_e164, v_content, v_attempt_count;
  return;
end;
$$;

revoke all on function public.claim_outbound_message_v2() from public, anon, authenticated;
grant execute on function public.claim_outbound_message_v2() to service_role;

-- ---------------------------------------------------------------------------
-- set_whatsapp_contact_route: pending-outbox cleanup is automation-only
-- ---------------------------------------------------------------------------

create or replace function public.set_whatsapp_contact_route(
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
    raise exception 'set_whatsapp_contact_route: whatsapp_account_id is required';
  end if;
  if p_contact_e164 is null or p_contact_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'set_whatsapp_contact_route: invalid contact_e164';
  end if;
  if p_mode is null or p_mode not in ('ai', 'manual', 'personal', 'inherit') then
    raise exception 'set_whatsapp_contact_route: invalid mode';
  end if;

  select wa.clinic_id, wa.automation_default
    into v_clinic_id, v_default_mode
  from public.whatsapp_accounts wa
  where wa.id = p_whatsapp_account_id
  for update;

  if v_clinic_id is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
  end if;

  select o.id
    into v_owner_id
  from public.owners o
  where o.clinic_id = v_clinic_id
    and o.phone_e164 = p_contact_e164
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
      and r.contact_e164 = p_contact_e164
    for update;

    insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
    values (p_whatsapp_account_id, v_clinic_id, p_contact_e164, p_mode)
    on conflict (whatsapp_account_id, contact_e164)
    do update set mode = excluded.mode, updated_at = pg_catalog.now();

    v_final_mode := p_mode;
    if v_existing_mode is not distinct from p_mode then
      v_result := 'unchanged';
    else
      v_result := 'updated';
    end if;
  end if;

  if v_final_mode in ('manual', 'personal') and v_owner_id is not null then
    delete from public.outbound_message_outbox oo
    using public.conversations c
    where oo.conversation_id = c.id
      and c.owner_id = v_owner_id
      and c.clinic_id = v_clinic_id
      and oo.whatsapp_account_id = p_whatsapp_account_id
      and oo.delivery_status = 'pending'
      and oo.message_origin = 'automation';
  end if;

  return query select v_result;
  return;
end;
$$;

revoke all on function public.set_whatsapp_contact_route(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.set_whatsapp_contact_route(uuid, text, text)
  to authenticated;

-- ---------------------------------------------------------------------------
-- queue_staff_reply_v1: the only writer of staff-origin outbox rows
-- ---------------------------------------------------------------------------

create function public.queue_staff_reply_v1(
  p_work_item_id uuid,
  p_request_id uuid,
  p_content text
)
returns table (
  result text,
  outbox_id uuid,
  window_expires_at timestamptz
)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_member_user_id uuid;
  v_clinic_id uuid;
  v_conversation_id uuid;
  v_kind text;
  v_status text;
  v_assigned_to uuid;
  v_clinic_status text;
  v_owner_id uuid;
  v_intake_stage text;
  v_recipient_e164 text;
  v_account_id uuid;
  v_latest_inbound_at timestamptz;
  v_window_expires_at timestamptz;
  v_existing_outbox_id uuid;
  v_existing_actor uuid;
  v_existing_work_item_id uuid;
  v_existing_conversation_id uuid;
  v_existing_content text;
  v_existing_window timestamptz;
  v_outbox_id uuid;
begin
  if p_work_item_id is null then
    raise exception 'queue_staff_reply_v1: work_item_id is required';
  end if;
  if p_request_id is null then
    raise exception 'queue_staff_reply_v1: request_id is required';
  end if;
  if p_content is null
    or char_length(p_content) < 1
    or char_length(p_content) > 4096
    or p_content !~ '[^[:space:]]'
    or translate(p_content, E'\t\n\r', '   ') ~ '[[:cntrl:]]'
  then
    raise exception 'queue_staff_reply_v1: invalid content';
  end if;

  v_caller := (select auth.uid());

  -- Discover only the tenant key first. Lock the clinic before the work item
  -- so lifecycle RPCs (clinic -> child rows) and this enqueue path share one
  -- lock order; the second work-item read below is the authoritative one.
  select wi.clinic_id
    into v_clinic_id
  from public.staff_work_items wi
  where wi.id = p_work_item_id;

  if v_clinic_id is null or v_caller is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select cl.operational_status
    into v_clinic_status
  from public.clinics cl
  where cl.id = v_clinic_id
  for key share of cl;

  -- A lifecycle transition may have completed while the clinic lock waited.
  -- Re-check and retain a lock on the membership row before locking/re-reading
  -- the work item. This prevents both lifecycle and membership revocation from
  -- committing before a later enqueue in this transaction.
  select cs.user_id
    into v_member_user_id
  from public.clinic_staff cs
  where cs.clinic_id = v_clinic_id
    and cs.user_id = v_caller
  for key share of cs;

  if v_clinic_status is null or v_member_user_id is distinct from v_caller then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select wi.conversation_id, wi.kind, wi.status, wi.assigned_to
    into v_conversation_id, v_kind, v_status, v_assigned_to
  from public.staff_work_items wi
  where wi.id = p_work_item_id
    and wi.clinic_id = v_clinic_id
  for update of wi;

  if v_conversation_id is null then
    return query select 'not_found'::text, null::uuid, null::timestamptz;
    return;
  end if;

  -- A missing row cannot be gap-locked. Serialize the global request UUID
  -- explicitly before looking for a prior outbox row so concurrent first use
  -- across different work items cannot fall through to a unique violation.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select oo.id, oo.staff_actor_user_id, oo.staff_work_item_id,
         oo.conversation_id, oo.content, oo.staff_window_expires_at
    into v_existing_outbox_id, v_existing_actor, v_existing_work_item_id,
         v_existing_conversation_id, v_existing_content, v_existing_window
  from public.outbound_message_outbox oo
  where oo.staff_request_id = p_request_id
  for update of oo;

  if v_existing_outbox_id is not null then
    if v_existing_actor is not distinct from v_caller
      and v_existing_work_item_id = p_work_item_id
      and v_existing_conversation_id = v_conversation_id
      and v_existing_content = p_content
    then
      return query select 'already_queued'::text, v_existing_outbox_id, v_existing_window;
      return;
    end if;

    raise exception 'queue_staff_reply_v1: request_id % already used for a different actor, work item or content', p_request_id;
  end if;

  if v_clinic_status is distinct from 'active' then
    return query select 'inactive'::text, null::uuid, null::timestamptz;
    return;
  end if;

  if v_kind <> 'human_handoff' or v_status <> 'in_progress' or v_assigned_to is distinct from v_caller then
    return query select 'not_allowed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select c.owner_id, c.intake_stage
    into v_owner_id, v_intake_stage
  from public.conversations c
  where c.id = v_conversation_id
    and c.clinic_id = v_clinic_id;

  if v_owner_id is null then
    raise exception 'queue_staff_reply_v1: conversation not found for work item %', p_work_item_id;
  end if;

  if v_intake_stage = 'completed' then
    return query select 'not_allowed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  select o.phone_e164 into v_recipient_e164
  from public.owners o
  where o.id = v_owner_id
    and o.clinic_id = v_clinic_id;

  if v_recipient_e164 is null then
    raise exception 'queue_staff_reply_v1: owner not found for work item %', p_work_item_id;
  end if;

  select least(m.created_at, we.received_at), we.whatsapp_account_id
    into v_latest_inbound_at, v_account_id
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = m.whatsapp_message_id
  where m.conversation_id = v_conversation_id
    and m.clinic_id = v_clinic_id
    and m.direction = 'inbound'
  order by least(m.created_at, we.received_at) desc, m.id desc
  limit 1;

  if v_account_id is null then
    return query select 'not_allowed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  v_window_expires_at := v_latest_inbound_at + interval '24 hours';

  if v_window_expires_at <= pg_catalog.now() then
    return query select 'window_closed'::text, null::uuid, null::timestamptz;
    return;
  end if;

  insert into public.outbound_message_outbox (
    clinic_id, conversation_id, whatsapp_account_id, recipient_e164,
    reply_category, content, message_origin, staff_request_id, staff_work_item_id,
    staff_actor_user_id, staff_window_expires_at
  )
  values (
    v_clinic_id, v_conversation_id, v_account_id, v_recipient_e164,
    'staff_reply', p_content, 'staff', p_request_id, p_work_item_id,
    v_caller, v_window_expires_at
  )
  returning id into v_outbox_id;

  return query select 'queued'::text, v_outbox_id, v_window_expires_at;
  return;
end;
$$;

revoke all on function public.queue_staff_reply_v1(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.queue_staff_reply_v1(uuid, uuid, text) to authenticated;
