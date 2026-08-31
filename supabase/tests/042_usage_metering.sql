-- Task 042: rollback-only proof for the clinic-scoped AI usage ledger and
-- monthly reconciliation. Not run against any database by the implementer.

begin;

-- Small fixture helper: looks up the current (conversation_id, claim_token)
-- for a clinic + provider message id, mirroring the exact resolution join
-- record_intake_ai_usage_v1 uses internally, so later proof blocks never
-- need to carry state across separate `do` blocks.
create function pg_temp.current_claim(p_clinic_id uuid, p_wamid text, out conversation_id uuid, out claim_token uuid)
language sql
as $$
  select m.conversation_id, we.intake_claim_token
  from public.messages m
  join public.webhook_events we
    on we.clinic_id = m.clinic_id
   and we.provider_event_id = m.whatsapp_message_id
  where m.clinic_id = p_clinic_id
    and m.whatsapp_message_id = p_wamid;
$$;

-- =========================================================================
-- Fixture clinics
-- =========================================================================

insert into public.clinics (id, name)
values
  ('42000000-0000-0000-0000-000000000001', 'Usage Ledger Clinic A'),
  ('42000000-0000-0000-0000-000000000003', 'Usage Ledger Clinic B (cross-tenant)'),
  ('42000000-0000-0000-0000-000000000005', 'Usage Ledger Clinic D (known-empty)');

-- Task 041: clinics default to suspended; activate so ingest/claim below
-- behaves the same as before that change.
update public.clinics set operational_status = 'active', suspended_at = null
where id in (
  '42000000-0000-0000-0000-000000000001',
  '42000000-0000-0000-0000-000000000003',
  '42000000-0000-0000-0000-000000000005'
);

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '420000001'),
  ('42000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000003', '420000002');

-- Task 034's strict allowlist defaults every unlisted contact to personal.
-- Only these fixture contacts are allowed into the AI path; the final two
-- account-A contacts deliberately exercise manual and personal exclusion.
insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420001', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420002', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420003', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420004', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420005', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420006', 'ai'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420007', 'manual'),
  ('42000000-0000-0000-0000-000000000002', '42000000-0000-0000-0000-000000000001', '+15550420008', 'personal'),
  ('42000000-0000-0000-0000-000000000004', '42000000-0000-0000-0000-000000000003', '+15550420099', 'ai');

-- =========================================================================
-- Ingest + claim every AI message this fixture needs. Each uses a separate
-- owner/conversation so Task 039's three-second burst representative rule
-- cannot make an earlier fixture job superseded. The aggregate proof later
-- gives two rows the same derived conversation hash explicitly.
-- =========================================================================

do $$
declare
  v_result text;
  v_conversation_id uuid;
begin
  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-1',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420004',
    p_owner_name => 'Usage Owner One', p_message_text => 'Kedim kusuyor',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-1 to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-4',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420005',
    p_owner_name => 'Usage Owner One', p_message_text => 'Bir de asisi var mi?',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-4 to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-4b',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420001',
    p_owner_name => 'Usage Owner One', p_message_text => 'Bugun musait misiniz?',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-4b to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-3',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420006',
    p_owner_name => 'Usage Owner Three', p_message_text => 'Randevu almak istiyorum',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-3 to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-6',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420003',
    p_owner_name => 'Usage Owner Three', p_message_text => 'Hala orada misiniz?',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-6 to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-5',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420002',
    p_owner_name => 'Usage Owner Two', p_message_text => 'Kopegim icin soru',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-5 to ingest as processed, got %', v_result; end if;

  select result into v_result from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000002', p_provider_message_id => 'wamid.042-B1',
    p_payload_hash => repeat('a', 64), p_sender_e164 => '+15550420099',
    p_owner_name => 'Cross Tenant Owner', p_message_text => 'Baska klinik mesaji',
    p_provider_timestamp => now()
  );
  if v_result <> 'processed' then raise exception 'expected wamid.042-B1 to ingest as processed, got %', v_result; end if;

  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-MANUAL',
    p_payload_hash => repeat('b', 64), p_sender_e164 => '+15550420007',
    p_owner_name => 'Usage Manual Owner', p_message_text => 'Personel okuyacak',
    p_provider_timestamp => now()
  );
  if v_result <> 'manual' or v_conversation_id is null then
    raise exception 'expected manual route to persist a completed conversation, got %/%', v_result, v_conversation_id;
  end if;

  select result, conversation_id into v_result, v_conversation_id
  from public.ingest_whatsapp_text_message(
    p_phone_number_id => '420000001', p_provider_message_id => 'wamid.042-PERSONAL',
    p_payload_hash => repeat('c', 64), p_sender_e164 => '+15550420008',
    p_owner_name => 'Usage Personal Owner', p_message_text => 'Asla kaydedilmemeli',
    p_provider_timestamp => now()
  );
  if v_result <> 'ignored' or v_conversation_id is not null then
    raise exception 'expected personal route to be ignored without a conversation, got %/%', v_result, v_conversation_id;
  end if;
