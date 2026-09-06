-- Task 053 Phase B: rollback-only proof for the operational alerting
-- repository objects (staff_work_items.provenance, clinic/platform alert
-- recipients, alert_deliveries, sync_alert_delivery_candidates,
-- record_platform_signal, claim/accept/release_alert_delivery,
-- alert_monitor_heartbeat). Sonnet does NOT run this file against any
-- database; Codex alone applies the paired migration and this fixture on
-- disposable vetai-test, with zero residue, before any staging activation.
-- Never run this fixture script against a real clinic database.
-- See docs/operational-alerting.md, docs/database-schema.md,
-- docs/staff-work-items.md, docs/inbound-queue.md.
--
-- Single-session limit: like 020/047/049, this proves claim/lease/dedup
-- logic within one session and cannot itself exercise true cross-session
-- SKIP LOCKED contention; that is reviewed from claim_alert_delivery's
-- `for update skip locked` clause instead of exercised directly here. To
-- keep claim_alert_delivery's row selection deterministic in a single
-- session, every claim/accept/release scenario below first drains the
-- table to empty, then inserts exactly the row(s) that scenario needs.

begin;

-- =========================================================================
-- 0. Fixture: two clinics, staff, a WhatsApp account, and platform admins.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('53000000-0000-0000-1000-000000000001', 'Alerting Test Clinic A'),
  ('53000000-0000-0000-1000-000000000002', 'Alerting Test Clinic B');

-- Task 041: clinics default to suspended; activate this fixture's clinics.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('53000000-0000-0000-2000-000000000001', 'authenticated', 'authenticated', 'alerts-053-a@example.invalid', now(), now()),
  ('53000000-0000-0000-2000-000000000002', 'authenticated', 'authenticated', 'alerts-053-b@example.invalid', now(), now()),
  ('53000000-0000-0000-2000-000000000003', 'authenticated', 'authenticated', 'alerts-053-admin1@example.invalid', now(), now()),
  ('53000000-0000-0000-2000-000000000004', 'authenticated', 'authenticated', 'alerts-053-admin2@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'admin'),
  ('53000000-0000-0000-1000-000000000002', '53000000-0000-0000-2000-000000000002', 'admin');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('53000000-0000-0000-3000-000000000001', '53000000-0000-0000-1000-000000000001', '953000001');

-- Strict allowlist: the account default is permanently personal, so the
-- one contact used by the real ingest -> claim -> finalize proof needs an
-- explicit AI route. Without it ingest correctly returns a non-AI outcome and
-- never creates the conversation that section 5 claims.
insert into public.whatsapp_contact_routes (whatsapp_account_id, clinic_id, contact_e164, mode)
values ('53000000-0000-0000-3000-000000000001', '53000000-0000-0000-1000-000000000001', '+15553000010', 'ai');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.set_platform_admin_v1('53000000-0000-0000-2000-000000000003', true);
  if v_result <> 'enabled' then raise exception 'expected admin1 enabled, got %', v_result; end if;
  select result into v_result from public.set_platform_admin_v1('53000000-0000-0000-2000-000000000004', true);
  if v_result <> 'enabled' then raise exception 'expected admin2 enabled, got %', v_result; end if;
end;
$$;
reset role;

-- Enabled recipients that section 6's fanout math depends on (1 clinic-A, 1
-- clinic-B, 2 platform). Also exercises set_clinic_alert_recipient/
-- set_platform_alert_recipient's actor_user_id/reason audit trail from their
-- very first call (Task 053 Codex review item 8).
set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.set_clinic_alert_recipient(
    '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'alerts-a@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'fixture seed'
  );
  if v_result <> 'set' then raise exception 'expected set for clinic A recipient seed, got %', v_result; end if;

  select result into v_result from public.set_clinic_alert_recipient(
    '53000000-0000-0000-1000-000000000002', '53000000-0000-0000-2000-000000000002', 'alerts-b@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'fixture seed'
  );
  if v_result <> 'set' then raise exception 'expected set for clinic B recipient seed, got %', v_result; end if;

  select result into v_result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000003', 'alerts-053-admin1@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'fixture seed'
  );
  if v_result <> 'set' then raise exception 'expected set for platform admin1 seed, got %', v_result; end if;

  select result into v_result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000004', 'alerts-053-admin2@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'fixture seed'
  );
  if v_result <> 'set' then raise exception 'expected set for platform admin2 seed, got %', v_result; end if;

  if (select count(*) from public.alert_recipient_audit where action = 'created') <> 4 then
    raise exception 'expected 4 created audit rows from the recipient seed calls, got %',
      (select count(*) from public.alert_recipient_audit where action = 'created');
  end if;
  if exists (
    select 1 from public.alert_recipient_audit
    where actor_user_id <> '53000000-0000-0000-2000-000000000003' or reason <> 'fixture seed'
  ) then
    raise exception 'expected every seed audit row to carry the seeding actor and reason';
  end if;
  if exists (
    select 1 from public.alert_recipient_audit
    where (recipient_scope = 'clinic' and clinic_id is null)
       or (recipient_scope = 'platform' and clinic_id is not null)
  ) then
    raise exception 'alert_recipient_audit scope/clinic_id must stay coherent';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- 1. Shape: RLS enabled + zero policies on all four new tables; anon/
-- authenticated denied direct access, service_role holds the documented
-- privilege level (all on the recipient/delivery tables, select+update only
-- on the heartbeat singleton).
-- =========================================================================

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'clinic_alert_recipients', 'platform_alert_recipients', 'alert_deliveries', 'alert_monitor_heartbeat'
  ] loop
    if not (
      select cl.relrowsecurity from pg_catalog.pg_class cl
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = v_table
    ) then
      raise exception '% must have RLS enabled', v_table;
    end if;
    if exists (
      select 1 from pg_catalog.pg_policy p
      join pg_catalog.pg_class cl on cl.oid = p.polrelid
      join pg_catalog.pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = v_table
    ) then
      raise exception '% must have zero RLS policies', v_table;
    end if;
    if exists (
      select 1 from information_schema.role_table_grants g
      where g.table_schema = 'public' and g.table_name = v_table and g.grantee in ('anon', 'authenticated', 'PUBLIC')
    ) then
      raise exception '% must not be directly grantable to anon/authenticated/PUBLIC', v_table;
    end if;
  end loop;

  if not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'alert_monitor_heartbeat' and grantee = 'service_role' and privilege_type = 'SELECT'
  ) or not exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'alert_monitor_heartbeat' and grantee = 'service_role' and privilege_type = 'UPDATE'
  ) then
    raise exception 'alert_monitor_heartbeat must grant service_role select+update';
  end if;
end;
$$;

-- Every new/changed RPC is executable only by service_role.
do $$
declare
  v_name text;
begin
  foreach v_name in array array[
    'set_clinic_alert_recipient', 'set_platform_alert_recipient', 'sync_alert_delivery_candidates',
    'record_platform_signal', 'claim_alert_delivery', 'accept_alert_delivery', 'release_alert_delivery',
    'record_alert_monitor_heartbeat', 'is_alert_monitor_heartbeat_fresh'
  ] loop
    if exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = v_name and grantee in ('PUBLIC', 'anon', 'authenticated')
    ) then
      raise exception '% must not be executable by PUBLIC/anon/authenticated', v_name;
    end if;
    if not exists (
      select 1 from information_schema.role_routine_grants
      where routine_schema = 'public' and routine_name = v_name and grantee = 'service_role'
    ) then
      raise exception '% must be executable by service_role', v_name;
    end if;
  end loop;
