-- Task 043: platform-admin metadata overview (read-only MVP).
--
-- platform_admins is a bare allowlist: RLS is enabled with no policy and all
-- table privileges are revoked from every runtime role, including
-- service_role, matching the clinic_ai_usage_events pattern from Task 042.
-- The only access paths are the two `security definer` RPCs below.

-- The browser's closed overview parser relies on the same clinic-name shape
-- already enforced by provision_clinic_v1. Make it structural so one legacy
-- or direct service-role row cannot make the all-or-nothing overview fail.
alter table public.clinics
  add constraint clinics_name_shape_check check (
    name = btrim(name)
    and char_length(name) between 1 and 200
    and name !~ '[[:cntrl:]]'
  );

create table public.platform_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.platform_admins enable row level security;

revoke all on public.platform_admins from public, anon, authenticated, service_role;

-- =========================================================================
-- set_platform_admin_v1
-- =========================================================================

-- Backend/operator-only bootstrap RPC. Not called from /admin in this task.
create function public.set_platform_admin_v1(
  p_user_id uuid,
  p_enabled boolean
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_user_exists boolean;
begin
  if p_user_id is null then
    raise exception 'set_platform_admin_v1: invalid user_id';
  end if;
  if p_enabled is null then
    raise exception 'set_platform_admin_v1: invalid enabled flag';
  end if;

  select exists (select 1 from auth.users u where u.id = p_user_id)
    into v_user_exists;

  if not v_user_exists then
    return query select 'user_not_found'::text;
    return;
  end if;

  if p_enabled then
    insert into public.platform_admins (user_id)
    values (p_user_id)
    on conflict (user_id) do nothing;
    return query select 'enabled'::text;
  else
    delete from public.platform_admins where user_id = p_user_id;
    return query select 'disabled'::text;
  end if;
end;
$$;

revoke all on function public.set_platform_admin_v1(uuid, boolean) from public, anon, authenticated;
grant execute on function public.set_platform_admin_v1(uuid, boolean) to service_role;

-- =========================================================================
-- get_platform_admin_overview_v1
-- =========================================================================

-- Read-only, cross-clinic operational overview. Authorization happens here,
-- inside the same function, via auth.uid() -- the browser never performs a
-- separate "am I admin?" check followed by a broadly readable query. Returns
-- no phone number, WABA/Meta ID, account UUID, auth user UUID, work-item ID,
-- provider ID, usage hash, message or clinical content.
create function public.get_platform_admin_overview_v1(
  p_month_start date
)
returns table (
  result text,
  clinic_id uuid,
  clinic_name text,
  operational_status text,
  whatsapp_account_count bigint,
  open_work_item_count bigint,
  urgent_work_item_count bigint,
  pending_outbound_count bigint,
  processing_outbound_count bigint,
  failed_outbound_count bigint,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  period_start date,
  period_end date,
  ai_turn_count bigint,
  ai_touched_conversation_count bigint,
  input_tokens bigint,
  output_tokens bigint,
  total_tokens bigint,
  missing_token_usage_count bigint
)
language plpgsql
security definer
stable
set search_path = ''
as $$
declare
  v_caller uuid;
  v_is_admin boolean;
  v_period_start date;
  v_period_end date;
begin
  if p_month_start is null or p_month_start <> date_trunc('month', p_month_start)::date then
    raise exception 'get_platform_admin_overview_v1: month_start must be the first day of a month';
  end if;

  v_period_start := p_month_start;
  v_period_end := (p_month_start + interval '1 month')::date;

  v_caller := auth.uid();

  v_is_admin := v_caller is not null
    and exists (select 1 from public.platform_admins pa where pa.user_id = v_caller);

  if not v_is_admin then
    return query
      select
        'forbidden'::text, null::uuid, null::text, null::text,
        null::bigint, null::bigint, null::bigint,
        null::bigint, null::bigint, null::bigint,
        null::timestamptz, null::timestamptz,
        v_period_start, v_period_end,
        null::bigint, null::bigint, null::bigint, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  if not exists (select 1 from public.clinics) then
    return query
      select
        'empty'::text, null::uuid, null::text, null::text,
        null::bigint, null::bigint, null::bigint,
        null::bigint, null::bigint, null::bigint,
        null::timestamptz, null::timestamptz,
        v_period_start, v_period_end,
        null::bigint, null::bigint, null::bigint, null::bigint, null::bigint, null::bigint;
    return;
  end if;

  return query
    select
      'reported'::text,
      c.id,
      c.name,
      c.operational_status,
      coalesce(wa.account_count, 0)::bigint,
      coalesce(wi.open_count, 0)::bigint,
      coalesce(wi.urgent_count, 0)::bigint,
      coalesce(ob.pending_count, 0)::bigint,
      coalesce(ob.processing_count, 0)::bigint,
      coalesce(ob.failed_count, 0)::bigint,
      msg.last_inbound_at,
      msg.last_outbound_at,
      v_period_start,
      v_period_end,
      coalesce(u.ai_turn_count, 0)::bigint,
      coalesce(u.ai_touched_conversation_count, 0)::bigint,
      coalesce(u.input_tokens, 0)::bigint,
      coalesce(u.output_tokens, 0)::bigint,
      coalesce(u.total_tokens, 0)::bigint,
      coalesce(u.missing_token_usage_count, 0)::bigint
    from public.clinics c
    left join (
      select wa.clinic_id, count(*) as account_count
      from public.whatsapp_accounts wa
      group by wa.clinic_id
    ) wa on wa.clinic_id = c.id
    left join (
      select
        swi.clinic_id,
        count(*) as open_count,
        count(*) filter (where swi.priority = 'urgent') as urgent_count
      from public.staff_work_items swi
      where swi.status <> 'resolved'
      group by swi.clinic_id
    ) wi on wi.clinic_id = c.id
    left join (
      select
        o.clinic_id,
        count(*) filter (where o.delivery_status = 'pending') as pending_count,
        count(*) filter (where o.delivery_status = 'processing') as processing_count,
        count(*) filter (where o.delivery_status = 'failed') as failed_count
      from public.outbound_message_outbox o
      group by o.clinic_id
    ) ob on ob.clinic_id = c.id
    left join (
      select
        m.clinic_id,
        max(m.created_at) filter (where m.direction = 'inbound') as last_inbound_at,
        max(m.created_at) filter (where m.direction = 'outbound') as last_outbound_at
      from public.messages m
      group by m.clinic_id
    ) msg on msg.clinic_id = c.id
    left join lateral (
      select
        r.ai_turn_count,
        r.ai_touched_conversation_count,
        r.input_tokens,
        r.output_tokens,
        r.total_tokens,
        r.missing_token_usage_count
      from public.get_clinic_monthly_usage_v1(c.id, v_period_start) r
    ) u on true
    order by c.name, c.id;
  return;
end;
$$;

revoke all on function public.get_platform_admin_overview_v1(date) from public, anon, service_role;
grant execute on function public.get_platform_admin_overview_v1(date) to authenticated;