end;
$$;

-- wamid.042-3 is deliberately left out and never claimed (proof 3's
-- non-processing/pending rejection case).
do $$
declare
  r record;
  v_conversation_id uuid;
  v_result text;
  v_token uuid;
begin
  for r in
    select * from (values
      ('42000000-0000-0000-0000-000000000001'::uuid, 'wamid.042-1'),
      ('42000000-0000-0000-0000-000000000001'::uuid, 'wamid.042-4'),
      ('42000000-0000-0000-0000-000000000001'::uuid, 'wamid.042-4b'),
      ('42000000-0000-0000-0000-000000000001'::uuid, 'wamid.042-6'),
      ('42000000-0000-0000-0000-000000000001'::uuid, 'wamid.042-5'),
      ('42000000-0000-0000-0000-000000000003'::uuid, 'wamid.042-B1')
    ) as t(clinic_id, wamid)
  loop
    select conversation_id into v_conversation_id
    from public.messages where clinic_id = r.clinic_id and whatsapp_message_id = r.wamid;
    select result, claim_token into v_result, v_token from public.claim_intake_queue_job(v_conversation_id, r.wamid);
    if v_result <> 'claimed' then raise exception 'expected % to claim, got %', r.wamid, v_result; end if;
  end loop;
end;
$$;

-- =========================================================================
-- 1. A valid current AI claim records exactly one PII-minimized row: correct
--    clinic, fixed metadata, SHA-256 hashes (not the raw ids), token counts,
--    and no column stores the source event id or provider message id.
-- =========================================================================

do $$
declare
  v_claim record;
  v_result text;
  v_event_id uuid;
  v_expected_source_hash text;
  v_expected_conversation_hash text;
  v_row record;
  v_column_count int;
