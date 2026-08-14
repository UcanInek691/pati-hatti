-- Clinic public contact/hours profile and a tenant-safe operational-context
-- RPC used only to personalize the existing non-emergency human_handoff
-- reply with truthful open/closed wording. Validated by Codex only on the
-- disposable vetai-test project on 2026-08-14; not applied to production and
-- still subject to the required Claude Opus review before release.
-- See docs/clinic-operations.md and docs/database-schema.md.

-- =========================================================================
-- Clinic public profile columns
-- =========================================================================

alter table public.clinics
  add column contact_phone_e164 text,
  add column public_address text;

alter table public.clinics
  add constraint clinics_contact_phone_e164_check
    check (contact_phone_e164 is null or contact_phone_e164 ~ '^\+[1-9]\d{1,14}$');

alter table public.clinics
  add constraint clinics_public_address_check
    check (
      public_address is null
      or (
        public_address = btrim(public_address)
        and char_length(public_address) between 1 and 500
        and public_address !~ '[[:cntrl:]]'
      )
    );

-- =========================================================================
-- Weekly hours and full-day closures
-- =========================================================================

-- MVP ceiling: one non-overnight interval per weekday. No split shifts, no
-- partial-day exceptions, no overnight intervals.
create table public.clinic_weekly_hours (
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  iso_weekday smallint not null check (iso_weekday between 1 and 7),
  opens_at time without time zone not null,
  closes_at time without time zone not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, iso_weekday),
  check (opens_at < closes_at)
);

create table public.clinic_closure_dates (
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  closed_on date not null,
  created_at timestamptz not null default now(),
  primary key (clinic_id, closed_on)
);

create trigger set_updated_at before update on public.clinic_weekly_hours
  for each row execute function vetai_private.set_updated_at();

-- =========================================================================
-- RLS and privileges
-- =========================================================================

alter table public.clinic_weekly_hours enable row level security;
alter table public.clinic_closure_dates enable row level security;

revoke all on public.clinic_weekly_hours, public.clinic_closure_dates
  from public, anon, authenticated;

grant select on public.clinic_weekly_hours, public.clinic_closure_dates to authenticated;
grant all on public.clinic_weekly_hours, public.clinic_closure_dates to service_role;

create policy clinic_weekly_hours_select on public.clinic_weekly_hours
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

create policy clinic_closure_dates_select on public.clinic_closure_dates
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

-- =========================================================================
-- RPC: tenant-safe operational context for the conversation's own clinic
-- =========================================================================

create function public.get_conversation_clinic_operational_context(
  p_conversation_id uuid,
  p_at timestamptz default pg_catalog.now()
)
returns table (
  result text,
  clinic_name text,
  contact_phone_e164 text,
  public_address text,
  is_open boolean
)
language plpgsql
security invoker
stable
set search_path = ''
as $$
declare
  v_clinic_id uuid;
  v_name text;
  v_phone text;
  v_address text;
  v_has_hours boolean;
  v_local_ts timestamp;
  v_local_date date;
  v_local_time time;
  v_local_weekday smallint;
  v_is_open boolean;
begin
  if p_conversation_id is null or p_at is null then
    raise exception 'get_conversation_clinic_operational_context: invalid input';
  end if;

  -- Tenant routing comes only from the conversation's own persisted state;
  -- the caller never supplies a clinic id.
  select c.clinic_id into v_clinic_id
  from public.conversations c
  where c.id = p_conversation_id;

  if v_clinic_id is null then
    return query select 'not_found'::text, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  select cl.name, cl.contact_phone_e164, cl.public_address
    into v_name, v_phone, v_address
  from public.clinics cl
  where cl.id = v_clinic_id;

  select exists (
    select 1 from public.clinic_weekly_hours h where h.clinic_id = v_clinic_id
  ) into v_has_hours;

  if v_name is null
    or v_name <> btrim(v_name)
    or char_length(v_name) not between 1 and 120
    or v_name ~ '[[:cntrl:]]'
    or v_phone is null
    or not v_has_hours
  then
    return query select 'unconfigured'::text, null::text, null::text, null::text, null::boolean;
    return;
  end if;

  v_local_ts := p_at at time zone 'Europe/Istanbul';
  v_local_date := v_local_ts::date;
  v_local_time := v_local_ts::time;
  v_local_weekday := extract(isodow from v_local_ts);

  select
    exists (
      select 1
      from public.clinic_weekly_hours h
      where h.clinic_id = v_clinic_id
        and h.iso_weekday = v_local_weekday
        and v_local_time >= h.opens_at
        and v_local_time < h.closes_at
    )
    and not exists (
      select 1
      from public.clinic_closure_dates d
      where d.clinic_id = v_clinic_id
        and d.closed_on = v_local_date
    )
  into v_is_open;

  return query select 'configured'::text, v_name, v_phone, v_address, v_is_open;
  return;
end;
$$;

revoke all on function public.get_conversation_clinic_operational_context(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_conversation_clinic_operational_context(uuid, timestamptz)
  to service_role;
