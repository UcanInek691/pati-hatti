-- Rollback-only proof for Task 034 Phase D. Never run against a real clinic
-- database. The migration itself must be applied before this proof.

begin;

insert into public.clinics (id, name)
values
  ('34000000-0000-0000-0000-000000000001', 'Strict Allowlist Test Clinic A'),
  ('34000000-0000-0000-0000-000000000003', 'Strict Allowlist Test Clinic B');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values
  ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '934000001'),
  ('34000000-0000-0000-0000-000000000004', '34000000-0000-0000-0000-000000000003', '934000002');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('34100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'allow-a@example.invalid', now(), now()),
  ('34100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'allow-b@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('34000000-0000-0000-0000-000000000001', '34100000-0000-0000-0000-000000000001', 'admin'),
  ('34000000-0000-0000-0000-000000000003', '34100000-0000-0000-0000-000000000002', 'admin');

-- Local helper: use the real ingest -> claim -> atomic-finalize path to
-- produce one coherent pending reply. It exists only in pg_temp and vanishes
-- with this rollback fixture.
create function pg_temp.make_strict_outbox_row(
  p_phone_number_id text,
  p_provider_message_id text,
  p_sender_e164 text
) returns uuid
language plpgsql
as $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_claim_token uuid;
  v_stage text;
  v_version integer;
  v_finalize_result text;
  v_outbox_id uuid;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => p_phone_number_id,
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => p_sender_e164,
    p_owner_name => 'Strict Allowlist Fixture Owner',
    p_message_text => 'Synthetic allowlist fixture message',
    p_provider_timestamp => pg_catalog.now()
  );

  select m.conversation_id into v_conversation_id
  from public.messages m
  where m.whatsapp_message_id = p_provider_message_id;

  select claimed.result, claimed.claim_token
    into v_claim_result, v_claim_token
  from public.claim_intake_queue_job(v_conversation_id, p_provider_message_id) claimed;
  if v_claim_result <> 'claimed' then
    raise exception 'make_strict_outbox_row: expected claimed, got %', v_claim_result;
  end if;

  select c.intake_stage, c.state_version into v_stage, v_version
  from public.conversations c
  where c.id = v_conversation_id;

  select finalized.result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id,
    p_provider_message_id,
    v_claim_token,
    v_version,
    v_stage,
    null,
    '{"fixture": true}'::jsonb,
    'intake_received',
    'Sentetik allowlist yaniti.'
  ) finalized;
  if v_finalize_result <> 'applied' then
    raise exception 'make_strict_outbox_row: expected applied, got %', v_finalize_result;
  end if;

  select oo.id into v_outbox_id
  from public.outbound_message_outbox oo
  where oo.source_provider_message_id = p_provider_message_id;

  return v_outbox_id;
end;
$$;

-- New accounts and unlisted contacts are personal by construction.
do $$
declare
  v_default text;
  v_result text;
begin
  select automation_default into v_default
  from public.whatsapp_accounts
  where id = '34000000-0000-0000-0000-000000000002';
  if v_default <> 'personal' then
    raise exception 'expected strict personal account default, got %', v_default;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('934000001', '+15553400001');
  if v_result <> 'personal' then
    raise exception 'expected an unlisted contact to resolve personal, got %', v_result;
  end if;

  begin
    insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, automation_default)
    values ('34000000-0000-0000-0000-000000000099', '34000000-0000-0000-0000-000000000001', '934000099', 'ai');
    raise exception 'account unexpectedly accepted an ai default';
  exception
    when check_violation then null;
  end;
end;
$$;

-- The strict default is enforced by the real ingest boundary: an unlisted
-- sender is ignored before any event, owner, conversation, or message write.
do $$
declare
  v_result text;
  v_conversation_id uuid;
