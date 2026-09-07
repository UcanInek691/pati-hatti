-- Task 056: clinic-wide alert rollout gate + personal staff subscription.
--
-- Two independent controls sit in front of the Task 053 clinic-scope alert
-- pipeline: a platform-admin clinic-wide gate (this migration,
-- `clinic_alert_settings`, defaults OFF) and each staff member's own-only
-- subscription (Task 053's existing `clinic_alert_recipients`, now also
-- writable by the staff member themselves through a new self-service RPC,
-- in addition to the existing service-role-invoked admin path). Effective
-- clinic delivery requires both to be on. Platform-scope recipients/signals
-- are untouched.
--
-- Not run against any database by the implementer -- Codex runs
-- supabase/tests/056_clinic_alert_preferences.sql against the disposable
-- vetai-test project.

-- =========================================================================
-- 1. Clinic-wide gate. `updated_at` is the database-authored activation
-- epoch: it only ever moves on a genuine enabled/disabled transition (see
-- set_platform_clinic_alert_gate below), never on an idempotent re-affirm,
-- so it can be compared against a delivery's own created_at to tell a
-- pre-toggle stale delivery from a fresh post-toggle one. Defaults OFF:
-- applying this migration must not start sending any clinic e-mail for any
-- existing clinic. Absence of a row means OFF, so no backfill is needed --
-- every predicate below treats "no row" the same as "row with enabled =
-- false".
-- =========================================================================

-- Keep the recipient activation epoch separate from its general updated_at.
-- Task 053's service-role setter refreshes updated_at on every call, including
-- an otherwise idempotent write; using that column as the eligibility epoch
-- would permanently suppress an already-pending delivery. This trigger owns
-- enabled_at for every current/future write path and moves it only on a real
-- enabled-state transition.
alter table public.clinic_alert_recipients
  add column enabled_at timestamptz;

update public.clinic_alert_recipients
  set enabled_at = updated_at
  where enabled;

alter table public.clinic_alert_recipients
  add constraint clinic_alert_recipients_enabled_at_check check (
    (enabled and enabled_at is not null)
    or (not enabled and enabled_at is null)
  );

create function vetai_private.set_clinic_alert_recipient_enabled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.enabled_at := case when new.enabled then pg_catalog.now() else null end;
  elsif new.enabled is distinct from old.enabled then
    new.enabled_at := case when new.enabled then pg_catalog.now() else null end;
  else
    new.enabled_at := old.enabled_at;
  end if;
  return new;
end;
$$;

revoke all on function vetai_private.set_clinic_alert_recipient_enabled_at()
  from public, anon, authenticated, service_role;

create trigger set_clinic_alert_recipient_enabled_at
before insert or update of enabled on public.clinic_alert_recipients
for each row execute function vetai_private.set_clinic_alert_recipient_enabled_at();

create table public.clinic_alert_settings (
  clinic_id uuid primary key references public.clinics (id) on delete cascade,
  enabled boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now()
);

alter table public.clinic_alert_settings enable row level security;
revoke all on public.clinic_alert_settings from anon, authenticated, public;
grant all on public.clinic_alert_settings to service_role;

-- Minimized, append-only audit for the clinic-wide gate: actor, clinic,
-- desired state, timestamp -- nothing else (no clinic name, no e-mail, no
-- free-form reason). Not exposed to any browser role; only the SECURITY
-- DEFINER function below ever writes to it, running as its owner, so no
-- service_role grant is needed either.
create table public.clinic_alert_gate_audit (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  enabled boolean not null,
  actor_user_id uuid not null,
  created_at timestamptz not null default pg_catalog.now()
);

alter table public.clinic_alert_gate_audit enable row level security;
revoke all on public.clinic_alert_gate_audit from anon, authenticated, public, service_role;

-- =========================================================================
-- 2. Staff self-service RPCs (`/staff`). Both are SECURITY DEFINER with an
-- empty search_path, granted only to `authenticated`, and derive identity
-- solely from auth.uid() -- the browser never supplies a target user,
-- e-mail address, or audit actor/reason.
-- =========================================================================

