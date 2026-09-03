-- Task 048 rollback-only proof for the staff WhatsApp reply composer.
-- begin/rollback only; never applied outside a disposable database. Proves
-- schema coherence, grants, tenant isolation, the 24-hour window, request-id
-- idempotency, route-change preservation of staff replies, expired-window
-- terminalization ahead of claim, and accept-time origin propagation.
-- Not a proof of real two-session concurrency or a real Meta send.

begin;

-- claim_outbound_message_v2 is intentionally a global sender RPC. Refuse to
-- run this rollback-only fixture on a database that already has claimable
-- active-clinic work, so the proof can never transiently lease an unrelated
-- row while looking for its own deterministic candidates below.
do $$
begin
  if exists (
    select 1
    from public.outbound_message_outbox oo
    join public.whatsapp_accounts wa
      on wa.id = oo.whatsapp_account_id
     and wa.clinic_id = oo.clinic_id
    join public.clinics cl
      on cl.id = wa.clinic_id
     and cl.operational_status = 'active'
    where (
      (oo.delivery_status = 'pending' and oo.next_attempt_at <= pg_catalog.now())
      or
      (oo.delivery_status = 'processing' and oo.delivery_lease_until <= pg_catalog.now())
    )
  ) then
    raise exception 'task 048 fixture requires a disposable database with no pre-existing claimable outbound rows';
  end if;
end;
$$;

-- =========================================================================
-- Fixture data
-- =========================================================================

insert into public.clinics (id, name, operational_status, suspended_at)
values
  ('48800000-0000-0000-0000-000000000001', '048 Clinic A', 'active', null),
  ('48800000-0000-0000-0000-000000000002', '048 Clinic B', 'active', null);

insert into public.clinics (id, name, operational_status, suspended_at)
values
  ('48800000-0000-0000-0000-000000000003', '048 Clinic Suspended', 'suspended', now());

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id, display_name, automation_default)
values
  ('48800000-0000-0000-0000-000000000011', '48800000-0000-0000-0000-000000000001', '9488000001', '048 A account 1', 'personal'),
  ('48800000-0000-0000-0000-000000000012', '48800000-0000-0000-0000-000000000001', '9488000002', '048 A account 2', 'personal'),
  ('48800000-0000-0000-0000-000000000013', '48800000-0000-0000-0000-000000000002', '9488000003', '048 B account 1', 'personal'),
  ('48800000-0000-0000-0000-000000000014', '48800000-0000-0000-0000-000000000003', '9488000004', '048 Suspended account', 'personal');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('48800000-0000-0000-0000-000000000021', '48800000-0000-0000-0000-000000000001', '048 Owner A', '+905551000001'),
  ('48800000-0000-0000-0000-000000000022', '48800000-0000-0000-0000-000000000002', '048 Owner B', '+905551000002'),
  ('48800000-0000-0000-0000-000000000023', '48800000-0000-0000-0000-000000000003', '048 Owner Suspended', '+905551000003'),
  ('48800000-0000-0000-0000-000000000024', '48800000-0000-0000-0000-000000000001', '048 Owner Boundary', '+905551000004'),
  ('48800000-0000-0000-0000-000000000025', '48800000-0000-0000-0000-000000000001', '048 Owner Dual', '+905551000005'),
  ('48800000-0000-0000-0000-000000000026', '48800000-0000-0000-0000-000000000001', '048 Owner Route', '+905551000006'),
  ('48800000-0000-0000-0000-000000000027', '48800000-0000-0000-0000-000000000001', '048 Owner Erasure', '+905551000007'),
  ('48800000-0000-0000-0000-000000000028', '48800000-0000-0000-0000-000000000001', '048 Owner Completed', '+905551000008');