begin
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-1');

  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-1', v_claim.claim_token,
    'gpt-5.6-luna', '2026-08-28.2', 100, 50, 150
  );
  if v_result <> 'recorded' then raise exception 'expected wamid.042-1 to record, got %', v_result; end if;

  select we.id into v_event_id
  from public.webhook_events we
  where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-1';
  v_expected_source_hash := encode(sha256(v_event_id::text::bytea), 'hex');
  v_expected_conversation_hash := encode(sha256(v_claim.conversation_id::text::bytea), 'hex');

  select * into v_row from public.clinic_ai_usage_events
  where clinic_id = '42000000-0000-0000-0000-000000000001' and source_event_hash = v_expected_source_hash;

  if v_row.model <> 'gpt-5.6-luna' or v_row.prompt_version <> '2026-08-28.2'
    or v_row.input_tokens <> 100 or v_row.output_tokens <> 50 or v_row.total_tokens <> 150 then
    raise exception 'recorded row metadata/tokens mismatch';
  end if;
  if v_row.conversation_hash <> v_expected_conversation_hash then
    raise exception 'recorded row conversation_hash does not match sha256(conversation_id)';
  end if;
  if v_row.source_event_hash = v_event_id::text or v_row.conversation_hash = v_claim.conversation_id::text then
    raise exception 'recorded row stored a raw id instead of a hash';
  end if;

  select count(*) into v_column_count
  from information_schema.columns
  where table_schema = 'public' and table_name = 'clinic_ai_usage_events'
    and column_name in ('provider_message_id', 'event_id', 'webhook_event_id', 'source_event_id', 'conversation_id');
  if v_column_count <> 0 then
    raise exception 'clinic_ai_usage_events unexpectedly has a raw source/provider id column';
  end if;

  if (select count(*) from public.clinic_ai_usage_events where clinic_id = '42000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'expected exactly one usage row after the first record call';
  end if;
end;
$$;

update public.clinic_ai_usage_events set occurred_at = timestamptz '2026-08-15 10:00:00+00'
where clinic_id = '42000000-0000-0000-0000-000000000001'
  and source_event_hash = (
    select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
    where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-1'
  );

-- =========================================================================
-- 2. Exact replay returns `duplicate` and leaves the first row byte-for-byte
--    unchanged, even when the replay carries different metadata/tokens --
--    at-least-once delivery cannot double-count or overwrite.
-- =========================================================================

do $$
declare
  v_claim record;
  v_result text;
  v_before record;
  v_after record;
begin
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-1');
  select * into v_before from public.clinic_ai_usage_events
  where clinic_id = '42000000-0000-0000-0000-000000000001'
    and source_event_hash = (
      select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
      where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-1'
    );

  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-1', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 100, 50, 150
  );
  if v_result <> 'duplicate' then raise exception 'expected exact replay to return duplicate, got %', v_result; end if;

  -- A retry that would carry a second real provider call's different token
  -- sample must still be rejected as duplicate and keep the first sample.
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-1', v_claim.claim_token, 'other-model', '9999-99.9', 999, 999, 1998
  );
  if v_result <> 'duplicate' then raise exception 'expected differing-metadata replay to return duplicate, got %', v_result; end if;

  select * into v_after from public.clinic_ai_usage_events
  where clinic_id = '42000000-0000-0000-0000-000000000001'
    and source_event_hash = (
      select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
      where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-1'
    );

  if v_after.model <> v_before.model or v_after.prompt_version <> v_before.prompt_version
    or v_after.input_tokens <> v_before.input_tokens or v_after.output_tokens <> v_before.output_tokens
    or v_after.total_tokens <> v_before.total_tokens or v_after.occurred_at <> v_before.occurred_at
    or v_after.id <> v_before.id then
    raise exception 'replay must not mutate the first recorded row';
  end if;

  if (select count(*) from public.clinic_ai_usage_events where clinic_id = '42000000-0000-0000-0000-000000000001') <> 1 then
    raise exception 'replay unexpectedly inserted a second row';
  end if;
end;
$$;

-- =========================================================================
-- 3. Another token, conversation, provider id, tenant, manual/personal route,
--    or a non-processing event cannot create a row.
-- =========================================================================

do $$
declare
  v_claim record;
  v_result text;
  v_count_before int;
  v_count_after int;
