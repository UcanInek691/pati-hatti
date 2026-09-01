-- Task 044: clinic schedule and appointment-slot self-service.
--
-- Extends the existing tenant-scoped /staff surface so a clinic's own
-- `clinic_staff.role = 'admin'` member can manage that clinic's weekly
-- opening hours, full-day closure dates and future bookable slot
-- inventory. All other same-clinic roles remain read-only. Authorization is
-- enforced entirely inside SECURITY DEFINER functions with a fixed empty
-- search_path and no dynamic SQL; the browser never receives a direct grant
-- on `appointment_slots`, and normal tenant RLS on `clinic_weekly_hours` /
-- `clinic_closure_dates` (already SELECT-only for `authenticated`, gated by
-- `vetai_private.is_clinic_staff`) is left untouched.
--
-- A schedule change never deletes, releases or edits a `held` or
-- `confirmed` appointment_slots row; only affected future `available` rows
-- are removed, and every mutation result reports how many active
-- (held/confirmed) rows were preserved so the caller can render a truthful
-- warning instead of claiming an appointment was cancelled or a person was
-- contacted.

-- =========================================================================
-- Shared mutation authorization helper
-- =========================================================================

-- Locks the target clinic row first (so every mutation below serializes
-- behind this one lock before it reads membership or touches schedule/slot
-- rows), then resolves the caller's exact clinic_staff role from auth.uid().
-- An absent or cross-tenant clinic and a caller with no membership row are
-- deliberately indistinguishable ('not_found'); a same-clinic non-admin
-- member is 'forbidden'; a same-clinic admin of a non-active clinic is
-- 'inactive'. Runs SECURITY DEFINER so callers need no direct grant on
-- `clinics` or `clinic_staff` to be authorized, but it performs no mutation
-- itself.
create function vetai_private.authorize_clinic_schedule_mutation(target_clinic_id uuid)
returns text
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_status text;
  v_role text;
begin
  select cl.operational_status into v_status
  from public.clinics cl
  where cl.id = target_clinic_id
  -- Schedule changes do not modify a clinic key. NO KEY UPDATE still
  -- serializes schedule/lifecycle mutations, while remaining compatible with
  -- FK integrity checks that take KEY SHARE on clinics during child inserts.
  for no key update;

  if v_status is null then
    return 'not_found';
  end if;

  select cs.role into v_role
  from public.clinic_staff cs
  where cs.clinic_id = target_clinic_id
    and cs.user_id = (select auth.uid());

  if v_role is null then
    return 'not_found';
  end if;
  if v_role <> 'admin' then
    return 'forbidden';
  end if;
  if v_status <> 'active' then
    return 'inactive';
  end if;
  return 'ok';
end;
$$;

revoke all on function vetai_private.authorize_clinic_schedule_mutation(uuid) from public, anon, authenticated;
grant execute on function vetai_private.authorize_clinic_schedule_mutation(uuid) to service_role;

-- =========================================================================
-- RPC 1: list_clinic_appointment_slots_v1 (read, any same-clinic role)
-- =========================================================================

