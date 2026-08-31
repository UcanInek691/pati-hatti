-- Rollback-only proof for Task 039 Part C (bounded multi-message user
-- turns), defined by
-- supabase/migrations/20260829000200_inbound_message_bursts.sql. That
-- migration, and 20260829000100_pet_appointment_guard_and_cancellation.sql
-- before it, must both be applied to the target database first.
--
-- WRITE-ONLY as delivered by Sonnet: never executed against any database as
-- part of Task 039's implementation step. Codex alone applies it to
-- disposable `vetai-test`.
--
-- Coverage:
--   0  grants: anon/authenticated denied execute on both replaced RPCs.
--   1  eligibility at ingest: ai text -> true, unsupported-media marker ->
--      false, manual mode -> false.
--   2  ordering: two eligible messages inside the 3s window assemble into
--      one "Mesaj 1: ...\nMesaj 2: ..." block in chronological order.
--   3  supersession: the older job is completed with zero claim/reply when
--      a newer eligible message already exists; the newest job alone
--      claims the aggregate; redelivery of the superseded job stays
--      'completed' (idempotent).
--   4  outbound boundary: a message sent after an outbound reply starts a
--      fresh burst that never merges backward across that reply.
--   5  stage exclusion: intake_confirmation never aggregates, even with a
--      newer eligible neighbor in-window; it claims its own raw text only.
--   6  manual exclusion: manual-mode events complete at ingest and never
--      enter the claim/burst path at all.
--   7  overflow (count): a 5th eligible message in one window routes the
--      newest job to 'overflow' with zero aggregate text.
--   8  overflow (size): four eligible messages whose combined labelled text
--      exceeds 65,536 code points routes the newest job to 'overflow'.
--   9  cross-tenant isolation: two clinics texting at the same instant
--      never leak into each other's aggregate.
--   10 zero residue: deleting the owner cascades away every message,
--      including ai_burst_eligible ones (webhook_events itself is keyed by
--      clinic_id, not owner_id, so it is out of scope for owner erasure and
--      is untouched here, exactly as for every other owner in this suite).
--   11 fixed windows: a 0s/2s/4s chain becomes two non-overlapping turns;
--      the first message is never lost by transitive supersession.
begin;

-- =========================================================================
-- Fixture 0: grants.
-- =========================================================================
do $$
begin
  begin
    set local role anon;
    perform result from public.claim_intake_queue_job('00000000-0000-0000-0000-000000000000'::uuid, 'x');
    raise exception 'fixture 0: expected anon to be denied execute on claim_intake_queue_job';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

do $$
begin
  begin
    set local role authenticated;
    perform result from public.ingest_whatsapp_text_message(
      'x', 'x', repeat('a', 64), '+15550000000', 'x', 'x', pg_catalog.now()
    );
    raise exception 'fixture 0: expected authenticated to be denied execute on ingest_whatsapp_text_message';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Shared fixture data.
-- =========================================================================
insert into public.clinics (id, name) values
  ('39900000-0000-0000-0000-000000000001', '039C Clinic A'),
  ('39900000-0000-0000-0000-000000000002', '039C Clinic B (cross-tenant)'),
  ('39900000-0000-0000-0000-000000000003', '039C Clinic C (manual mode)');

-- Task 041: clinics default to suspended; activate this fixture's clinics so
-- the existing AI/ingest/outbound assertions below stay unchanged.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id) values
  ('39900000-0000-0000-0000-000000000011', '39900000-0000-0000-0000-000000000001', '939900001'),
  ('39900000-0000-0000-0000-000000000012', '39900000-0000-0000-0000-000000000002', '939900002'),
  ('39900000-0000-0000-0000-000000000013', '39900000-0000-0000-0000-000000000003', '939900003');

insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode) values
  ('39900000-0000-0000-0000-000000000011', '39900000-0000-0000-0000-000000000001', '+15559900001', 'ai'),
  ('39900000-0000-0000-0000-000000000012', '39900000-0000-0000-0000-000000000002', '+15559900002', 'ai'),
  ('39900000-0000-0000-0000-000000000013', '39900000-0000-0000-0000-000000000003', '+15559900003', 'manual');