begin
  select count(*) into v_count_before from public.clinic_ai_usage_events;

  -- Wrong claim token.
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-1');
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-1', gen_random_uuid(), 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'stale_claim' then raise exception 'expected wrong claim token to return stale_claim, got %', v_result; end if;

  -- Wrong conversation id (a fresh, unrelated uuid) with a real provider id.
  select result into v_result from public.record_intake_ai_usage_v1(
    gen_random_uuid(), 'wamid.042-1', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'not_found' then raise exception 'expected wrong conversation_id to return not_found, got %', v_result; end if;

  -- Wrong provider message id with a real conversation id.
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.NOPE', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'not_found' then raise exception 'expected wrong provider_message_id to return not_found, got %', v_result; end if;

  -- Cross-tenant: clinic B's conversation with clinic A's provider message id.
  declare
    v_claim_b record;
  begin
    select * into v_claim_b from pg_temp.current_claim('42000000-0000-0000-0000-000000000003', 'wamid.042-B1');
    select result into v_result from public.record_intake_ai_usage_v1(
      v_claim_b.conversation_id, 'wamid.042-1', v_claim_b.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
    );
    if v_result <> 'not_found' then raise exception 'expected cross-tenant lookup to return not_found, got %', v_result; end if;
  end;

  -- Non-processing (never claimed, still pending) event.
  select conversation_id into v_claim.conversation_id
  from public.messages where clinic_id = '42000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.042-3';
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-3', gen_random_uuid(), 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'stale_claim' then raise exception 'expected a pending (unclaimed) event to return stale_claim, got %', v_result; end if;

  -- Manual is persisted already-completed and therefore cannot hold a live
  -- AI claim; personal was ignored before any event/conversation write.
  select conversation_id into v_claim.conversation_id
  from public.messages
  where clinic_id = '42000000-0000-0000-0000-000000000001'
    and whatsapp_message_id = 'wamid.042-MANUAL';
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-MANUAL', gen_random_uuid(), 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'stale_claim' then raise exception 'expected manual event to return stale_claim, got %', v_result; end if;

  select result into v_result from public.record_intake_ai_usage_v1(
    gen_random_uuid(), 'wamid.042-PERSONAL', gen_random_uuid(), 'gpt-5.6-luna', '2026-08-28.2', 1, 1, 2
  );
  if v_result <> 'not_found' then raise exception 'expected personal event to return not_found, got %', v_result; end if;

  select count(*) into v_count_after from public.clinic_ai_usage_events;
  if v_count_after <> v_count_before then
    raise exception 'a rejected record attempt unexpectedly inserted a row';
  end if;
end;
$$;

-- =========================================================================
-- 4. Null token usage is accepted only as an all-null triplet; negative,
--    partial, or malformed model/prompt input raises with zero mutation.
-- =========================================================================

do $$
declare
  v_claim record;
  v_result text;
  v_count_before int;
  v_count_after int;
  v_raised boolean;
begin
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-4');
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-4', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', null, null, null
  );
  if v_result <> 'recorded' then raise exception 'expected an all-null usage triplet to record, got %', v_result; end if;

  select count(*) into v_count_before from public.clinic_ai_usage_events;
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-4b');

  v_raised := false;
  begin
    perform result from public.record_intake_ai_usage_v1(
      v_claim.conversation_id, 'wamid.042-4b', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 100, null, null
    );
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'expected a partial-null token triplet to raise'; end if;

  v_raised := false;
  begin
    perform result from public.record_intake_ai_usage_v1(
      v_claim.conversation_id, 'wamid.042-4b', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', -1, 0, 0
    );
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'expected a negative token count to raise'; end if;

  v_raised := false;
  begin
    perform result from public.record_intake_ai_usage_v1(
      v_claim.conversation_id, 'wamid.042-4b', v_claim.claim_token, '  spaced-model  ', '2026-08-28.2', 1, 1, 2
    );
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'expected an untrimmed model to raise'; end if;

  v_raised := false;
  begin
    perform result from public.record_intake_ai_usage_v1(
      v_claim.conversation_id, 'wamid.042-4b', v_claim.claim_token, 'gpt-5.6-luna', '', 1, 1, 2
    );
  exception when others then v_raised := true;
  end;
  if not v_raised then raise exception 'expected an empty prompt_version to raise'; end if;

  select count(*) into v_count_after from public.clinic_ai_usage_events;
  if v_count_after <> v_count_before then
    raise exception 'an invalid-input attempt unexpectedly inserted a row';
  end if;
end;
$$;

-- Deterministic, fixed-clock aggregate/boundary data for proofs 5 and 6.
update public.clinic_ai_usage_events set occurred_at = timestamptz '2026-08-20 10:00:00+00'
where clinic_id = '42000000-0000-0000-0000-000000000001'
  and source_event_hash = (
    select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
    where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-4'
  );

