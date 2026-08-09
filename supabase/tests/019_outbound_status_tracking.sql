-- Rollback-only proof for outbound WhatsApp status callback tracking
-- (public.record_whatsapp_outbound_status and the
-- provider_delivery_status/provider_status_at summary columns on
-- outbound_message_outbox). Never run this fixture script against a real
-- clinic database.
--
-- Single-session limit: this fixture proves the documented rank/timestamp
-- result contract inside one PostgreSQL session and cannot itself prove true
-- lock contention across separate connections or genuine out-of-order
-- delivery from Meta; those are reviewed from the RPC's `for update of o`
-- locking and this task's mocked TypeScript tests instead of exercised
-- directly here.
-- Validated against disposable `vetai-test` on 2026-08-09. Production was
-- not touched.

begin;

insert into public.clinics (id, name)
values ('19000000-0000-0000-0000-000000000001', 'Status Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('19000000-0000-0000-0000-000000000002', '19000000-0000-0000-0000-000000000001', '919000001');

insert into public.clinics (id, name)
values ('19000000-0000-0000-0000-000000000003', 'Status Test Clinic B');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('19000000-0000-0000-0000-000000000004', '19000000-0000-0000-0000-000000000003', '919000002');

-- Local helper: runs the already-reviewed ingest -> claim -> finalize path
-- (unchanged by this migration) to produce one real pending outbox row,
-- exactly like a live intake reply would. Lives in pg_temp so it vanishes
-- with this session/transaction; it never becomes part of the public schema.
create function pg_temp.make_pending_outbox_row(
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
    raise exception 'make_pending_outbox_row: expected claimed for %, got %', p_provider_message_id, v_claim_result;
  end if;

  select result into v_finalize_result
  from public.finalize_intake_queue_job(
    v_conversation_id, p_provider_message_id, v_token, 1, 'complaint_collection', null,
    '{"note": "fixture"}'::jsonb, p_reply_category, p_reply_text
  );
  if v_finalize_result <> 'applied' then
    raise exception 'make_pending_outbox_row: expected applied for %, got %', p_provider_message_id, v_finalize_result;
  end if;

  select id into v_outbox_id
  from public.outbound_message_outbox
  where source_provider_message_id = p_provider_message_id
  order by created_at desc
  limit 1;

  return v_outbox_id;
end;
$$;

-- Local helper: drives a pending row all the way to `accepted`, exactly like
-- a live Task 018 send would, so this file can exercise the new status RPC
-- against a real accepted row with a known provider_message_id/recipient.
create function pg_temp.make_accepted_outbox_row(
  p_phone_number_id text,
  p_inbound_provider_message_id text,
  p_outbound_provider_message_id text,
  p_payload_hash_char text,
  p_sender_e164 text,
  p_owner_name text,
  p_reply_category text,
  p_reply_text text
) returns uuid
language plpgsql
as $$
declare
  v_outbox_id uuid;
  v_claim record;
  v_accept record;
begin
  v_outbox_id := pg_temp.make_pending_outbox_row(
    p_phone_number_id, p_inbound_provider_message_id, p_payload_hash_char, p_sender_e164, p_owner_name, p_reply_category, p_reply_text
  );

  select * into v_claim from public.claim_outbound_message() where outbox_id = v_outbox_id;
  if v_claim.result <> 'claimed' then
    raise exception 'make_accepted_outbox_row: expected outbound claim for %, got %', p_inbound_provider_message_id, v_claim.result;
  end if;

  select * into v_accept from public.accept_outbound_message(v_outbox_id, v_claim.claim_token, p_outbound_provider_message_id);
  if v_accept.result <> 'accepted' then
    raise exception 'make_accepted_outbox_row: expected accepted for %, got %', p_outbound_provider_message_id, v_accept.result;
  end if;

  return v_outbox_id;
end;
$$;

-- =========================================================================
-- Fixture 1: a Task 018 accepted row backfills both new columns null.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
begin
  v_outbox_id := pg_temp.make_accepted_outbox_row(
    '919000001', 'wamid.S1', 'wamid.OUT-S1', '1', '+15550091111', 'Status Owner One', 'intake_received', 'Bilgileri aldik.'
  );

  if exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id and (provider_delivery_status is not null or provider_status_at is not null)
  ) then
    raise exception 'expected a freshly accepted row to backfill both status columns null';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 2: the exact account/provider-id/recipient records `sent` under
-- real `service_role` (not just the superuser test session).
-- =========================================================================
set local role service_role;
do $$
declare
  v_outbox_id uuid;
  v_result record;
begin
  select id into v_outbox_id from public.outbound_message_outbox where provider_message_id = 'wamid.OUT-S1';

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'sent', '2026-08-09T10:00:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected recorded for the first sent status, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id and provider_delivery_status = 'sent' and provider_status_at = '2026-08-09T10:00:00Z'::timestamptz
  ) then
    raise exception 'expected S1 to be recorded as sent at the given timestamp';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 3: exact replay is a duplicate; same status with a newer timestamp