create function public.list_clinic_appointment_slots_v1(
  p_clinic_id uuid,
  p_from date,
  p_to date
)
returns table (
  slot_id uuid,
  starts_at timestamptz,
  ends_at timestamptz,
  status text
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_member boolean;
begin
  if p_clinic_id is null or p_from is null or p_to is null then
    raise exception 'list_clinic_appointment_slots_v1: invalid input';
  end if;
  if p_to < p_from or p_to > p_from + 61 then
    raise exception 'list_clinic_appointment_slots_v1: invalid window';
  end if;

  select exists (
    select 1
    from public.clinic_staff cs
    where cs.clinic_id = p_clinic_id
      and cs.user_id = (select auth.uid())
  ) into v_member;

  if not v_member then
    return;
  end if;

  return query
  select s.id, s.starts_at, s.ends_at, s.status
  from public.appointment_slots s
  where s.clinic_id = p_clinic_id
    and s.starts_at >= pg_catalog.now()
    and (s.starts_at at time zone 'Europe/Istanbul')::date >= p_from
    and (s.starts_at at time zone 'Europe/Istanbul')::date <= p_to
  order by s.starts_at, s.id;
end;
$$;

revoke all on function public.list_clinic_appointment_slots_v1(uuid, date, date) from public, anon, service_role;
grant execute on function public.list_clinic_appointment_slots_v1(uuid, date, date) to authenticated;

-- =========================================================================
-- RPC 2: set_clinic_weekly_hours_v1 (admin mutation)
-- =========================================================================

create function public.set_clinic_weekly_hours_v1(
  p_clinic_id uuid,
  p_iso_weekday smallint,
  p_enabled boolean,
  p_opens_at time,
  p_closes_at time
)
returns table (
  result text,
  removed_slots integer,
  preserved_active_slots integer
)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_auth text;
  v_changed integer;
  v_removed integer;
  v_preserved integer;
  v_opens time;
  v_closes time;
  v_now timestamptz := pg_catalog.now();
begin
  if p_clinic_id is null or p_iso_weekday is null or p_iso_weekday not between 1 and 7 or p_enabled is null then
    raise exception 'set_clinic_weekly_hours_v1: invalid input';
  end if;
  if p_enabled then
    if p_opens_at is null or p_closes_at is null then
      raise exception 'set_clinic_weekly_hours_v1: missing hours';
    end if;
    if extract(second from p_opens_at) <> 0 or extract(second from p_closes_at) <> 0 then
      raise exception 'set_clinic_weekly_hours_v1: hours must be whole minutes';
    end if;
    if extract(minute from p_opens_at)::integer not in (0, 30) or extract(minute from p_closes_at)::integer not in (0, 30) then
      raise exception 'set_clinic_weekly_hours_v1: hours must align to :00 or :30';
    end if;
    if p_opens_at >= time '24:00' or p_closes_at >= time '24:00' then
      raise exception 'set_clinic_weekly_hours_v1: 24:00 is not supported';
    end if;
    if p_opens_at >= p_closes_at then
      raise exception 'set_clinic_weekly_hours_v1: opens_at must precede closes_at';
    end if;
  else
    if p_opens_at is not null or p_closes_at is not null then
      raise exception 'set_clinic_weekly_hours_v1: disabled day must not carry hours';
    end if;
  end if;

  v_auth := vetai_private.authorize_clinic_schedule_mutation(p_clinic_id);
  if v_auth <> 'ok' then
    return query select v_auth, null::integer, null::integer;
    return;
  end if;

  if p_enabled then
    insert into public.clinic_weekly_hours (clinic_id, iso_weekday, opens_at, closes_at)
    values (p_clinic_id, p_iso_weekday, p_opens_at, p_closes_at)
    on conflict (clinic_id, iso_weekday) do update
      set opens_at = excluded.opens_at, closes_at = excluded.closes_at
      where clinic_weekly_hours.opens_at <> excluded.opens_at or clinic_weekly_hours.closes_at <> excluded.closes_at;
    get diagnostics v_changed = row_count;
  else
    delete from public.clinic_weekly_hours
      where clinic_id = p_clinic_id and iso_weekday = p_iso_weekday;
    get diagnostics v_changed = row_count;
  end if;

  -- Current (possibly now-absent) interval for this weekday, after the
  -- mutation above. A null v_opens means the day is disabled: every future
  -- available slot on this weekday is now out of bounds.
  select h.opens_at, h.closes_at into v_opens, v_closes
  from public.clinic_weekly_hours h
  where h.clinic_id = p_clinic_id and h.iso_weekday = p_iso_weekday;

  -- Match hold_appointment_slot's ascending slot-id lock order before a
  -- multi-row cleanup. READ COMMITTED rechecks the available predicate after
  -- any wait, so a hold that won first is excluded and preserved.
  with target_slots as materialized (
    select s.id
    from public.appointment_slots s
    where s.clinic_id = p_clinic_id
      and s.status = 'available'
      and s.starts_at > v_now
      and extract(isodow from (s.starts_at at time zone 'Europe/Istanbul')) = p_iso_weekday
      and (
        v_opens is null
        or (s.starts_at at time zone 'Europe/Istanbul') <
           ((s.starts_at at time zone 'Europe/Istanbul')::date + v_opens)
        or (s.ends_at at time zone 'Europe/Istanbul') >
           ((s.starts_at at time zone 'Europe/Istanbul')::date + v_closes)
      )
    order by s.id
    for update
  )
  delete from public.appointment_slots s
  using target_slots t
  where s.id = t.id;
  get diagnostics v_removed = row_count;

  select count(*) into v_preserved
  from public.appointment_slots s
  where s.clinic_id = p_clinic_id
    and s.status in ('held', 'confirmed')
    and s.starts_at > v_now
    and extract(isodow from (s.starts_at at time zone 'Europe/Istanbul')) = p_iso_weekday
    and (
      v_opens is null
      or (s.starts_at at time zone 'Europe/Istanbul') <
         ((s.starts_at at time zone 'Europe/Istanbul')::date + v_opens)
      or (s.ends_at at time zone 'Europe/Istanbul') >
         ((s.starts_at at time zone 'Europe/Istanbul')::date + v_closes)
    );

  return query
  select
    case when v_changed > 0 then (case when p_enabled then 'updated' else 'removed' end) else 'unchanged' end,
    v_removed,
    v_preserved;
end;
$$;

revoke all on function public.set_clinic_weekly_hours_v1(uuid, smallint, boolean, time, time) from public, anon, service_role;
grant execute on function public.set_clinic_weekly_hours_v1(uuid, smallint, boolean, time, time) to authenticated;

-- =========================================================================
-- RPC 3: set_clinic_closure_date_v1 (admin mutation)
-- =========================================================================

create function public.set_clinic_closure_date_v1(
  p_clinic_id uuid,
  p_closed_on date,
  p_closed boolean
)
returns table (
  result text,
  removed_slots integer,
  preserved_active_slots integer
)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_auth text;
  v_changed integer;
  v_removed integer := 0;
  v_preserved integer := 0;
  v_today date;
  v_now timestamptz := pg_catalog.now();
begin
  if p_clinic_id is null or p_closed_on is null or p_closed is null then
    raise exception 'set_clinic_closure_date_v1: invalid input';
  end if;

  v_today := (v_now at time zone 'Europe/Istanbul')::date;
  if p_closed_on < v_today or p_closed_on > v_today + 366 then
    raise exception 'set_clinic_closure_date_v1: date out of the allowed operator window';
  end if;

  v_auth := vetai_private.authorize_clinic_schedule_mutation(p_clinic_id);
  if v_auth <> 'ok' then
    return query select v_auth, null::integer, null::integer;
    return;
  end if;

  if p_closed then
    insert into public.clinic_closure_dates (clinic_id, closed_on)
    values (p_clinic_id, p_closed_on)
    on conflict (clinic_id, closed_on) do nothing;
    get diagnostics v_changed = row_count;

    if v_changed > 0 then
      with target_slots as materialized (
        select s.id
        from public.appointment_slots s
        where s.clinic_id = p_clinic_id
          and s.status = 'available'
          and s.starts_at > v_now
          and (s.starts_at at time zone 'Europe/Istanbul')::date = p_closed_on
        order by s.id
        for update
      )
      delete from public.appointment_slots s
      using target_slots t
      where s.id = t.id;
      get diagnostics v_removed = row_count;
    end if;

    select count(*) into v_preserved
    from public.appointment_slots s
    where s.clinic_id = p_clinic_id
      and s.status in ('held', 'confirmed')
      and s.starts_at > v_now
      and (s.starts_at at time zone 'Europe/Istanbul')::date = p_closed_on;

    return query select
      case when v_changed > 0 then 'updated' else 'unchanged' end,
      v_removed,
      v_preserved;
  else
    delete from public.clinic_closure_dates
      where clinic_id = p_clinic_id and closed_on = p_closed_on;
    get diagnostics v_changed = row_count;

    -- Removing a closure creates no slots automatically, so there is
    -- nothing new to remove or preserve on this branch.
    return query select
      case when v_changed > 0 then 'removed' else 'unchanged' end,
      0,
      0;
  end if;
end;
$$;

revoke all on function public.set_clinic_closure_date_v1(uuid, date, boolean) from public, anon, service_role;
grant execute on function public.set_clinic_closure_date_v1(uuid, date, boolean) to authenticated;

-- =========================================================================
-- RPC 4: generate_clinic_appointment_slots_v1 (admin mutation)
-- =========================================================================

create function public.generate_clinic_appointment_slots_v1(
  p_clinic_id uuid,
  p_local_date date
)
returns table (
  result text,
  candidate_count integer,
  created_count integer,
  existing_count integer
)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_auth text;
  v_today date;
  v_weekday smallint;
  v_opens time;
  v_closes time;
  v_closed boolean;
  v_now timestamptz := pg_catalog.now();
  v_candidate_count integer;
  v_created_count integer;
begin
  if p_clinic_id is null or p_local_date is null then
    raise exception 'generate_clinic_appointment_slots_v1: invalid input';
  end if;

  v_today := (v_now at time zone 'Europe/Istanbul')::date;
  if p_local_date > v_today + 366 then
    raise exception 'generate_clinic_appointment_slots_v1: date out of the allowed operator window';
  end if;

  v_auth := vetai_private.authorize_clinic_schedule_mutation(p_clinic_id);
  if v_auth <> 'ok' then
    return query select v_auth, null::integer, null::integer, null::integer;
    return;
  end if;

  if p_local_date < v_today then
    return query select 'past'::text, null::integer, null::integer, null::integer;
    return;
  end if;

  select exists (
    select 1 from public.clinic_closure_dates d
    where d.clinic_id = p_clinic_id and d.closed_on = p_local_date
  ) into v_closed;
  if v_closed then
    return query select 'closed'::text, null::integer, null::integer, null::integer;
    return;
  end if;

  v_weekday := extract(isodow from p_local_date);
  select h.opens_at, h.closes_at into v_opens, v_closes
  from public.clinic_weekly_hours h
  where h.clinic_id = p_clinic_id and h.iso_weekday = v_weekday;

  if v_opens is null or v_opens >= time '24:00' or v_closes >= time '24:00' then
    return query select 'unconfigured'::text, null::integer, null::integer, null::integer;
    return;
  end if;

  with candidates as (
    select gs as starts_at, gs + interval '30 minutes' as ends_at
    from generate_series(
      (p_local_date + v_opens) at time zone 'Europe/Istanbul',
      (p_local_date + v_closes) at time zone 'Europe/Istanbul' - interval '30 minutes',
      interval '30 minutes'
    ) as gs
    where gs > v_now
    order by gs
    limit 48
  ),
  inserted as (
    insert into public.appointment_slots (clinic_id, starts_at, ends_at, status)
    select p_clinic_id, c.starts_at, c.ends_at, 'available'
    from candidates c
    on conflict (clinic_id, starts_at) do nothing
    returning 1
  )
  select
    (select count(*) from candidates)::integer,
    (select count(*) from inserted)::integer
  into v_candidate_count, v_created_count;

  return query
  select
    case when v_created_count > 0 then 'generated' else 'unchanged' end,
    v_candidate_count,
    v_created_count,
    v_candidate_count - v_created_count;
end;
$$;

revoke all on function public.generate_clinic_appointment_slots_v1(uuid, date) from public, anon, service_role;
grant execute on function public.generate_clinic_appointment_slots_v1(uuid, date) to authenticated;

-- =========================================================================
-- RPC 5: delete_clinic_appointment_slot_v1 (admin mutation)
-- =========================================================================

create function public.delete_clinic_appointment_slot_v1(
  p_clinic_id uuid,
  p_slot_id uuid
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_auth text;
  v_slot public.appointment_slots%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  if p_clinic_id is null or p_slot_id is null then
    raise exception 'delete_clinic_appointment_slot_v1: invalid input';
  end if;

  v_auth := vetai_private.authorize_clinic_schedule_mutation(p_clinic_id);
  if v_auth <> 'ok' then
    return query select v_auth;
    return;
  end if;

  select * into v_slot
  from public.appointment_slots s
  where s.id = p_slot_id and s.clinic_id = p_clinic_id
  for update;

  if v_slot.id is null then
    return query select 'not_found'::text;
    return;
  end if;

  if v_slot.status in ('held', 'confirmed') then
    return query select 'in_use'::text;
    return;
  end if;

  if v_slot.starts_at <= v_now then
    return query select 'past'::text;
    return;
  end if;

  delete from public.appointment_slots where id = v_slot.id;

  return query select 'deleted'::text;
end;
$$;

revoke all on function public.delete_clinic_appointment_slot_v1(uuid, uuid) from public, anon, service_role;
grant execute on function public.delete_clinic_appointment_slot_v1(uuid, uuid) to authenticated;
