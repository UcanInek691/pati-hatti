-- Task 042: clinic-scoped, PII-minimized AI usage ledger and monthly
-- reconciliation. This is measurement only -- no currency amount, plan,
-- quota, or enforcement is introduced anywhere in this migration.
--
-- The ledger is append-only to every runtime role, including service_role:
-- RLS is enabled with no policy and all table privileges are revoked, so the
-- only way to read or write a row is through the two RPCs below, which run
-- `security definer` (unlike most RPCs in this project) precisely because
-- service_role has no direct grant on this table to rely on.

create table public.clinic_ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  event_kind text not null check (event_kind = 'intake_ai_turn'),
  source_event_hash text not null check (source_event_hash ~ '^[0-9a-f]{64}$'),
  conversation_hash text not null check (conversation_hash ~ '^[0-9a-f]{64}$'),
  model text not null
    check (
      model = btrim(model)
      and char_length(model) between 1 and 120
      and model !~ '[[:cntrl:]]'
    ),
  prompt_version text not null
    check (
      prompt_version = btrim(prompt_version)
      and char_length(prompt_version) between 1 and 120
      and prompt_version !~ '[[:cntrl:]]'
    ),
  input_tokens bigint check (input_tokens is null or input_tokens >= 0),
  output_tokens bigint check (output_tokens is null or output_tokens >= 0),
  total_tokens bigint check (total_tokens is null or total_tokens >= 0),
  occurred_at timestamptz not null default now(),
  constraint clinic_ai_usage_events_token_triplet_check check (
    (input_tokens is null and output_tokens is null and total_tokens is null)
    or (input_tokens is not null and output_tokens is not null and total_tokens is not null)
  ),
  constraint clinic_ai_usage_events_dedup_key unique (clinic_id, event_kind, source_event_hash)
);

-- Serves get_clinic_monthly_usage_v1's clinic_id + occurred_at range scan.
create index clinic_ai_usage_events_clinic_occurred_idx
  on public.clinic_ai_usage_events (clinic_id, occurred_at);

alter table public.clinic_ai_usage_events enable row level security;

revoke all on public.clinic_ai_usage_events from public, anon, authenticated, service_role;

-- =========================================================================
-- record_intake_ai_usage_v1
-- =========================================================================

-- Records one logical successful intake-AI turn. The caller never supplies
-- clinic_id or either hash: both are derived here from the representative
-- webhook_events row resolved through the already-claimed
-- (conversation_id, provider_message_id, claim_token), which this function
-- re-resolves and locks itself rather than trusting caller-supplied identity.
create function public.record_intake_ai_usage_v1(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_model text,
  p_prompt_version text,
  p_input_tokens bigint,
  p_output_tokens bigint,
  p_total_tokens bigint
)
returns table (result text)
language plpgsql
security definer
volatile
set search_path = ''
as $$
declare
  v_event_id uuid;
  v_clinic_id uuid;
  v_intake_status text;
  v_intake_claim_token uuid;
  v_source_event_hash text;
  v_conversation_hash text;
  v_row_count int;
