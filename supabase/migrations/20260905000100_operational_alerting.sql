-- Task 053 Phase B: operational alerting repository objects (recipients,
-- durable delivery/dedup state, monitor heartbeat, dead-letter provenance).
-- NOT RUN against any database by the implementer (Claude Sonnet). Codex
-- must apply this migration and the paired fixture
-- (supabase/tests/053_operational_alerting.sql) only on disposable
-- vetai-test, with zero residue, before any staging activation.
-- See docs/operational-alerting.md, docs/inbound-queue.md,
-- docs/database-schema.md, docs/staff-work-items.md.

-- =========================================================================
-- 1. staff_work_items.provenance (Task 053 DB item 2)
-- =========================================================================

alter table public.staff_work_items
  add column provenance text not null default 'workflow';

alter table public.staff_work_items
  add constraint staff_work_items_provenance_check
    check (provenance in ('workflow', 'intake_dead_letter'));

-- Only a human_handoff item can ever originate from the dead-letter path;
-- a delivery_failure item is always 'workflow'.
alter table public.staff_work_items
  add constraint staff_work_items_provenance_kind_check
    check (provenance <> 'intake_dead_letter' or kind = 'human_handoff');

-- =========================================================================
-- 2. finalize_intake_dead_letter (Task 053 DB items 2-3): tags the work
-- item this handoff creates/reuses with its real origin, on both the
-- empty-first-turn marker path and the existing-snapshot-preserved path.
-- Every other line is byte-for-byte identical to
-- supabase/migrations/20260810000300_intake_dead_letter_handoff.sql; only
-- v_clinic_id and the new UPDATE below are additions.
-- =========================================================================

create or replace function public.finalize_intake_dead_letter(
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
  v_clinic_id uuid;
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
  select we.id, we.intake_status, m.clinic_id
    into v_event_id, v_intake_status, v_clinic_id
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
  -- only that case so the DLQ itself cannot become poison.
  --
  -- Task 053 correction: a later inbound message on this handoff
  -- conversation does NOT reach a fallback that replaces this marker.
  -- src/intakeConsumer.ts's human_handoff branch rejects it via
  -- readCanonicalPersistedSnapshot (it is not a valid canonical snapshot)
  -- and, before Task 053, retried forever. isExactDeadLetterHandoffMarker
  -- now acknowledges that exact state instead of looping. See
  -- docs/inbound-queue.md.
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

  -- Task 053: tag the work item this advance creates/reuses with its real
  -- origin so public.sync_alert_delivery_candidates can route it as
  -- "unassessed", not clinically urgent, without re-deriving it from the
  -- jsonb marker (which only the empty-first-turn path ever sets) at query
  -- time. Covers the empty-first-turn path and the existing-snapshot-
  -- preserved path identically: both flow through the advance call above.
  update public.staff_work_items
    set provenance = 'intake_dead_letter'
    where conversation_id = p_conversation_id
      and clinic_id = v_clinic_id
      and kind = 'human_handoff'
      and status <> 'resolved';

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

-- ACL is preserved by CREATE OR REPLACE (owner unchanged, no DROP), so the
-- existing grant still applies. Restated here only for auditability,
-- matching Task 051's own precedent.
revoke all on function public.finalize_intake_dead_letter(uuid, text)
  from public, anon, authenticated;
grant execute on function public.finalize_intake_dead_letter(uuid, text)
  to service_role;

-- One-time historical backfill: only rows whose current conversation state
-- still proves the dead-letter origin (exact marker, still at
-- human_handoff) are tagged. A conversation already advanced past that
-- marker by a later turn is left untouched -- never guess provenance for a
-- row the marker no longer proves.
update public.staff_work_items w
set provenance = 'intake_dead_letter'
from public.conversations c
where c.id = w.conversation_id
  and c.clinic_id = w.clinic_id
  and w.kind = 'human_handoff'
  and w.provenance = 'workflow'
  and c.intake_stage = 'human_handoff'
  and c.intake_data = pg_catalog.jsonb_build_object('dead_letter_handoff', true);

-- =========================================================================
-- 3. Recipient stores (Task 053 DB item 1). Same pattern as
-- outbound_message_outbox/webhook_events: RLS enabled, zero policies,
-- revoked from anon/authenticated/public, service_role granted directly.
-- The Worker's own code discipline (service-role RPCs only) is the trust
-- boundary; recipients are never Env secrets.
-- =========================================================================

create table public.clinic_alert_recipients (
  clinic_id uuid not null,
  user_id uuid not null,
  email text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (clinic_id, user_id),
  foreign key (clinic_id, user_id) references public.clinic_staff (clinic_id, user_id) on delete cascade,
  constraint clinic_alert_recipients_email_check check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 320
    and email like '_%@_%.__%'
  )
);

alter table public.clinic_alert_recipients enable row level security;
revoke all on public.clinic_alert_recipients from anon, authenticated, public;
grant all on public.clinic_alert_recipients to service_role;

create table public.platform_alert_recipients (
  user_id uuid primary key references public.platform_admins (user_id) on delete cascade,
  email text not null,
  enabled boolean not null default true,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint platform_alert_recipients_email_check check (
    email = lower(btrim(email))
    and char_length(email) between 3 and 320
    and email like '_%@_%.__%'
  )
);

