-- Minimal staff status, ownership, and audit columns for VetAI (Task 032):
-- extends the existing open/resolved staff_work_items workflow with
-- seen/in_progress states, first-seen/assignment/resolver identity, and
-- three closed authenticated RPCs. Adds no notification, event/audit table,
-- or new list index. Validated only on disposable vetai-test by Codex on
-- 2026-08-14; not applied to production.
-- See docs/staff-workflow.md, docs/staff-work-items.md, and
-- docs/database-schema.md.

-- =========================================================================
-- Columns
-- =========================================================================

alter table public.staff_work_items
  add column first_seen_at timestamptz,
  add column first_seen_by uuid references auth.users (id) on delete set null,
  add column assigned_at timestamptz,
  add column assigned_to uuid references auth.users (id) on delete set null,
  add column resolved_by uuid references auth.users (id) on delete set null;

-- =========================================================================
-- Status and audit checks
-- =========================================================================

-- Drops the original inline `status in ('open', 'resolved')` check (its
-- Postgres-assigned name) so it can be replaced by the four-value check
-- below.
alter table public.staff_work_items
  drop constraint staff_work_items_status_check;

-- Drops the original open/resolved timestamp-coherence check; replaced by
-- one named check per status below.
alter table public.staff_work_items
  drop constraint staff_work_items_resolved_state_check;

alter table public.staff_work_items
  add constraint staff_work_items_status_check
    check (status in ('open', 'seen', 'in_progress', 'resolved')),
  -- open: nothing has happened yet.
  add constraint staff_work_items_open_state_check check (
    status <> 'open' or (
      first_seen_at is null and first_seen_by is null
      and assigned_at is null and assigned_to is null
      and resolved_at is null and resolved_by is null
    )
  ),
  -- seen: first view recorded, not yet claimed or resolved.
  add constraint staff_work_items_seen_state_check check (
    status <> 'seen' or (
      first_seen_at is not null
      and assigned_at is null and assigned_to is null
      and resolved_at is null and resolved_by is null
    )
  ),
  -- in_progress: seen and claimed, not yet resolved. The assignee column
  -- itself may be null after Auth-user erasure (ON DELETE SET NULL); the
  -- row is then a recoverable, reclaimable claim rather than an invalid one.
  add constraint staff_work_items_in_progress_state_check check (
    status <> 'in_progress' or (
      first_seen_at is not null and assigned_at is not null
      and resolved_at is null and resolved_by is null
    )
  ),
  -- resolved: existing rows and the automatic provider-failure trigger
  -- resolve with no human actor, so only the timestamp is required.
  add constraint staff_work_items_resolved_state_check check (
    status <> 'resolved' or resolved_at is not null
  ),
  -- An actor UUID, when present, always has its matching timestamp, even if
  -- a later Auth-user deletion erases the UUID and leaves the timestamp.
  add constraint staff_work_items_first_seen_actor_check check (
    first_seen_by is null or first_seen_at is not null
  ),
  add constraint staff_work_items_assigned_actor_check check (
    assigned_to is null or assigned_at is not null
  ),
  add constraint staff_work_items_resolved_actor_check check (
    resolved_by is null or resolved_at is not null
  );

-- Existing RLS policy and grants are unchanged: authenticated keeps
-- same-clinic SELECT only; direct INSERT/UPDATE/DELETE remain denied.

-- =========================================================================
-- Preserve Task 020 deduplication and provider-failure auto-resolution
-- =========================================================================

-- Task 020's partial keys covered only `open`. Once this migration makes
-- `seen` and `in_progress` reachable, every non-resolved state must remain in
-- the same uniqueness domain or a later trigger replay could create a second
-- item for the same conversation/outbox row.
drop index public.staff_work_items_open_handoff_uniq;
drop index public.staff_work_items_open_delivery_uniq;

create unique index staff_work_items_open_handoff_uniq
  on public.staff_work_items (clinic_id, conversation_id)
  where kind = 'human_handoff' and status <> 'resolved';

create unique index staff_work_items_open_delivery_uniq
  on public.staff_work_items (clinic_id, source_outbox_id)
  where kind = 'delivery_failure' and status <> 'resolved';

create or replace function vetai_private.sync_human_handoff_work_item()
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

  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
  values (new.clinic_id, new.id, 'human_handoff', v_priority, v_reason, 'open')
  on conflict (clinic_id, conversation_id)
    where kind = 'human_handoff' and status <> 'resolved'
  do update set
    priority = excluded.priority,
    reason = excluded.reason
  where public.staff_work_items.priority = 'normal' and excluded.priority = 'urgent';

  return new;
end;
$$;