end;
$$;

-- A single-session fixture cannot hold the competing transaction open, but
-- it can pin the lock mode whose conflict semantics close both resolution
-- paths. The behavior after a completed resolve is exercised again in §9b.
do $$
begin
  if pg_catalog.pg_get_functiondef('public.claim_alert_delivery()'::regprocedure) not ilike '%for no key update%' then
    raise exception 'claim_alert_delivery must lock the work item FOR NO KEY UPDATE';
  end if;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform * from public.sync_alert_delivery_candidates();
    raise exception 'authenticated unexpectedly executed sync_alert_delivery_candidates';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform * from public.claim_alert_delivery();
    raise exception 'anon unexpectedly executed claim_alert_delivery';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- 2. staff_work_items.provenance: default/allowed values and the
-- cross-column check tying intake_dead_letter provenance to human_handoff.
-- =========================================================================

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('53000000-0000-0000-4000-000000000001', '53000000-0000-0000-1000-000000000001', 'Alert Owner Urgent', '+15553000001'),
  ('53000000-0000-0000-4000-000000000002', '53000000-0000-0000-1000-000000000001', 'Alert Owner Normal', '+15553000002'),
  ('53000000-0000-0000-4000-000000000003', '53000000-0000-0000-1000-000000000001', 'Alert Owner DL Empty', '+15553000003'),
  ('53000000-0000-0000-4000-000000000004', '53000000-0000-0000-1000-000000000001', 'Alert Owner DL Seeded', '+15553000004'),
  ('53000000-0000-0000-4000-000000000005', '53000000-0000-0000-1000-000000000002', 'Alert Owner Clinic B', '+15553000005');