alter table public.platform_alert_recipients enable row level security;
revoke all on public.platform_alert_recipients from anon, authenticated, public;
grant all on public.platform_alert_recipients to service_role;

-- Actor/reason audit trail for every recipient create/enable/disable/update
-- (Task 053 Codex review item 8). RLS enabled, zero policies, service_role
-- only -- same pattern as every other table in this migration.
create table public.alert_recipient_audit (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  recipient_scope text not null check (recipient_scope in ('clinic', 'platform')),
  -- ON DELETE CASCADE (Task 053 Codex second re-review item 2): a bare uuid
  -- with no FK would leave stale clinic identifiers behind after clinic
  -- offboarding. Null for platform-scope rows, so the cascade never fires
  -- for them -- only clinic-derived audit rows are cleaned up.
  clinic_id uuid references public.clinics (id) on delete cascade,
  recipient_user_id uuid not null,
  action text not null check (action in ('created', 'enabled', 'disabled', 'updated')),
  actor_user_id uuid not null,
  reason text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint alert_recipient_audit_scope_check check (
    (recipient_scope = 'clinic' and clinic_id is not null)
    or (recipient_scope = 'platform' and clinic_id is null)
  ),
  constraint alert_recipient_audit_reason_check check (
    reason = btrim(reason) and char_length(reason) between 1 and 500
  )
);

alter table public.alert_recipient_audit enable row level security;
revoke all on public.alert_recipient_audit from anon, authenticated, public;
grant select, insert on public.alert_recipient_audit to service_role;