revoke all on function vetai_private.sync_human_handoff_work_item() from public, anon, authenticated;

create or replace function vetai_private.sync_delivery_failure_work_item()
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

  -- Later delivered/read evidence resolves the current non-resolved
  -- provider-failure item regardless of whether staff already saw or claimed
  -- it. Exhausted-send items remain intentionally untouched.
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

-- =========================================================================
-- public.mark_staff_work_item_seen
-- =========================================================================

create function public.mark_staff_work_item_seen(p_work_item_id uuid)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status text;
begin
  if p_work_item_id is null then
    raise exception 'mark_staff_work_item_seen: invalid work_item_id';
  end if;

  select clinic_id, status
    into v_clinic_id, v_status
  from public.staff_work_items
  where id = p_work_item_id
  for update;

  -- No matching row and "row exists but caller isn't staff there" return
  -- the same not_found result so the RPC never reveals which case occurred.
  if v_clinic_id is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
  end if;

  if v_status = 'resolved' then
    return query select 'already_resolved'::text;
    return;
  end if;

  if v_status in ('seen', 'in_progress') then
    return query select 'already_seen'::text;
    return;
  end if;

  update public.staff_work_items
    set status = 'seen',
        first_seen_at = pg_catalog.now(),
        first_seen_by = (select auth.uid())
    where id = p_work_item_id;

  return query select 'seen'::text;
  return;
end;
$$;

revoke all on function public.mark_staff_work_item_seen(uuid) from public, anon, service_role;
grant execute on function public.mark_staff_work_item_seen(uuid) to authenticated;

-- =========================================================================
-- public.claim_staff_work_item
-- =========================================================================

create function public.claim_staff_work_item(p_work_item_id uuid)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status text;
  v_assigned_to uuid;
  v_caller uuid;
begin
  if p_work_item_id is null then
    raise exception 'claim_staff_work_item: invalid work_item_id';
  end if;

  v_caller := (select auth.uid());

  select clinic_id, status, assigned_to
    into v_clinic_id, v_status, v_assigned_to
  from public.staff_work_items
  where id = p_work_item_id
  for update;

  if v_clinic_id is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
  end if;

  if v_status = 'resolved' then
    return query select 'already_resolved'::text;
    return;
  end if;

  if v_status = 'in_progress' then
    if v_assigned_to is null then
      -- Recoverable claim: the previous assignee's Auth user was erased.
      update public.staff_work_items
        set assigned_at = pg_catalog.now(), assigned_to = v_caller
        where id = p_work_item_id;
      return query select 'claimed'::text;
      return;
    elsif v_assigned_to = v_caller then
      return query select 'already_claimed'::text;
      return;
    else
      return query select 'busy'::text;
      return;
    end if;
  end if;

  -- v_status in ('open', 'seen'): fill any missing first-seen fields and
  -- claim in one step.
  update public.staff_work_items
    set status = 'in_progress',
        first_seen_at = coalesce(first_seen_at, pg_catalog.now()),
        first_seen_by = coalesce(first_seen_by, v_caller),
        assigned_at = pg_catalog.now(),
        assigned_to = v_caller
    where id = p_work_item_id;

  return query select 'claimed'::text;
  return;
end;
$$;

revoke all on function public.claim_staff_work_item(uuid) from public, anon, service_role;
grant execute on function public.claim_staff_work_item(uuid) to authenticated;

-- =========================================================================
-- public.resolve_staff_work_item (replaced; signature unchanged)
-- =========================================================================

create or replace function public.resolve_staff_work_item(p_work_item_id uuid)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_status text;
  v_assigned_to uuid;
  v_caller uuid;
begin
  if p_work_item_id is null then
    raise exception 'resolve_staff_work_item: invalid work_item_id';
  end if;

  v_caller := (select auth.uid());

  select clinic_id, status, assigned_to
    into v_clinic_id, v_status, v_assigned_to
  from public.staff_work_items
  where id = p_work_item_id
  for update;

  if v_clinic_id is null or not vetai_private.is_clinic_staff(v_clinic_id) then
    return query select 'not_found'::text;
    return;
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

  update public.staff_work_items
    set status = 'resolved', resolved_at = pg_catalog.now(), resolved_by = v_caller
    where id = p_work_item_id;

  return query select 'resolved'::text;
  return;
end;
$$;

-- ACL is preserved by CREATE OR REPLACE (owner unchanged, no DROP), so the
-- existing authenticated-only grant from Task 021 still applies. Restated
-- here only for auditability.
revoke all on function public.resolve_staff_work_item(uuid) from public, anon, service_role;
grant execute on function public.resolve_staff_work_item(uuid) to authenticated;