insert into public.conversations (id, clinic_id, owner_id, status)
values
  ('53000000-0000-0000-5000-000000000001', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-4000-000000000001', 'active'),
  ('53000000-0000-0000-5000-000000000002', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-4000-000000000002', 'active'),
  ('53000000-0000-0000-5000-000000000003', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-4000-000000000003', 'active'),
  ('53000000-0000-0000-5000-000000000004', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-4000-000000000004', 'active'),
  ('53000000-0000-0000-5000-000000000005', '53000000-0000-0000-1000-000000000002', '53000000-0000-0000-4000-000000000005', 'active');

do $$
begin
  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, provenance)
    values ('53000000-0000-0000-1000-000000000002', '53000000-0000-0000-5000-000000000005', 'human_handoff', 'normal', 'human_handoff', 'open', 'not_a_real_value');
    raise exception 'expected an invalid provenance value to be rejected';
  exception
    when check_violation then null;
  end;
end;
$$;

-- =========================================================================
-- 3. Dead-letter provenance tagging via finalize_intake_dead_letter, both
-- the empty-first-turn marker path and the existing-snapshot-preserved
-- path (Task 053 correction: the snapshot is preserved, never replaced --
-- see docs/inbound-queue.md).
-- =========================================================================

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('53000000-0000-0000-1000-000000000001', '53000000-0000-0000-5000-000000000003', 'inbound', 'first stuck message', 'wamid.053.EMPTY');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status)
values ('53000000-0000-0000-1000-000000000001', 'wamid.053.EMPTY', 'hash-053-empty', 'processed', 'pending');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.finalize_intake_dead_letter('53000000-0000-0000-5000-000000000003'::uuid, 'wamid.053.EMPTY');
  if v_result <> 'handed_off' then raise exception 'expected handed_off for the empty-turn dead letter, got %', v_result; end if;
end;
$$;
reset role;

do $$
begin
  if (select intake_data from public.conversations where id = '53000000-0000-0000-5000-000000000003') <> '{"dead_letter_handoff": true}'::jsonb then
    raise exception 'expected the empty-turn conversation to persist the fixed marker';
  end if;
  if (
    select provenance from public.staff_work_items
    where conversation_id = '53000000-0000-0000-5000-000000000003' and kind = 'human_handoff' and status = 'open'
  ) <> 'intake_dead_letter' then
    raise exception 'expected the empty-turn handoff work item tagged intake_dead_letter';
  end if;
end;
$$;

set local role service_role;
do $$
begin
  perform advanced.intake_stage from public.advance_conversation_intake(
    '53000000-0000-0000-5000-000000000004'::uuid, 1, 'complaint_collection', null, '{"note": "seed-053"}'::jsonb
  ) advanced;
end;
$$;
reset role;

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
values ('53000000-0000-0000-1000-000000000001', '53000000-0000-0000-5000-000000000004', 'inbound', 'stuck message', 'wamid.053.SEEDED');
insert into public.webhook_events (clinic_id, provider_event_id, payload_hash, processing_status, intake_status, intake_claim_token, intake_lease_until)
values ('53000000-0000-0000-1000-000000000001', 'wamid.053.SEEDED', 'hash-053-seeded', 'processed', 'processing', gen_random_uuid(), now() + interval '2 minutes');

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.finalize_intake_dead_letter('53000000-0000-0000-5000-000000000004'::uuid, 'wamid.053.SEEDED');
  if v_result <> 'handed_off' then raise exception 'expected handed_off for the seeded-snapshot dead letter, got %', v_result; end if;
end;
$$;
reset role;

do $$
declare
  v_outbox_a uuid;
  v_conversation_id uuid;
  v_clinic_id uuid;
begin
  if (select intake_data from public.conversations where id = '53000000-0000-0000-5000-000000000004') <> '{"note": "seed-053"}'::jsonb then
    raise exception 'seeded-snapshot handoff must preserve the existing intake_data, not the marker';
  end if;
  if (
    select provenance from public.staff_work_items
    where conversation_id = '53000000-0000-0000-5000-000000000004' and kind = 'human_handoff' and status = 'open'
  ) <> 'intake_dead_letter' then
    raise exception 'expected the seeded-snapshot handoff work item tagged intake_dead_letter too';
  end if;

  select conversation_id, clinic_id into v_conversation_id, v_clinic_id
  from public.staff_work_items
  where conversation_id = '53000000-0000-0000-5000-000000000004' and kind = 'human_handoff';

  -- Cross-column check: intake_dead_letter provenance can never attach to a
  -- delivery_failure item, even a resolved one.
  begin
    insert into public.staff_work_items
      (clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status, resolved_at, provenance)
    values (v_clinic_id, v_conversation_id, 'delivery_failure', 'normal', 'send_attempts_exhausted', gen_random_uuid(), 'resolved', now(), 'intake_dead_letter');
    raise exception 'expected intake_dead_letter provenance on a delivery_failure item to be rejected';
  exception
    when check_violation then null;
  end;
end;
$$;

-- =========================================================================
-- 4. Ordinary (workflow-provenance) human_handoff items: urgent from a true
-- safety signal, normal otherwise -- provenance stays 'workflow', never
-- touched by finalize_intake_dead_letter.
-- =========================================================================

set local role service_role;
do $$
begin
  perform advanced.intake_stage from public.advance_conversation_intake(
    '53000000-0000-0000-5000-000000000001'::uuid, 1, 'human_handoff', null,
    '{"reported_safety_signals": {"seizure": true}}'::jsonb
  ) advanced;
  perform advanced.intake_stage from public.advance_conversation_intake(
    '53000000-0000-0000-5000-000000000002'::uuid, 1, 'human_handoff', null, '{"note": "ordinary"}'::jsonb
  ) advanced;
  perform advanced.intake_stage from public.advance_conversation_intake(
    '53000000-0000-0000-5000-000000000005'::uuid, 1, 'human_handoff', null,
    '{"reported_safety_signals": {"seizure": true}}'::jsonb
  ) advanced;
end;
$$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.staff_work_items
    where conversation_id = '53000000-0000-0000-5000-000000000001'
      and kind = 'human_handoff' and priority = 'urgent' and provenance = 'workflow' and status = 'open'
  ) then
    raise exception 'expected an urgent workflow-provenance handoff item for the safety-signal conversation';
  end if;
  if not exists (
    select 1 from public.staff_work_items
    where conversation_id = '53000000-0000-0000-5000-000000000002'
      and kind = 'human_handoff' and priority = 'normal' and provenance = 'workflow' and status = 'open'
  ) then
    raise exception 'expected a normal workflow-provenance handoff item for the ordinary conversation';
  end if;
  if not exists (
    select 1 from public.staff_work_items
    where conversation_id = '53000000-0000-0000-5000-000000000005'
      and kind = 'human_handoff' and priority = 'urgent' and provenance = 'workflow' and status = 'open'
  ) then
    raise exception 'expected an urgent workflow-provenance handoff item for clinic B';
  end if;
end;
$$;

-- Backdate the normal item past sync_alert_delivery_candidates' 4-hour
-- open-normal-handoff threshold (branch 4).
update public.staff_work_items
  set created_at = now() - interval '5 hours'
  where conversation_id = '53000000-0000-0000-5000-000000000002' and kind = 'human_handoff';

-- =========================================================================
-- 5. A real terminal delivery_failure item, produced the same way
-- production would (ingest -> claim -> finalize -> exhausted send), not
-- hand-crafted.
-- =========================================================================

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

do $$
declare
  v_outbox_id uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '953000001', 'wamid.053.D1', 'a', '+15553000010', 'Alert Delivery Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'processing', delivery_claim_token = gen_random_uuid(),
        delivery_lease_until = now() + interval '5 minutes', delivery_attempt_count = 3, next_attempt_at = null
    where id = v_outbox_id;
  update public.outbound_message_outbox
    set delivery_status = 'failed', delivery_claim_token = null, delivery_lease_until = null,
        failed_at = now(), failure_reason = 'attempts_exhausted'
    where id = v_outbox_id;

  if not exists (
    select 1 from public.staff_work_items
    where source_outbox_id = v_outbox_id and kind = 'delivery_failure' and provenance = 'workflow' and status = 'open'
  ) then
    raise exception 'expected an open workflow-provenance delivery_failure item';
  end if;
end;
$$;

-- =========================================================================
-- 5b. Recipient/work-item reference coherence (Task 053 Codex review item
-- 8): a hand-crafted or malformed insert must fail closed at the database,
-- before any Worker-side validation ever runs.
-- =========================================================================

set local role service_role;
do $$
declare
  v_work_item_b uuid;
begin
  select id into v_work_item_b
  from public.staff_work_items
  where conversation_id = '53000000-0000-0000-5000-000000000005' and kind = 'human_handoff' and status = 'open';
  if v_work_item_b is null then
    raise exception 'expected clinic B''s urgent handoff work item to still be open';
  end if;

  -- Platform scope with a non-null clinic_id must violate the scope check.
  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, dedup_key)
    values ('webhook_401', 'platform', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000003', 'fixture:053:fk:platform-clinic-id');
    raise exception 'expected a platform-scope row with a non-null clinic_id to be rejected';
  exception
    when check_violation then null;
  end;

  -- Clinic scope referencing a recipient never enrolled at that clinic must
  -- violate the clinic-recipient FK.
  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, dedup_key)
    values ('webhook_401', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000004', 'fixture:053:fk:unknown-clinic-recipient');
    raise exception 'expected a clinic-scope row for a non-recipient user to be rejected';
  exception
    when foreign_key_violation then null;
  end;

  -- Platform scope referencing a user never enrolled as a platform recipient
  -- must violate the platform-recipient FK (via platform_recipient_ref).
  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, recipient_user_id, dedup_key)
    values ('webhook_401', 'platform', '53000000-0000-0000-2000-000000000001', 'fixture:053:fk:unknown-platform-recipient');
    raise exception 'expected a platform-scope row for a non-admin user to be rejected';
  exception
    when foreign_key_violation then null;
  end;

  -- A work item's real clinic must match a clinic-scope row's clinic_id --
  -- clinic B's work item under clinic A's clinic_id must violate the
  -- composite work-item/clinic FK.
  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
    values ('webhook_401', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', v_work_item_b, 'fixture:053:fk:cross-tenant-work-item');
    raise exception 'expected a cross-tenant work_item_id/clinic_id pairing to be rejected';
  exception
    when foreign_key_violation then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- 6. sync_alert_delivery_candidates: the four mutually exclusive routing
-- branches, per-branch recipient fanout (clinic+platform vs. clinic-only),
-- idempotent re-sync (dedup_key uniqueness, no duplicate first notice), and
-- tenant isolation.
--
-- Expected fanout with 1 enabled clinic-A recipient, 1 enabled clinic-B
-- recipient, and 2 enabled platform recipients:
--   branch 1 (delivery_failure, clinic A):        1 clinic + 2 platform = 3
--   branch 2 (intake_dead_letter, clinic A) x2:    2 clinic + 4 platform = 6
--   branch 3 (urgent workflow, clinic-only) x2:    1 (A) + 1 (B)         = 2
--   branch 4 (normal workflow 4h+, clinic-only):   1 (A)                 = 1
--   total = 12 (6 platform-scope, 6 clinic-scope; 5 of the clinic rows at A)
-- =========================================================================

set local role service_role;
do $$
declare
  v_inserted integer;
begin
  select inserted_count into v_inserted from public.sync_alert_delivery_candidates();
  if v_inserted <> 12 then
    raise exception 'expected 12 candidate deliveries inserted on first sync, got %', v_inserted;
  end if;

  select inserted_count into v_inserted from public.sync_alert_delivery_candidates();
  if v_inserted <> 0 then
    raise exception 'expected a repeat sync to insert nothing (dedup_key uniqueness), got %', v_inserted;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.alert_deliveries where recipient_scope = 'platform') <> 6 then
    raise exception 'expected 6 platform-scope deliveries (delivery_failure + 2 dead-letter items x 2 admins), got %',
      (select count(*) from public.alert_deliveries where recipient_scope = 'platform');
  end if;
  if (select count(*) from public.alert_deliveries where recipient_scope = 'clinic' and clinic_id = '53000000-0000-0000-1000-000000000001') <> 5 then
    raise exception 'expected 5 clinic A deliveries (delivery_failure + 2 dead-letter + urgent + backdated-normal), got %',
      (select count(*) from public.alert_deliveries where recipient_scope = 'clinic' and clinic_id = '53000000-0000-0000-1000-000000000001');
  end if;
  if (select count(*) from public.alert_deliveries where recipient_scope = 'clinic' and clinic_id = '53000000-0000-0000-1000-000000000002') <> 1 then
    raise exception 'expected exactly 1 clinic B delivery (its own urgent handoff only), got %',
      (select count(*) from public.alert_deliveries where recipient_scope = 'clinic' and clinic_id = '53000000-0000-0000-1000-000000000002');
  end if;
  if exists (
    select 1 from public.alert_deliveries
    where recipient_scope = 'clinic' and recipient_user_id = '53000000-0000-0000-2000-000000000002'
      and clinic_id <> '53000000-0000-0000-1000-000000000002'
  ) then
    raise exception 'clinic B recipient must never receive a clinic A delivery row';
  end if;
  -- Task 053 Codex review item 8: platform-scope rows must never carry a
  -- clinic_id, even though the fanout CTE they came from also produced
  -- clinic-scope siblings for the same work item.
  if exists (select 1 from public.alert_deliveries where recipient_scope = 'platform' and clinic_id is not null) then
    raise exception 'platform-scope deliveries must always have clinic_id null';
  end if;