create function public.set_clinic_alert_recipient(
  p_clinic_id uuid,
  p_user_id uuid,
  p_email text,
  p_enabled boolean,
  p_actor_user_id uuid,
  p_reason text
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_email text;
  v_member uuid;
  v_reason text;
  v_existed boolean;
  v_prev_enabled boolean;
  v_action text;
begin
  if p_clinic_id is null or p_user_id is null or p_enabled is null or p_actor_user_id is null then
    raise exception 'set_clinic_alert_recipient: invalid arguments';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if char_length(v_email) < 3 or char_length(v_email) > 320 or v_email not like '_%@_%.__%' then
    raise exception 'set_clinic_alert_recipient: invalid email';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'set_clinic_alert_recipient: invalid reason';
  end if;

  -- Only an existing clinic_staff membership may receive alert mail; this is
  -- the same tenant fact the RLS-equivalent FK below re-asserts, checked
  -- early so the caller gets a result row instead of a raised FK error.
  select cs.user_id into v_member
  from public.clinic_staff cs
  where cs.clinic_id = p_clinic_id and cs.user_id = p_user_id
  for key share of cs;

  if v_member is null then
    return query select 'not_staff'::text;
    return;
  end if;

  select enabled into v_prev_enabled
  from public.clinic_alert_recipients
  where clinic_id = p_clinic_id and user_id = p_user_id
  for update;
  v_existed := found;

  insert into public.clinic_alert_recipients (clinic_id, user_id, email, enabled)
  values (p_clinic_id, p_user_id, v_email, p_enabled)
  on conflict (clinic_id, user_id) do update
    set email = excluded.email, enabled = excluded.enabled, updated_at = pg_catalog.now();

  v_action := case
    when not v_existed then 'created'
    when v_prev_enabled = p_enabled then 'updated'
    when p_enabled then 'enabled'
    else 'disabled'
  end;

  insert into public.alert_recipient_audit (recipient_scope, clinic_id, recipient_user_id, action, actor_user_id, reason)
  values ('clinic', p_clinic_id, p_user_id, v_action, p_actor_user_id, v_reason);

  return query select 'set'::text;
  return;
end;
$$;

revoke all on function public.set_clinic_alert_recipient(uuid, uuid, text, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_clinic_alert_recipient(uuid, uuid, text, boolean, uuid, text)
  to service_role;

create function public.set_platform_alert_recipient(
  p_user_id uuid,
  p_email text,
  p_enabled boolean,
  p_actor_user_id uuid,
  p_reason text
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_email text;
  v_reason text;
  v_existed boolean;
  v_prev_enabled boolean;
  v_action text;
begin
  if p_user_id is null or p_enabled is null or p_actor_user_id is null then
    raise exception 'set_platform_alert_recipient: invalid arguments';
  end if;

  v_email := lower(btrim(coalesce(p_email, '')));
  if char_length(v_email) < 3 or char_length(v_email) > 320 or v_email not like '_%@_%.__%' then
    raise exception 'set_platform_alert_recipient: invalid email';
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) < 1 or char_length(v_reason) > 500 then
    raise exception 'set_platform_alert_recipient: invalid reason';
  end if;

  select enabled into v_prev_enabled
  from public.platform_alert_recipients
  where user_id = p_user_id
  for update;
  v_existed := found;

  begin
    insert into public.platform_alert_recipients (user_id, email, enabled)
    values (p_user_id, v_email, p_enabled)
    on conflict (user_id) do update
      set email = excluded.email, enabled = excluded.enabled, updated_at = pg_catalog.now();
  exception
    when foreign_key_violation then
      return query select 'not_admin'::text;
      return;
  end;

  v_action := case
    when not v_existed then 'created'
    when v_prev_enabled = p_enabled then 'updated'
    when p_enabled then 'enabled'
    else 'disabled'
  end;

  insert into public.alert_recipient_audit (recipient_scope, clinic_id, recipient_user_id, action, actor_user_id, reason)
  values ('platform', null, p_user_id, v_action, p_actor_user_id, v_reason);

  return query select 'set'::text;
  return;
end;
$$;

revoke all on function public.set_platform_alert_recipient(uuid, text, boolean, uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_platform_alert_recipient(uuid, text, boolean, uuid, text)
  to service_role;

-- =========================================================================
-- 4. Durable alert/delivery dedup + lease state (Task 053 DB item 4).
-- Rows reference the current recipient record (clinic_id + recipient_user_id,
-- or recipient_user_id alone for platform scope) rather than copying an
-- address; the address is read fresh at send time via that join. No PII: no
-- pet/owner/message/phone content is stored here, only closed identifiers.
-- =========================================================================

create table public.alert_deliveries (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  signal_kind text not null check (signal_kind in (
    'delivery_failure',
    'human_handoff_urgent',
    'human_handoff_normal',
    'intake_dead_letter',
    'queue_backlog',
    'webhook_5xx',
    'webhook_401',
    'openai_extraction_failure'
  )),
  recipient_scope text not null check (recipient_scope in ('clinic', 'platform')),
  clinic_id uuid,
  recipient_user_id uuid not null,
  work_item_id uuid,
  dedup_key text not null,
  -- Bumped only by record_platform_signal's ON CONFLICT; feeds the
  -- platform-mail aggregate count, never shown in clinic mail.
  occurrence_count integer not null default 1,
  delivery_status text not null default 'pending',
  delivery_claim_token uuid,
  delivery_lease_until timestamptz,
  delivery_attempt_count integer not null default 0,
  next_attempt_at timestamptz default pg_catalog.now(),
  accepted_at timestamptz,
  failed_at timestamptz,
  failure_reason text,
  -- Repeat/recovery (Task 053 Codex re-review item 1): set only at accept
  -- time, only for repeat-eligible signal kinds, only while the underlying
  -- work item is still unresolved. next_repeat_at is cleared the moment a
  -- row stops being the series' live "accepted, awaiting repeat" row --
  -- superseded by a fresh repeat row (schedule_alert_repeat_notifications)
  -- or closed out by recovery -- so it can never survive as a stale value.
  -- recovered_at is the explicit, permanent recovery fact itself: it is set
  -- once the underlying work item resolves and is never inferred from
  -- next_repeat_at going stale.
  next_repeat_at timestamptz,
  recovered_at timestamptz,
  repeat_count integer not null default 0 check (repeat_count >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  -- recipient_scope = 'platform' rows must carry clinic_id = null: this is
  -- what makes the MATCH SIMPLE composite FKs below auto-inert for platform
  -- rows (Task 053 Codex review item 8).
  platform_recipient_ref uuid generated always as (
    case when recipient_scope = 'platform' then recipient_user_id else null end
  ) stored,
  constraint alert_deliveries_dedup_key_unique unique (dedup_key),
  constraint alert_deliveries_clinic_scope_check check (
    (recipient_scope = 'clinic' and clinic_id is not null)
    or (recipient_scope = 'platform' and clinic_id is null)
  ),
  -- recovered_at is only ever meaningful on the series' terminal, closed
  -- 'accepted' row: it can never coexist with a still-live next_repeat_at.
  constraint alert_deliveries_recovered_at_check check (
    recovered_at is null
    or (delivery_status = 'accepted' and next_repeat_at is null)
  ),
  constraint alert_deliveries_status_check check (
    (delivery_status = 'pending'
      and delivery_claim_token is null and delivery_lease_until is null
      and accepted_at is null and failed_at is null
      and failure_reason is null
      and next_attempt_at is not null and next_repeat_at is null
      and delivery_attempt_count between 0 and 2)
    or (delivery_status = 'claimed'
      and delivery_claim_token is not null and delivery_lease_until is not null
      and accepted_at is null and failed_at is null
      and failure_reason is null
      and next_attempt_at is null and next_repeat_at is null
      and delivery_attempt_count between 1 and 3)
    or (delivery_status = 'accepted'
      and delivery_claim_token is null and delivery_lease_until is null
      and accepted_at is not null and failed_at is null
      and failure_reason is null
      and next_attempt_at is null
      and delivery_attempt_count between 1 and 3)
    or (delivery_status = 'failed'
      and delivery_claim_token is null and delivery_lease_until is null
      and accepted_at is null and failed_at is not null
      and failure_reason in ('send_failed', 'attempts_exhausted')
      and next_attempt_at is null and next_repeat_at is null
      and delivery_attempt_count = 3)
  )
);

create index alert_deliveries_claim_idx
  on public.alert_deliveries (delivery_status, next_attempt_at, delivery_lease_until, created_at, id);

create index alert_deliveries_repeat_idx
  on public.alert_deliveries (delivery_status, next_repeat_at) where next_repeat_at is not null;

-- Task 053 Codex re-review item 1: the database-enforced series identity.
-- A repeat never reopens/reuses the row it is repeating -- it is always a
-- new row with its own id and its own dedup_key (see
-- schedule_alert_repeat_notifications) -- so uniqueness can no longer live
-- on dedup_key alone once a series has more than one row. This partial
-- index instead bounds the live, not-yet-decided part of a series: at most
-- one pending/claimed row may exist at a time per (work_item, recipient),
-- so a series can never have two notices in flight together. Terminal rows
-- (accepted/failed) fall outside the index and simply accumulate as
-- immutable history.
create unique index alert_deliveries_active_series_idx
  on public.alert_deliveries (work_item_id, recipient_scope, recipient_user_id)
  where delivery_status in ('pending', 'claimed');

alter table public.alert_deliveries enable row level security;
revoke all on public.alert_deliveries from anon, authenticated, public;
grant all on public.alert_deliveries to service_role;

-- Recipient/work-item reference coherence (Task 053 Codex review item 8).
-- staff_work_items has no natural (id, clinic_id) unique key yet -- add one
-- the same way 20260809000400_staff_work_items.sql added it for
-- outbound_message_outbox -- so the composite FK below can prove a
-- clinic-scope delivery's work item actually belongs to that clinic.
alter table public.staff_work_items
  add constraint staff_work_items_id_clinic_id_unique unique (id, clinic_id);

-- Work item must exist, full stop. ON DELETE CASCADE (Task 053 Codex second
-- re-review item 2): finalize_clinic_offboarding_v1 deletes staff_work_items
-- via clinics' existing cascade, and a delivery is meaningless once its work
-- item is gone -- without this the offboarding delete would be FK-blocked
-- the moment any alert had ever fired for that clinic. work_item_id is null
-- for the platform-signal kinds that carry no work item, so this action
-- never fires for them.
alter table public.alert_deliveries
  add constraint alert_deliveries_work_item_fkey
  foreign key (work_item_id) references public.staff_work_items (id) on delete cascade;

-- Work item's clinic must match a clinic-scope delivery's clinic_id; MATCH
-- SIMPLE (the default) skips this for platform-scope rows, whose clinic_id
-- is always null. ON DELETE CASCADE for the same reason as the FK above --
-- both constraints reference the same work item row, so both cascades are
-- idempotent with each other.
alter table public.alert_deliveries
  add constraint alert_deliveries_work_item_clinic_fkey
  foreign key (work_item_id, clinic_id) references public.staff_work_items (id, clinic_id) on delete cascade;

-- Clinic-scope recipient must exist in clinic_alert_recipients; null-skipped
-- for platform-scope rows the same way. ON DELETE CASCADE (Task 053 Codex
-- second re-review item 2): clinic_alert_recipients itself cascades from
-- clinic_staff, which cascades from clinics -- without this action, a
-- clinic's own alert_deliveries history would FK-block deleting its own
-- clinic_alert_recipients row during offboarding.
alter table public.alert_deliveries
  add constraint alert_deliveries_clinic_recipient_fkey
  foreign key (clinic_id, recipient_user_id) references public.clinic_alert_recipients (clinic_id, user_id) on delete cascade;

-- Platform-scope recipient must exist in platform_alert_recipients. A plain
-- FK on recipient_user_id would wrongly also apply to clinic-scope rows
-- (which reference clinic_staff, not platform_admins), so the generated
-- platform_recipient_ref column narrows this FK to platform-scope rows only.
-- ON DELETE CASCADE (Task 053 Codex second re-review item 2): SET NULL is
-- not an option on a generated column (it would just recompute back to the
-- same non-null value from recipient_scope/recipient_user_id), and the
-- point of this action is the same as the two FKs above -- removing a
-- platform admin/recipient (set_platform_admin_v1 disable path) must not be
-- FK-blocked by that recipient's own signal history; deliveries unrelated
-- to the removed recipient are untouched.
alter table public.alert_deliveries
  add constraint alert_deliveries_platform_recipient_fkey
  foreign key (platform_recipient_ref) references public.platform_alert_recipients (user_id) on delete cascade;

-- =========================================================================
-- 5a. Candidate synchronization (Task 053 DB item 6): mutually exclusive
-- routing over staff_work_items. Branch order matters only for readability
-- -- the four WHERE clauses are disjoint by construction (provenance and
-- priority each partition the rows), so no work item can ever match two
-- branches. ON CONFLICT DO NOTHING against the unique dedup_key is what
-- makes repeated scans produce no duplicate first notices; a resolved item
-- simply stops matching any candidates CTE on the next scan, so no separate
-- "cancel" step is needed. A work item resolved in the small window between
-- this read and the INSERT still gets one delivery row -- an accepted,
-- documented race (see delivery record), not a tenant-safety issue.
-- =========================================================================

create function public.sync_alert_delivery_candidates()
returns table (inserted_count integer)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_inserted integer := 0;
  v_batch integer;
begin
  -- Branch 1: terminal delivery_failure -> clinic + platform, immediate, no repeat.
  with candidates as (
    select w.id as work_item_id, w.clinic_id
    from public.staff_work_items w
    where w.kind = 'delivery_failure'
      and w.status <> 'resolved'
  ),
  fanout as (
    select c.work_item_id, c.clinic_id, 'clinic'::text as recipient_scope, r.user_id as recipient_user_id
    from candidates c
    join public.clinic_alert_recipients r on r.clinic_id = c.clinic_id and r.enabled
    union all
    select c.work_item_id, c.clinic_id, 'platform'::text, r.user_id
    from candidates c
    cross join public.platform_alert_recipients r
    where r.enabled
  )
  insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  select 'delivery_failure', f.recipient_scope,
         case when f.recipient_scope = 'clinic' then f.clinic_id else null end,
         f.recipient_user_id, f.work_item_id,
         'work_item:' || f.work_item_id::text || ':' || f.recipient_scope || ':' || f.recipient_user_id::text
  from fanout f
  on conflict (dedup_key) do nothing;
  get diagnostics v_batch = row_count;
  v_inserted := v_inserted + v_batch;

  -- Branch 2: intake_dead_letter provenance -> clinic + platform, immediate,
  -- framed as unassessed, not clinically urgent.
  with candidates as (
    select w.id as work_item_id, w.clinic_id
    from public.staff_work_items w
    where w.kind = 'human_handoff'
      and w.provenance = 'intake_dead_letter'
      and w.status <> 'resolved'
  ),
  fanout as (
    select c.work_item_id, c.clinic_id, 'clinic'::text as recipient_scope, r.user_id as recipient_user_id
    from candidates c
    join public.clinic_alert_recipients r on r.clinic_id = c.clinic_id and r.enabled
    union all
    select c.work_item_id, c.clinic_id, 'platform'::text, r.user_id
    from candidates c
    cross join public.platform_alert_recipients r
    where r.enabled
  )
  insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  select 'intake_dead_letter', f.recipient_scope,
         case when f.recipient_scope = 'clinic' then f.clinic_id else null end,
         f.recipient_user_id, f.work_item_id,
         'work_item:' || f.work_item_id::text || ':' || f.recipient_scope || ':' || f.recipient_user_id::text
  from fanout f
  on conflict (dedup_key) do nothing;
  get diagnostics v_batch = row_count;
  v_inserted := v_inserted + v_batch;

  -- Branch 3: unresolved urgent human_handoff, ordinary workflow provenance
  -- only -> clinic, immediate.
  with candidates as (
    select w.id as work_item_id, w.clinic_id
    from public.staff_work_items w
    where w.kind = 'human_handoff'
      and w.provenance = 'workflow'
      and w.priority = 'urgent'
      and w.status <> 'resolved'
  ),
  fanout as (
    select c.work_item_id, c.clinic_id, 'clinic'::text as recipient_scope, r.user_id as recipient_user_id
    from candidates c
    join public.clinic_alert_recipients r on r.clinic_id = c.clinic_id and r.enabled
  )
  insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  select 'human_handoff_urgent', f.recipient_scope, f.clinic_id, f.recipient_user_id, f.work_item_id,
         'work_item:' || f.work_item_id::text || ':' || f.recipient_scope || ':' || f.recipient_user_id::text
  from fanout f
  on conflict (dedup_key) do nothing;
  get diagnostics v_batch = row_count;
  v_inserted := v_inserted + v_batch;

  -- Branch 4: unresolved normal human_handoff, ordinary workflow provenance
  -- only, open for at least 4 hours -> clinic.
  with candidates as (
    select w.id as work_item_id, w.clinic_id
    from public.staff_work_items w
    where w.kind = 'human_handoff'
      and w.provenance = 'workflow'
      and w.priority = 'normal'
      and w.status <> 'resolved'
      and w.created_at <= pg_catalog.now() - interval '4 hours'
  ),
  fanout as (
    select c.work_item_id, c.clinic_id, 'clinic'::text as recipient_scope, r.user_id as recipient_user_id
    from candidates c
    join public.clinic_alert_recipients r on r.clinic_id = c.clinic_id and r.enabled
  )
  insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  select 'human_handoff_normal', f.recipient_scope, f.clinic_id, f.recipient_user_id, f.work_item_id,
         'work_item:' || f.work_item_id::text || ':' || f.recipient_scope || ':' || f.recipient_user_id::text
  from fanout f
  on conflict (dedup_key) do nothing;
  get diagnostics v_batch = row_count;
  v_inserted := v_inserted + v_batch;

  return query select v_inserted;
  return;
end;
$$;

revoke all on function public.sync_alert_delivery_candidates()
  from public, anon, authenticated;
grant execute on function public.sync_alert_delivery_candidates()
  to service_role;

-- =========================================================================
-- 5b. Platform-signal recording (Task 053 DB item 5/Worker items 3-5): a
-- single entry point for every platform-only monitoring signal (queue
-- backlog, webhook 5xx/401 telemetry, the OpenAI-extraction-failure
-- fallback signal). Dedup is bucketed to the current UTC hour, so a
-- persisting condition re-alerts at most once per hour instead of once per
-- Cron tick; this is a deliberate, documented simplification (see delivery
-- record), not a per-row cadence tuned to docs/operational-alerting.md's
-- non-binding suggested cadences.
-- =========================================================================

create function public.record_platform_signal(p_signal_kind text, p_queue_id text default null)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_bucket text;
  v_base_key text;
  v_affected integer;
begin
  if p_signal_kind not in ('queue_backlog', 'webhook_5xx', 'webhook_401', 'openai_extraction_failure') then
    raise exception 'record_platform_signal: invalid signal_kind';
  end if;

  v_bucket := to_char(pg_catalog.date_trunc('hour', pg_catalog.now()), 'YYYYMMDDHH24');
  v_base_key := 'platform_signal:' || p_signal_kind || ':' || coalesce(p_queue_id, '-') || ':' || v_bucket;

  insert into public.alert_deliveries (signal_kind, recipient_scope, recipient_user_id, dedup_key)
  select p_signal_kind, 'platform', r.user_id, v_base_key || ':' || r.user_id::text
  from public.platform_alert_recipients r
  where r.enabled
  on conflict (dedup_key) do update
    set occurrence_count = public.alert_deliveries.occurrence_count + 1;

  get diagnostics v_affected = row_count;
  if v_affected = 0 then
    return query select 'no_recipients'::text;
    return;
  end if;

  return query select 'recorded'::text;
  return;
end;
$$;

revoke all on function public.record_platform_signal(text, text)
  from public, anon, authenticated;
grant execute on function public.record_platform_signal(text, text)
  to service_role;

-- =========================================================================
-- 6. Delivery claim/accept/release (Task 053 DB item 5), same shape as
-- claim_outbound_message/accept_outbound_message/release_outbound_message
-- in supabase/migrations/20260809000200_outbound_delivery.sql: 5-minute
-- lease, SKIP LOCKED claim, 2-minute retry backoff, 3-attempt ceiling.
-- =========================================================================

-- recipient_email is resolved fresh at claim time (not copied at insert
-- time), so a recipient disabled between candidate-sync and claim is
-- re-checked here and the row is simply never selected -- it stays
-- 'pending' rather than sending to a since-disabled address. A row for a
-- recipient disabled after being claimed already carries the address it
-- needs to finish that one send; disabling only ever prevents a *future*
-- claim, never recalls one already in flight.
create function public.claim_alert_delivery()
returns table (
  id uuid,
  signal_kind text,
  recipient_scope text,
  clinic_id uuid,
  recipient_user_id uuid,
  work_item_id uuid,
  recipient_email text,
  occurrence_count integer,
  created_at timestamptz,
  claim_token uuid
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_id uuid;
  v_work_item_id uuid;
  v_work_item_status text;
  v_delivery_status text;
  v_attempts integer;
  v_token uuid := pg_catalog.gen_random_uuid();
begin
  select d.id, d.work_item_id, d.delivery_status, d.delivery_attempt_count
    into v_id, v_work_item_id, v_delivery_status, v_attempts
  from public.alert_deliveries d
  where (
      (d.delivery_status = 'pending' and d.next_attempt_at <= pg_catalog.now())
      or (d.delivery_status = 'claimed' and d.delivery_lease_until <= pg_catalog.now())
    )
    and (
      (d.recipient_scope = 'clinic' and exists (
        select 1 from public.clinic_alert_recipients r
        where r.clinic_id = d.clinic_id and r.user_id = d.recipient_user_id and r.enabled
      ))
      or
      (d.recipient_scope = 'platform' and exists (
        select 1 from public.platform_alert_recipients r
        where r.user_id = d.recipient_user_id and r.enabled
      ))
    )
    -- Task 053 Codex review item 5: a work item resolved by sync (or by any
    -- other path) between candidate-sync and claim must never be claimed
    -- again. Platform-scope rows skip the clinic match on purpose -- platform
    -- recipients are legitimately cross-tenant, and clinic_id is always null
    -- for them (alert_deliveries_clinic_scope_check).
    and (
      d.work_item_id is null
      or exists (
        select 1 from public.staff_work_items w
        where w.id = d.work_item_id
          and w.status <> 'resolved'
          and (d.recipient_scope = 'platform' or w.clinic_id = d.clinic_id)
      )
    )
  order by d.created_at, d.id
  for update skip locked
  limit 1;

  if v_id is null then
    return;
  end if;

  -- A crashed send already consumed its attempt when it was claimed. Once a
  -- third claim lease expires, close it instead of sending the same email
  -- forever after the provider's idempotency window expires.
  if v_delivery_status = 'claimed' and v_attempts >= 3 then
    update public.alert_deliveries d
      set delivery_status = 'failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null,
          failed_at = pg_catalog.now(),
          failure_reason = 'attempts_exhausted'
      where d.id = v_id;
    return;
  end if;

  -- Task 053 Codex re-review item 2: the exists-check above reads
  -- staff_work_items from the candidate query's own snapshot, without a row
  -- lock, so a concurrent resolve_staff_work_item() could still commit in
  -- the gap between that read and this function's UPDATE below. Lock the
  -- exact tenant-bound work item now and re-read its authoritative status
  -- before finalizing the claim. FOR NO KEY UPDATE conflicts both with
  -- resolve_staff_work_item's FOR UPDATE and with the delivery-status
  -- trigger paths' ordinary FOR NO KEY UPDATE row lock. Locking it after the
  -- alert_deliveries row above (never before) matches the only order this
  -- function ever uses; resolve_staff_work_item never locks alert_deliveries
  -- at all, so no cycle between the two functions is possible.
  if v_work_item_id is not null then
    select w.status into v_work_item_status
    from public.staff_work_items w
    where w.id = v_work_item_id
    for no key update;

    if v_work_item_status is null or v_work_item_status = 'resolved' then
      -- Recovered between the candidate read and this lock: never claim
      -- it. The row stays pending; a documented two-session limitation is
      -- that this run's remaining candidates are retried on the next tick
      -- rather than in this same call.
      return;
    end if;
  end if;

  update public.alert_deliveries
    set delivery_status = 'claimed',
        delivery_claim_token = v_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = v_attempts + 1,
        next_attempt_at = null
    where alert_deliveries.id = v_id;

  return query
  select
    d.id, d.signal_kind, d.recipient_scope, d.clinic_id, d.recipient_user_id, d.work_item_id,
    coalesce(
      (select r.email from public.clinic_alert_recipients r
        where d.recipient_scope = 'clinic' and r.clinic_id = d.clinic_id and r.user_id = d.recipient_user_id),
      (select r.email from public.platform_alert_recipients r
        where d.recipient_scope = 'platform' and r.user_id = d.recipient_user_id)
    ) as recipient_email,
    d.occurrence_count,
    d.created_at,
    v_token
  from public.alert_deliveries d
  where d.id = v_id;
end;
$$;

revoke all on function public.claim_alert_delivery() from public, anon, authenticated;
grant execute on function public.claim_alert_delivery() to service_role;

create function public.accept_alert_delivery(p_id uuid, p_claim_token uuid)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
  v_signal_kind text;
  v_clinic_id uuid;
  v_recipient_scope text;
  v_work_item_id uuid;
  v_repeat_count integer;
  v_next_repeat_at timestamptz;
  v_recovered_at timestamptz;
  v_still_open boolean;
begin
  if p_id is null or p_claim_token is null then
    raise exception 'accept_alert_delivery: invalid arguments';
  end if;

  select delivery_status, delivery_claim_token, signal_kind, clinic_id, recipient_scope, work_item_id, repeat_count
    into v_status, v_token, v_signal_kind, v_clinic_id, v_recipient_scope, v_work_item_id, v_repeat_count
  from public.alert_deliveries
  where id = p_id
  for update;

  if v_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_status = 'accepted' then
    return query select 'already_accepted'::text;
    return;
  end if;
  if v_status <> 'claimed' or v_token is distinct from p_claim_token then
    return query select 'stale_claim'::text;
    return;
  end if;

  -- Task 053 Codex re-review item 1: repeat/recovery are explicit, closed
  -- database states, never inferred from the provider's send acceptance or
  -- from a stale next_repeat_at. Only human_handoff_urgent/human_handoff_normal
  -- repeat, and only while the underlying work item is still unresolved
  -- right now -- a work item resolved between claim and accept ends the
  -- chain here, and that recovery is recorded on this row immediately
  -- rather than left to be inferred later, exactly like
  -- claim_alert_delivery's own tenant/unresolved recheck.
  v_next_repeat_at := null;
  v_recovered_at := null;
  if v_signal_kind in ('human_handoff_urgent', 'human_handoff_normal') and v_work_item_id is not null then
    select w.status <> 'resolved' into v_still_open
    from public.staff_work_items w
    where w.id = v_work_item_id
      and (v_recipient_scope = 'platform' or w.clinic_id = v_clinic_id);

    if coalesce(v_still_open, false) then
      v_next_repeat_at := pg_catalog.now() + (case
        when v_signal_kind = 'human_handoff_urgent' then
          case
            when v_repeat_count <= 0 then interval '15 minutes'
            when v_repeat_count = 1 then interval '30 minutes'
            else interval '1 hour'
          end
        else interval '24 hours'
      end);
    else
      v_recovered_at := pg_catalog.now();
    end if;
  end if;

  update public.alert_deliveries
    set delivery_status = 'accepted',
        accepted_at = pg_catalog.now(),
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_repeat_at = v_next_repeat_at,
        recovered_at = v_recovered_at
    where id = p_id;

  return query select 'accepted'::text;
  return;
end;
$$;

revoke all on function public.accept_alert_delivery(uuid, uuid) from public, anon, authenticated;
grant execute on function public.accept_alert_delivery(uuid, uuid) to service_role;

create function public.release_alert_delivery(p_id uuid, p_claim_token uuid, p_failure_reason text)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_token uuid;
  v_attempts integer;
begin
  if p_id is null or p_claim_token is null or p_failure_reason is distinct from 'send_failed' then
    raise exception 'release_alert_delivery: invalid arguments';
  end if;

  select delivery_status, delivery_claim_token, delivery_attempt_count
    into v_status, v_token, v_attempts
  from public.alert_deliveries
  where id = p_id
  for update;

  if v_status is null then
    return query select 'not_found'::text;
    return;
  end if;
  if v_status = 'accepted' or v_status = 'failed' then
    return query select 'already_terminal'::text;
    return;
  end if;
  if v_status <> 'claimed' or v_token is distinct from p_claim_token then
    return query select 'stale_claim'::text;
    return;
  end if;

  if v_attempts >= 3 then
    update public.alert_deliveries
      set delivery_status = 'failed',
          failed_at = pg_catalog.now(),
          -- The caller may submit only this fixed value; provider bodies and
          -- arbitrary text never enter the database.
          failure_reason = 'send_failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null
      where id = p_id;
    return query select 'exhausted'::text;
    return;
  end if;

  update public.alert_deliveries
    set delivery_status = 'pending',
        next_attempt_at = pg_catalog.now() + interval '2 minutes',
        delivery_claim_token = null,
        delivery_lease_until = null
    where id = p_id;

  return query select 'retrying'::text;
  return;
end;
$$;

revoke all on function public.release_alert_delivery(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.release_alert_delivery(uuid, uuid, text) to service_role;

-- =========================================================================
-- 6b. Repeat/recovery (Task 053 Codex re-review item 1): a due repeat is
-- always a brand new row with its own id and its own Resend idempotency
-- key -- the 'accepted' row being repeated is never reopened or recycled,
-- so its accepted_at history stays intact forever. dedup_key is derived
-- fresh from the series identity (work_item_id, recipient_scope,
-- recipient_user_id) plus the new repeat number, which keeps the
-- database-enforced series relationship: the same series can never have two
-- rows with the same repeat number, and alert_deliveries_active_series_idx
-- caps it to one live (pending/claimed) row at a time. A work item that
-- resolved before its repeat came due is never silently left with a stale
-- next_repeat_at: recovery is recorded explicitly and permanently via
-- recovered_at, whether or not a repeat was actually due yet.
-- =========================================================================

create function public.schedule_alert_repeat_notifications()
returns table (reopened_count integer)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_reopened integer := 0;
  v_row record;
  v_next_dedup_key text;
begin
  for v_row in
    select d.id, d.signal_kind, d.recipient_scope, d.clinic_id, d.recipient_user_id,
           d.work_item_id, d.repeat_count, d.occurrence_count, d.next_repeat_at,
           w.status as work_item_status
    from public.alert_deliveries d
    join public.staff_work_items w on w.id = d.work_item_id
    where d.delivery_status = 'accepted'
      and d.next_repeat_at is not null
      and (d.recipient_scope = 'platform' or w.clinic_id = d.clinic_id)
    order by d.created_at, d.id
    for update of d skip locked
  loop
    if v_row.work_item_status = 'resolved' then
      update public.alert_deliveries
        set next_repeat_at = null,
            recovered_at = pg_catalog.now()
        where id = v_row.id;
      continue;
    end if;

    if v_row.next_repeat_at > pg_catalog.now() then
      continue;
    end if;

    v_next_dedup_key := 'work_item:' || v_row.work_item_id::text || ':' || v_row.recipient_scope
      || ':' || v_row.recipient_user_id::text || ':repeat:' || (v_row.repeat_count + 1)::text;

    begin
      insert into public.alert_deliveries (
        signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id,
        dedup_key, repeat_count, occurrence_count
      )
      values (
        v_row.signal_kind, v_row.recipient_scope, v_row.clinic_id, v_row.recipient_user_id, v_row.work_item_id,
        v_next_dedup_key, v_row.repeat_count + 1, v_row.occurrence_count + 1
      );
    exception
      when unique_violation then
        -- Another process already created this series' next repeat row.
        null;
    end;

    update public.alert_deliveries
      set next_repeat_at = null
      where id = v_row.id;

    v_reopened := v_reopened + 1;
  end loop;

  return query select v_reopened;
  return;
end;
$$;

revoke all on function public.schedule_alert_repeat_notifications() from public, anon, authenticated;
grant execute on function public.schedule_alert_repeat_notifications() to service_role;

-- =========================================================================
-- 7. Monitor heartbeat (Task 053 DB item 7 / Worker item 8): a single
-- environment's database-time-only heartbeat. Exposed to /ready only as a
-- closed boolean (public.is_alert_monitor_heartbeat_fresh) -- never the
-- timestamp, never a count, never why it is stale. last_run_at seeds as
-- null (Task 053 Codex re-review item 4): the row must start stale and stay
-- that way until record_alert_monitor_heartbeat() records a real completed
-- run, never fresh-by-migration before the monitor has ever actually run.
-- =========================================================================

create table public.alert_monitor_heartbeat (
  id boolean primary key default true,
  last_run_at timestamptz,
  constraint alert_monitor_heartbeat_singleton check (id)
);

insert into public.alert_monitor_heartbeat (id) values (true);

alter table public.alert_monitor_heartbeat enable row level security;
revoke all on public.alert_monitor_heartbeat from anon, authenticated, public;
grant select, update on public.alert_monitor_heartbeat to service_role;

create function public.record_alert_monitor_heartbeat()
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
begin
  if not exists (select 1 from public.platform_alert_recipients where enabled) then
    return query select 'no_recipients'::text;
    return;
  end if;

  update public.alert_monitor_heartbeat
    set last_run_at = pg_catalog.now()
    where id = true;

  return query select 'recorded'::text;
  return;
end;
$$;

revoke all on function public.record_alert_monitor_heartbeat() from public, anon, authenticated;
grant execute on function public.record_alert_monitor_heartbeat() to service_role;

create function public.is_alert_monitor_heartbeat_fresh(p_max_age_seconds integer default 180)
returns table (fresh boolean)
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_last timestamptz;
  v_has_recipient boolean;
begin
  if p_max_age_seconds is null or p_max_age_seconds <= 0 then
    raise exception 'is_alert_monitor_heartbeat_fresh: invalid max_age_seconds';
  end if;

  select last_run_at into v_last from public.alert_monitor_heartbeat where id = true;
  select exists (select 1 from public.platform_alert_recipients where enabled) into v_has_recipient;

  return query select v_has_recipient and v_last is not null and v_last >= pg_catalog.now() - make_interval(secs => p_max_age_seconds);
  return;
end;
$$;

revoke all on function public.is_alert_monitor_heartbeat_fresh(integer) from public, anon, authenticated;
grant execute on function public.is_alert_monitor_heartbeat_fresh(integer) to service_role;