-- webhook_events.received_at (and a directly-inserted outbound message's
-- created_at) default to now(), which is frozen for this entire wrapping
-- transaction, not per-statement -- every fixture calling now() would
-- otherwise get the exact same instant, both within itself and across every
-- other fixture sharing the same clinic-A conversation. Each fixture below
-- gets its own 10-minute-spaced anchor from this table, then patches
-- webhook_events.received_at (or sets created_at directly) using small
-- offsets from that anchor, so ordering/window/boundary assertions are
-- deterministic and fixtures never bleed into each other's windows.
do $$
declare
  v_base timestamptz := pg_catalog.now();
begin
  create temporary table burst_fixture_times (key text primary key, value timestamptz not null) on commit drop;
  insert into pg_temp.burst_fixture_times (key, value) values
    ('f2', v_base + interval '10 minutes'),
    ('f3', v_base + interval '20 minutes'),
    ('f4', v_base + interval '30 minutes'),
    ('f7', v_base + interval '40 minutes'),
    ('f8', v_base + interval '50 minutes'),
    ('f9', v_base + interval '60 minutes'),
    ('f11', v_base + interval '70 minutes');
end;
$$;

grant select on pg_temp.burst_fixture_times to service_role;

set local role service_role;

-- =========================================================================
-- Fixture 1: eligibility at ingest.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_ai_eligible boolean;
  v_media_eligible boolean;
  v_manual_eligible boolean;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
begin
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F1-ai', repeat('a', 64), '+15559900001', '039C Owner A',
    'Merhaba', pg_catalog.now()
  );

  select we.ai_burst_eligible into v_ai_eligible
  from public.webhook_events we
  where we.clinic_id = '39900000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.039C-F1-ai';
  if v_ai_eligible is distinct from true then
    raise exception 'fixture 1: expected ai-mode text message to be burst-eligible, got %', v_ai_eligible;
  end if;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F1-media', repeat('a', 64), '+15559900001', '039C Owner A',
    '__vetai_unsupported_media__', pg_catalog.now()
  );

  select we.ai_burst_eligible into v_media_eligible
  from public.webhook_events we
  where we.clinic_id = '39900000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.039C-F1-media';
  if v_media_eligible is distinct from false then
    raise exception 'fixture 1: expected unsupported-media marker to be ineligible, got %', v_media_eligible;
  end if;

  select m.conversation_id into v_conv
  from public.messages m
  where m.clinic_id = '39900000-0000-0000-0000-000000000001'
    and m.whatsapp_message_id = 'wamid.039C-F1-media';

  select c.result, c.claim_token, c.message_text into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F1-media') c;
  if v_result <> 'claimed' or v_message_text <> '__vetai_unsupported_media__' then
    raise exception 'fixture 1: ineligible media must retain single-message behavior, got % / %', v_result, v_message_text;
  end if;
  perform result from public.complete_intake_queue_job(v_conv, 'wamid.039C-F1-media', v_claim_token);

  -- Simulate a pre-migration historical text row (the new column backfills
  -- false). It too must be processed singly, never silently superseded.
  update public.webhook_events set ai_burst_eligible = false
  where clinic_id = '39900000-0000-0000-0000-000000000001'
    and provider_event_id = 'wamid.039C-F1-ai';
  select c.result, c.claim_token, c.message_text into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F1-ai') c;
  if v_result <> 'claimed' or v_message_text <> 'Merhaba' then
    raise exception 'fixture 1: historical ineligible text must retain single-message behavior, got % / %', v_result, v_message_text;
  end if;
  perform result from public.complete_intake_queue_job(v_conv, 'wamid.039C-F1-ai', v_claim_token);

  perform result from public.ingest_whatsapp_text_message(
    '939900003', 'wamid.039C-F1-manual', repeat('a', 64), '+15559900003', '039C Owner C',
    'Merhaba', pg_catalog.now()
  );

  select we.ai_burst_eligible into v_manual_eligible
  from public.webhook_events we
  where we.clinic_id = '39900000-0000-0000-0000-000000000003' and we.provider_event_id = 'wamid.039C-F1-manual';
  if v_manual_eligible is distinct from false then
    raise exception 'fixture 1: expected manual-mode text message to be ineligible, got %', v_manual_eligible;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: ordering. Two quick messages assemble as one labelled block.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
  v_mode text;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f2';
  -- webhook_events.received_at defaults to now(), which is frozen for this
  -- entire wrapping transaction (not per-statement): every insert in this
  -- rollback-only fixture would otherwise tie. Patch it explicitly after
  -- each ingest to simulate real, strictly-increasing arrival times.
  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F2-1', repeat('a', 64), '+15559900001', '039C Owner A',
    'Pamuk kusuyor', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F2-1';

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F2-2', repeat('a', 64), '+15559900001', '039C Owner A',
    'iki gündür kusuyor', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0 + interval '500 milliseconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F2-2';

  select claimed.result, claimed.claim_token, claimed.message_text, claimed.automation_mode
    into v_result, v_claim_token, v_message_text, v_mode
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F2-2') claimed;

  if v_result <> 'claimed' then
    raise exception 'fixture 2: expected claimed for the newest message, got %', v_result;
  end if;
  if v_message_text <> 'Mesaj 1: Pamuk kusuyor' || E'\n' || 'Mesaj 2: iki gündür kusuyor' then
    raise exception 'fixture 2: unexpected assembled text: %', v_message_text;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F2-2', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 2 reply', 'wamid.039C-F2-out', v_t0 + interval '1 second');