-- updates; same status with an older timestamp is stale.
-- =========================================================================
do $$
declare v_result record;
begin
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'sent', '2026-08-09T10:00:00Z'
  );
  if v_result.result <> 'duplicate' then
    raise exception 'expected duplicate for an exact replay, got %', v_result.result;
  end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'sent', '2026-08-09T10:05:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected recorded when the same status arrives with a newer timestamp, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where provider_message_id = 'wamid.OUT-S1' and provider_status_at = '2026-08-09T10:05:00Z'::timestamptz
  ) then
    raise exception 'expected the newer timestamp to be stored';
  end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'sent', '2026-08-09T09:00:00Z'
  );
  if v_result.result <> 'stale' then
    raise exception 'expected stale for an older same-status timestamp, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where provider_message_id = 'wamid.OUT-S1' and provider_status_at = '2026-08-09T10:05:00Z'::timestamptz
  ) then
    raise exception 'a stale callback must not change the stored timestamp';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: out-of-order higher rank advances even with an older
-- timestamp; a lower rank can never regress a higher rank regardless of
-- timestamp, all the way through delivered -> read.
-- =========================================================================
do $$
declare v_result record;
begin
  -- delivered (rank 3) arrives with an earlier timestamp than the currently
  -- stored sent/10:05, but must still advance because rank outranks time.
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'delivered', '2026-08-09T09:30:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected a higher-rank status to advance even with an older timestamp, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where provider_message_id = 'wamid.OUT-S1' and provider_delivery_status = 'delivered' and provider_status_at = '2026-08-09T09:30:00Z'::timestamptz
  ) then
    raise exception 'expected delivered/09:30 to be stored despite arriving out of order';
  end if;

  -- a late sent (rank 1) must never regress delivered (rank 3), even with a
  -- much newer timestamp.
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'sent', '2026-08-09T12:00:00Z'
  );
  if v_result.result <> 'stale' then
    raise exception 'expected a lower-rank status to never regress delivered, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where provider_message_id = 'wamid.OUT-S1' and provider_delivery_status = 'delivered'
  ) then
    raise exception 'a lower-rank replay must not change the stored status';
  end if;

  -- advance to read (rank 4), then prove read cannot be regressed by
  -- delivered (rank 3) either, even with a much newer timestamp.
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'read', '2026-08-09T09:45:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected read to advance from delivered, got %', v_result.result;
  end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S1', '+15550091111', 'delivered', '2026-08-09T23:00:00Z'
  );
  if v_result.result <> 'stale' then
    raise exception 'expected delivered to never regress read, even with a much newer timestamp, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where provider_message_id = 'wamid.OUT-S1' and provider_delivery_status = 'read'
  ) then
    raise exception 'read must remain the stored status after a lower-rank replay';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 5: `failed` may supersede `sent`, and is later superseded by
-- `delivered` (rank sent=1 < failed=2 < delivered=3 < read=4).
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_result record;
begin
  v_outbox_id := pg_temp.make_accepted_outbox_row(
    '919000001', 'wamid.S2', 'wamid.OUT-S2', '2', '+15550092222', 'Status Owner Two', 'complaint', 'Sikayetiniz alindi.'
  );

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S2', '+15550092222', 'sent', '2026-08-09T10:00:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected S2 initial sent to record, got %', v_result.result;
  end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S2', '+15550092222', 'failed', '2026-08-09T10:01:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected failed to supersede sent, got %', v_result.result;
  end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S2', '+15550092222', 'delivered', '2026-08-09T10:02:00Z'
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected delivered to supersede failed, got %', v_result.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id and provider_delivery_status = 'delivered'
  ) then
    raise exception 'expected S2 to end at delivered after sent -> failed -> delivered';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 6: wrong account/provider-id/recipient, and a genuinely
