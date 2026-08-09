-- Rollback-only proof for the durable staff work queue
-- (public.staff_work_items, vetai_private.sync_human_handoff_work_item,
-- vetai_private.sync_delivery_failure_work_item,
-- vetai_private.has_true_safety_signal).
-- Never run this fixture script against a real clinic database.
--
-- Single-session limit: this fixture proves the documented trigger/state
-- contract inside one PostgreSQL session and cannot itself prove true
-- concurrent trigger races across separate connections; that is reviewed
-- from the partial unique indexes plus ON CONFLICT semantics documented in
-- docs/staff-work-items.md instead of exercised directly here.
-- Apply-time backfill (the migration's own INSERT ... SELECT statements) is
-- covered separately by Codex's disposable-database gate, which seeds rows
-- before applying the migration; this fixture only proves post-migration
-- trigger behavior.
-- Validated on disposable vetai-test on 2026-08-09; never run against a real
-- clinic database.

begin;

-- =========================================================================
-- Fixtures: two clinics with staff, a throwaway third clinic for the clinic-
-- erasure case, and one extra WhatsApp account for the account-erasure case.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('99000000-0000-0000-0000-000000000001', 'Staff Work Test Clinic A'),
  ('99000000-0000-0000-0000-000000000002', 'Staff Work Test Clinic B'),
  ('99000000-0000-0000-0000-000000000003', 'Staff Work Test Clinic C');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('99100000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'swi-a@example.invalid', now(), now()),
  ('99100000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'swi-b@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('99000000-0000-0000-0000-000000000001', '99100000-0000-0000-0000-000000000001', 'admin'),
  ('99000000-0000-0000-0000-000000000002', '99100000-0000-0000-0000-000000000002', 'admin');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values
  ('99200000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000001', '992000001'),
  ('99200000-0000-0000-0000-000000000003', '99000000-0000-0000-0000-000000000001', '992000003');

-- Local helper: runs the already-reviewed ingest -> claim -> finalize path
-- (unchanged by this migration) to produce one real, atomically-persisted
-- pending outbox row, exactly like a live intake reply would. Lives in
-- pg_temp so it vanishes with this session/transaction. Copied from
-- supabase/tests/018_outbound_delivery.sql.
create function pg_temp.make_outbox_row(
  p_phone_number_id text,
  p_provider_message_id text,
  p_payload_hash_char text,
  p_sender_e164 text,
  p_owner_name text,
  p_reply_category text,
  p_reply_text text
) returns uuid
language plpgsql
as $$
declare
  v_conversation_id uuid;
  v_claim_result text;
  v_token uuid;
  v_finalize_result text;
  v_outbox_id uuid;
begin
  perform result from public.ingest_whatsapp_text_message(
    p_phone_number_id => p_phone_number_id,
    p_provider_message_id => p_provider_message_id,
    p_payload_hash => repeat(p_payload_hash_char, 64),
    p_sender_e164 => p_sender_e164,
    p_owner_name => p_owner_name,
    p_message_text => 'Fixture message for ' || p_provider_message_id,
    p_provider_timestamp => now()
  );

  select conversation_id into v_conversation_id
  from public.messages
  where whatsapp_message_id = p_provider_message_id;

  select result, claim_token into v_claim_result, v_token
  from public.claim_intake_queue_job(v_conversation_id, p_provider_message_id);
  if v_claim_result <> 'claimed' then
    raise exception 'make_outbox_row: expected claimed for %, got %', p_provider_message_id, v_claim_result;
  end if;

  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, p_provider_message_id, v_token, 1, 'complaint_collection', null,
    '{"note": "fixture"}'::jsonb, p_reply_category, p_reply_text
  );
  if v_finalize_result <> 'applied' then
    raise exception 'make_outbox_row: expected applied for %, got %', p_provider_message_id, v_finalize_result;
  end if;

  select id into v_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  return v_outbox_id;
end;
$$;

-- =========================================================================
-- Fixture 0: table/RLS/grant/policy shape.
-- =========================================================================
do $$
declare
  v_authenticated_privs text[];
begin
  if not (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'staff_work_items'
  ) then
    raise exception 'expected RLS enabled on staff_work_items';
  end if;

  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'staff_work_items') <> 1 then
    raise exception 'expected exactly one policy on staff_work_items';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'anon'
  ) then
    raise exception 'anon has a staff_work_items grant';
  end if;

  select array_agg(privilege_type order by privilege_type)
    into v_authenticated_privs
    from information_schema.role_table_grants
   where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'authenticated';

  if v_authenticated_privs is distinct from array['SELECT'] then
    raise exception 'expected authenticated to have exactly SELECT on staff_work_items, got %', v_authenticated_privs;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 1: a normal handoff creates one normal item; a repeated