-- conv_main: happy-path queue + exact replay + mismatched-reuse.
-- conv_boundary: exact 24h boundary + already-expired window.
-- conv_dual: same owner reachable through two clinic accounts.
-- conv_route: preserved across a manual/personal route change.
-- conv_erasure: actor nulled by Auth-user deletion after queueing.
-- conv_completed: non-eligible conversation (intake_stage = completed).
insert into public.conversations (id, clinic_id, owner_id, status, intake_stage)
values
  ('48800000-0000-0000-0000-000000000031', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000021', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000032', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000024', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000033', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000025', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000034', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000026', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000035', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000027', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000036', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000028', 'completed', 'completed'),
  ('48800000-0000-0000-0000-000000000037', '48800000-0000-0000-0000-000000000002', '48800000-0000-0000-0000-000000000022', 'handoff', 'human_handoff'),
  ('48800000-0000-0000-0000-000000000038', '48800000-0000-0000-0000-000000000003', '48800000-0000-0000-0000-000000000023', 'handoff', 'human_handoff');

-- Inbound provider events + messages driving the 24h window and account
-- derivation. webhook_events.whatsapp_account_id ties an inbound message to
-- the exact account it arrived on.
insert into public.webhook_events (id, clinic_id, provider_event_id, payload_hash, processing_status, whatsapp_account_id, received_at)
values
  ('48800000-0000-0000-0000-000000000041', '48800000-0000-0000-0000-000000000001', '048-evt-main', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000042', '48800000-0000-0000-0000-000000000001', '048-evt-boundary', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '24 hours'),
  ('48800000-0000-0000-0000-000000000043', '48800000-0000-0000-0000-000000000001', '048-evt-dual-old', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '2 hours'),
  ('48800000-0000-0000-0000-000000000044', '48800000-0000-0000-0000-000000000001', '048-evt-dual-new', 'h', 'processed', '48800000-0000-0000-0000-000000000012', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000045', '48800000-0000-0000-0000-000000000001', '048-evt-route', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000046', '48800000-0000-0000-0000-000000000001', '048-evt-erasure', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000047', '48800000-0000-0000-0000-000000000001', '048-evt-completed', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000048', '48800000-0000-0000-0000-000000000002', '048-evt-cross', 'h', 'processed', '48800000-0000-0000-0000-000000000013', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000049', '48800000-0000-0000-0000-000000000003', '048-evt-suspended', 'h', 'processed', '48800000-0000-0000-0000-000000000014', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000050', '48800000-0000-0000-0000-000000000001', '048-evt-retry-503', 'h', 'processed', '48800000-0000-0000-0000-000000000011', now() - interval '22 hours');

insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)
values
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031', 'inbound', 'merhaba', '048-evt-main', now() - interval '1 hour'),
  -- A future-skewed provider/client timestamp must not extend the service
  -- window beyond the trusted server receipt time above.
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000032', 'inbound', 'merhaba', '048-evt-boundary', now() + interval '1 hour'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000033', 'inbound', 'ilk mesaj', '048-evt-dual-old', now() - interval '2 hours'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000033', 'inbound', 'ikinci mesaj', '048-evt-dual-new', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000034', 'inbound', 'merhaba', '048-evt-route', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000035', 'inbound', 'merhaba', '048-evt-erasure', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000036', 'inbound', 'merhaba', '048-evt-completed', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000002', '48800000-0000-0000-0000-000000000037', 'inbound', 'merhaba', '048-evt-cross', now() - interval '1 hour'),
  ('48800000-0000-0000-0000-000000000003', '48800000-0000-0000-0000-000000000038', 'inbound', 'merhaba', '048-evt-suspended', now() - interval '1 hour');

-- Auth users: staff_1/staff_2 are clinic A staff, staff_b is clinic B staff,
-- staff_nonmember intentionally has no clinic_staff row, staff_erasure is
-- deleted later in this fixture to prove actor nulling.
insert into auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('48800000-0000-0000-0000-000000000101', 'authenticated', 'authenticated', 'staff048-1@example.invalid', 'x', now(), now(), now()),
  ('48800000-0000-0000-0000-000000000102', 'authenticated', 'authenticated', 'staff048-2@example.invalid', 'x', now(), now(), now()),
  ('48800000-0000-0000-0000-000000000103', 'authenticated', 'authenticated', 'staff048-b@example.invalid', 'x', now(), now(), now()),
  ('48800000-0000-0000-0000-000000000104', 'authenticated', 'authenticated', 'staff048-none@example.invalid', 'x', now(), now(), now()),
  ('48800000-0000-0000-0000-000000000105', 'authenticated', 'authenticated', 'staff048-erasure@example.invalid', 'x', now(), now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000101', 'receptionist'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000102', 'receptionist'),
  ('48800000-0000-0000-0000-000000000002', '48800000-0000-0000-0000-000000000103', 'receptionist'),
  ('48800000-0000-0000-0000-000000000003', '48800000-0000-0000-0000-000000000101', 'receptionist'),
  ('48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000105', 'receptionist');
-- 48800000-...-000104 (staff_nonmember) intentionally has no clinic_staff row.

-- A valid accepted automation outbox row anchors the delivery-failure
-- work-item negative below without creating claimable work.
insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id,
  source_provider_message_id, recipient_e164, reply_category, content,
  delivery_status, delivery_attempt_count, provider_message_id, accepted_at,
  next_attempt_at
)
values (
  '48800000-0000-0000-0000-000000000510',
  '48800000-0000-0000-0000-000000000001',
  '48800000-0000-0000-0000-000000000031',
  '48800000-0000-0000-0000-000000000011',
  '048-evt-main', '+905551000001', 'human_handoff',
  'teslim hatası iş kalemi için kaynak', 'accepted', 1,
  'wamid.048-kind-negative', pg_catalog.now(), null
);

