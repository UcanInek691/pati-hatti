-- Task 045: platform-admin TOTP MFA boundary.
--
-- Recreates get_platform_admin_overview_v1(date) with the exact Task 043
-- signature, 20 OUT columns, query, sort order, `stable` volatility,
-- `security definer`, and empty search_path. The only behavioral change is a
-- second, independent authorization predicate: the caller's JWT assurance
-- level claim (`aal`) must be exactly `aal2`, checked here inside the
-- function alongside the existing platform_admins membership check. Neither
-- predicate alone is sufficient. platform_admins, clinic RLS, the membership
-- bootstrap RPC, table grants, and usage metering are unchanged.
create or replace function public.get_platform_admin_overview_v1(
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
  v_aal text;
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

  -- `->>'aal'` extracts the claim as text for any underlying JSON type
  -- (string, number, boolean, array, object, or a missing/null key) without
  -- raising, so a malformed or non-string claim safely fails the comparison
  -- below instead of throwing before the closed sentinel is returned.
  -- `is not distinct from` is used instead of `=` because a null v_aal
  -- (missing claim, or a JSON null value) would otherwise make `=` yield
  -- NULL rather than false, and PL/pgSQL's `if not <null>` is skipped (not
  -- treated as true) -- silently falling through past the closed sentinel.
  v_aal := auth.jwt() ->> 'aal';

  v_is_admin := v_caller is not null
    and v_aal is not distinct from 'aal2'
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