end;
$$;

-- =========================================================================
-- 7. Drain every row produced above so the claim/accept/release scenarios
-- below run against a known-empty queue (see the single-session note at the
-- top of this file for why).
-- =========================================================================

set local role service_role;
do $$
declare
  v_row record;
  v_result text;
  v_drained integer := 0;
begin
  loop
    select * into v_row from public.claim_alert_delivery();
    exit when not found;
    select result into v_result from public.accept_alert_delivery(v_row.id, v_row.claim_token);
    if v_result <> 'accepted' then
      raise exception 'drain: expected accepted, got %', v_result;
    end if;
    v_drained := v_drained + 1;
  end loop;
  if v_drained <> 12 then
    raise exception 'expected to drain exactly the 12 rows sync just produced, got %', v_drained;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- 8. claim/accept/release lifecycle: a recipient disabled before its first
-- claim is skipped entirely; retry-to-exhaustion over three claims;
-- stale-claim/not_found/already_accepted/already_terminal replay shapes.
-- Each scenario below is the only pending row when it runs, so
-- claim_alert_delivery's selection is deterministic.
-- =========================================================================

insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, dedup_key)
values ('53000000-0000-0000-6000-000000000001', 'delivery_failure', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'fixture:053:claim-lifecycle:x');

set local role service_role;
do $$
declare
  v_id constant uuid := '53000000-0000-0000-6000-000000000001';
  v_row record;
  v_result text;
  v_token uuid;
begin
  -- Disable the clinic recipient before it is ever claimed: claim must skip it.
  perform result from public.set_clinic_alert_recipient(
    '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'alerts-a@example.invalid', false,
    '53000000-0000-0000-2000-000000000003', 'temporarily muting clinic A recipient'
  );
  if exists (select 1 from public.claim_alert_delivery() where id = v_id) then
    raise exception 'a disabled recipient''s pending row must never be claimable';
  end if;

  -- Re-enable: now claimable.
  perform result from public.set_clinic_alert_recipient(
    '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'alerts-a@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 're-enabling clinic A recipient'
  );
  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or v_row.recipient_email <> 'alerts-a@example.invalid' or v_row.occurrence_count <> 1 then
    raise exception 'expected to claim the fixture row with the current recipient email, got %', to_json(v_row);
  end if;
  v_token := v_row.claim_token;
  if (select delivery_status from public.alert_deliveries where id = v_id) <> 'claimed'
    or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 1 then
    raise exception 'expected first claim to consume attempt 1';
  end if;

  -- Stale/wrong claim token is rejected without mutating state.
  select result into v_result from public.release_alert_delivery(v_id, gen_random_uuid(), 'send_failed');
  if v_result <> 'stale_claim' then raise exception 'expected stale_claim for a wrong token, got %', v_result; end if;

  -- Arbitrary/provider text is never accepted as a persisted failure reason.
  begin
    perform result from public.release_alert_delivery(v_id, v_token, 'provider raw response');
    raise exception 'expected a non-vocabulary failure reason to be rejected';
  exception
    when raise_exception then
      if sqlerrm not like 'release_alert_delivery: invalid arguments%' then raise; end if;
  end;
  if (select delivery_status from public.alert_deliveries where id = v_id) <> 'claimed'
    or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 1 then
    raise exception 'invalid failure input must not mutate the claimed row';
  end if;

  -- Retry-to-exhaustion: claims 1 and 2 retry with backoff; claim 3 fails terminally on release.
  select result into v_result from public.release_alert_delivery(v_id, v_token, 'send_failed');
  if v_result <> 'retrying' then raise exception 'expected retrying on attempt 1, got %', v_result; end if;
  if (select delivery_status from public.alert_deliveries where id = v_id) <> 'pending'
    or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 1
    or (select next_attempt_at from public.alert_deliveries where id = v_id) <= now() then
    raise exception 'expected attempt 1 to reset to pending with a future next_attempt_at';
  end if;

  update public.alert_deliveries set next_attempt_at = now() - interval '1 second' where id = v_id;
  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 2 then
    raise exception 'expected the second claim to consume attempt 2';
  end if;
  v_token := v_row.claim_token;
  select result into v_result from public.release_alert_delivery(v_id, v_token, 'send_failed');
  if v_result <> 'retrying' then raise exception 'expected retrying on attempt 2, got %', v_result; end if;

  update public.alert_deliveries set next_attempt_at = now() - interval '1 second' where id = v_id;
  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 3 then
    raise exception 'expected the third claim to consume attempt 3';
  end if;
  v_token := v_row.claim_token;
  select result into v_result from public.release_alert_delivery(v_id, v_token, 'send_failed');
  if v_result <> 'exhausted' then raise exception 'expected exhausted on attempt 3, got %', v_result; end if;
  if (select delivery_status from public.alert_deliveries where id = v_id) <> 'failed'
    or (select failure_reason from public.alert_deliveries where id = v_id) <> 'send_failed'
    or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 3 then
    raise exception 'expected a coherent failed row after exhaustion';
  end if;

  -- Terminal states refuse further release/accept.
  select result into v_result from public.release_alert_delivery(v_id, v_token, 'send_failed');
  if v_result <> 'already_terminal' then raise exception 'expected already_terminal after exhaustion, got %', v_result; end if;
  select result into v_result from public.accept_alert_delivery(v_id, v_token);
  if v_result <> 'stale_claim' then raise exception 'expected stale_claim for accept after exhaustion (token cleared), got %', v_result; end if;
end;
$$;
reset role;

-- A Worker crash after send but before accept/release must also have a hard
-- ceiling. Each expired lease consumes no additional attempt; the next claim
-- advances the counter, and a third expired claim terminalizes without a
-- fourth email send.
insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, dedup_key)
values ('53000000-0000-0000-6000-000000000003', 'delivery_failure', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'fixture:053:claim-lifecycle:crash');

set local role service_role;
do $$
declare
  v_id constant uuid := '53000000-0000-0000-6000-000000000003';
  v_row record;
begin
  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 1 then
    raise exception 'expected crash scenario claim 1';
  end if;
  update public.alert_deliveries set delivery_lease_until = now() - interval '1 second' where id = v_id;

  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 2 then
    raise exception 'expected crash scenario claim 2';
  end if;
  update public.alert_deliveries set delivery_lease_until = now() - interval '1 second' where id = v_id;

  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found or (select delivery_attempt_count from public.alert_deliveries where id = v_id) <> 3 then
    raise exception 'expected crash scenario claim 3';
  end if;
  update public.alert_deliveries set delivery_lease_until = now() - interval '1 second' where id = v_id;

  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if found then raise exception 'an expired third claim must not produce a fourth send'; end if;
  if not exists (
    select 1 from public.alert_deliveries
    where id = v_id and delivery_status = 'failed' and delivery_attempt_count = 3
      and failure_reason = 'attempts_exhausted' and failed_at is not null
  ) then
    raise exception 'expected an expired third claim to close as attempts_exhausted';
  end if;