-- staff_work_items: an in_progress handoff assigned to staff_1 for every
-- conversation except conv_completed (kept 'open', unclaimed) and a
-- delivery_failure item on conv_main's clinic (kind mismatch negative).
insert into public.staff_work_items (
  id, clinic_id, conversation_id, kind, priority, reason, status,
  first_seen_at, first_seen_by, assigned_at, assigned_to
)
values
  ('48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'),
  ('48800000-0000-0000-0000-000000000202', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000032', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'),
  ('48800000-0000-0000-0000-000000000203', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000033', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'),
  ('48800000-0000-0000-0000-000000000204', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000034', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'),
  ('48800000-0000-0000-0000-000000000205', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000035', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000105', now(), '48800000-0000-0000-0000-000000000105'),
  ('48800000-0000-0000-0000-000000000206', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000036', 'human_handoff', 'normal', 'human_handoff', 'open', null, null, null, null),
  ('48800000-0000-0000-0000-000000000207', '48800000-0000-0000-0000-000000000002', '48800000-0000-0000-0000-000000000037', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000103', now(), '48800000-0000-0000-0000-000000000103'),
  ('48800000-0000-0000-0000-000000000208', '48800000-0000-0000-0000-000000000003', '48800000-0000-0000-0000-000000000038', 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101');

insert into public.staff_work_items (
  id, clinic_id, conversation_id, kind, priority, reason, source_outbox_id,
  status, first_seen_at, first_seen_by, assigned_at, assigned_to
)
values (
  '48800000-0000-0000-0000-000000000209',
  '48800000-0000-0000-0000-000000000001',
  '48800000-0000-0000-0000-000000000031',
  'delivery_failure', 'normal', 'send_attempts_exhausted',
  '48800000-0000-0000-0000-000000000510', 'in_progress',
  pg_catalog.now(), '48800000-0000-0000-0000-000000000101',
  pg_catalog.now(), '48800000-0000-0000-0000-000000000101'
);

-- =========================================================================
-- 1. Schema shape: new columns/indexes/constraints exist; existing
--    automation-shaped rows are unaffected.
-- =========================================================================

do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'outbound_message_outbox'
      and column_name in ('message_origin', 'staff_request_id', 'staff_work_item_id', 'staff_actor_user_id', 'staff_window_expires_at')
    having count(*) = 5
  ) then
    raise exception 'expected all five staff columns on outbound_message_outbox';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'outbound_message_outbox'
      and indexname = 'outbound_message_outbox_automation_source_key'
  ) then
    raise exception 'expected outbound_message_outbox_automation_source_key partial index';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public' and tablename = 'outbound_message_outbox'
      and indexname = 'outbound_message_outbox_staff_request_key'
      and indexdef like 'CREATE UNIQUE INDEX % (staff_request_id) WHERE (staff_request_id IS NOT NULL)'
  ) then
    raise exception 'expected a global one-column unique partial staff-request index';
  end if;

  if exists (
    select 1 from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    where rel.relname = 'outbound_message_outbox' and con.contype = 'u'
      and con.conkey = (
        select array_agg(att.attnum order by att.attnum)
        from pg_catalog.pg_attribute att
        where att.attrelid = rel.oid and att.attname in ('clinic_id', 'source_provider_message_id')
      )
  ) then
    raise exception 'expected the legacy two-column unique constraint to be dropped';
  end if;

  if (
    select count(*)
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and (
        (rel.relname = 'outbound_message_outbox' and con.conname in (
          'outbound_message_outbox_message_origin_check',
          'outbound_message_outbox_origin_coherence_check',
          'outbound_message_outbox_delivery_state_check',
          'outbound_message_outbox_reply_category_check'
        ))
        or
        (rel.relname = 'messages' and con.conname in (
          'messages_outbound_origin_value_check',
          'messages_outbound_origin_coherence_check'
        ))
      )
      and con.convalidated
  ) <> 6 then
    raise exception 'expected all six Task 048 check constraints to exist and be validated';
  end if;
end;
$$;

-- Preserve the complete reply-category vocabulary from the latest prior
-- constraint and add only staff_reply. This catches drift against real
-- appointment/cancellation rows, not merely the fixture's usual categories.
do $$
declare
  v_category text;
begin
  foreach v_category in array array[
    'emergency_handoff', 'human_handoff', 'safety_questions', 'pet_identity',
    'intake_confirmation', 'complaint', 'intake_received',
    'appointment_offer', 'appointment_confirmed', 'appointment_declined',
    'appointment_unavailable', 'appointment_cancel_offer',
    'appointment_cancelled', 'appointment_cancel_declined',
    'appointment_cancel_unavailable'
  ] loop
    insert into public.webhook_events (
      id, clinic_id, provider_event_id, payload_hash, processing_status,
      whatsapp_account_id, received_at
    ) values (
      pg_catalog.gen_random_uuid(),
      '48800000-0000-0000-0000-000000000001',
      '048-category-' || v_category, 'h', 'processed',
      '48800000-0000-0000-0000-000000000011', pg_catalog.now()
    );

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id,
      source_provider_message_id, recipient_e164, reply_category, content,
      next_attempt_at
    ) values (
      '48800000-0000-0000-0000-000000000001',
      '48800000-0000-0000-0000-000000000031',
      '48800000-0000-0000-0000-000000000011',
      '048-category-' || v_category,
      '+905551000001', v_category, 'category compatibility proof',
      pg_catalog.now() + interval '100 years'
    );
  end loop;

  if (
    select count(*)
    from public.outbound_message_outbox
    where source_provider_message_id like '048-category-%'
  ) <> 15 then
    raise exception 'expected all 15 pre-existing reply categories to remain valid';
  end if;

  begin
    insert into public.webhook_events (
      id, clinic_id, provider_event_id, payload_hash, processing_status,
      whatsapp_account_id, received_at
    ) values (
      pg_catalog.gen_random_uuid(),
      '48800000-0000-0000-0000-000000000001',
      '048-category-invalid', 'h', 'processed',
      '48800000-0000-0000-0000-000000000011', pg_catalog.now()
    );

    insert into public.outbound_message_outbox (
      clinic_id, conversation_id, whatsapp_account_id,
      source_provider_message_id, recipient_e164, reply_category, content,
      next_attempt_at
    ) values (
      '48800000-0000-0000-0000-000000000001',
      '48800000-0000-0000-0000-000000000031',
      '48800000-0000-0000-0000-000000000011',
      '048-category-invalid', '+905551000001', 'invalid_category',
      'invalid category must fail', pg_catalog.now() + interval '100 years'
    );
    raise exception 'expected unknown reply category to be rejected';
  exception
    when check_violation then null;
  end;

  delete from public.outbound_message_outbox
  where source_provider_message_id like '048-category-%';

  delete from public.webhook_events
  where clinic_id = '48800000-0000-0000-0000-000000000001'
    and provider_event_id like '048-category-%';