-- The report groups by the privacy-preserving conversation hash. Reuse the
-- first row's already-proven derived hash to model a second logical turn in
-- that same conversation without making this fixture depend on burst timing.
update public.clinic_ai_usage_events
set conversation_hash = (
  select conversation_hash
  from public.clinic_ai_usage_events
  where clinic_id = '42000000-0000-0000-0000-000000000001'
    and source_event_hash = (
      select encode(sha256(we.id::text::bytea), 'hex')
      from public.webhook_events we
      where we.clinic_id = '42000000-0000-0000-0000-000000000001'
        and we.provider_event_id = 'wamid.042-1'
    )
)
where clinic_id = '42000000-0000-0000-0000-000000000001'
  and source_event_hash = (
    select encode(sha256(we.id::text::bytea), 'hex')
    from public.webhook_events we
    where we.clinic_id = '42000000-0000-0000-0000-000000000001'
      and we.provider_event_id = 'wamid.042-4'
  );

do $$
declare
  v_claim record;
  v_result text;
begin
  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-5');
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-5', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 70, 30, 100
  );
  if v_result <> 'recorded' then raise exception 'expected wamid.042-5 to record, got %', v_result; end if;

  select * into v_claim from pg_temp.current_claim('42000000-0000-0000-0000-000000000001', 'wamid.042-6');
  select result into v_result from public.record_intake_ai_usage_v1(
    v_claim.conversation_id, 'wamid.042-6', v_claim.claim_token, 'gpt-5.6-luna', '2026-08-28.2', 10, 10, 20
  );
  if v_result <> 'recorded' then raise exception 'expected wamid.042-6 to record, got %', v_result; end if;
end;
$$;

-- wamid.042-5: exactly Europe/Istanbul midnight of 2026-08-01 (August's
-- inclusive start boundary). wamid.042-6: exactly Europe/Istanbul midnight
-- of 2026-09-01 (August's exclusive end / September's inclusive start).
update public.clinic_ai_usage_events set occurred_at = timestamptz '2026-07-31 21:00:00+00'
where clinic_id = '42000000-0000-0000-0000-000000000001'
  and source_event_hash = (
    select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
    where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-5'
  );
update public.clinic_ai_usage_events set occurred_at = timestamptz '2026-08-31 21:00:00+00'
where clinic_id = '42000000-0000-0000-0000-000000000001'
  and source_event_hash = (
    select encode(sha256(we.id::text::bytea), 'hex') from public.webhook_events we
    where we.clinic_id = '42000000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.042-6'
  );

-- =========================================================================
-- 5 & 6. Two logical turns in one conversation count as two turns and one
--    touched conversation; another conversation counts separately. Europe/
--    Istanbul start-inclusive/end-exclusive month boundaries and the
--    missing-token aggregate are exact.
-- =========================================================================

do $$
declare
  v_row record;