end;
$$;

-- =========================================================================
-- Fixture 3: supersession, including idempotent redelivery.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
  v_mode text;
  v_status_older text;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f3';

  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F3-1', repeat('a', 64), '+15559900001', '039C Owner A',
    'Bunların hiçbiri yok', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F3-1';

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F3-2', repeat('a', 64), '+15559900001', '039C Owner A',
    'ama yürürken dengesiz', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0 + interval '1 second'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F3-2';

  -- The older message's own job runs after the newer one already exists.
  select claimed.result, claimed.claim_token, claimed.message_text, claimed.automation_mode
    into v_result, v_claim_token, v_message_text, v_mode
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F3-1') claimed;

  if v_result <> 'superseded' then
    raise exception 'fixture 3: expected superseded for the older message, got %', v_result;
  end if;
  if v_claim_token is not null or v_message_text is not null or v_mode is not null then
    raise exception 'fixture 3: expected no claim_token/message_text/automation_mode on supersession';
  end if;

  select we.intake_status into v_status_older
  from public.webhook_events we
  where we.clinic_id = '39900000-0000-0000-0000-000000000001' and we.provider_event_id = 'wamid.039C-F3-1';
  if v_status_older <> 'completed' then
    raise exception 'fixture 3: expected the superseded event to be completed, got %', v_status_older;
  end if;

  if exists (
    select 1 from public.outbound_message_outbox oob where oob.conversation_id = v_conv
  ) then
    raise exception 'fixture 3: expected zero replies from a superseded job';
  end if;

  -- At-least-once redelivery of the same superseded job is terminal while
  -- its text remains visible to the current-turn representative.
  select claimed.result into v_result
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F3-1') claimed;
  if v_result <> 'completed' then
    raise exception 'fixture 3: expected redelivery of a superseded job to stay completed, got %', v_result;
  end if;

  -- The newest job alone claims the aggregate.
  select claimed.result, claimed.claim_token, claimed.message_text
    into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F3-2') claimed;
  if v_result <> 'claimed' then
    raise exception 'fixture 3: expected the newest message to be claimed, got %', v_result;
  end if;
  if v_message_text <> 'Mesaj 1: Bunların hiçbiri yok' || E'\n' || 'Mesaj 2: ama yürürken dengesiz' then
    raise exception 'fixture 3: unexpected aggregate on the newest job: %', v_message_text;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F3-2', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 3 reply', 'wamid.039C-F3-out', v_t0 + interval '2 seconds');

end;
$$;