-- non-accepted row, all return not_found with zero mutation. A pending
-- row's provider_message_id is structurally null (Task 018's delivery-state
-- CHECK), so it can never satisfy the lookup.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_before timestamptz;
  v_result record;
begin
  select provider_status_at into v_before from public.outbound_message_outbox where provider_message_id = 'wamid.OUT-S2';

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000002', 'wamid.OUT-S2', '+15550092222', 'read', now()
  );
  if v_result.result <> 'not_found' then raise exception 'expected not_found for the wrong account, got %', v_result.result; end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-DOES-NOT-EXIST', '+15550092222', 'read', now()
  );
  if v_result.result <> 'not_found' then raise exception 'expected not_found for an unknown provider message id, got %', v_result.result; end if;

  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S2', '+15559999999', 'read', now()
  );
  if v_result.result <> 'not_found' then raise exception 'expected not_found for the wrong recipient, got %', v_result.result; end if;

  v_outbox_id := pg_temp.make_pending_outbox_row(
    '919000001', 'wamid.S3', '3', '+15550093333', 'Status Owner Three', 'intake_received', 'Henuz kabul edilmedi.'
  );
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S3-NEVER-ACCEPTED', '+15550093333', 'sent', now()
  );
  if v_result.result <> 'not_found' then raise exception 'expected not_found for a non-accepted row, got %', v_result.result; end if;
  if (select delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'pending' then
    raise exception 'a not_found lookup must never mutate an unrelated pending row';
  end if;

  if (select provider_status_at from public.outbound_message_outbox where provider_message_id = 'wamid.OUT-S2') <> v_before then
    raise exception 'a not_found lookup must never mutate an unrelated accepted row';
  end if;

  -- Keep later fixture claims isolated from this deliberately pending row.
  delete from public.outbound_message_outbox where id = v_outbox_id;
end;
$$;

-- =========================================================================
-- Fixture 7: invalid inputs raise (roll back) instead of returning a
-- result, and leave the row completely unchanged.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_rejected boolean;
begin
  v_outbox_id := (select id from public.outbound_message_outbox where provider_message_id = 'wamid.OUT-S2');

  v_rejected := false;
  begin
    perform result from public.record_whatsapp_outbound_status('abc123', 'wamid.OUT-S2', '+15550092222', 'read', now());
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a non-numeric phone_number_id to raise'; end if;

  v_rejected := false;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', '', '+15550092222', 'read', now());
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected an empty provider_message_id to raise'; end if;

  v_rejected := false;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', 'wamid.OUT-S2', '15550092222', 'read', now());
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a recipient missing the leading + to raise'; end if;

  v_rejected := false;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', 'wamid.OUT-S2', '+15550092222', 'queued', now());
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected an unsupported provider_status to raise'; end if;

  v_rejected := false;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', 'wamid.OUT-S2', '+15550092222', 'read', null);
  exception when others then v_rejected := true;
  end;
  if not v_rejected then raise exception 'expected a null provider_timestamp to raise'; end if;

  if (select provider_delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'delivered' then
    raise exception 'invalid-input rejections must never mutate S2''s stored status';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 8: a raw CHECK violation on the summary columns fails closed and
-- leaves the row unchanged.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
begin
  v_outbox_id := (select id from public.outbound_message_outbox where provider_message_id = 'wamid.OUT-S2');

  begin
    update public.outbound_message_outbox
      set provider_delivery_status = 'sent', provider_status_at = null
      where id = v_outbox_id;
    raise exception 'expected a non-null provider_delivery_status with a null provider_status_at to violate the CHECK';
  exception
    when check_violation then null;
  end;

  begin
    update public.outbound_message_outbox
      set provider_delivery_status = null, provider_status_at = now()
      where id = v_outbox_id;
    raise exception 'expected a null provider_delivery_status with a non-null provider_status_at to violate the CHECK';
  exception
    when check_violation then null;
  end;

  if (select provider_delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'delivered' then
    raise exception 'a rejected CHECK violation must leave the row unchanged';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 9: `anon`/`authenticated` cannot execute the new RPC. No new RLS
-- policies were added, so table access remains exactly as Task 017/018 left
-- it (proven there; not re-proven here).
-- =========================================================================
do $$
begin
  set local role anon;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', 'wamid.OUT-S2', '+15550092222', 'read', now());
    raise exception 'expected anon to be denied record_whatsapp_outbound_status';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role authenticated;
  begin
    perform result from public.record_whatsapp_outbound_status('919000001', 'wamid.OUT-S2', '+15550092222', 'read', now());
    raise exception 'expected authenticated to be denied record_whatsapp_outbound_status';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- =========================================================================
-- Fixture 10: same-looking provider IDs across two different clinics stay
-- tenant-isolated (the lookup joins through each clinic's own account).
-- =========================================================================
do $$
declare
  v_outbox_a uuid;
  v_outbox_b uuid;
  v_result_a record;
  v_result_b record;
begin
  v_outbox_a := pg_temp.make_accepted_outbox_row(
    '919000001', 'wamid.T1A', 'wamid.SHARED-STATUS-ID', '4', '+15550094441', 'Status Owner Four A', 'intake_received', 'Clinic A receipt.'
  );
  v_outbox_b := pg_temp.make_accepted_outbox_row(
    '919000002', 'wamid.T1B', 'wamid.SHARED-STATUS-ID', '5', '+15550094442', 'Status Owner Four B', 'intake_received', 'Clinic B receipt.'
  );

  select * into v_result_a from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.SHARED-STATUS-ID', '+15550094441', 'delivered', now()
  );
  if v_result_a.result <> 'recorded' then
    raise exception 'expected clinic A to record its own shared-looking provider id, got %', v_result_a.result;
  end if;

  if (select provider_delivery_status from public.outbound_message_outbox where id = v_outbox_b) is not null then
    raise exception 'recording clinic A''s status must never leak into clinic B''s same-looking provider id';
  end if;

  select * into v_result_b from public.record_whatsapp_outbound_status(
    '919000002', 'wamid.SHARED-STATUS-ID', '+15550094442', 'sent', now()
  );
  if v_result_b.result <> 'recorded' then
    raise exception 'expected clinic B to independently record the same-looking provider id, got %', v_result_b.result;
  end if;
  if (select provider_delivery_status from public.outbound_message_outbox where id = v_outbox_a) <> 'delivered' then
    raise exception 'clinic B''s recording must not affect clinic A''s already-recorded status';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 11: parent erasure cascades remain intact with the new status
-- columns populated (owner deletion still reaches an accepted, status-
-- tracked outbox row).
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_conversation_id uuid;
  v_owner_id uuid;
  v_result record;
begin
  v_outbox_id := pg_temp.make_accepted_outbox_row(
    '919000001', 'wamid.S4', 'wamid.OUT-S4', '6', '+15550095555', 'Status Owner Five', 'intake_received', 'Cascade probe.'
  );
  select * into v_result from public.record_whatsapp_outbound_status(
    '919000001', 'wamid.OUT-S4', '+15550095555', 'delivered', now()
  );
  if v_result.result <> 'recorded' then
    raise exception 'expected S4 delivered status to record before the cascade probe, got %', v_result.result;
  end if;

  select conversation_id into v_conversation_id from public.outbound_message_outbox where id = v_outbox_id;
  select owner_id into v_owner_id from public.conversations where id = v_conversation_id;

  delete from public.owners where id = v_owner_id;

  if exists (select 1 from public.outbound_message_outbox where id = v_outbox_id) then
    raise exception 'owner erasure must still cascade through conversations to an accepted row carrying a status summary';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('19000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000003')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('19000000-0000-0000-0000-000000000002', '19000000-0000-0000-0000-000000000004')) as remaining_test_accounts,
  (select count(*) from public.outbound_message_outbox where clinic_id in ('19000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000003')) as remaining_test_outbox_rows,
  (select count(*) from public.messages where clinic_id in ('19000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000003')) as remaining_test_messages,
  (select count(*) from public.conversations where clinic_id in ('19000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000003')) as remaining_test_conversations,
  (select count(*) from public.owners where clinic_id in ('19000000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000003')) as remaining_test_owners;