begin
  select * into v_row from public.get_clinic_monthly_usage_v1('42000000-0000-0000-0000-000000000001', date '2026-08-01');
  if v_row.result <> 'reported' then raise exception 'expected August report for clinic A, got %', v_row.result; end if;
  if v_row.period_start <> date '2026-08-01' or v_row.period_end <> date '2026-09-01' then
    raise exception 'August period bounds mismatch: % .. %', v_row.period_start, v_row.period_end;
  end if;
  if v_row.ai_turn_count <> 3 then raise exception 'expected 3 August turns (wamid 1, 4, 5), got %', v_row.ai_turn_count; end if;
  if v_row.ai_touched_conversation_count <> 2 then
    raise exception 'expected 2 touched conversations (one shared by wamid 1+4, one for wamid 5), got %', v_row.ai_touched_conversation_count;
  end if;
  if v_row.input_tokens <> 170 or v_row.output_tokens <> 80 or v_row.total_tokens <> 250 then
    raise exception 'August token sums mismatch: input=%, output=%, total=%', v_row.input_tokens, v_row.output_tokens, v_row.total_tokens;
  end if;
  if v_row.missing_token_usage_count <> 1 then
    raise exception 'expected 1 missing-token turn (wamid.042-4), got %', v_row.missing_token_usage_count;
  end if;

  select * into v_row from public.get_clinic_monthly_usage_v1('42000000-0000-0000-0000-000000000001', date '2026-09-01');
  if v_row.result <> 'reported' then raise exception 'expected September report for clinic A, got %', v_row.result; end if;
  if v_row.period_start <> date '2026-09-01' or v_row.period_end <> date '2026-10-01' then
    raise exception 'September period bounds mismatch: % .. %', v_row.period_start, v_row.period_end;
  end if;
  if v_row.ai_turn_count <> 1 or v_row.ai_touched_conversation_count <> 1 then
    raise exception 'expected exactly the boundary-excluded-from-August wamid.042-6 turn in September, got turns=% conversations=%',
      v_row.ai_turn_count, v_row.ai_touched_conversation_count;
  end if;
  if v_row.input_tokens <> 10 or v_row.output_tokens <> 10 or v_row.total_tokens <> 20 or v_row.missing_token_usage_count <> 0 then
    raise exception 'September aggregate mismatch';
  end if;
end;
$$;

-- =========================================================================
-- 7. Known-empty and absent-clinic report shapes are exact.
-- =========================================================================

do $$
declare
  v_row record;
begin
  select * into v_row from public.get_clinic_monthly_usage_v1('42000000-0000-0000-0000-000000000005', date '2026-08-01');
  if v_row.result <> 'reported' then raise exception 'expected a known-empty clinic to report, got %', v_row.result; end if;
  if v_row.ai_turn_count <> 0 or v_row.ai_touched_conversation_count <> 0
    or v_row.input_tokens <> 0 or v_row.output_tokens <> 0 or v_row.total_tokens <> 0
    or v_row.missing_token_usage_count <> 0 then
    raise exception 'known-empty clinic must report all-zero aggregates';
  end if;

  select * into v_row from public.get_clinic_monthly_usage_v1('42000000-0000-0000-0000-000000009999', date '2026-08-01');
  if v_row.result <> 'clinic_not_found' then raise exception 'expected an absent clinic to report clinic_not_found, got %', v_row.result; end if;
  if v_row.clinic_id <> '42000000-0000-0000-0000-000000009999' then raise exception 'absent-clinic report echoed the wrong clinic_id'; end if;
  if v_row.ai_turn_count <> 0 or v_row.ai_touched_conversation_count <> 0
    or v_row.input_tokens <> 0 or v_row.output_tokens <> 0 or v_row.total_tokens <> 0
    or v_row.missing_token_usage_count <> 0 then
    raise exception 'clinic_not_found must report all-zero aggregates';
  end if;
end;
$$;

-- =========================================================================
-- 8. authenticated/anon have no table visibility or mutation and cannot
--    execute either RPC; service_role has execute but no direct table
--    privilege.
-- =========================================================================