-- handoff-stage update does not duplicate it.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000001';
  v_item record;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000001', '99000000-0000-0000-0000-000000000001', 'H1 Owner', '+15559900001')
  returning id into v_owner_id;

  insert into public.conversations (id, clinic_id, owner_id)
  values (v_conv_id, '99000000-0000-0000-0000-000000000001', v_owner_id);

  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_id;

  if (select count(*) from public.staff_work_items where conversation_id = v_conv_id) <> 1 then
    raise exception 'expected exactly one staff work item after first handoff update';
  end if;

  -- Repeat the same handoff-stage update (e.g. a later message while still
  -- in handoff): must not duplicate the open item.
  update public.conversations set intake_data = '{}'::jsonb where id = v_conv_id;

  select * into v_item from public.staff_work_items where conversation_id = v_conv_id;
  if not found or (select count(*) from public.staff_work_items where conversation_id = v_conv_id) <> 1 then
    raise exception 'expected a repeated handoff update to leave exactly one item';
  end if;
  if v_item.kind <> 'human_handoff' or v_item.priority <> 'normal' or v_item.reason <> 'human_handoff'
    or v_item.status <> 'open' or v_item.source_outbox_id is not null then
    raise exception 'unexpected normal handoff item shape: %', to_json(v_item);
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: any literal true persisted safety signal creates the one open
-- item as urgent/emergency_handoff, using an unrecognized signal name to
-- prove the trigger does not hardcode current signal names.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000002';
  v_item record;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000002', '99000000-0000-0000-0000-000000000001', 'H2 Owner', '+15559900002')
  returning id into v_owner_id;

  insert into public.conversations (id, clinic_id, owner_id)
  values (v_conv_id, '99000000-0000-0000-0000-000000000001', v_owner_id);

  update public.conversations
    set intake_stage = 'human_handoff',
        intake_data = '{"reported_safety_signals": {"totally_unrecognized_future_signal": true}}'::jsonb
    where id = v_conv_id;

  select * into v_item from public.staff_work_items where conversation_id = v_conv_id;
  if not found or v_item.priority <> 'urgent' or v_item.reason <> 'emergency_handoff' then
    raise exception 'expected an unrecognized true signal to still produce urgent/emergency_handoff, got %', to_json(v_item);
  end if;
  if (select count(*) from public.staff_work_items where conversation_id = v_conv_id) <> 1 then
    raise exception 'expected exactly one item for the urgent handoff conversation';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: absent or malformed (non-object) safety data does not raise
