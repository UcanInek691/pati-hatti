-- Outbound WhatsApp status callback tracking for VetAI: adds a bounded
-- provider-status summary to accepted `outbound_message_outbox` rows and one
-- tenant-safe recording RPC. Validated on disposable `vetai-test` with
-- supabase/tests/019_outbound_status_tracking.sql on 2026-08-09; production
-- still requires the managed migration workflow.
-- See docs/outbound-status.md, docs/outbound-delivery.md, and
-- docs/database-schema.md.

-- =========================================================================
-- Status summary columns
-- =========================================================================

alter table public.outbound_message_outbox
  add column provider_delivery_status text,
  add column provider_status_at timestamptz;

-- Existing accepted rows (and every pending/processing/failed row) backfill
-- with both fields null automatically since neither column has a default.

alter table public.outbound_message_outbox
  add constraint outbound_message_outbox_provider_status_check check (
    (provider_delivery_status is null and provider_status_at is null)
    or (
      delivery_status = 'accepted'
      and provider_delivery_status is not null
      and provider_delivery_status in ('sent', 'failed', 'delivered', 'read')
      and provider_status_at is not null
    )
  );

-- Covers the status RPC's exact lookup: the accepted row for one tenant-safe
-- account plus provider message id plus recipient.
create index outbound_message_outbox_status_lookup_idx
  on public.outbound_message_outbox (whatsapp_account_id, provider_message_id, recipient_e164)
  where delivery_status = 'accepted';

-- =========================================================================
-- Status recording RPC
-- =========================================================================

create function public.record_whatsapp_outbound_status(
  p_phone_number_id text,
  p_provider_message_id text,
  p_recipient_e164 text,
  p_provider_status text,
  p_provider_timestamp timestamptz
)
returns table (result text)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_outbox_id uuid;
  v_current_status text;
  v_current_at timestamptz;
  v_new_rank integer;
  v_current_rank integer;
begin
  if p_phone_number_id is null or p_phone_number_id !~ '^[0-9]{1,64}$' then
    raise exception 'record_whatsapp_outbound_status: invalid phone_number_id';
  end if;
  if p_provider_message_id is null
    or char_length(p_provider_message_id) < 1
    or char_length(p_provider_message_id) > 512 then
    raise exception 'record_whatsapp_outbound_status: invalid provider_message_id';
  end if;
  if p_recipient_e164 is null or p_recipient_e164 !~ '^\+[1-9]\d{1,14}$' then
    raise exception 'record_whatsapp_outbound_status: invalid recipient_e164';
  end if;
  if p_provider_status is null or p_provider_status not in ('sent', 'failed', 'delivered', 'read') then
    raise exception 'record_whatsapp_outbound_status: invalid provider_status';
  end if;
  if p_provider_timestamp is null then
    raise exception 'record_whatsapp_outbound_status: invalid provider_timestamp';
  end if;

  -- Tenant-safe resolution: the account is reached only through the
  -- outbox row's own whatsapp_account_id/clinic_id pair (never a
  -- caller-supplied clinic or outbox id), then matched on all three
  -- provider-reported facts against that exact account's accepted row.
  select o.id, o.provider_delivery_status, o.provider_status_at
    into v_outbox_id, v_current_status, v_current_at
  from public.outbound_message_outbox o
  join public.whatsapp_accounts wa
    on wa.id = o.whatsapp_account_id
   and wa.clinic_id = o.clinic_id
  where o.delivery_status = 'accepted'
    and wa.phone_number_id = p_phone_number_id
    and o.provider_message_id = p_provider_message_id
    and o.recipient_e164 = p_recipient_e164
  order by o.accepted_at desc, o.id desc
  limit 1
  for update of o;

  if v_outbox_id is null then
    return query select 'not_found'::text;
    return;
  end if;

  v_new_rank := case p_provider_status
    when 'sent' then 1
    when 'failed' then 2
    when 'delivered' then 3
    when 'read' then 4
  end;

  if v_current_status is null then
    update public.outbound_message_outbox
      set provider_delivery_status = p_provider_status,
          provider_status_at = p_provider_timestamp
      where id = v_outbox_id;
    return query select 'recorded'::text;
    return;
  end if;

  v_current_rank := case v_current_status
    when 'sent' then 1
    when 'failed' then 2
    when 'delivered' then 3
    when 'read' then 4
  end;

  if v_new_rank > v_current_rank then
    update public.outbound_message_outbox
      set provider_delivery_status = p_provider_status,
          provider_status_at = p_provider_timestamp
      where id = v_outbox_id;
    return query select 'recorded'::text;
    return;
  end if;

  if v_new_rank < v_current_rank then
    return query select 'stale'::text;
    return;
  end if;

  -- Same rank: only a strictly newer provider timestamp advances the
  -- stored summary; an exact timestamp match is a duplicate callback and an
  -- older timestamp is a late, already-superseded arrival.
  if p_provider_timestamp > v_current_at then
    update public.outbound_message_outbox
      set provider_status_at = p_provider_timestamp
      where id = v_outbox_id;
    return query select 'recorded'::text;
    return;
  elsif p_provider_timestamp = v_current_at then
    return query select 'duplicate'::text;
    return;
  else
    return query select 'stale'::text;
    return;
  end if;
end;
$$;

revoke all on function public.record_whatsapp_outbound_status(text, text, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_whatsapp_outbound_status(text, text, text, text, timestamptz) to service_role;