begin
  select ingested.result, ingested.conversation_id
    into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '934000001',
    p_provider_message_id => 'wamid.STRICT_UNLISTED',
    p_payload_hash => repeat('a', 64),
    p_sender_e164 => '+15553400999',
    p_owner_name => 'Must Not Persist',
    p_message_text => 'Must not be stored',
    p_provider_timestamp => pg_catalog.now()
  ) ingested;

  if v_result <> 'ignored' or v_conversation_id is not null then
    raise exception 'expected strict-default ingest ignored/null, got %/%', v_result, v_conversation_id;
  end if;
  if exists (
    select 1 from public.webhook_events we
    where we.clinic_id = '34000000-0000-0000-0000-000000000001'
      and we.provider_event_id = 'wamid.STRICT_UNLISTED'
  ) then
    raise exception 'unlisted ingest wrote a webhook event';
  end if;
  if exists (
    select 1 from public.owners o
    where o.clinic_id = '34000000-0000-0000-0000-000000000001'
      and o.phone_e164 = '+15553400999'
  ) then
    raise exception 'unlisted ingest wrote an owner';
  end if;
  if exists (
    select 1
    from public.conversations c
    join public.owners o on o.id = c.owner_id and o.clinic_id = c.clinic_id
    where c.clinic_id = '34000000-0000-0000-0000-000000000001'
      and o.phone_e164 = '+15553400999'
  ) then
    raise exception 'unlisted ingest wrote a conversation';
  end if;
  if exists (
    select 1 from public.messages m
    where m.clinic_id = '34000000-0000-0000-0000-000000000001'
      and m.whatsapp_message_id = 'wamid.STRICT_UNLISTED'
  ) then
    raise exception 'unlisted ingest wrote a message';
  end if;
end;
$$;

-- Same-clinic staff can add/remove one exact AI allowlist entry. Inherit
-- deletes the row and therefore returns the contact to personal.
set local role authenticated;
select set_config('request.jwt.claim.sub', '34100000-0000-0000-0000-000000000001', true);

do $$
declare
  v_result text;
begin
  select result into v_result
  from public.set_whatsapp_contact_route(
    '34000000-0000-0000-0000-000000000002', '+15553400001', 'ai'
  );
  if v_result <> 'updated' then
    raise exception 'expected an AI allowlist insert, got %', v_result;
  end if;

  select result into v_result
  from public.set_whatsapp_contact_route(
    '34000000-0000-0000-0000-000000000002', '+15553400001', 'inherit'
  );
  if v_result <> 'updated' then
    raise exception 'expected inherit to remove the allowlist entry, got %', v_result;
  end if;
end;
$$;
reset role;

do $$
declare
  v_result text;
begin
  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400001', 'ai');

  select result into v_result
  from public.resolve_whatsapp_contact_automation('934000001', '+15553400001');
  if v_result <> 'ai' then
    raise exception 'expected an exact allowlisted contact to resolve ai, got %', v_result;
  end if;

  select result into v_result
  from public.resolve_whatsapp_contact_automation('934000002', '+15553400001');
  if v_result <> 'personal' then
    raise exception 'same contact on another account must keep its own personal default, got %', v_result;
  end if;

  delete from public.whatsapp_contact_routes
  where whatsapp_account_id = '34000000-0000-0000-0000-000000000002'
    and contact_e164 = '+15553400001';

  select result into v_result
  from public.resolve_whatsapp_contact_automation('934000001', '+15553400001');
  if v_result <> 'personal' then
    raise exception 'expected removed allowlist contact to resolve personal, got %', v_result;
  end if;
end;
$$;

-- The activation cleanup predicate keeps explicitly authorized work and
-- terminal history, removes unauthorized pending/processing work, and never
-- lets an AI route on another account protect the target row.
do $$
declare
  v_ai_pending uuid;
  v_unlisted_pending uuid;
  v_unlisted_processing uuid;
  v_unlisted_accepted uuid;
  v_unlisted_failed uuid;
  v_other_tenant_pending uuid;