do $$
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c
          join pg_catalog.pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = 'clinic_ai_usage_events') then
    raise exception 'clinic_ai_usage_events must have RLS enabled';
  end if;
  if exists (select 1 from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'clinic_ai_usage_events') then
    raise exception 'clinic_ai_usage_events must have no RLS policy';
  end if;
  if pg_catalog.has_table_privilege('service_role', 'public.clinic_ai_usage_events', 'SELECT')
    or pg_catalog.has_table_privilege('service_role', 'public.clinic_ai_usage_events', 'INSERT')
    or pg_catalog.has_table_privilege('service_role', 'public.clinic_ai_usage_events', 'UPDATE')
    or pg_catalog.has_table_privilege('service_role', 'public.clinic_ai_usage_events', 'DELETE') then
    raise exception 'service_role unexpectedly has a direct ledger table privilege';
  end if;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform 1 from public.clinic_ai_usage_events limit 1;
    raise exception 'authenticated role unexpectedly read clinic_ai_usage_events';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.clinic_ai_usage_events (clinic_id, event_kind, source_event_hash, conversation_hash, model, prompt_version)
    values ('42000000-0000-0000-0000-000000000001', 'intake_ai_turn', repeat('a', 64), repeat('b', 64), 'x', 'y');
    raise exception 'authenticated role unexpectedly inserted into clinic_ai_usage_events';
  exception when insufficient_privilege then null;
  end;

  begin
    perform result from public.record_intake_ai_usage_v1(gen_random_uuid(), 'wamid.AUTH', gen_random_uuid(), 'x', 'y', null, null, null);
    raise exception 'authenticated role unexpectedly executed record_intake_ai_usage_v1';
  exception when insufficient_privilege then null;
  end;

  begin
    perform result from public.get_clinic_monthly_usage_v1(gen_random_uuid(), date '2026-08-01');
    raise exception 'authenticated role unexpectedly executed get_clinic_monthly_usage_v1';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from public.clinic_ai_usage_events limit 1;
    raise exception 'anon role unexpectedly read clinic_ai_usage_events';
  exception when insufficient_privilege then null;
  end;

  begin
    perform result from public.record_intake_ai_usage_v1(gen_random_uuid(), 'wamid.ANON', gen_random_uuid(), 'x', 'y', null, null, null);
    raise exception 'anon role unexpectedly executed record_intake_ai_usage_v1';
  exception when insufficient_privilege then null;
  end;

  begin
    perform result from public.get_clinic_monthly_usage_v1(gen_random_uuid(), date '2026-08-01');
    raise exception 'anon role unexpectedly executed get_clinic_monthly_usage_v1';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_result text;
  v_row record;
begin
  begin
    perform 1 from public.clinic_ai_usage_events limit 1;
    raise exception 'service_role unexpectedly has direct table read on clinic_ai_usage_events';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.clinic_ai_usage_events (clinic_id, event_kind, source_event_hash, conversation_hash, model, prompt_version)
    values ('42000000-0000-0000-0000-000000000001', 'intake_ai_turn', repeat('c', 64), repeat('d', 64), 'x', 'y');
    raise exception 'service_role unexpectedly has direct table insert on clinic_ai_usage_events';
  exception when insufficient_privilege then null;
  end;

  select result into v_result from public.record_intake_ai_usage_v1(gen_random_uuid(), 'wamid.SVC', gen_random_uuid(), 'x', 'y', null, null, null);
  if v_result <> 'not_found' then raise exception 'expected service_role RPC execute to succeed (not_found), got %', v_result; end if;

  select * into v_row from public.get_clinic_monthly_usage_v1('42000000-0000-0000-0000-000000000005', date '2026-08-01');
  if v_row.result <> 'reported' then raise exception 'expected service_role monthly-usage RPC execute to succeed, got %', v_row.result; end if;
end;
$$;
reset role;

-- =========================================================================
-- 9. Clinic deletion cascades ledger rows; no fixture residue remains.
-- =========================================================================

do $$
declare
  v_before int;
  v_after int;
begin
  select count(*) into v_before from public.clinic_ai_usage_events where clinic_id = '42000000-0000-0000-0000-000000000001';
  if v_before <> 4 then raise exception 'expected 4 clinic A usage rows before deletion, got %', v_before; end if;

  delete from public.clinics where id = '42000000-0000-0000-0000-000000000001';

  select count(*) into v_after from public.clinic_ai_usage_events where clinic_id = '42000000-0000-0000-0000-000000000001';
  if v_after <> 0 then raise exception 'expected clinic deletion to cascade all its ledger rows, % remain', v_after; end if;

  if (select count(*) from public.clinic_ai_usage_events
      where clinic_id in (
        '42000000-0000-0000-0000-000000000001',
        '42000000-0000-0000-0000-000000000003',
        '42000000-0000-0000-0000-000000000005'
      )) <> 0 then
    raise exception 'expected no Task 042 fixture usage rows after clinic A deletion';
  end if;
end;
$$;

rollback;