-- =========================================================================
-- Fixture 4: outbound boundary. A burst never merges backward across a
-- reply that was already sent.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f4';

  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F4-before', repeat('a', 64), '+15559900001', '039C Owner A',
    'Karamel de var', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F4-before';

  -- Directly recording a sent reply, mirroring the outbound delivery
  -- pipeline's own effect on public.messages for this narrow read path.
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'Karamel''in kaç yaşında?', 'wamid.039C-F4-reply', v_t0 + interval '1 second');
  update public.webhook_events
    set intake_status = 'completed', intake_completed_at = v_t0 + interval '1 second'
  where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F4-before';

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F4-after', repeat('a', 64), '+15559900001', '039C Owner A',
    'iki yaşında', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0 + interval '2 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F4-after';

  select claimed.result, claimed.claim_token, claimed.message_text
    into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F4-after') claimed;

  if v_result <> 'claimed' then
    raise exception 'fixture 4: expected claimed for the post-reply message, got %', v_result;
  end if;
  if v_message_text <> 'Mesaj 1: iki yaşında' then
    raise exception 'fixture 4: expected the burst to start fresh after the outbound reply, got: %', v_message_text;
  end if;

  -- The source event completed by the reply is the durable boundary. Its
  -- delayed Queue job remains terminal and can never be pulled forward.
  select claimed.result into v_result
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F4-before') claimed;
  if v_result <> 'completed' then
    raise exception 'fixture 4: expected the pre-reply message to remain completed, got %', v_result;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F4-after', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 4 follow-up', 'wamid.039C-F4-out', v_t0 + interval '3 seconds');
end;
$$;

-- =========================================================================
-- Fixture 5: stage exclusion. intake_confirmation never aggregates.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
begin
  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = '39900000-0000-0000-0000-000000000001';

  update public.conversations set intake_stage = 'intake_confirmation' where id = v_conv;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F5-1', repeat('a', 64), '+15559900001', '039C Owner A',
    'EVET', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F5-2', repeat('a', 64), '+15559900001', '039C Owner A',
    'aslında hayır', pg_catalog.now()
  );

  select claimed.result, claimed.claim_token, claimed.message_text
    into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F5-1') claimed;

  if v_result <> 'claimed' then
    raise exception 'fixture 5: expected the confirmation-stage job to claim its own turn, got %', v_result;
  end if;
  if v_message_text <> 'EVET' then
    raise exception 'fixture 5: expected the confirmation stage to see only its own raw text, got: %', v_message_text;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F5-1', v_claim_token
  );

  select claimed.result, claimed.claim_token, claimed.message_text
    into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F5-2') claimed;
  if v_result <> 'claimed' or v_message_text <> 'aslında hayır' then
    raise exception 'fixture 5: expected the later confirmation-stage message to also claim its own raw text only, got % / %', v_result, v_message_text;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F5-2', v_claim_token
  );

  update public.conversations set intake_stage = 'complaint_collection' where id = v_conv;
end;
$$;

-- =========================================================================
-- Fixture 6: manual exclusion. Manual-mode events complete at ingest and
-- never enter burst logic at all.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_result text;
  v_message_text text;
  v_mode text;
begin
  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner C' and c.clinic_id = '39900000-0000-0000-0000-000000000003';

  perform result from public.ingest_whatsapp_text_message(
    '939900003', 'wamid.039C-F6-1', repeat('a', 64), '+15559900003', '039C Owner C',
    'Merhaba', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900003', 'wamid.039C-F6-2', repeat('a', 64), '+15559900003', '039C Owner C',
    'randevu almak istiyorum', pg_catalog.now()
  );

  select claimed.result, claimed.message_text, claimed.automation_mode
    into v_result, v_message_text, v_mode
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F6-2') claimed;

  if v_result <> 'completed' or v_mode is not null or v_message_text is not null then
    raise exception 'fixture 6: expected manual mode to be terminal before claim with null text/mode, got % / % / %', v_result, v_mode, v_message_text;
  end if;
  if 2 <> (
    select count(*)
    from public.webhook_events we
    where we.clinic_id = '39900000-0000-0000-0000-000000000003'
      and we.provider_event_id in ('wamid.039C-F6-1', 'wamid.039C-F6-2')
      and we.intake_status = 'completed'
  ) then
    raise exception 'fixture 6: expected both manual events to complete at ingest';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 7: overflow by count (5 eligible messages in one window).
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_claim_token uuid;
  v_message_text text;
  i integer;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f7';

  -- Start a fresh burst after Fixture 5's confirmation turns.
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  select v_clinic, c.id, 'outbound', 'Nasıl yardımcı olabilirim?', 'wamid.039C-F7-reply', v_t0
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  for i in 1..5 loop
    perform result from public.ingest_whatsapp_text_message(
      '939900001', 'wamid.039C-F7-' || i, repeat('a', 64), '+15559900001', '039C Owner A',
      'mesaj ' || i, pg_catalog.now()
    );
    update public.webhook_events set received_at = v_t0 + (interval '500 milliseconds' * i)
      where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F7-' || i;
  end loop;

  select claimed.result, claimed.claim_token, claimed.message_text
    into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F7-5') claimed;

  if v_result <> 'overflow' then
    raise exception 'fixture 7: expected overflow at 5 messages in one window, got %', v_result;
  end if;
  if v_claim_token is null then
    raise exception 'fixture 7: expected overflow to still hand back a claim_token for the human-handoff boundary';
  end if;
  if v_message_text is not null then
    raise exception 'fixture 7: expected zero aggregate text on overflow, got: %', v_message_text;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F7-5', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 7 overflow handoff', 'wamid.039C-F7-out', v_t0 + interval '3 seconds');