end;
$$;

-- =========================================================================
-- 2. Direct table access remains unavailable to anon/authenticated; RPC
--    grants are authenticated-only.
-- =========================================================================

do $$
begin
  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'outbound_message_outbox'
      and grantee in ('anon', 'authenticated')
  ) then
    raise exception 'expected no direct table grants on outbound_message_outbox for anon/authenticated';
  end if;

  if exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'queue_staff_reply_v1'
      and grantee in ('anon', 'service_role', 'public')
  ) then
    raise exception 'expected queue_staff_reply_v1 to be revoked from anon/service_role/public';
  end if;

  if not exists (
    select 1 from information_schema.role_routine_grants
    where routine_schema = 'public' and routine_name = 'queue_staff_reply_v1'
      and grantee = 'authenticated' and privilege_type = 'EXECUTE'
  ) then
    raise exception 'expected queue_staff_reply_v1 granted to authenticated';
  end if;

  if not exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'queue_staff_reply_v1'
      and p.prosecdef
      and p.provolatile = 'v'
      and (p.proconfig @> array['search_path='] or p.proconfig @> array['search_path=""'])
      and pg_catalog.strpos(pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)), 'for key share of cl') > 0
      and pg_catalog.strpos(pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)), 'for key share of cs') > 0
      and pg_catalog.strpos(pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)), 'for key share of cl')
        < pg_catalog.strpos(pg_catalog.lower(pg_catalog.pg_get_functiondef(p.oid)), 'for update of wi')
  ) then
    raise exception 'expected queue_staff_reply_v1 metadata and clinic-before-work-item lock order';
  end if;
end;
$$;

-- =========================================================================
-- 3-8. Negative paths: each creates zero outbox/message/work-item rows.
-- =========================================================================

-- Missing/null caller: no request.jwt.claim.sub set at all.
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000301', 'merhaba'
  );
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a missing caller, got %', v_result;
  end if;
end;
$$;
reset role;

-- Non-member caller (authenticated, but no clinic_staff row anywhere).
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000104', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000302', 'merhaba'
  );
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a non-member caller, got %', v_result;
  end if;
end;
$$;
reset role;

-- Cross-tenant: clinic B staff targeting clinic A's work item.
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000103', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000303', 'merhaba'
  );
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-tenant caller, got %', v_result;
  end if;
end;
$$;
reset role;

-- Inactive clinic: caller is a legitimate assigned staff member, but the
-- clinic is suspended.
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000208', '48800000-0000-0000-0000-000000000304', 'merhaba'
  );
  if v_result <> 'inactive' then
    raise exception 'expected inactive for a suspended clinic, got %', v_result;
  end if;
end;
$$;
reset role;

-- Unclaimed (status = 'open').
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000206', '48800000-0000-0000-0000-000000000305', 'merhaba'
  );
  if v_result <> 'not_allowed' then
    raise exception 'expected not_allowed for an open (unclaimed) item, got %', v_result;
  end if;
end;
$$;
reset role;

-- Assigned to a different staff member.
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000102', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000306', 'merhaba'
  );
  if v_result <> 'not_allowed' then
    raise exception 'expected not_allowed when assigned to another staff member, got %', v_result;
  end if;
end;
$$;
reset role;

-- Resolved work item.
update public.staff_work_items
  set status = 'resolved', resolved_at = now(), resolved_by = '48800000-0000-0000-0000-000000000101'
  where id = '48800000-0000-0000-0000-000000000209';

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000209', '48800000-0000-0000-0000-000000000307', 'merhaba'
  );
  if v_result <> 'not_allowed' then
    raise exception 'expected not_allowed for a resolved item, got %', v_result;
  end if;
end;
$$;
reset role;

-- Non-handoff kind (delivery_failure), reusing item 209 pre-resolve state
-- via a fresh in_progress delivery_failure item.
insert into public.staff_work_items (
  id, clinic_id, conversation_id, kind, priority, reason, source_outbox_id, status,
  first_seen_at, first_seen_by, assigned_at, assigned_to
)
values (
  '48800000-0000-0000-0000-000000000210', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000032',
  'delivery_failure', 'normal', 'provider_failed', '48800000-0000-0000-0000-000000000510',
  'in_progress', now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000210', '48800000-0000-0000-0000-000000000308', 'merhaba'
  );
  if v_result <> 'not_allowed' then
    raise exception 'expected not_allowed for a delivery_failure work item, got %', v_result;
  end if;
