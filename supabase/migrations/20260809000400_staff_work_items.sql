-- Durable staff work queue for VetAI: makes human-handoff conversations and
-- terminally failed outbound deliveries visible to authenticated clinic
-- staff without notifying anyone or adding Worker wiring.
-- Validated on disposable vetai-test on 2026-08-09; not applied to production.
-- See docs/staff-work-items.md, docs/database-schema.md,
-- docs/intake-replies.md, docs/outbound-delivery.md, and
-- docs/outbound-status.md.

-- =========================================================================
-- Supporting unique key
-- =========================================================================

-- Lets the composite tenant-safe FK below target the exact outbox row,
-- matching the (id, clinic_id) pattern already used by owners/pets/
-- conversations/whatsapp_accounts.
alter table public.outbound_message_outbox
  add unique (id, clinic_id);

-- =========================================================================
-- Table
-- =========================================================================

create table public.staff_work_items (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  conversation_id uuid not null,
  kind text not null check (kind in ('human_handoff', 'delivery_failure')),
  priority text not null check (priority in ('urgent', 'normal')),
  reason text not null check (reason in (
    'emergency_handoff', 'human_handoff', 'send_attempts_exhausted', 'provider_failed'
  )),
  source_outbox_id uuid,
  status text not null default 'open' check (status in ('open', 'resolved')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  foreign key (conversation_id, clinic_id)
    references public.conversations (id, clinic_id) on delete cascade,
  foreign key (source_outbox_id, clinic_id)
    references public.outbound_message_outbox (id, clinic_id) on delete cascade,

  constraint staff_work_items_resolved_state_check check (
    (status = 'open' and resolved_at is null)
    or (status = 'resolved' and resolved_at is not null)
  ),
  constraint staff_work_items_kind_reason_check check (
    (kind = 'human_handoff' and source_outbox_id is null
      and reason in ('emergency_handoff', 'human_handoff'))
    or (kind = 'delivery_failure' and source_outbox_id is not null
      and reason in ('send_attempts_exhausted', 'provider_failed'))
  ),
  constraint staff_work_items_reason_priority_check check (
    (reason = 'emergency_handoff' and priority = 'urgent')
    or (reason <> 'emergency_handoff' and priority = 'normal')
  )
);

-- At most one open item per conversation/outbox row, so a replayed trigger
-- upserts instead of duplicating. Also the race-safety backstop this task's
-- single-session fixture cannot exercise directly.
create unique index staff_work_items_open_handoff_uniq
  on public.staff_work_items (clinic_id, conversation_id)
  where kind = 'human_handoff' and status = 'open';

create unique index staff_work_items_open_delivery_uniq
  on public.staff_work_items (clinic_id, source_outbox_id)
  where kind = 'delivery_failure' and status = 'open';

create index staff_work_items_list_idx
  on public.staff_work_items (clinic_id, status, priority, created_at, id);

-- =========================================================================
-- RLS and privileges
-- =========================================================================

alter table public.staff_work_items enable row level security;

revoke all on public.staff_work_items from public, anon, authenticated;
grant select on public.staff_work_items to authenticated;
grant all on public.staff_work_items to service_role;

-- Read-only, same-tenant. Staff cannot insert/update/delete directly in this
-- task; resolution is a later, explicit workflow.
create policy staff_work_items_select on public.staff_work_items
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

-- =========================================================================
-- Safety-signal helper
-- =========================================================================

-- Tolerates absent/null/non-object safety data by returning false rather
-- than raising; scans values generically so it never hardcodes signal names.
create function vetai_private.has_true_safety_signal(p_intake_data jsonb)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_intake_data -> 'reported_safety_signals') = 'object' then exists (
      select 1
      from jsonb_each(p_intake_data -> 'reported_safety_signals') as signal
      where signal.value = 'true'::jsonb
    )
    else false
  end;
$$;

revoke all on function vetai_private.has_true_safety_signal(jsonb) from public, anon, authenticated;

-- =========================================================================
-- Human-handoff trigger
-- =========================================================================

create function vetai_private.sync_human_handoff_work_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_urgent boolean;
  v_priority text;
  v_reason text;