end;
$$;
reset role;

insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, dedup_key)
values ('53000000-0000-0000-6000-000000000002', 'delivery_failure', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', 'fixture:053:claim-lifecycle:y');

set local role service_role;
do $$
declare
  v_id constant uuid := '53000000-0000-0000-6000-000000000002';
  v_row record;
  v_result text;
begin
  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if not found then raise exception 'expected to claim the second fixture row'; end if;

  select result into v_result from public.accept_alert_delivery(v_id, v_row.claim_token);
  if v_result <> 'accepted' then raise exception 'expected accepted, got %', v_result; end if;

  select result into v_result from public.accept_alert_delivery(v_id, v_row.claim_token);
  if v_result <> 'already_accepted' then raise exception 'expected already_accepted on replay, got %', v_result; end if;

  select result into v_result from public.accept_alert_delivery(gen_random_uuid(), v_row.claim_token);
  if v_result <> 'not_found' then raise exception 'expected not_found for an unknown id, got %', v_result; end if;
end;
$$;
reset role;

-- =========================================================================
-- 9. record_platform_signal: hourly-bucketed dedup, occurrence_count bump
-- on repeat, one row per enabled platform recipient, disabled recipients
-- excluded from a fresh signal.
-- =========================================================================

set local role service_role;
do $$
declare
  v_result text;
begin
  select result into v_result from public.record_platform_signal('queue_backlog', 'vetai-intake');
  if v_result <> 'recorded' then raise exception 'expected recorded, got %', v_result; end if;

  if (select count(*) from public.alert_deliveries where signal_kind = 'queue_backlog') <> 2 then
    raise exception 'expected one queue_backlog delivery per enabled platform recipient (2), got %',
      (select count(*) from public.alert_deliveries where signal_kind = 'queue_backlog');
  end if;
  if exists (select 1 from public.alert_deliveries where signal_kind = 'queue_backlog' and occurrence_count <> 1) then
    raise exception 'expected occurrence_count 1 on first record';
  end if;

  -- Same signal/queue within the same hour bucket bumps occurrence_count
  -- instead of inserting a second row.
  select result into v_result from public.record_platform_signal('queue_backlog', 'vetai-intake');
  if v_result <> 'recorded' then raise exception 'expected recorded on repeat, got %', v_result; end if;
  if (select count(*) from public.alert_deliveries where signal_kind = 'queue_backlog') <> 2 then
    raise exception 'a repeat signal within the same hour must not create a second row';
  end if;
  if exists (select 1 from public.alert_deliveries where signal_kind = 'queue_backlog' and occurrence_count <> 2) then
    raise exception 'expected occurrence_count bumped to 2 on repeat';
  end if;

  -- Disable one platform recipient: a fresh signal must skip them entirely.
  perform result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000004', 'alerts-053-admin2@example.invalid', false,
    '53000000-0000-0000-2000-000000000003', 'temporarily muting admin2'
  );
  select result into v_result from public.record_platform_signal('webhook_401');
  if v_result <> 'recorded' then raise exception 'expected recorded, got %', v_result; end if;
  if (select count(*) from public.alert_deliveries where signal_kind = 'webhook_401') <> 1 then
    raise exception 'expected exactly one webhook_401 delivery once admin2 is disabled, got %',
      (select count(*) from public.alert_deliveries where signal_kind = 'webhook_401');
  end if;
  if exists (
    select 1 from public.alert_deliveries where signal_kind = 'webhook_401' and recipient_user_id = '53000000-0000-0000-2000-000000000004'
  ) then
    raise exception 'a disabled platform recipient must never receive a new signal row';
  end if;

  -- With no enabled recipient, the signal must fail closed instead of
  -- disappearing behind a false 'recorded' result.
  perform result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000003', 'alerts-053-admin1@example.invalid', false,
    '53000000-0000-0000-2000-000000000003', 'testing the no-recipient signal guard'
  );
  select result into v_result from public.record_platform_signal('webhook_5xx');
  if v_result <> 'no_recipients' then raise exception 'expected no_recipients, got %', v_result; end if;
  if exists (select 1 from public.alert_deliveries where signal_kind = 'webhook_5xx') then
    raise exception 'a no-recipient platform signal must not create a delivery row';
  end if;
  perform result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000003', 'alerts-053-admin1@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'restoring admin1 after no-recipient proof'
  );
end;
$$;
reset role;

-- Drain record_platform_signal's leftover pending rows (admin1's
-- queue_backlog/webhook_401 rows are never claimed above) so the scenarios
-- below are once again the only pending row when they run, matching
-- section 7/8's own determinism convention.
set local role service_role;
do $$
declare
  v_row record;
  v_result text;
begin
  loop
    select * into v_row from public.claim_alert_delivery();
    exit when not found;
    select result into v_result from public.accept_alert_delivery(v_row.id, v_row.claim_token);
    if v_result <> 'accepted' then
      raise exception 'drain: expected accepted, got %', v_result;
    end if;
  end loop;
end;
$$;
reset role;

-- =========================================================================
-- 9b. Claim-time tenant/unresolved recheck (Task 053 Codex review item 5):
-- a work item resolved after candidate-sync but before claim must never be
-- claimed.
--
-- Note (Task 053 Opus remediation): claim_alert_delivery now takes a
-- `for no key update` lock on the work item row and re-reads its status only
-- after acquiring it, so a resolve that lands concurrently with a claim
-- cannot race past this recheck. A single-session pgTAP script runs
-- statements sequentially and cannot itself open two overlapping
-- transactions, so it cannot exercise that true lock-holding race window --
-- this is an accepted, documented limitation of this fixture, not a gap in
-- the guarded behavior. What the test below proves is the outcome the lock
-- exists to guarantee: once a work item is resolved, no later claim can
-- ever see it as claimable, whether the resolve happened before this
-- statement runs (as here) or concurrently with it. The claim path always
-- locks alert_deliveries before staff_work_items; resolution paths lock only
-- staff_work_items and never alert_deliveries, so they add no reverse edge.
-- =========================================================================

set local role service_role;
do $$
declare
  v_work_item_b uuid;
  v_id constant uuid := '53000000-0000-0000-6000-000000000020';
  v_row record;
begin
  select id into v_work_item_b
  from public.staff_work_items
  where conversation_id = '53000000-0000-0000-5000-000000000005' and kind = 'human_handoff' and status = 'open';
  if v_work_item_b is null then
    raise exception 'expected clinic B''s urgent handoff work item to still be open for the claim-recheck test';
  end if;

  insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  values (v_id, 'human_handoff_urgent', 'clinic', '53000000-0000-0000-1000-000000000002', '53000000-0000-0000-2000-000000000002', v_work_item_b, 'fixture:053:claim-recheck');

  update public.staff_work_items set status = 'resolved', resolved_at = now() where id = v_work_item_b;

  select * into v_row from public.claim_alert_delivery() where id = v_id;
  if found then
    raise exception 'expected claim_alert_delivery to skip a row whose work item is already resolved';
  end if;
  if (select delivery_status from public.alert_deliveries where id = v_id) <> 'pending' then
    raise exception 'a skipped row must stay pending, not silently change status';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- 9c. Repeat/recovery scheduling (Task 053 Codex review item 3/6):