-- and creates a normal item rather than asserting safety.
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_conv_absent uuid := '99500000-0000-0000-0000-000000000003';
  v_conv_malformed uuid := '99500000-0000-0000-0000-000000000004';
  v_item record;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000003', '99000000-0000-0000-0000-000000000001', 'H3 Owner', '+15559900003')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_absent, '99000000-0000-0000-0000-000000000001', v_owner_id);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_absent;

  select * into v_item from public.staff_work_items where conversation_id = v_conv_absent;
  if not found or v_item.priority <> 'normal' or v_item.reason <> 'human_handoff' then
    raise exception 'expected absent safety data to produce a normal item, got %', to_json(v_item);
  end if;

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000004', '99000000-0000-0000-0000-000000000001', 'H4 Owner', '+15559900004')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_malformed, '99000000-0000-0000-0000-000000000001', v_owner_id);
  update public.conversations
    set intake_stage = 'human_handoff',
        intake_data = '{"reported_safety_signals": "not-an-object"}'::jsonb
    where id = v_conv_malformed;

  select * into v_item from public.staff_work_items where conversation_id = v_conv_malformed;
  if not found or v_item.priority <> 'normal' or v_item.reason <> 'human_handoff' then
    raise exception 'expected malformed non-object safety data to produce a normal item without raising, got %', to_json(v_item);
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: a later update with a true safety signal upgrades the existing
-- open normal item in place (no duplicate row).
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000005';
  v_first_id uuid;
  v_item record;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000005', '99000000-0000-0000-0000-000000000001', 'H5 Owner', '+15559900005')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_id, '99000000-0000-0000-0000-000000000001', v_owner_id);

  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_id;

  select id into v_first_id from public.staff_work_items where conversation_id = v_conv_id;

  update public.conversations
    set intake_data = '{"reported_safety_signals": {"sig": true}}'::jsonb
    where id = v_conv_id;

  select * into v_item from public.staff_work_items where conversation_id = v_conv_id;
  if (select count(*) from public.staff_work_items where conversation_id = v_conv_id) <> 1 then
    raise exception 'expected the upgrade to update the existing row, not add a second one';
  end if;
  if v_item.id <> v_first_id then
    raise exception 'expected the same item id to be upgraded in place';
  end if;
  if v_item.priority <> 'urgent' or v_item.reason <> 'emergency_handoff' then
    raise exception 'expected the item to be upgraded to urgent/emergency_handoff, got %', to_json(v_item);
  end if;
end;
$$;

-- =========================================================================
-- Fixture 5: after a simulated resolution, a later handoff update may open
-- one new item (distinct id from the resolved one).
-- =========================================================================
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000006';
  v_resolved_id uuid;
  v_reopened_id uuid;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000006', '99000000-0000-0000-0000-000000000001', 'H6 Owner', '+15559900006')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_id, '99000000-0000-0000-0000-000000000001', v_owner_id);

  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_id;
  select id into v_resolved_id from public.staff_work_items where conversation_id = v_conv_id;

  -- Simulate a future staff-resolution workflow this task does not build.
  update public.staff_work_items set status = 'resolved', resolved_at = now() where id = v_resolved_id;

  update public.conversations set intake_data = '{"note": "later message"}'::jsonb where id = v_conv_id;

  if (select count(*) from public.staff_work_items where conversation_id = v_conv_id) <> 2 then
    raise exception 'expected a resolved item plus one newly reopened item';
  end if;

  select id into v_reopened_id from public.staff_work_items
  where conversation_id = v_conv_id and status = 'open';
  if v_reopened_id is null or v_reopened_id = v_resolved_id then
    raise exception 'expected a distinct new open item after resolution';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 6: exhausted-send and provider-failure transitions each create the
-- exact failure reason once; unrelated transitions create nothing.
-- =========================================================================
do $$
declare
  v_outbox_exhausted uuid;
  v_outbox_provider uuid;
  v_outbox_unrelated uuid;
  v_item record;