end;
$$;
reset role;

-- Completed conversation is not reachable at all (its work item stayed
-- open above); prove separately that a completed conversation's own
-- in_progress item, if it existed, would be rejected. Flip conv_completed's
-- item to in_progress to exercise the intake_stage = completed branch.
update public.staff_work_items
  set status = 'in_progress', first_seen_at = now(), first_seen_by = '48800000-0000-0000-0000-000000000101',
      assigned_at = now(), assigned_to = '48800000-0000-0000-0000-000000000101'
  where id = '48800000-0000-0000-0000-000000000206';

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000206', '48800000-0000-0000-0000-000000000309', 'merhaba'
  );
  if v_result <> 'not_allowed' then
    raise exception 'expected not_allowed for a completed conversation, got %', v_result;
  end if;
end;
$$;
reset role;

-- Content validation is authoritative in SQL as well as the browser. A draft
-- containing only permitted whitespace characters must still fail closed.
set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_raised boolean := false;
begin
  begin
    perform result from public.queue_staff_reply_v1(
      '48800000-0000-0000-0000-000000000201',
      '48800000-0000-0000-0000-000000000310',
      E'\n\t\r'
    );
  exception when others then
    v_raised := true;
  end;

  if not v_raised then
    raise exception 'expected a whitespace-only staff reply to raise';
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (select 1 from public.outbound_message_outbox where message_origin = 'staff') then
    raise exception 'expected zero staff outbox rows after every negative-path case above';
  end if;
end;
$$;

-- =========================================================================
-- 9. Happy path: queues one server-derived staff-origin row.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
  v_outbox_id uuid;
  v_window timestamptz;
begin
  select result, outbox_id, window_expires_at
    into v_result, v_outbox_id, v_window
  from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000401', 'Merhaba, evet müsait.'
  );

  if v_result <> 'queued' or v_outbox_id is null or v_window is null then
    raise exception 'expected queued with non-null outbox_id/window, got % / % / %', v_result, v_outbox_id, v_window;
  end if;

  perform pg_catalog.set_config('vetai_test.happy_outbox_id', v_outbox_id::text, true);
end;
$$;
reset role;

do $$
declare
  v_outbox_id uuid := current_setting('vetai_test.happy_outbox_id')::uuid;
  v_row public.outbound_message_outbox%rowtype;
begin
  select * into v_row from public.outbound_message_outbox where id = v_outbox_id;
  if v_row.clinic_id <> '48800000-0000-0000-0000-000000000001'
    or v_row.conversation_id <> '48800000-0000-0000-0000-000000000031'
    or v_row.whatsapp_account_id <> '48800000-0000-0000-0000-000000000011'
    or v_row.recipient_e164 <> '+905551000001'
    or v_row.message_origin <> 'staff'
    or v_row.reply_category <> 'staff_reply'
    or v_row.source_provider_message_id is not null
    or v_row.staff_work_item_id <> '48800000-0000-0000-0000-000000000201'
    or v_row.staff_actor_user_id <> '48800000-0000-0000-0000-000000000101'
    or v_row.delivery_status <> 'pending'
  then
    raise exception 'unexpected staff outbox row shape for %', v_outbox_id;
  end if;

  -- Keep this exact happy-path row deterministic for the later accept proof.
  -- Its service-window expiry remains server-derived and unchanged.
  update public.outbound_message_outbox
    set created_at = pg_catalog.now() - interval '21 hours'
    where id = v_outbox_id;
end;
$$;

-- Exact replay remains exact after the original item is resolved; a fresh
-- handoff for the same conversation is still a different work item and must
-- not inherit the old request id even when actor/content are identical.
update public.staff_work_items
  set status = 'resolved', resolved_at = now(), resolved_by = '48800000-0000-0000-0000-000000000101'
  where id = '48800000-0000-0000-0000-000000000201';

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000401', 'Merhaba, evet müsait.'
  );
  if v_result <> 'already_queued' then
    raise exception 'expected an exact replay after resolution to remain already_queued, got %', v_result;
  end if;
end;
$$;
reset role;

insert into public.staff_work_items (
  id, clinic_id, conversation_id, kind, priority, reason, status,
  first_seen_at, first_seen_by, assigned_at, assigned_to
)
values (
  '48800000-0000-0000-0000-000000000211', '48800000-0000-0000-0000-000000000001',
  '48800000-0000-0000-0000-000000000031', 'human_handoff', 'normal', 'human_handoff', 'in_progress',
  now(), '48800000-0000-0000-0000-000000000101', now(), '48800000-0000-0000-0000-000000000101'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_raised boolean := false;
begin
  begin
    perform result from public.queue_staff_reply_v1(
      '48800000-0000-0000-0000-000000000211', '48800000-0000-0000-0000-000000000401', 'Merhaba, evet müsait.'
    );
  exception when others then
    v_raised := true;
  end;

  if not v_raised then
    raise exception 'expected same request id on a different work item to raise';
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.outbound_message_outbox where message_origin = 'staff') <> 1 then
    raise exception 'expected different-work-item replay to create no row';
  end if;
