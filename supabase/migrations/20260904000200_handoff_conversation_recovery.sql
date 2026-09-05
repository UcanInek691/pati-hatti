-- Safe terminal-handoff recovery for VetAI (Task 051): resolving a
-- `kind = 'human_handoff'` staff_work_items row now atomically completes its
-- linked conversation in the same transaction, so a later inbound message
-- creates a fresh conversation and runs safety-first intake again instead of
-- being permanently locked out. Resolving a `kind = 'delivery_failure'` item
-- remains byte-for-byte unchanged: only the work item changes. A one-time
-- backfill repairs conversations left stuck by the old behavior, under the
-- exact conditions in CURRENT_TASK.md decision 10 only.
-- Not run against any database by the implementer (Claude Sonnet); Codex
-- must apply this migration and the paired fixture
-- (supabase/tests/051_handoff_conversation_recovery.sql) only on disposable
-- vetai-test, with zero residue, before any staging activation.
-- See docs/staff-workflow.md and docs/database-schema.md.

-- =========================================================================
-- public.resolve_staff_work_item (replaced; signature and public result set
-- unchanged: resolved | already_resolved | not_claimed | not_owner |
-- not_found)
-- =========================================================================

create or replace function public.resolve_staff_work_item(p_work_item_id uuid)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  -- Step 1: untrusted locator read (no lock), used only to pick the correct
  -- lock order below. Revalidated against the authoritative reread in step 5.
  v_locator_clinic_id uuid;
  v_locator_conversation_id uuid;
  v_locator_kind text;
  -- Step 5: authoritative, locked reread.
  v_clinic_id uuid;
  v_conversation_id uuid;
  v_kind text;
  v_reason text;
  v_status text;
  v_assigned_to uuid;
  v_conv_status text;
  v_conv_stage text;
  v_clinic_lock uuid;
  v_member_lock uuid;