begin
  v_outbox_exhausted := pg_temp.make_outbox_row(
    '992000001', 'wamid.SWI-D1', 'a', '+15559910001', 'D1 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'processing',
        delivery_claim_token = gen_random_uuid(),
        delivery_lease_until = now() + interval '5 minutes',
        delivery_attempt_count = 3,
        next_attempt_at = null
    where id = v_outbox_exhausted;
  update public.outbound_message_outbox
    set delivery_status = 'failed',
        delivery_claim_token = null,
        delivery_lease_until = null,
        failed_at = now(),
        failure_reason = 'attempts_exhausted'
    where id = v_outbox_exhausted;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_exhausted;
  if not found or v_item.kind <> 'delivery_failure' or v_item.reason <> 'send_attempts_exhausted'
    or v_item.priority <> 'normal' or v_item.status <> 'open' then
    raise exception 'expected one open normal send_attempts_exhausted item, got %', to_json(v_item);
  end if;
  if (select count(*) from public.staff_work_items where source_outbox_id = v_outbox_exhausted) <> 1 then
    raise exception 'expected exactly one item for the exhausted-send row';
  end if;

  v_outbox_provider := pg_temp.make_outbox_row(
    '992000001', 'wamid.SWI-D2', 'b', '+15559910002', 'D2 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'accepted',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        provider_message_id = 'wamid.SWI-D2-PROVIDER',
        accepted_at = now(),
        delivery_attempt_count = 1
    where id = v_outbox_provider;
  update public.outbound_message_outbox
    set provider_delivery_status = 'failed', provider_status_at = now()
    where id = v_outbox_provider;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_provider;
  if not found or v_item.reason <> 'provider_failed' or v_item.priority <> 'normal' or v_item.status <> 'open' then
    raise exception 'expected one open normal provider_failed item, got %', to_json(v_item);
  end if;

  -- Unrelated transitions (accepted with no provider status yet, then a
  -- non-failed provider status) must create nothing.
  v_outbox_unrelated := pg_temp.make_outbox_row(
    '992000001', 'wamid.SWI-D3', 'c', '+15559910003', 'D3 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'accepted',
        next_attempt_at = null,
        provider_message_id = 'wamid.SWI-D3-PROVIDER',
        accepted_at = now(),
        delivery_attempt_count = 1
    where id = v_outbox_unrelated;
  update public.outbound_message_outbox
    set provider_delivery_status = 'sent', provider_status_at = now()
    where id = v_outbox_unrelated;
  update public.outbound_message_outbox
    set provider_delivery_status = 'delivered', provider_status_at = now()
    where id = v_outbox_unrelated;

  if exists (select 1 from public.staff_work_items where source_outbox_id = v_outbox_unrelated) then
    raise exception 'expected no staff work item for a sent/delivered outbox row';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 7: a delivered/read callback resolves an open provider_failed
-- item, while an unrelated exhausted-send item remains open.
-- =========================================================================
do $$
declare
  v_provider_item_id uuid;
  v_outbox_provider uuid;
begin
  select source_outbox_id into v_outbox_provider
  from public.staff_work_items
  where reason = 'provider_failed' and status = 'open'
  order by created_at desc limit 1;

  select id into v_provider_item_id from public.staff_work_items where source_outbox_id = v_outbox_provider;

  update public.outbound_message_outbox
    set provider_delivery_status = 'delivered', provider_status_at = now()
    where id = v_outbox_provider;

  if (select status from public.staff_work_items where id = v_provider_item_id) <> 'resolved' then
    raise exception 'expected the provider_failed item to be resolved after a delivered callback';
  end if;
  if (select resolved_at from public.staff_work_items where id = v_provider_item_id) is null then
    raise exception 'expected resolved_at to be set';
  end if;

  if (select count(*) from public.staff_work_items where reason = 'send_attempts_exhausted' and status = 'open') <> 1 then
    raise exception 'expected the unrelated exhausted-send item to remain open';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 8: named state checks and composite tenant FKs reject invalid or
-- cross-tenant rows with zero partial mutation.
-- =========================================================================
do $$
declare
  v_before integer;
  v_after integer;
  v_owner_b uuid;
  v_conv_b uuid := '99500000-0000-0000-0000-000000000008';
  v_some_conv_a uuid := '99500000-0000-0000-0000-000000000001';
  v_some_outbox_a uuid;
begin
  select count(*) into v_before from public.staff_work_items;

  select source_outbox_id into v_some_outbox_a from public.staff_work_items where reason = 'send_attempts_exhausted' limit 1;

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000008', '99000000-0000-0000-0000-000000000002', 'B1 Owner', '+15559900008')
  returning id into v_owner_b;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_b, '99000000-0000-0000-0000-000000000002', v_owner_b);

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values ('99000000-0000-0000-0000-000000000001', v_some_conv_a, 'human_handoff', 'normal', 'human_handoff', v_some_outbox_a, 'open');
    raise exception 'expected human_handoff with a non-null source_outbox_id to violate the kind/reason check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
    values ('99000000-0000-0000-0000-000000000001', v_some_conv_a, 'human_handoff', 'urgent', 'human_handoff', 'open');
    raise exception 'expected reason=human_handoff with priority=urgent to violate the priority check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, resolved_at)
    values ('99000000-0000-0000-0000-000000000001', v_some_conv_a, 'human_handoff', 'normal', 'human_handoff', 'open', now());
    raise exception 'expected status=open with a non-null resolved_at to violate the resolved-state check';
  exception when check_violation then null;
  end;

  begin
    -- Clinic A row naming a Clinic B conversation.
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
    values ('99000000-0000-0000-0000-000000000001', v_conv_b, 'human_handoff', 'normal', 'human_handoff', 'open');
    raise exception 'expected a cross-tenant conversation reference to violate the composite FK';
  exception when foreign_key_violation then null;
  end;

  begin
    -- Clinic B row naming a Clinic A outbox row.
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status)
    values ('99000000-0000-0000-0000-000000000002', v_conv_b, 'delivery_failure', 'normal', 'send_attempts_exhausted', v_some_outbox_a, 'open');
    raise exception 'expected a cross-tenant outbox reference to violate the composite FK';
  exception when foreign_key_violation then null;
  end;

  select count(*) into v_after from public.staff_work_items;
  if v_after <> v_before then
    raise exception 'expected zero partial mutation from rejected inserts, before % after %', v_before, v_after;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 9: RLS — same-clinic staff see only their own clinic's rows;
-- another clinic's staff, an authenticated caller with no resolvable
-- identity, and anon see none of clinic A's rows.
-- =========================================================================
do $$
declare
  v_owner_b uuid;
  v_conv_b uuid := '99500000-0000-0000-0000-000000000009';
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000009', '99000000-0000-0000-0000-000000000002', 'B2 Owner', '+15559900009')
  returning id into v_owner_b;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_b, '99000000-0000-0000-0000-000000000002', v_owner_b);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_b;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99100000-0000-0000-0000-000000000001', true);