begin
  insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
  values
    ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400101', 'ai'),
    ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400102', 'ai'),
    ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400103', 'ai'),
    ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400104', 'ai'),
    ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000001', '+15553400105', 'ai'),
    ('34000000-0000-0000-0000-000000000004', '34000000-0000-0000-0000-000000000003', '+15553400102', 'ai');

  v_ai_pending := pg_temp.make_strict_outbox_row('934000001', 'wamid.STRICT_KEEP_AI', '+15553400101');
  v_unlisted_pending := pg_temp.make_strict_outbox_row('934000001', 'wamid.STRICT_DROP_PENDING', '+15553400102');
  v_unlisted_processing := pg_temp.make_strict_outbox_row('934000001', 'wamid.STRICT_DROP_PROCESSING', '+15553400103');
  v_unlisted_accepted := pg_temp.make_strict_outbox_row('934000001', 'wamid.STRICT_KEEP_ACCEPTED', '+15553400104');
  v_unlisted_failed := pg_temp.make_strict_outbox_row('934000001', 'wamid.STRICT_KEEP_FAILED', '+15553400105');
  v_other_tenant_pending := pg_temp.make_strict_outbox_row('934000002', 'wamid.STRICT_KEEP_OTHER_TENANT', '+15553400102');

  update public.outbound_message_outbox
  set delivery_status = 'processing',
      delivery_claim_token = '34000000-0000-0000-0000-000000000103',
      delivery_lease_until = pg_catalog.now() + interval '5 minutes',
      delivery_attempt_count = 1,
      next_attempt_at = null
  where id = v_unlisted_processing;

  update public.outbound_message_outbox
  set delivery_status = 'accepted',
      delivery_attempt_count = 1,
      next_attempt_at = null,
      provider_message_id = 'wamid.STRICT_PROVIDER_ACCEPTED',
      accepted_at = pg_catalog.now()
  where id = v_unlisted_accepted;

  update public.outbound_message_outbox
  set delivery_status = 'failed',
      delivery_attempt_count = 3,
      next_attempt_at = null,
      failed_at = pg_catalog.now(),
      failure_reason = 'attempts_exhausted'
  where id = v_unlisted_failed;

  delete from public.whatsapp_contact_routes
  where whatsapp_account_id = '34000000-0000-0000-0000-000000000002'
    and contact_e164 in ('+15553400102', '+15553400103', '+15553400104', '+15553400105');

  -- Exact copy of the forward migration's one-time cleanup predicate.
  delete from public.outbound_message_outbox oo
  where oo.delivery_status in ('pending', 'processing')
    and not exists (
      select 1
      from public.whatsapp_contact_routes r
      where r.whatsapp_account_id = oo.whatsapp_account_id
        and r.contact_e164 = oo.recipient_e164
        and r.mode = 'ai'
    );

  if not exists (select 1 from public.outbound_message_outbox where id = v_ai_pending and delivery_status = 'pending') then
    raise exception 'cleanup removed an explicitly allowlisted pending row';
  end if;
  if exists (select 1 from public.outbound_message_outbox where id in (v_unlisted_pending, v_unlisted_processing)) then
    raise exception 'cleanup kept unauthorized pending/processing work';
  end if;
  if not exists (select 1 from public.outbound_message_outbox where id = v_unlisted_accepted and delivery_status = 'accepted') then
    raise exception 'cleanup removed accepted terminal history';
  end if;
  if not exists (select 1 from public.outbound_message_outbox where id = v_unlisted_failed and delivery_status = 'failed') then
    raise exception 'cleanup removed failed terminal history';
  end if;
  if not exists (select 1 from public.outbound_message_outbox where id = v_other_tenant_pending and delivery_status = 'pending') then
    raise exception 'cleanup crossed the account/tenant boundary';
  end if;
end;
$$;

-- Cross-tenant staff cannot create an allowlist entry for another clinic.
set local role authenticated;
select set_config('request.jwt.claim.sub', '34100000-0000-0000-0000-000000000002', true);
do $$
declare
  v_result text;
begin
  select result into v_result
  from public.set_whatsapp_contact_route(
    '34000000-0000-0000-0000-000000000002', '+15553400002', 'ai'
  );
  if v_result <> 'not_found' then
    raise exception 'expected cross-tenant allowlist mutation to return not_found, got %', v_result;
  end if;
end;
$$;
reset role;

-- Verify row absence outside authenticated RLS; under clinic-B RLS this
-- assertion would be vacuous because clinic-A rows are intentionally hidden.
do $$
begin
  if exists (
    select 1 from public.whatsapp_contact_routes
    where whatsapp_account_id = '34000000-0000-0000-0000-000000000002'
      and contact_e164 = '+15553400002'
  ) then
    raise exception 'cross-tenant allowlist mutation created a route';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('34000000-0000-0000-0000-000000000001', '34000000-0000-0000-0000-000000000003')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000004')) as remaining_test_accounts,
  (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id in ('34000000-0000-0000-0000-000000000002', '34000000-0000-0000-0000-000000000004')) as remaining_test_routes;