begin
  v_urgent := vetai_private.has_true_safety_signal(new.intake_data);
  v_priority := case when v_urgent then 'urgent' else 'normal' end;
  v_reason := case when v_urgent then 'emergency_handoff' else 'human_handoff' end;

  -- Insert a new open item, or upgrade the existing open one from normal to
  -- urgent; never downgrades and never duplicates while one remains open.
  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values (new.clinic_id, new.id, 'human_handoff', v_priority, v_reason, 'open')
  on conflict (clinic_id, conversation_id) where kind = 'human_handoff' and status = 'open'
  do update set
    priority = excluded.priority,
    reason = excluded.reason
  where public.staff_work_items.priority = 'normal' and excluded.priority = 'urgent';

  return new;
end;
$$;

revoke all on function vetai_private.sync_human_handoff_work_item() from public, anon, authenticated;

create trigger sync_human_handoff_work_item
  after update on public.conversations
  for each row
  when (new.intake_stage = 'human_handoff')
  execute function vetai_private.sync_human_handoff_work_item();

-- =========================================================================
-- Delivery-failure trigger
-- =========================================================================

create function vetai_private.sync_delivery_failure_work_item()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.delivery_status = 'failed' and old.delivery_status is distinct from 'failed' then
    insert into public.staff_work_items
      (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values
      (new.clinic_id, new.conversation_id, 'delivery_failure', 'normal', 'send_attempts_exhausted', new.id, 'open')
    on conflict (clinic_id, source_outbox_id) where kind = 'delivery_failure' and status = 'open'
    do nothing;
  end if;

  if new.provider_delivery_status = 'failed' and old.provider_delivery_status is distinct from 'failed' then
    insert into public.staff_work_items
      (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values
      (new.clinic_id, new.conversation_id, 'delivery_failure', 'normal', 'provider_failed', new.id, 'open')
    on conflict (clinic_id, source_outbox_id) where kind = 'delivery_failure' and status = 'open'
    do nothing;
  end if;

  -- A later delivered/read callback supersedes only the provider-failure
  -- evidence; exhausted-send items never auto-resolve this way.
  if old.provider_delivery_status = 'failed' and new.provider_delivery_status in ('delivered', 'read') then
    update public.staff_work_items
      set status = 'resolved', resolved_at = pg_catalog.now()
      where clinic_id = new.clinic_id
        and source_outbox_id = new.id
        and kind = 'delivery_failure'
        and reason = 'provider_failed'
        and status = 'open';
  end if;

  return new;
end;
$$;

revoke all on function vetai_private.sync_delivery_failure_work_item() from public, anon, authenticated;

create trigger sync_delivery_failure_work_item
  after update on public.outbound_message_outbox
  for each row
  when (
    (new.delivery_status = 'failed' and old.delivery_status is distinct from 'failed')
    or (new.provider_delivery_status = 'failed' and old.provider_delivery_status is distinct from 'failed')
    or (old.provider_delivery_status = 'failed' and new.provider_delivery_status in ('delivered', 'read'))
  )
  execute function vetai_private.sync_delivery_failure_work_item();

-- =========================================================================
-- Backfill existing terminal state
-- =========================================================================

insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
select
  c.clinic_id,
  c.id,
  'human_handoff',
  case when vetai_private.has_true_safety_signal(c.intake_data) then 'urgent' else 'normal' end,
  case when vetai_private.has_true_safety_signal(c.intake_data) then 'emergency_handoff' else 'human_handoff' end,
  'open'
from public.conversations c
where c.intake_stage = 'human_handoff'
on conflict (clinic_id, conversation_id) where kind = 'human_handoff' and status = 'open'
do nothing;

insert into public.staff_work_items
  (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
select o.clinic_id, o.conversation_id, 'delivery_failure', 'normal', 'send_attempts_exhausted', o.id, 'open'
from public.outbound_message_outbox o
where o.delivery_status = 'failed'
on conflict (clinic_id, source_outbox_id) where kind = 'delivery_failure' and status = 'open'
do nothing;

insert into public.staff_work_items
  (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
select o.clinic_id, o.conversation_id, 'delivery_failure', 'normal', 'provider_failed', o.id, 'open'
from public.outbound_message_outbox o
where o.provider_delivery_status = 'failed'
on conflict (clinic_id, source_outbox_id) where kind = 'delivery_failure' and status = 'open'
do nothing;