do $$
begin
  if (select count(*) from public.staff_work_items where clinic_id = '99000000-0000-0000-0000-000000000001') = 0 then
    raise exception 'expected clinic A staff to see clinic A rows';
  end if;
  if (select count(*) from public.staff_work_items where clinic_id = '99000000-0000-0000-0000-000000000002') <> 0 then
    raise exception 'expected clinic A staff to see zero clinic B rows';
  end if;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
    values ('99000000-0000-0000-0000-000000000001', '99500000-0000-0000-0000-000000000001', 'human_handoff', 'normal', 'human_handoff', 'open');
    raise exception 'expected authenticated insert on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    update public.staff_work_items set status = 'resolved', resolved_at = now()
      where conversation_id = '99500000-0000-0000-0000-000000000001';
    raise exception 'expected authenticated update on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    delete from public.staff_work_items where conversation_id = '99500000-0000-0000-0000-000000000001';
    raise exception 'expected authenticated delete on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    perform vetai_private.sync_human_handoff_work_item();
    raise exception 'expected direct execution of the human-handoff trigger function to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    perform vetai_private.sync_delivery_failure_work_item();
    raise exception 'expected direct execution of the delivery-failure trigger function to be denied';
  exception when insufficient_privilege then null;
  end;

  begin
    perform vetai_private.has_true_safety_signal('{}'::jsonb);
    raise exception 'expected direct execution of the safety-signal helper to be denied';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99100000-0000-0000-0000-000000000002', true);
do $$
begin
  if (select count(*) from public.staff_work_items where clinic_id = '99000000-0000-0000-0000-000000000001') <> 0 then
    raise exception 'expected clinic B staff to see zero clinic A rows';
  end if;
  if (select count(*) from public.staff_work_items where clinic_id = '99000000-0000-0000-0000-000000000002') = 0 then
    raise exception 'expected clinic B staff to see clinic B rows';
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  if (select count(*) from public.staff_work_items) <> 0 then
    raise exception 'expected an authenticated caller with no resolvable identity to see zero rows';
  end if;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform 1 from public.staff_work_items limit 1;
    raise exception 'expected anon to be denied staff_work_items table access';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 10: erasure cascades leave no dangling staff items.