-- Read: only the caller's own clinic memberships, closed fields, no e-mail.
create function public.get_my_clinic_alert_preferences()
returns table (
  clinic_id uuid,
  clinic_name text,
  clinic_gate_enabled boolean,
  my_preference_enabled boolean,
  effective_enabled boolean
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid;
begin
  v_caller := auth.uid();
  if v_caller is null then
    return;
  end if;

  return query
    select
      cs.clinic_id,
      c.name,
      coalesce(g.enabled, false),
      coalesce(r.enabled, false),
      (coalesce(g.enabled, false) and coalesce(r.enabled, false))
    from public.clinic_staff cs
    join public.clinics c on c.id = cs.clinic_id
    left join public.clinic_alert_settings g on g.clinic_id = cs.clinic_id
    left join public.clinic_alert_recipients r on r.clinic_id = cs.clinic_id and r.user_id = cs.user_id
    where cs.user_id = v_caller
    order by c.name;
end;
$$;

revoke all on function public.get_my_clinic_alert_preferences() from public, anon, service_role;
grant execute on function public.get_my_clinic_alert_preferences() to authenticated;

-- Write: clinic id + desired boolean only. Uses the repository-wide parent-
-- first order: clinic, exact membership, then clinic_alert_recipients. The
-- stronger membership lock makes
-- two concurrent self-service toggles observe one another instead of both
-- recording a first transition. It resolves the caller's own
-- confirmed Auth e-mail server-side, and reuses the existing
-- alert_recipient_audit trail with the caller as actor and a fixed,
-- machine-authored reason. A disable against a row that does not exist is
-- an idempotent no-op: it never materializes a row (and never resolves or
-- stores an e-mail) just to represent "false".
create function public.set_my_clinic_alert_preference(
  p_clinic_id uuid,
  p_enabled boolean
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_member uuid;
  v_email text;
  v_email_confirmed_at timestamptz;
  v_existed boolean;
  v_prev_enabled boolean;
  v_action text;
begin
  if p_clinic_id is null or p_enabled is null then
    raise exception 'set_my_clinic_alert_preference: invalid arguments';
  end if;

  v_caller := auth.uid();
  if v_caller is null then
    return query select 'forbidden'::text;
    return;
  end if;

  perform 1
  from public.clinics c
  where c.id = p_clinic_id
  for key share of c;

  if not found then
    return query select 'forbidden'::text;
    return;
  end if;

  select cs.user_id into v_member
  from public.clinic_staff cs
  where cs.clinic_id = p_clinic_id and cs.user_id = v_caller
  for no key update of cs;

  if v_member is null then
    return query select 'forbidden'::text;
    return;
  end if;

  select enabled into v_prev_enabled
  from public.clinic_alert_recipients
  where clinic_id = p_clinic_id and user_id = v_caller
  for update;
  v_existed := found;
  if not v_existed then
    v_prev_enabled := false;
  end if;

  if v_prev_enabled = p_enabled then
    return query select (case when p_enabled then 'already_enabled' else 'already_disabled' end)::text;
    return;
  end if;

  if p_enabled then
    select u.email, u.email_confirmed_at into v_email, v_email_confirmed_at
    from auth.users u
    where u.id = v_caller;

    if v_email is null or v_email_confirmed_at is null then
      return query select 'email_unconfirmed'::text;
      return;
    end if;

    insert into public.clinic_alert_recipients (clinic_id, user_id, email, enabled)
    values (p_clinic_id, v_caller, lower(btrim(v_email)), true)
    on conflict (clinic_id, user_id) do update
      set email = excluded.email, enabled = true, updated_at = pg_catalog.now();
  else
    update public.clinic_alert_recipients
      set enabled = false, updated_at = pg_catalog.now()
      where clinic_id = p_clinic_id and user_id = v_caller;
  end if;

  v_action := case when not v_existed then 'created' when p_enabled then 'enabled' else 'disabled' end;

  insert into public.alert_recipient_audit (recipient_scope, clinic_id, recipient_user_id, action, actor_user_id, reason)
  values ('clinic', p_clinic_id, v_caller, v_action, v_caller, 'staff self-service alert preference change');

  return query select (case when p_enabled then 'enabled' else 'disabled' end)::text;
  return;
end;
$$;

revoke all on function public.set_my_clinic_alert_preference(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_my_clinic_alert_preference(uuid, boolean) to authenticated;

-- =========================================================================
-- 3. Platform-admin RPCs (`/admin`). Both call the existing Task 054/055
-- vetai_private.platform_admin_authorized_caller_v1() helper, which enforces
-- exact aal2 + platform_admins membership inside the database. That helper
-- is granted only to service_role, but a SECURITY DEFINER function runs as
-- its owner, which implicitly bypasses grants on its own schema's objects --
-- the same pattern platform_suspend_clinic_v1/platform_resume_clinic_v1
-- already rely on.
-- =========================================================================

-- Read: clinic id + gate state only -- no clinic name, no recipient data.
-- Returns an empty set when the caller is not an authorized platform admin;
-- /admin already surfaces "forbidden" from get_platform_admin_overview_v1
-- before this RPC would ever be called, so no separate sentinel is needed
-- here and none is returned.
create function public.get_platform_clinic_alert_gates()
returns table (clinic_id uuid, enabled boolean)
language plpgsql
security definer
stable
set search_path = ''
as $$
begin
  if vetai_private.platform_admin_authorized_caller_v1() is null then
    return;
  end if;

  return query
    select c.id, coalesce(g.enabled, false)
    from public.clinics c
    left join public.clinic_alert_settings g on g.clinic_id = c.id
    order by c.id;
end;
$$;

revoke all on function public.get_platform_clinic_alert_gates() from public, anon, service_role;
grant execute on function public.get_platform_clinic_alert_gates() to authenticated;

-- Write: clinic id + desired boolean only. Locks clinics then
-- clinic_alert_settings (a new, independent lock pair that never overlaps
-- with clinic_staff -> clinic_alert_recipients above; clinics is always the
-- first row locked in every existing mutation path in this codebase, so no
-- new deadlock edge is introduced). Idempotent: only a genuine transition
-- bumps updated_at (the activation epoch) or writes an audit row.
create function public.set_platform_clinic_alert_gate(
  p_clinic_id uuid,
  p_enabled boolean
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_caller uuid;
  v_prev_enabled boolean;
  v_existed boolean;
begin
  if p_clinic_id is null or p_enabled is null then
    raise exception 'set_platform_clinic_alert_gate: invalid arguments';
  end if;

  v_caller := vetai_private.platform_admin_authorized_caller_v1();
  if v_caller is null then
    return query select 'forbidden'::text;
    return;
  end if;

  if not exists (
    select 1 from public.clinics c where c.id = p_clinic_id for no key update
  ) then
    return query select 'not_found'::text;
    return;
  end if;

  select enabled into v_prev_enabled
  from public.clinic_alert_settings
  where clinic_id = p_clinic_id
  for update;
  v_existed := found;
  if not v_existed then
    v_prev_enabled := false;
  end if;

  if v_prev_enabled = p_enabled then
    return query select (case when p_enabled then 'already_enabled' else 'already_disabled' end)::text;
    return;
  end if;

  insert into public.clinic_alert_settings (clinic_id, enabled)
  values (p_clinic_id, p_enabled)
  on conflict (clinic_id) do update
    set enabled = excluded.enabled, updated_at = pg_catalog.now();

  insert into public.clinic_alert_gate_audit (clinic_id, enabled, actor_user_id)
  values (p_clinic_id, p_enabled, v_caller);

  return query select (case when p_enabled then 'enabled' else 'disabled' end)::text;
  return;
end;
$$;

revoke all on function public.set_platform_clinic_alert_gate(uuid, boolean) from public, anon, service_role;
grant execute on function public.set_platform_clinic_alert_gate(uuid, boolean) to authenticated;

-- =========================================================================
-- 4. Task 053 eligibility predicates. Recreated byte-for-byte except for
-- the clinic-gate/personal-epoch additions below -- signatures, result
-- shapes, volatility, invoker/definer mode, empty search_path and grants
-- are unchanged. Platform branches are untouched in all three functions.
-- =========================================================================

-- sync_alert_delivery_candidates: every clinic-scope branch also requires
-- the clinic gate to be currently on. No epoch check here -- this function
-- only ever inserts a row once per (work_item, recipient) for all time
-- (on conflict (dedup_key) do nothing against a permanent unique key), so a
-- freshly-created row can never itself be "stale"; a work item that stayed
-- open through a gate-off window simply gets its first notice, timestamped
-- now, the next time the gate is on.
create or replace function public.sync_alert_delivery_candidates()
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
      and exists (
        select 1 from public.clinic_alert_settings g
        where g.clinic_id = c.clinic_id and g.enabled
      )
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
      and exists (
        select 1 from public.clinic_alert_settings g
        where g.clinic_id = c.clinic_id and g.enabled
      )
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
      and exists (
        select 1 from public.clinic_alert_settings g
        where g.clinic_id = c.clinic_id and g.enabled
      )
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
      and exists (
        select 1 from public.clinic_alert_settings g
        where g.clinic_id = c.clinic_id and g.enabled
      )
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

-- claim_alert_delivery: clinic-scope claims now also require the clinic
-- gate to be currently on, AND require the delivery row's own created_at to
-- be at or after both the gate's and the recipient's activation epoch
-- (clinic_alert_settings.updated_at / clinic_alert_recipients.enabled_at).
-- Re-enabling either one starts a new epoch: a pending or
-- expired-lease row created before that epoch stays stale and unclaimable
-- forever, even though the current boolean state now reads "on".
create or replace function public.claim_alert_delivery()
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
      (d.recipient_scope = 'clinic'
        and exists (
          select 1 from public.clinic_alert_recipients r
          where r.clinic_id = d.clinic_id and r.user_id = d.recipient_user_id and r.enabled
            and d.created_at >= r.enabled_at
        )
        and exists (
          select 1 from public.clinic_alert_settings g
          where g.clinic_id = d.clinic_id and g.enabled
            and d.created_at >= g.updated_at
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

-- schedule_alert_repeat_notifications: clinic-scope repeats recheck both
-- the current gate/recipient state and the repeating row's own epoch
-- eligibility (the same created_at >= activation-epoch comparison claim uses,
-- against the series' original row) -- a repeat belonging to a series that
-- predates the current activation epoch is skipped rather than fired the
-- moment the gate flips back on.
create or replace function public.schedule_alert_repeat_notifications()
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
           d.work_item_id, d.repeat_count, d.occurrence_count, d.next_repeat_at, d.created_at,
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

    if v_row.recipient_scope = 'clinic' and not (
      exists (
        select 1 from public.clinic_alert_settings g
        where g.clinic_id = v_row.clinic_id and g.enabled and v_row.created_at >= g.updated_at
      )
      and exists (
        select 1 from public.clinic_alert_recipients r
        where r.clinic_id = v_row.clinic_id and r.user_id = v_row.recipient_user_id and r.enabled
          and v_row.created_at >= r.enabled_at
      )
    ) then
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
