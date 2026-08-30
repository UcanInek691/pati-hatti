-- Task 040: per-account Meta credential isolation, database side. Adds an
-- expand-only V2 claim RPC that reuses public.claim_outbound_message's
-- reviewed lock/lease/retry body unchanged, but returns one additional
-- whatsapp_account_id column from the same tenant-safe composite join
-- (outbound_message_outbox.whatsapp_account_id/clinic_id to
-- whatsapp_accounts.id/clinic_id) so the Worker can select the exact
-- per-account Meta token instead of one global secret. V1 is preserved
-- byte-for-byte so the previously deployed Worker keeps a valid rollback
-- target; new Worker code calls only V2. Not run against any database by the
-- implementer; see supabase/tests/040_per_account_whatsapp_credentials.sql
-- and docs/outbound-delivery.md.

create function public.claim_outbound_message_v2()
returns table (
  result text,
  outbox_id uuid,
  claim_token uuid,
  whatsapp_account_id uuid,
  phone_number_id text,
  recipient_e164 text,
  content text,
  attempt_count integer
)
language plpgsql
security invoker
volatile
set search_path = ''
as $$
declare
  v_outbox_id uuid;
  v_delivery_status text;
  v_attempt_count integer;
  v_new_token uuid;
  v_account_id uuid;
  v_phone_number_id text;
  v_recipient_e164 text;
  v_content text;
begin
  select o.id, o.delivery_status, o.delivery_attempt_count, o.recipient_e164, o.content, wa.id, wa.phone_number_id
    into v_outbox_id, v_delivery_status, v_attempt_count, v_recipient_e164, v_content, v_account_id, v_phone_number_id
  from public.outbound_message_outbox o
  join public.whatsapp_accounts wa
    on wa.id = o.whatsapp_account_id
   and wa.clinic_id = o.clinic_id
  where (o.delivery_status = 'pending' and o.next_attempt_at <= pg_catalog.now())
     or (o.delivery_status = 'processing' and o.delivery_lease_until <= pg_catalog.now())
  order by o.created_at, o.id
  for update of o skip locked
  limit 1;

  if v_outbox_id is null then
    return query select 'empty'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  if v_delivery_status = 'processing' and v_attempt_count >= 3 then
    update public.outbound_message_outbox
      set delivery_status = 'failed',
          delivery_claim_token = null,
          delivery_lease_until = null,
          next_attempt_at = null,
          failed_at = pg_catalog.now(),
          failure_reason = 'attempts_exhausted'
      where id = v_outbox_id;

    return query select 'exhausted'::text, null::uuid, null::uuid, null::uuid, null::text, null::text, null::text, null::integer;
    return;
  end if;

  v_new_token := pg_catalog.gen_random_uuid();
  v_attempt_count := v_attempt_count + 1;

  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = v_new_token,
        delivery_lease_until = pg_catalog.now() + interval '5 minutes',
        delivery_attempt_count = v_attempt_count,
        next_attempt_at = null
    where id = v_outbox_id;

  return query select 'claimed'::text, v_outbox_id, v_new_token, v_account_id, v_phone_number_id, v_recipient_e164, v_content, v_attempt_count;
  return;
end;
$$;

revoke all on function public.claim_outbound_message_v2() from public, anon, authenticated;
grant execute on function public.claim_outbound_message_v2() to service_role;