end;
$$;

-- =========================================================================
-- Fixture 8: overflow by size (aggregate exceeds 65,536 code points).
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_claim_token uuid;
  v_long text := repeat('x', 16380);
  i integer;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f8';

  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  select v_clinic, c.id, 'outbound', 'devam edin', 'wamid.039C-F8-reply', v_t0
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  for i in 1..4 loop
    perform result from public.ingest_whatsapp_text_message(
      '939900001', 'wamid.039C-F8-' || i, repeat('a', 64), '+15559900001', '039C Owner A',
      v_long, pg_catalog.now()
    );
    update public.webhook_events set received_at = v_t0 + (interval '500 milliseconds' * i)
      where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F8-' || i;
  end loop;

  select claimed.result, claimed.claim_token into v_result, v_claim_token
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F8-4') claimed;

  if v_result <> 'overflow' then
    raise exception 'fixture 8: expected overflow once the aggregate exceeds 65,536 code points, got %', v_result;
  end if;

  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F8-4', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 8 overflow handoff', 'wamid.039C-F8-out', v_t0 + interval '3 seconds');
end;
$$;

-- =========================================================================
-- Fixture 9: cross-tenant isolation.
-- =========================================================================
do $$
declare
  v_conv_b uuid;
  v_clinic_b uuid := '39900000-0000-0000-0000-000000000002';
  v_t0 timestamptz;
  v_message_text text;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f9';

  perform result from public.ingest_whatsapp_text_message(
    '939900002', 'wamid.039C-F9-b1', repeat('a', 64), '+15559900002', '039C Owner B',
    'Merhaba', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0
    where clinic_id = v_clinic_b and provider_event_id = 'wamid.039C-F9-b1';

  perform result from public.ingest_whatsapp_text_message(
    '939900002', 'wamid.039C-F9-b2', repeat('a', 64), '+15559900002', '039C Owner B',
    'Boncuk''un kulağı kızarmış', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0 + interval '500 milliseconds'
    where clinic_id = v_clinic_b and provider_event_id = 'wamid.039C-F9-b2';

  select c.id into v_conv_b
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner B' and c.clinic_id = '39900000-0000-0000-0000-000000000002';

  select claimed.message_text into v_message_text
  from public.claim_intake_queue_job(v_conv_b, 'wamid.039C-F9-b2') claimed;

  if v_message_text <> 'Mesaj 1: Merhaba' || E'\n' || 'Mesaj 2: Boncuk''un kulağı kızarmış' then
    raise exception 'fixture 9: expected clinic B''s own two-message burst only, got: %', v_message_text;
  end if;
  if v_message_text like '%mesaj 1%' or v_message_text like '%mesaj 2%' or v_message_text like '%iki yaşında%' then
    raise exception 'fixture 9: cross-tenant leakage detected in clinic B''s aggregate: %', v_message_text;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 10: zero residue on erasure.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
begin
  select o.id into v_owner_id
  from public.owners o
  where o.full_name = '039C Owner B' and o.clinic_id = '39900000-0000-0000-0000-000000000002';

  delete from public.owners where id = v_owner_id;

  if exists (
    select 1 from public.messages m where m.clinic_id = '39900000-0000-0000-0000-000000000002'
  ) then
    raise exception 'fixture 10: expected zero residual messages (including burst-eligible ones) after owner erasure';
  end if;
  if exists (
    select 1 from public.conversations c where c.clinic_id = '39900000-0000-0000-0000-000000000002'
  ) then
    raise exception 'fixture 10: expected zero residual conversations after owner erasure';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 11: fixed non-overlapping windows prevent transitive message loss.
-- =========================================================================
do $$
declare
  v_conv uuid;
  v_clinic uuid := '39900000-0000-0000-0000-000000000001';
  v_t0 timestamptz;
  v_result text;
  v_message_text text;
  v_claim_token uuid;
begin
  select value into v_t0 from pg_temp.burst_fixture_times where key = 'f11';
  select c.id into v_conv
  from public.conversations c
  join public.owners o on o.id = c.owner_id
  where o.full_name = '039C Owner A' and c.clinic_id = v_clinic;

  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-1', repeat('b', 64), '+15559900001', '039C Owner A',
    'Merhaba', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-2', repeat('c', 64), '+15559900001', '039C Owner A',
    'Pamuk kusuyor', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-3', repeat('d', 64), '+15559900001', '039C Owner A',
    'Bir de halsiz', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-1';
  update public.webhook_events set received_at = v_t0 + interval '2 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-2';
  update public.webhook_events set received_at = v_t0 + interval '4 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-3';

  select c.result into v_result
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-1') c;
  if v_result <> 'superseded' then
    raise exception 'fixture 11: expected first job to be superseded by the second, got %', v_result;
  end if;

  select c.result, c.claim_token, c.message_text into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-2') c;
  if v_result <> 'claimed'
    or v_message_text <> 'Mesaj 1: Merhaba' || E'\n' || 'Mesaj 2: Pamuk kusuyor' then
    raise exception 'fixture 11: expected the complete first fixed window, got % / %', v_result, v_message_text;
  end if;
  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F11-2', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 11 first reply', 'wamid.039C-F11-out-1', v_t0 + interval '3 seconds');

  select c.result, c.claim_token, c.message_text into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-3') c;
  if v_result <> 'claimed' or v_message_text <> 'Mesaj 1: Bir de halsiz' then
    raise exception 'fixture 11: expected the 4-second message in a new window, got % / %', v_result, v_message_text;
  end if;
  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F11-3', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 11 second reply', 'wamid.039C-F11-out-2', v_t0 + interval '5 seconds');

  -- Reverse Queue order: the later fixed window must wait rather than
  -- causing the earlier window's content to be discarded by an outbound
  -- boundary. Once the first representative completes, the later window is
  -- independently claimable.
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-4', repeat('e', 64), '+15559900001', '039C Owner A',
    'İlk pencere bir', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-5', repeat('f', 64), '+15559900001', '039C Owner A',
    'İlk pencere iki', pg_catalog.now()
  );
  perform result from public.ingest_whatsapp_text_message(
    '939900001', 'wamid.039C-F11-6', repeat('0', 64), '+15559900001', '039C Owner A',
    'İkinci pencere', pg_catalog.now()
  );
  update public.webhook_events set received_at = v_t0 + interval '10 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-4';
  update public.webhook_events set received_at = v_t0 + interval '12 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-5';
  update public.webhook_events set received_at = v_t0 + interval '14 seconds'
    where clinic_id = v_clinic and provider_event_id = 'wamid.039C-F11-6';

  select c.result into v_result
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-6') c;
  if v_result <> 'busy' then
    raise exception 'fixture 11: later window must wait when claimed first, got %', v_result;
  end if;

  select c.result, c.claim_token, c.message_text into v_result, v_claim_token, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-5') c;
  if v_result <> 'claimed'
    or v_message_text <> 'Mesaj 1: İlk pencere bir' || E'\n' || 'Mesaj 2: İlk pencere iki' then
    raise exception 'fixture 11: reverse order lost the earlier fixed window: % / %', v_result, v_message_text;
  end if;
  perform result from public.complete_intake_queue_job(
    v_conv, 'wamid.039C-F11-5', v_claim_token
  );
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
  values (v_clinic, v_conv, 'outbound', 'fixture 11 reverse reply', 'wamid.039C-F11-out-3', v_t0 + interval '13 seconds');

  select c.result, c.message_text into v_result, v_message_text
  from public.claim_intake_queue_job(v_conv, 'wamid.039C-F11-6') c;
  if v_result <> 'claimed' or v_message_text <> 'Mesaj 1: İkinci pencere' then
    raise exception 'fixture 11: later window did not resume after the first completed: % / %', v_result, v_message_text;
  end if;
end;
$$;

reset role;
-- Rollback-proof: nothing written by this fixture is ever committed.
rollback;