begin
  if p_conversation_id is null then
    raise exception 'record_intake_ai_usage_v1: invalid conversation_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'record_intake_ai_usage_v1: invalid provider_message_id';
  end if;
  if p_claim_token is null then
    raise exception 'record_intake_ai_usage_v1: invalid claim_token';
  end if;
  if p_model is null
    or p_model <> btrim(p_model)
    or char_length(p_model) < 1
    or char_length(p_model) > 120
    or p_model ~ '[[:cntrl:]]' then
    raise exception 'record_intake_ai_usage_v1: invalid model';
  end if;
  if p_prompt_version is null
    or p_prompt_version <> btrim(p_prompt_version)
    or char_length(p_prompt_version) < 1
    or char_length(p_prompt_version) > 120
    or p_prompt_version ~ '[[:cntrl:]]' then
    raise exception 'record_intake_ai_usage_v1: invalid prompt_version';
  end if;
  if (p_input_tokens is null) <> (p_output_tokens is null)
    or (p_input_tokens is null) <> (p_total_tokens is null) then
    raise exception 'record_intake_ai_usage_v1: token usage must be an all-null or all-present triplet';
  end if;
  if p_input_tokens is not null
    and (p_input_tokens < 0 or p_output_tokens < 0 or p_total_tokens < 0) then
    raise exception 'record_intake_ai_usage_v1: token counts must be nonnegative';
  end if;

  select we.id, we.clinic_id, we.intake_status, we.intake_claim_token
    into v_event_id, v_clinic_id, v_intake_status, v_intake_claim_token
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

  if v_intake_status is distinct from 'processing'
    or v_intake_claim_token is distinct from p_claim_token then
    return query select 'stale_claim'::text;
    return;
  end if;

  v_source_event_hash := pg_catalog.encode(pg_catalog.sha256(v_event_id::text::bytea), 'hex');
  v_conversation_hash := pg_catalog.encode(pg_catalog.sha256(p_conversation_id::text::bytea), 'hex');

  insert into public.clinic_ai_usage_events (
    clinic_id, event_kind, source_event_hash, conversation_hash,
    model, prompt_version, input_tokens, output_tokens, total_tokens
  )
  values (
    v_clinic_id, 'intake_ai_turn', v_source_event_hash, v_conversation_hash,
    p_model, p_prompt_version, p_input_tokens, p_output_tokens, p_total_tokens
  )
  on conflict (clinic_id, event_kind, source_event_hash) do nothing;

  get diagnostics v_row_count = row_count;

  if v_row_count = 1 then
    return query select 'recorded'::text;
  else
    return query select 'duplicate'::text;
  end if;
  return;
end;
$$;

revoke all on function public.record_intake_ai_usage_v1(uuid, text, uuid, text, text, bigint, bigint, bigint)
  from public, anon, authenticated;
grant execute on function public.record_intake_ai_usage_v1(uuid, text, uuid, text, text, bigint, bigint, bigint)
  to service_role;

-- =========================================================================
-- get_clinic_monthly_usage_v1
-- =========================================================================

-- Read-only monthly reconciliation. Never returns event hashes, event rows,
-- message/provider identifiers, or content -- only clinic-scoped aggregates.
create function public.get_clinic_monthly_usage_v1(
  p_clinic_id uuid,
  p_month_start date
)
returns table (
  result text,
  clinic_id uuid,
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
  v_clinic_exists boolean;
  v_period_start date;
  v_period_end date;
  v_range_start timestamptz;
  v_range_end timestamptz;
begin
  if p_clinic_id is null then
    raise exception 'get_clinic_monthly_usage_v1: invalid clinic_id';
  end if;
  if p_month_start is null or p_month_start <> date_trunc('month', p_month_start)::date then
    raise exception 'get_clinic_monthly_usage_v1: month_start must be the first day of a month';
  end if;

  v_period_start := p_month_start;
  v_period_end := (p_month_start + interval '1 month')::date;

  select exists (select 1 from public.clinics c where c.id = p_clinic_id)
    into v_clinic_exists;

  if not v_clinic_exists then
    return query
      select
        'clinic_not_found'::text, p_clinic_id, v_period_start, v_period_end,
        0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint;
    return;
  end if;

  -- Reverse of the confirmed `timestamptz at time zone 'Europe/Istanbul'`
  -- idiom used elsewhere in this project: a naive local midnight is
  -- interpreted as Europe/Istanbul wall-clock time and converted to
  -- timestamptz, giving start-inclusive/end-exclusive UTC bounds.
  v_range_start := v_period_start::timestamp at time zone 'Europe/Istanbul';
  v_range_end := v_period_end::timestamp at time zone 'Europe/Istanbul';

  return query
    select
      'reported'::text,
      p_clinic_id,
      v_period_start,
      v_period_end,
      count(*)::bigint,
      count(distinct e.conversation_hash)::bigint,
      coalesce(sum(e.input_tokens), 0)::bigint,
      coalesce(sum(e.output_tokens), 0)::bigint,
      coalesce(sum(e.total_tokens), 0)::bigint,
      count(*) filter (where e.input_tokens is null)::bigint
    from public.clinic_ai_usage_events e
    where e.clinic_id = p_clinic_id
      and e.occurred_at >= v_range_start
      and e.occurred_at < v_range_end;
  return;
end;
$$;

revoke all on function public.get_clinic_monthly_usage_v1(uuid, date) from public, anon, authenticated;
grant execute on function public.get_clinic_monthly_usage_v1(uuid, date) to service_role;