end;
$$;

-- =========================================================================
-- 10. Exact replay is idempotent; mismatched reuse raises before any second
--     row.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
  v_outbox_id uuid;
begin
  select result, outbox_id into v_result, v_outbox_id from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000401', 'Merhaba, evet müsait.'
  );

  if v_result <> 'already_queued' or v_outbox_id is null then
    raise exception 'expected already_queued with original outbox id, got % / %', v_result, v_outbox_id;
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.outbound_message_outbox where message_origin = 'staff') <> 1 then
    raise exception 'expected exact replay to create no new row';
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_raised boolean := false;
begin
  begin
    perform result from public.queue_staff_reply_v1(
      '48800000-0000-0000-0000-000000000201', '48800000-0000-0000-0000-000000000401', 'Farklı bir metin.'
    );
  exception when others then
    v_raised := true;
  end;

  if not v_raised then
    raise exception 'expected mismatched request_id reuse (different content) to raise';
  end if;
end;
$$;
reset role;

do $$
begin
  if (select count(*) from public.outbound_message_outbox where message_origin = 'staff') <> 1 then
    raise exception 'expected no new row on mismatched reuse';
  end if;
end;
$$;

-- =========================================================================
-- 11. Exact 24-hour boundary is fail-closed.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_result text;
begin
  select result into v_result from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000202', '48800000-0000-0000-0000-000000000402', 'merhaba'
  );
  if v_result <> 'window_closed' then
    raise exception 'expected window_closed exactly at the 24h boundary, got %', v_result;
  end if;
end;
$$;
reset role;

do $$
begin
  if exists (
    select 1 from public.outbound_message_outbox
    where conversation_id = '48800000-0000-0000-0000-000000000032' and message_origin = 'staff'
  ) then
    raise exception 'expected zero rows for the boundary-closed conversation';
  end if;
end;
$$;

-- =========================================================================
-- 12. Same owner/conversation reachable through two accounts: the latest
--     inbound account wins, not an arbitrary one.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_outbox_id uuid;
begin
  select outbox_id into v_outbox_id from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000203', '48800000-0000-0000-0000-000000000403', 'merhaba'
  );
  perform pg_catalog.set_config('vetai_test.dual_outbox_id', v_outbox_id::text, true);
end;
$$;
reset role;

do $$
declare
  v_account_id uuid;
begin
  select whatsapp_account_id into v_account_id
  from public.outbound_message_outbox
  where id = current_setting('vetai_test.dual_outbox_id')::uuid;
  if v_account_id <> '48800000-0000-0000-0000-000000000012' then
    raise exception 'expected the latest-inbound account (…12), got %', v_account_id;
  end if;
end;
$$;

-- =========================================================================
-- 13. Route change to manual/personal preserves a pending staff reply while
--     still cleaning up pending automation rows.
-- =========================================================================

-- Seed one automation-origin pending row on the same account/owner, using
-- the same insert shape finalize_intake_queue_job would produce.
insert into public.outbound_message_outbox (
  clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
  recipient_e164, reply_category, content
)
values (
  '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000034', '48800000-0000-0000-0000-000000000011',
  '048-evt-route', '+905551000006', 'human_handoff', 'otomatik yanıt'
);

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000101', true);
do $$
declare
  v_staff_outbox_id uuid;
begin
  select outbox_id into v_staff_outbox_id from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000204', '48800000-0000-0000-0000-000000000404', 'personel yanıtı'
  );

  perform result from public.set_whatsapp_contact_route(
    '48800000-0000-0000-0000-000000000011', '+905551000006', 'manual'
  );
  perform pg_catalog.set_config('vetai_test.route_staff_outbox_id', v_staff_outbox_id::text, true);
end;
$$;
reset role;

do $$
begin
  if not exists (
    select 1 from public.outbound_message_outbox
    where id = current_setting('vetai_test.route_staff_outbox_id')::uuid
  ) then
    raise exception 'expected the staff reply to survive a route change to manual';
  end if;

  if exists (
    select 1 from public.outbound_message_outbox
    where clinic_id = '48800000-0000-0000-0000-000000000001'
      and whatsapp_account_id = '48800000-0000-0000-0000-000000000011'
      and message_origin = 'automation'
      and source_provider_message_id = '048-evt-route'
  ) then
    raise exception 'expected the pending automation row to be deleted by the route change';
  end if;
end;
$$;

-- =========================================================================
-- 14. Expired pending / expired-lease-and-window processing staff rows are
--     terminalized before claim and never handed to the sender; ordinary
--     automation retry is unaffected.
-- =========================================================================

insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id, recipient_e164,
  reply_category, content, message_origin, staff_request_id, staff_work_item_id,
  staff_actor_user_id, staff_window_expires_at, delivery_status, next_attempt_at,
  created_at
)
values (
  '48800000-0000-0000-0000-000000000501', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031',
  '48800000-0000-0000-0000-000000000011', '+905551000001', 'staff_reply', 'süresi geçmiş bekleyen yanıt',
  'staff', '48800000-0000-0000-0000-000000000501', '48800000-0000-0000-0000-000000000211',
  '48800000-0000-0000-0000-000000000101', now() - interval '1 minute',
  'pending', now() - interval '1 minute', now() - interval '24 hours'
);

insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id, recipient_e164,
  reply_category, content, message_origin, staff_request_id, staff_work_item_id,
  staff_actor_user_id, staff_window_expires_at, delivery_status,
  delivery_claim_token, delivery_lease_until, delivery_attempt_count,
  next_attempt_at, created_at
)
values (
  '48800000-0000-0000-0000-000000000502', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031',
  '48800000-0000-0000-0000-000000000011', '+905551000001', 'staff_reply', 'süresi geçmiş işlenen yanıt',
  'staff', '48800000-0000-0000-0000-000000000502', '48800000-0000-0000-0000-000000000211',
  '48800000-0000-0000-0000-000000000101', now() - interval '1 minute',
  'processing', gen_random_uuid(), now() - interval '1 minute', 1,
  null, now() - interval '23 hours'
);

-- Expiry must win even when the retry counter is already exhausted; this
-- must not be mislabeled as attempts_exhausted or create a failure work item.
insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id, recipient_e164,
  reply_category, content, message_origin, staff_request_id, staff_work_item_id,
  staff_actor_user_id, staff_window_expires_at, delivery_status,
  delivery_claim_token, delivery_lease_until, delivery_attempt_count,
  next_attempt_at, created_at
)
values (
  '48800000-0000-0000-0000-000000000504', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031',
  '48800000-0000-0000-0000-000000000011', '+905551000001', 'staff_reply', 'süresi geçmiş ve denemesi tükenmiş yanıt',
  'staff', '48800000-0000-0000-0000-000000000504', '48800000-0000-0000-0000-000000000211',
  '48800000-0000-0000-0000-000000000101', now() - interval '1 minute',
  'processing', gen_random_uuid(), now() - interval '1 minute', 3,
  null, now() - interval '23 hours'
);

-- A normal automation row, due now, must still be claimable and unaffected.
insert into public.outbound_message_outbox (
  id, clinic_id, conversation_id, whatsapp_account_id, source_provider_message_id,
  recipient_e164, reply_category, content, created_at
)
values (
  '48800000-0000-0000-0000-000000000503', '48800000-0000-0000-0000-000000000001', '48800000-0000-0000-0000-000000000031',
  '48800000-0000-0000-0000-000000000011', '048-evt-retry-503', '+905551000001', 'human_handoff', 'otomatik tekrar',
  now() - interval '22 hours'
);

do $$
declare
  v_claim record;
begin
  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'claimed'
    or v_claim.outbox_id <> '48800000-0000-0000-0000-000000000503'
  then
    raise exception 'expected expired staff rows to be skipped and automation row 503 to be claimed, got % / %', v_claim.result, v_claim.outbox_id;
  end if;

  if not exists (
    select 1
    from public.outbound_message_outbox oo
    where oo.id = v_claim.outbox_id
      and oo.message_origin = 'automation'
      and oo.source_provider_message_id = '048-evt-retry-503'
      and oo.staff_request_id is null
      and oo.staff_work_item_id is null
      and oo.staff_actor_user_id is null
      and oo.staff_window_expires_at is null
  ) then
    raise exception 'expected the ordinary automation row to retain exact automation origin coherence';
  end if;
end;
$$;

do $$
declare
  v_501 record;
  v_502 record;
  v_504 record;
begin
  select delivery_status, failure_reason into v_501 from public.outbound_message_outbox where id = '48800000-0000-0000-0000-000000000501';
  select delivery_status, failure_reason into v_502 from public.outbound_message_outbox where id = '48800000-0000-0000-0000-000000000502';
  select delivery_status, failure_reason into v_504 from public.outbound_message_outbox where id = '48800000-0000-0000-0000-000000000504';

  if v_501.delivery_status <> 'failed' or v_501.failure_reason <> 'staff_window_expired' then
    raise exception 'expected pending expired staff row 501 to be terminalized, got % / %', v_501.delivery_status, v_501.failure_reason;
  end if;
  if v_502.delivery_status <> 'failed' or v_502.failure_reason <> 'staff_window_expired' then
    raise exception 'expected processing expired staff row 502 to be terminalized, got % / %', v_502.delivery_status, v_502.failure_reason;
  end if;
  if v_504.delivery_status <> 'failed' or v_504.failure_reason <> 'staff_window_expired' then
    raise exception 'expected attempt-3 expired staff row 504 to prioritize window expiry, got % / %', v_504.delivery_status, v_504.failure_reason;
  end if;
  if exists (
    select 1 from public.staff_work_items
    where source_outbox_id in (
      '48800000-0000-0000-0000-000000000501',
      '48800000-0000-0000-0000-000000000502',
      '48800000-0000-0000-0000-000000000504'
    )
  ) then
    raise exception 'staff-window expiry must not be mislabeled as send_attempts_exhausted';
  end if;
end;
$$;

-- =========================================================================
-- 15. Accept copies staff origin into messages; automation acceptance still
--     records automation origin.
-- =========================================================================

do $$
declare
  v_claim record;
  v_accept record;
  v_msg public.messages%rowtype;