begin
  if p_work_item_id is null then
    raise exception 'resolve_staff_work_item: invalid work_item_id';
  end if;

  v_caller := (select auth.uid());

  -- 1. Untrusted locator read for clinic/conversation/kind.
  select clinic_id, conversation_id, kind
    into v_locator_clinic_id, v_locator_conversation_id, v_locator_kind
  from public.staff_work_items
  where id = p_work_item_id;

  if v_locator_clinic_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  -- 2. Lock and revalidate the clinic, then the exact caller membership.
  -- FOR KEY SHARE serializes against clinic-lifecycle FOR UPDATE mutations
  -- (supabase/migrations/20260831000100_clinic_lifecycle.sql) without
  -- conflicting with other concurrent readers.
  select cl.id into v_clinic_lock
  from public.clinics cl
  where cl.id = v_locator_clinic_id
  for key share of cl;

  select cs.user_id into v_member_lock
  from public.clinic_staff cs
  where cs.clinic_id = v_locator_clinic_id
    and cs.user_id = v_caller
  for key share of cs;

  if v_caller is null
    or v_clinic_lock is null
    or v_member_lock is distinct from v_caller
  then
    return query select 'not_found'::text;
    return;
  end if;

  -- 4. For the human-handoff path only, lock the exact conversation before
  -- the work item. This matches vetai_private.sync_human_handoff_work_item's
  -- own order: its trigger locks the conversation row via its own UPDATE
  -- before ever touching staff_work_items. FOR NO KEY UPDATE does not
  -- conflict with the FOR KEY SHARE locks that child-table foreign keys
  -- (messages, appointment_slots, staff_work_items, outbox) implicitly take
  -- on their parent conversation row, so unrelated inserts on this
  -- conversation are not blocked by this lock.
  if v_locator_kind = 'human_handoff' then
    perform 1
    from public.conversations
    where id = v_locator_conversation_id and clinic_id = v_locator_clinic_id
    for no key update;
  end if;

  -- 5. Lock and authoritatively reread the work item. `reason` is read here
  -- (contract step 5) for the same audit-completeness reasons the caller
  -- identity is; only `kind` drives branching below, since the
  -- kind/reason pairing is already enforced by
  -- staff_work_items_kind_reason_check.
  select clinic_id, conversation_id, kind, reason, status, assigned_to
    into v_clinic_id, v_conversation_id, v_kind, v_reason, v_status, v_assigned_to
  from public.staff_work_items
  where id = p_work_item_id
  for update;

  if v_clinic_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  -- Revalidate locator values. These columns are never updated anywhere
  -- in the codebase, but only this locked reread is authoritative.
  if v_clinic_id is distinct from v_locator_clinic_id
    or v_conversation_id is distinct from v_locator_conversation_id
    or v_kind is distinct from v_locator_kind
  then
    raise exception 'resolve_staff_work_item: work item % identity changed during lock acquisition', p_work_item_id;
  end if;

  if v_status = 'resolved' then
    return query select 'already_resolved'::text;
    return;
  end if;

  if v_status <> 'in_progress' or v_assigned_to is null then
    return query select 'not_claimed'::text;
    return;
  end if;

  if v_assigned_to <> v_caller then
    return query select 'not_owner'::text;
    return;
  end if;

  -- 6. Complete the conversation (human-handoff only), then resolve the
  -- item, atomically.
  if v_kind = 'human_handoff' then
    select c.status, c.intake_stage
      into v_conv_status, v_conv_stage
    from public.conversations c
    where c.id = v_conversation_id and c.clinic_id = v_clinic_id;

    if v_conv_status = 'handoff' and v_conv_stage = 'human_handoff' then
      update public.conversations
        set status = 'completed', intake_stage = 'completed', state_version = state_version + 1
        where id = v_conversation_id and clinic_id = v_clinic_id;
    elsif v_conv_status = 'completed' and v_conv_stage = 'completed' then
      -- Decision 9: already exactly terminal tolerates resolution of the
      -- assigned open handoff item without another version increment.
      null;
    else
      raise exception
        'resolve_staff_work_item: unexpected conversation %/% status/stage for conversation % (work item %)',
        v_conv_status, v_conv_stage, v_conversation_id, p_work_item_id;
    end if;
  end if;

  update public.staff_work_items
    set status = 'resolved', resolved_at = pg_catalog.now(), resolved_by = v_caller
    where id = p_work_item_id;

  return query select 'resolved'::text;
  return;
end;
$$;

-- ACL is preserved by CREATE OR REPLACE (owner unchanged, no DROP), so the
-- existing authenticated-only grant still applies. Restated here only for
-- auditability, matching Task 032's own precedent.
revoke all on function public.resolve_staff_work_item(uuid) from public, anon, service_role;
grant execute on function public.resolve_staff_work_item(uuid) to authenticated;

-- =========================================================================
-- One-time historical repair (decision 10)
-- =========================================================================

-- Repairs conversations left stuck by the pre-Task-051 behavior: a
-- conversation is exactly handoff/human_handoff, at least one linked
-- kind = 'human_handoff' work item is resolved, and no linked
-- kind = 'human_handoff' work item remains non-resolved. A conversation
-- represented only by delivery-failure work never matches the first EXISTS
-- clause, so it is left untouched, as required.
with repair_targets as materialized (
  select c.id, c.clinic_id
  from public.conversations c
  where c.status = 'handoff'
    and c.intake_stage = 'human_handoff'
    and exists (
      select 1 from public.staff_work_items w
      where w.conversation_id = c.id
        and w.clinic_id = c.clinic_id
        and w.kind = 'human_handoff'
        and w.status = 'resolved'
    )
    and not exists (
      select 1 from public.staff_work_items w
      where w.conversation_id = c.id
        and w.clinic_id = c.clinic_id
        and w.kind = 'human_handoff'
        and w.status <> 'resolved'
    )
  order by c.clinic_id, c.id
  for no key update of c
)
update public.conversations c
set status = 'completed', intake_stage = 'completed', state_version = c.state_version + 1
from repair_targets target
where c.id = target.id and c.clinic_id = target.clinic_id;
