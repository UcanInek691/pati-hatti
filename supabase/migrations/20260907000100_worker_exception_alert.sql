-- Task 055: add the `worker_exception` platform alert signal.
--
-- `20260905000100_operational_alerting.sql` created `alert_deliveries` with a
-- fixed `signal_kind` allow-list and `record_platform_signal(p_signal_kind,
-- p_queue_id)` with its own, narrower platform-scope allow-list. Task 055's
-- new `checkWorkerException` monitor stage (src/operationalAlerts.ts) records
-- a 9th signal kind, `worker_exception`, through that same function and the
-- existing hourly dedup/no-recipient-fail-closed semantics. No other table,
-- function, grant, or signal changes. Not run against any database by the
-- implementer -- Codex runs supabase/tests/055_worker_exception_alert.sql
-- against the disposable vetai-test project.

alter table public.alert_deliveries
  drop constraint alert_deliveries_signal_kind_check,
  add constraint alert_deliveries_signal_kind_check check (signal_kind in (
    'delivery_failure',
    'human_handoff_urgent',
    'human_handoff_normal',
    'intake_dead_letter',
    'queue_backlog',
    'webhook_5xx',
    'webhook_401',
    'openai_extraction_failure',
    'worker_exception'
  ));

create or replace function public.record_platform_signal(p_signal_kind text, p_queue_id text default null)
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
  if p_signal_kind not in ('queue_backlog', 'webhook_5xx', 'webhook_401', 'openai_extraction_failure', 'worker_exception') then
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