begin
  -- Section 14 already claimed row 503 while proving expired staff rows are
  -- skipped. Reuse its persisted claim token instead of claiming globally a
  -- second time.
  select 'claimed'::text as result, oo.id as outbox_id,
         oo.delivery_claim_token as claim_token
    into v_claim
  from public.outbound_message_outbox oo
  where oo.id = '48800000-0000-0000-0000-000000000503'
    and oo.delivery_status = 'processing';
  if v_claim.outbox_id is null or v_claim.claim_token is null then
    raise exception 'expected automation row 503 to retain the section 14 claim';
  end if;

  select * into v_accept from public.accept_outbound_message(v_claim.outbox_id, v_claim.claim_token, '048-provider-automation-1');
  if v_accept.result <> 'accepted' then
    raise exception 'expected accepted for automation row 503, got %', v_accept.result;
  end if;

  select * into v_msg from public.messages where whatsapp_message_id = '048-provider-automation-1';
  if v_msg.outbound_origin <> 'automation' or v_msg.staff_actor_user_id is not null then
    raise exception 'expected automation origin with null actor on accepted automation message';
  end if;
end;
$$;

do $$
declare
  v_claim record;
  v_accept record;
  v_msg public.messages%rowtype;
begin
  -- Claim and accept the earlier happy-path staff row (conversation 031).
  select * into v_claim from public.claim_outbound_message_v2();
  if v_claim.result <> 'claimed' or not exists (
    select 1 from public.outbound_message_outbox oo
    where oo.id = v_claim.outbox_id
      and oo.staff_request_id = '48800000-0000-0000-0000-000000000401'
  ) then
    raise exception 'expected to claim the exact happy-path staff row, got % / %', v_claim.result, v_claim.outbox_id;
  end if;

  select * into v_accept from public.accept_outbound_message(v_claim.outbox_id, v_claim.claim_token, '048-provider-staff-1');
  if v_accept.result <> 'accepted' then
    raise exception 'expected accepted for the staff row, got %', v_accept.result;
  end if;

  select * into v_msg from public.messages where whatsapp_message_id = '048-provider-staff-1';
  if v_msg.outbound_origin <> 'staff' or v_msg.staff_actor_user_id <> '48800000-0000-0000-0000-000000000101' then
    raise exception 'expected staff origin with the actor on accepted staff message';
  end if;
end;
$$;

-- =========================================================================
-- 16. Auth-user deletion nulls the actor without deleting message/outbox
--     history.
-- =========================================================================

set local role authenticated;
select set_config('request.jwt.claim.sub', '48800000-0000-0000-0000-000000000105', true);
do $$
declare
  v_outbox_id uuid;
begin
  select outbox_id into v_outbox_id from public.queue_staff_reply_v1(
    '48800000-0000-0000-0000-000000000205', '48800000-0000-0000-0000-000000000405', 'silinecek personel yanıtı'
  );
  perform pg_catalog.set_config('vetai_test.erasure_outbox_id', v_outbox_id::text, true);
end;
$$;
reset role;

delete from auth.users where id = '48800000-0000-0000-0000-000000000105';

do $$
declare
  v_outbox_id uuid := current_setting('vetai_test.erasure_outbox_id')::uuid;
begin
  if not exists (select 1 from public.outbound_message_outbox where id = v_outbox_id and staff_actor_user_id is null) then
    raise exception 'expected staff_actor_user_id to be nulled after Auth-user deletion, row preserved otherwise';
  end if;
  if not exists (select 1 from public.staff_work_items where id = '48800000-0000-0000-0000-000000000205' and assigned_to is null) then
    raise exception 'expected the work item assignee to be nulled after Auth-user deletion';
  end if;
end;
$$;

-- =========================================================================
-- Residue check inside the transaction: everything above rolls back.
-- =========================================================================

do $$
declare
  v_counts integer[];
begin
  select array[
    (select count(*) from public.clinics where id::text like '48800000-%'),
    (select count(*) from public.conversations where id::text like '48800000-%'),
    (select count(*) from public.messages where clinic_id::text like '48800000-%'),
    (select count(*) from public.staff_work_items where id::text like '48800000-%'),
    (select count(*) from public.outbound_message_outbox where clinic_id::text like '48800000-%'),
    (select count(*) from auth.users where id::text like '48800000-%')
  ] into v_counts;
  if v_counts <> array[3, 8, 11, 11, 9, 4] then
    raise exception 'unexpected fixture counts before rollback: %', v_counts;
  end if;
end;
$$;

rollback;

-- Outside the rolled-back transaction: prove zero residue was left behind.
do $$
declare
  v_counts integer[];
begin
  select array[
    (select count(*) from public.clinics where id::text like '48800000-%'),
    (select count(*) from public.conversations where id::text like '48800000-%'),
    (select count(*) from public.messages where clinic_id::text like '48800000-%'),
    (select count(*) from public.staff_work_items where id::text like '48800000-%'),
    (select count(*) from public.outbound_message_outbox where clinic_id::text like '48800000-%'),
    (select count(*) from auth.users where id::text like '48800000-%')
  ] into v_counts;
  if v_counts <> array[0, 0, 0, 0, 0, 0] then
    raise exception 'expected zero residual 048 fixture rows after rollback: %', v_counts;
  end if;
end;
$$;