-- =========================================================================

-- (a) owner/conversation erasure.
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000010';
  v_item_id uuid;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000010', '99000000-0000-0000-0000-000000000001', 'Erase Owner', '+15559900010')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_id, '99000000-0000-0000-0000-000000000001', v_owner_id);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_id;

  select id into v_item_id from public.staff_work_items where conversation_id = v_conv_id;
  if v_item_id is null then
    raise exception 'expected a staff work item to exist before the owner erasure test';
  end if;

  delete from public.owners where id = v_owner_id;

  if exists (select 1 from public.staff_work_items where id = v_item_id) then
    raise exception 'expected owner erasure to cascade through conversations to the staff work item';
  end if;
end;
$$;

-- (b) account/outbox erasure (independent of conversation deletion).
do $$
declare
  v_outbox_id uuid;
  v_item_id uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '992000003', 'wamid.SWI-D4', 'd', '+15559910004', 'D4 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'processing', delivery_claim_token = gen_random_uuid(),
        delivery_lease_until = now() + interval '5 minutes', delivery_attempt_count = 3, next_attempt_at = null
    where id = v_outbox_id;
  update public.outbound_message_outbox
    set delivery_status = 'failed', delivery_claim_token = null, delivery_lease_until = null,
        failed_at = now(), failure_reason = 'attempts_exhausted'
    where id = v_outbox_id;

  select id into v_item_id from public.staff_work_items where source_outbox_id = v_outbox_id;
  if v_item_id is null then
    raise exception 'expected a staff work item to exist before the account erasure test';
  end if;

  -- Isolate the account -> outbox -> work-item cascade. The pre-existing
  -- webhook-event account FK is intentionally NO ACTION, so a standalone
  -- account delete is blocked while an event still carries that link.
  update public.webhook_events
    set whatsapp_account_id = null
    where clinic_id = '99000000-0000-0000-0000-000000000001'
      and provider_event_id = 'wamid.SWI-D4';

  delete from public.whatsapp_accounts where id = '99200000-0000-0000-0000-000000000003';

  if exists (select 1 from public.staff_work_items where id = v_item_id) then
    raise exception 'expected account erasure to cascade through the outbox row to the staff work item';
  end if;
  if exists (select 1 from public.conversations where id = (select conversation_id from public.messages where whatsapp_message_id = 'wamid.SWI-D4')) then
    null; -- the conversation itself is unaffected by account erasure; not asserted further here.
  end if;
end;
$$;

-- (c) clinic erasure.
do $$
declare
  v_owner_id uuid;
  v_conv_id uuid := '99500000-0000-0000-0000-000000000011';
  v_item_id uuid;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values ('99300000-0000-0000-0000-000000000011', '99000000-0000-0000-0000-000000000003', 'C1 Owner', '+15559900011')
  returning id into v_owner_id;
  insert into public.conversations (id, clinic_id, owner_id) values (v_conv_id, '99000000-0000-0000-0000-000000000003', v_owner_id);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = v_conv_id;

  select id into v_item_id from public.staff_work_items where conversation_id = v_conv_id;
  if v_item_id is null then
    raise exception 'expected a staff work item to exist before the clinic erasure test';
  end if;

  delete from public.clinics where id = '99000000-0000-0000-0000-000000000003';

  if exists (select 1 from public.staff_work_items where id = v_item_id) then
    raise exception 'expected clinic erasure to cascade to the staff work item';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000002',
    '99000000-0000-0000-0000-000000000003'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '99100000-0000-0000-0000-000000000001',
    '99100000-0000-0000-0000-000000000002'
  )) as remaining_test_users,
  (select count(*) from public.staff_work_items where clinic_id in (
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000002',
    '99000000-0000-0000-0000-000000000003'
  )) as remaining_test_items,
  (select count(*) from public.outbound_message_outbox where clinic_id in (
    '99000000-0000-0000-0000-000000000001',
    '99000000-0000-0000-0000-000000000002',
    '99000000-0000-0000-0000-000000000003'
  )) as remaining_test_outbox_rows;