-- accept_alert_delivery sets next_repeat_at only for repeat-eligible signal
-- kinds while the work item is still open; schedule_alert_repeat_notifications
-- reopens only what is actually due; recovery (the work item resolving)
-- stops the chain via claim_alert_delivery's own recheck, never inferred
-- from provider acceptance.
-- =========================================================================

set local role service_role;
do $$
declare
  v_work_item_urgent uuid;
  v_id_urgent constant uuid := '53000000-0000-0000-6000-000000000010';
  v_id_repeat1 uuid;
  v_row record;
  v_result text;
  v_status text;
  v_reopened integer;
  v_repeat_count integer;
  v_next timestamptz;
  v_recovered_at timestamptz;
begin
  -- Create this repeat-series witness only after the broad candidate-sync
  -- and drain sections above. Reusing the earlier urgent work item would
  -- also see its already-accepted first notice and make the "no repeat yet"
  -- assertion ambiguous even when no repeat row had been scheduled.
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values (
    '53000000-0000-0000-4000-000000000006',
    '53000000-0000-0000-1000-000000000001',
    'Alert Repeat Owner',
    '+15553000006'
  );

  insert into public.conversations (id, clinic_id, owner_id, status)
  values (
    '53000000-0000-0000-5000-000000000006',
    '53000000-0000-0000-1000-000000000001',
    '53000000-0000-0000-4000-000000000006',
    'active'
  );

  perform advanced.intake_stage
  from public.advance_conversation_intake(
    '53000000-0000-0000-5000-000000000006'::uuid,
    1,
    'human_handoff',
    null,
    '{"reported_safety_signals": {"seizure": true}}'::jsonb
  ) advanced;

  select id into v_work_item_urgent
  from public.staff_work_items
  where conversation_id = '53000000-0000-0000-5000-000000000006' and kind = 'human_handoff' and status = 'open';
  if v_work_item_urgent is null then
    raise exception 'expected the seeded urgent handoff work item to still be open';
  end if;

  if (select next_repeat_at from public.alert_deliveries where id = '53000000-0000-0000-6000-000000000002') is not null then
    raise exception 'a non-repeat-eligible signal_kind (delivery_failure) must never get a next_repeat_at';
  end if;

  insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  values (v_id_urgent, 'human_handoff_urgent', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', v_work_item_urgent, 'fixture:053:repeat:urgent');

  -- Task 053 Codex re-review item 1: the series/dedup relationship is a
  -- real database constraint, not just something the application code
  -- happens to respect -- a second live (pending/claimed) row for the same
  -- (work_item, scope, recipient) must be physically rejected.
  begin
    insert into public.alert_deliveries (signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
    values ('human_handoff_urgent', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', v_work_item_urgent, 'fixture:053:repeat:urgent:duplicate-live');
    raise exception 'expected alert_deliveries_active_series_idx to reject a second live row for the same series';
  exception
    when unique_violation then null;
  end;

  select * into v_row from public.claim_alert_delivery() where id = v_id_urgent;
  if not found then raise exception 'expected to claim the repeat-scheduling fixture row'; end if;
  select result into v_result from public.accept_alert_delivery(v_id_urgent, v_row.claim_token);
  if v_result <> 'accepted' then raise exception 'expected accepted, got %', v_result; end if;

  select repeat_count, next_repeat_at into v_repeat_count, v_next from public.alert_deliveries where id = v_id_urgent;
  if v_repeat_count <> 0 or v_next is null or v_next <= now() or v_next > now() + interval '16 minutes' then
    raise exception 'expected a ~15 minute next_repeat_at on first accept, got repeat_count=%, next_repeat_at=%', v_repeat_count, v_next;
  end if;

  -- Not due yet: schedule_alert_repeat_notifications must insert nothing,
  -- and the original accepted row must stay completely untouched (Task 053
  -- Codex re-review item 1: a repeat is never an in-place reopen).
  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  if v_reopened <> 0 then raise exception 'expected 0 repeats scheduled before next_repeat_at elapses, got %', v_reopened; end if;
  if not exists (
    select 1 from public.alert_deliveries
    where id = v_id_urgent and delivery_status = 'accepted' and accepted_at is not null and next_repeat_at = v_next
  ) then
    raise exception 'original row must stay accepted with its next_repeat_at untouched until actually due';
  end if;
  if exists (select 1 from public.alert_deliveries where work_item_id = v_work_item_urgent and id <> v_id_urgent) then
    raise exception 'no repeat row may exist before next_repeat_at is actually due';
  end if;

  -- Due: schedule_alert_repeat_notifications inserts a brand-new row with
  -- its own fresh id and its own per-repeat dedup_key -- it never reopens
  -- or reuses v_id_urgent (Task 053 Codex re-review item 1: that new id,
  -- not v_id_urgent's, is what the Worker sends as the next Resend
  -- Idempotency-Key) -- while the original accepted row is left as
  -- immutable history.
  update public.alert_deliveries set next_repeat_at = now() - interval '1 second' where id = v_id_urgent;
  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  if v_reopened <> 1 then raise exception 'expected exactly 1 repeat scheduled once due, got %', v_reopened; end if;

  if not exists (
    select 1 from public.alert_deliveries
    where id = v_id_urgent
      and delivery_status = 'accepted'
      and accepted_at is not null
      and next_repeat_at is null
      and repeat_count = 0
  ) then
    raise exception 'the original notice must remain accepted, immutable history -- never reopened in place';
  end if;

  select id into v_id_repeat1
  from public.alert_deliveries
  where work_item_id = v_work_item_urgent and id <> v_id_urgent;
  if v_id_repeat1 is null then raise exception 'expected a new repeat row for the urgent series'; end if;
  if not exists (
    select 1 from public.alert_deliveries
    where id = v_id_repeat1
      and delivery_status = 'pending'
      and repeat_count = 1
      and occurrence_count = 2
      and next_repeat_at is null
      and accepted_at is null
      and delivery_attempt_count = 0
      and dedup_key = 'work_item:' || v_work_item_urgent::text || ':clinic:53000000-0000-0000-2000-000000000001:repeat:1'
  ) then
    raise exception 'expected a new pending repeat row with repeat_count=1 and a fresh per-repeat dedup_key';
  end if;

  -- Escalation: repeat_count=1 must produce a ~30 minute next_repeat_at on
  -- the next accept, while the work item is still open.
  select * into v_row from public.claim_alert_delivery() where id = v_id_repeat1;
  if not found then raise exception 'expected to claim the new repeat row'; end if;
  if v_row.id = v_id_urgent then
    raise exception 'the repeat claim must carry the new row''s own id as its Resend idempotency key, not the original notice''s';
  end if;
  select result into v_result from public.accept_alert_delivery(v_id_repeat1, v_row.claim_token);
  if v_result <> 'accepted' then raise exception 'expected accepted on repeat re-send, got %', v_result; end if;
  select repeat_count, next_repeat_at into v_repeat_count, v_next from public.alert_deliveries where id = v_id_repeat1;
  if v_repeat_count <> 1 or v_next is null
    or v_next <= now() + interval '25 minutes' or v_next > now() + interval '31 minutes' then
    raise exception 'expected a ~30 minute next_repeat_at on second accept (repeat_count=1), got %', v_next;
  end if;

  -- Recovery: once the work item resolves, the chain stops explicitly --
  -- recovered_at is recorded durably on the currently-accepted repeat row,
  -- never inferred from a stale next_repeat_at, and no further repeat row
  -- is ever inserted (Task 053 Codex re-review item 2).
  update public.alert_deliveries set next_repeat_at = now() - interval '1 second' where id = v_id_repeat1;
  update public.staff_work_items set status = 'resolved', resolved_at = now() where id = v_work_item_urgent;

  select reopened_count into v_reopened from public.schedule_alert_repeat_notifications();
  if v_reopened <> 0 then
    raise exception 'expected schedule_alert_repeat_notifications to insert nothing for a row whose work item just resolved, got %', v_reopened;
  end if;
  select delivery_status, next_repeat_at, recovered_at into v_status, v_next, v_recovered_at from public.alert_deliveries where id = v_id_repeat1;
  if v_status <> 'accepted' or v_next is not null or v_recovered_at is null then
    raise exception 'expected the accepted repeat row to record an explicit recovered_at and clear next_repeat_at, got status=%, next_repeat_at=%, recovered_at=%', v_status, v_next, v_recovered_at;
  end if;
  if exists (select 1 from public.alert_deliveries where work_item_id = v_work_item_urgent and id not in (v_id_urgent, v_id_repeat1)) then
    raise exception 'recovery must never insert another repeat row';
  end if;

  -- Immutability, end to end: the very first accepted notice must be
  -- unchanged by everything that has since happened to its later repeat.
  if not exists (
    select 1 from public.alert_deliveries
    where id = v_id_urgent
      and delivery_status = 'accepted'
      and accepted_at is not null
      and next_repeat_at is null
      and recovered_at is null
      and repeat_count = 0
  ) then
    raise exception 'the original accepted notice must remain untouched across the whole repeat/recovery chain';
  end if;
end;
$$;
reset role;

set local role service_role;
do $$
declare
  v_work_item_normal uuid;
  v_id_normal constant uuid := '53000000-0000-0000-6000-000000000012';
  v_row record;
  v_result text;
  v_next timestamptz;
begin
  select id into v_work_item_normal
  from public.staff_work_items
  where conversation_id = '53000000-0000-0000-5000-000000000002' and kind = 'human_handoff' and status = 'open';
  if v_work_item_normal is null then
    raise exception 'expected the seeded normal handoff work item to still be open';
  end if;

  insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  values (v_id_normal, 'human_handoff_normal', 'clinic', '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-2000-000000000001', v_work_item_normal, 'fixture:053:repeat:normal');

  select * into v_row from public.claim_alert_delivery() where id = v_id_normal;
  if not found then raise exception 'expected to claim the normal-cadence repeat fixture row'; end if;
  select result into v_result from public.accept_alert_delivery(v_id_normal, v_row.claim_token);
  if v_result <> 'accepted' then raise exception 'expected accepted, got %', v_result; end if;

  select next_repeat_at into v_next from public.alert_deliveries where id = v_id_normal;
  if v_next is null or v_next <= now() + interval '23 hours' or v_next > now() + interval '25 hours' then
    raise exception 'expected a ~24 hour next_repeat_at for human_handoff_normal, got %', v_next;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- 10. Monitor heartbeat freshness/staleness.
-- =========================================================================

set local role service_role;
do $$
declare
  v_fresh boolean;
  v_result text;
  v_last_run_at timestamptz;
begin
  -- Task 053 Codex re-review item 7: the seed row must start with no
  -- last_run_at at all, so the heartbeat reads stale until the first real
  -- successful monitor run -- never fresh-by-default right after migration.
  select last_run_at into v_last_run_at from public.alert_monitor_heartbeat where id = true;
  if v_last_run_at is not null then raise exception 'expected the seed row to start with a null last_run_at'; end if;

  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(180);
  if v_fresh then raise exception 'expected the seed row to read stale immediately after migration'; end if;

  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(3600);
  if v_fresh then raise exception 'a null last_run_at must read stale under any max_age_seconds window'; end if;

  select result into v_result from public.record_alert_monitor_heartbeat();
  if v_result <> 'recorded' then raise exception 'expected recorded, got %', v_result; end if;

  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(180);
  if not v_fresh then raise exception 'expected fresh right after recording a heartbeat'; end if;

  -- Heartbeat health includes the ability to route a platform alarm. Removing
  -- the last enabled recipient makes freshness false immediately and must not
  -- advance the timestamp under a misleading 'recorded' result.
  perform result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000003', 'alerts-053-admin1@example.invalid', false,
    '53000000-0000-0000-2000-000000000003', 'testing the heartbeat recipient guard'
  );
  select last_run_at into v_last_run_at from public.alert_monitor_heartbeat where id = true;
  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(180);
  if v_fresh then raise exception 'heartbeat must be stale when no platform recipient is enabled'; end if;
  select result into v_result from public.record_alert_monitor_heartbeat();
  if v_result <> 'no_recipients' then raise exception 'expected heartbeat no_recipients, got %', v_result; end if;
  if (select last_run_at from public.alert_monitor_heartbeat where id = true) is distinct from v_last_run_at then
    raise exception 'no-recipient heartbeat call must not advance last_run_at';
  end if;
  perform result from public.set_platform_alert_recipient(
    '53000000-0000-0000-2000-000000000003', 'alerts-053-admin1@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'restoring admin1 after heartbeat guard proof'
  );

  update public.alert_monitor_heartbeat set last_run_at = now() - interval '10 minutes' where id = true;
  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(180);
  if v_fresh then raise exception 'expected stale once last_run_at is older than max_age_seconds'; end if;

  select fresh into v_fresh from public.is_alert_monitor_heartbeat_fresh(3600);
  if not v_fresh then raise exception 'a wider max_age_seconds window must read the same row as fresh again'; end if;
end;
$$;
reset role;

-- =========================================================================
-- 11. No residue: fixture and derived rows are present right before
-- rollback discards this entire transaction.
-- =========================================================================

do $$
begin
  if not exists (select 1 from public.clinic_alert_recipients) then
    raise exception 'fixture clinic recipients missing before rollback';
  end if;
  if not exists (select 1 from public.platform_alert_recipients) then
    raise exception 'fixture platform recipients missing before rollback';
  end if;
  if not exists (select 1 from public.alert_deliveries) then
    raise exception 'fixture alert deliveries missing before rollback';
  end if;
end;
$$;

-- =========================================================================
-- 12. FK cascade / offboarding cleanup (Task 053 Codex second re-review
-- item 2): clinic offboarding and platform-recipient removal must not be
-- FK-blocked by alert_deliveries/alert_recipient_audit history, and must
-- leave zero tenant-derived alert residue behind. Proven with a real
-- delete, run the same way finalize_clinic_offboarding_v1 and
-- set_platform_admin_v1's disable path do it -- not just a catalog-text
-- check of the FK definitions. Uses its own dedicated synthetic clinic and
-- platform admin so it cannot disturb any assertion elsewhere in this file.
-- =========================================================================

do $$
declare
  v_clinic_id constant uuid := '53000000-0000-0000-1000-000000000099';
  v_user_id constant uuid := '53000000-0000-0000-2000-000000000099';
  v_owner_id constant uuid := '53000000-0000-0000-4000-000000000099';
  v_conversation_id constant uuid := '53000000-0000-0000-5000-000000000099';
  v_platform_admin_id constant uuid := '53000000-0000-0000-2000-000000000098';
  v_work_item_id uuid;
  v_result text;
begin
  insert into auth.users (id, aud, role, email, created_at, updated_at)
  values
    (v_user_id, 'authenticated', 'authenticated', 'alerts-053-offboard@example.invalid', now(), now()),
    (v_platform_admin_id, 'authenticated', 'authenticated', 'alerts-053-offboard-admin@example.invalid', now(), now());

  insert into public.clinics (id, name) values (v_clinic_id, 'Alerting Offboarding Test Clinic');
  update public.clinics set operational_status = 'active', suspended_at = null where id = v_clinic_id;

  insert into public.clinic_staff (clinic_id, user_id, role) values (v_clinic_id, v_user_id, 'admin');

  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values (v_owner_id, v_clinic_id, 'Alert Owner Offboarding', '+15553000099');

  insert into public.conversations (id, clinic_id, owner_id, status)
  values (v_conversation_id, v_clinic_id, v_owner_id, 'active');

  insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, provenance)
  values (v_clinic_id, v_conversation_id, 'human_handoff', 'urgent', 'emergency_handoff', 'open', 'workflow')
  returning id into v_work_item_id;

  select result into v_result from public.set_clinic_alert_recipient(
    v_clinic_id, v_user_id, 'alerts-offboard@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'offboarding fixture'
  );
  if v_result <> 'set' then raise exception 'expected set for the offboarding clinic recipient, got %', v_result; end if;

  select result into v_result from public.set_platform_admin_v1(v_platform_admin_id, true);
  if v_result <> 'enabled' then raise exception 'expected offboarding platform admin enabled, got %', v_result; end if;
  select result into v_result from public.set_platform_alert_recipient(
    v_platform_admin_id, 'alerts-053-offboard-admin@example.invalid', true,
    '53000000-0000-0000-2000-000000000003', 'offboarding fixture'
  );
  if v_result <> 'set' then raise exception 'expected set for the offboarding platform recipient, got %', v_result; end if;

  -- One clinic-scope and one platform-scope delivery on the SAME work item
  -- (proving alert_deliveries_work_item_fkey/alert_deliveries_work_item_clinic_fkey
  -- and alert_deliveries_clinic_recipient_fkey all cascade), plus one
  -- clinic-independent platform-signal delivery tied only to the offboarding
  -- platform admin (proving alert_deliveries_platform_recipient_fkey cascades
  -- on its own, without a work item involved).
  insert into public.alert_deliveries (id, signal_kind, recipient_scope, clinic_id, recipient_user_id, work_item_id, dedup_key)
  values
    ('53000000-0000-0000-6000-000000000090', 'human_handoff_urgent', 'clinic', v_clinic_id, v_user_id, v_work_item_id, 'fixture:053:offboard:clinic'),
    ('53000000-0000-0000-6000-000000000091', 'human_handoff_urgent', 'platform', null, v_platform_admin_id, v_work_item_id, 'fixture:053:offboard:platform-on-work-item'),
    ('53000000-0000-0000-6000-000000000092', 'queue_backlog', 'platform', null, v_platform_admin_id, null, 'fixture:053:offboard:platform-signal');

  if (select count(*) from public.alert_recipient_audit where clinic_id = v_clinic_id) <> 1 then
    raise exception 'expected exactly 1 audit row for the offboarding clinic before delete';
  end if;

  -- The actual proof: delete the clinic exactly the way
  -- finalize_clinic_offboarding_v1 does, and confirm it is never FK-blocked
  -- by any alert table.
  delete from public.clinics where id = v_clinic_id;

  if exists (select 1 from public.clinic_staff where clinic_id = v_clinic_id) then
    raise exception 'clinic_staff must be gone after clinic delete';
  end if;
  if exists (select 1 from public.clinic_alert_recipients where clinic_id = v_clinic_id) then
    raise exception 'clinic_alert_recipients must be gone after clinic delete';
  end if;
  if exists (select 1 from public.alert_recipient_audit where clinic_id = v_clinic_id) then
    raise exception 'alert_recipient_audit must be gone after clinic delete -- zero tenant-derived audit residue';
  end if;
  if exists (select 1 from public.staff_work_items where clinic_id = v_clinic_id) then
    raise exception 'staff_work_items must be gone after clinic delete';
  end if;
  if exists (
    select 1 from public.alert_deliveries
    where id in ('53000000-0000-0000-6000-000000000090', '53000000-0000-0000-6000-000000000091')
  ) then
    raise exception 'both the clinic-scope and platform-scope work-item-bound deliveries must be gone after clinic delete -- zero tenant-derived alert residue';
  end if;

  -- Unrelated platform signal (no work item, no clinic) must survive the
  -- clinic delete untouched -- cascade must not overreach.
  if not exists (select 1 from public.alert_deliveries where id = '53000000-0000-0000-6000-000000000092') then
    raise exception 'a platform signal unrelated to the deleted clinic must survive';
  end if;
  if not exists (select 1 from public.platform_alert_recipients where user_id = v_platform_admin_id) then
    raise exception 'the offboarding platform admin recipient must survive an unrelated clinic delete';
  end if;

  -- Now remove the platform admin/recipient itself, the same way
  -- set_platform_admin_v1's disable path does, and confirm its own
  -- platform-signal delivery history never blocks the removal.
  delete from public.platform_admins where user_id = v_platform_admin_id;

  if exists (select 1 from public.platform_alert_recipients where user_id = v_platform_admin_id) then
    raise exception 'platform_alert_recipients must be gone after its platform_admins row is removed';
  end if;
  if exists (select 1 from public.alert_deliveries where id = '53000000-0000-0000-6000-000000000092') then
    raise exception 'the removed platform recipient''s own signal delivery must be gone too, not left orphaned';
  end if;

  -- Fixture data used by every earlier section in this file must be
  -- completely unaffected by this cleanup.
  if not exists (select 1 from public.clinics where id = '53000000-0000-0000-1000-000000000001') then
    raise exception 'unrelated fixture clinic A must survive the offboarding test';
  end if;
  if not exists (select 1 from public.platform_alert_recipients where user_id = '53000000-0000-0000-2000-000000000003') then
    raise exception 'unrelated fixture platform admin1 must survive the offboarding test';
  end if;
end;
$$;
reset role;

rollback;

-- Zero residue: these selects run against the post-rollback state.
select
  (select count(*) from public.clinics where id in (
    '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-1000-000000000002')) as clinics_left,
  (select count(*) from public.clinic_alert_recipients) as clinic_alert_recipients_left,
  (select count(*) from public.platform_alert_recipients where user_id in (
    '53000000-0000-0000-2000-000000000003', '53000000-0000-0000-2000-000000000004')) as platform_alert_recipients_left,
  (select count(*) from public.whatsapp_contact_routes where whatsapp_account_id =
    '53000000-0000-0000-3000-000000000001') as whatsapp_contact_routes_left,
  (select count(*) from public.alert_deliveries) as alert_deliveries_left,
  (select count(*) from public.staff_work_items where clinic_id in (
    '53000000-0000-0000-1000-000000000001', '53000000-0000-0000-1000-000000000002')) as staff_work_items_left;
