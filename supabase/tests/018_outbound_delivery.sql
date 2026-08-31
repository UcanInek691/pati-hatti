-- Rollback-only proof for the outbound delivery claim/send/accept lifecycle
-- (public.claim_outbound_message, public.release_outbound_message,
-- public.accept_outbound_message, and the outbox delivery-state columns).
-- Never run this fixture script against a real clinic database.
--
-- Single-session limit: this fixture proves the documented result/state
-- contract inside one PostgreSQL session and cannot itself prove true lock
-- contention across separate connections, a real Worker crash, or genuine
-- Meta HTTP behavior; those are reviewed from PostgreSQL's documented
-- `FOR UPDATE ... SKIP LOCKED` semantics and this task's mocked TypeScript
-- tests instead of exercised directly here.
-- Validated against disposable `vetai-test` on 2026-08-09; never run this
-- fixture against a real clinic database.

begin;

insert into public.clinics (id, name)
values ('18000000-0000-0000-0000-000000000001', 'Delivery Test Clinic A');

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('18000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000001', '918000001');

insert into public.clinics (id, name)
values ('18000000-0000-0000-0000-000000000003', 'Delivery Test Clinic B');

-- Task 041: clinics default to suspended; activate this fixture's clinics so
-- the existing AI/ingest/outbound assertions below stay unchanged.
update public.clinics set operational_status = 'active', suspended_at = null
where operational_status = 'suspended';

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('18000000-0000-0000-0000-000000000004', '18000000-0000-0000-0000-000000000003', '918000002');

-- Local helper: runs the already-reviewed ingest -> claim -> finalize path
-- (unchanged by this migration) to produce one real, atomically-persisted
-- pending outbox row, exactly like a live intake reply would. Lives in
-- pg_temp so it vanishes with this session/transaction; it never becomes
-- part of the public schema.
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
-- Fixture 1: a Task 017-style finalize-produced pending row already has a
-- coherent, immediately-due delivery state (no separate backfill step is
-- observable from the caller's side).
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_row record;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D1', 'a', '+15550011111', 'Delivery Owner One', 'intake_received', 'Bilgileri aldik.'
  );

  select * into v_row from public.outbound_message_outbox where id = v_outbox_id;

  if v_row.delivery_status <> 'pending'
    or v_row.delivery_claim_token is not null
    or v_row.delivery_lease_until is not null
    or v_row.delivery_attempt_count <> 0
    or v_row.next_attempt_at is null
    or v_row.next_attempt_at > now()
    or v_row.provider_message_id is not null
    or v_row.accepted_at is not null
    or v_row.failed_at is not null
    or v_row.failure_reason is not null then
    raise exception 'expected a freshly finalized row to be immediately-due pending with zero attempts, got %', to_json(v_row);
  end if;

  -- Keep later oldest-due fixtures independent inside this shared transaction.
  delete from public.outbound_message_outbox where id = v_outbox_id;
end;
$$;

-- =========================================================================
-- Fixture 2: oldest-due claim returns the exact account/recipient/content,
-- increments the attempt, and sets a fresh token/lease. A second sequential
-- claim cannot claim the same still-live lease.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_claim record;
  v_first_token uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D2', 'b', '+15550022222', 'Delivery Owner Two', 'complaint', 'Sikayetiniz icin tesekkurler.'
  );

  select * into v_claim from public.claim_outbound_message();
  if v_claim.result <> 'claimed'
    or v_claim.outbox_id <> v_outbox_id
    or v_claim.claim_token is null
    or v_claim.phone_number_id <> '918000001'
    or v_claim.recipient_e164 <> '+15550022222'
    or v_claim.content <> 'Sikayetiniz icin tesekkurler.'
    or v_claim.attempt_count <> 1 then
    raise exception 'expected claimed/D2/918000001/attempt 1, got %', to_json(v_claim);
  end if;
  v_first_token := v_claim.claim_token;

  if (select delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'processing' then
    raise exception 'expected D2 to be processing after claim';
  end if;
  if (select delivery_lease_until from public.outbound_message_outbox where id = v_outbox_id) <= now() then
    raise exception 'expected D2 lease to be in the future';
  end if;

  -- No other row is due and D2's lease is still live: nothing to claim.
  select * into v_claim from public.claim_outbound_message();
  if v_claim.result <> 'empty' or v_claim.outbox_id is not null then
    raise exception 'expected empty while the only row has a live lease, got %', to_json(v_claim);
  end if;

  -- Simulate a worker crash: expire the lease without exhausting attempts.
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;

  select * into v_claim from public.claim_outbound_message();
  if v_claim.result <> 'claimed' or v_claim.outbox_id <> v_outbox_id or v_claim.attempt_count <> 2 then
    raise exception 'expected reclaim of D2 at attempt 2, got %', to_json(v_claim);
  end if;
  if v_claim.claim_token = v_first_token then
    raise exception 'expected the reclaim to mint a different token than the first claim';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: release schedules a two-minute retry below attempt three, and
-- terminates at attempt three. Wrong/stale tokens cannot release or accept.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_token uuid;
  v_wrong_token uuid := '99999999-9999-9999-9999-999999999999';
  v_release record;
begin
  select id, delivery_claim_token into v_outbox_id, v_token
  from public.outbound_message_outbox
  where source_provider_message_id = 'wamid.D2';

  -- Wrong token: stale, mutates nothing.
  select * into v_release from public.release_outbound_message(v_outbox_id, v_wrong_token);
  if v_release.result <> 'stale' then
    raise exception 'expected stale release for a wrong token, got %', v_release.result;
  end if;
  if (select delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'processing' then
    raise exception 'a stale release must not change delivery_status';
  end if;

  -- Correct token at attempt 2: retry_scheduled, ~2 minutes out, pending.
  select * into v_release from public.release_outbound_message(v_outbox_id, v_token);
  if v_release.result <> 'retry_scheduled' then
    raise exception 'expected retry_scheduled at attempt 2, got %', v_release.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id
      and delivery_status = 'pending'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and delivery_attempt_count = 2
      and next_attempt_at between now() + interval '1 minute 50 seconds' and now() + interval '2 minutes 10 seconds'
  ) then
    raise exception 'expected D2 to be pending with a ~2 minute next_attempt_at and unchanged attempt 2';
  end if;

  -- Force the retry due immediately, claim a third time (attempt -> 3).
  update public.outbound_message_outbox set next_attempt_at = now() where id = v_outbox_id;
  select claim_token into v_token from public.claim_outbound_message();
  if (select delivery_attempt_count from public.outbound_message_outbox where id = v_outbox_id) <> 3 then
    raise exception 'expected D2 to reach attempt 3 after the third claim';
  end if;

  -- Correct token at attempt 3: terminal failure, not another retry.
  select * into v_release from public.release_outbound_message(v_outbox_id, v_token);
  if v_release.result <> 'failed' then
    raise exception 'expected failed at attempt 3, got %', v_release.result;
  end if;
  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id
      and delivery_status = 'failed'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and failed_at is not null
      and failure_reason = 'attempts_exhausted'
      and delivery_attempt_count = 3
  ) then
    raise exception 'expected D2 to be terminally failed at attempt 3';
  end if;

end;
$$;

do $$
declare
  v_outbox_id uuid;
  v_accept record;
begin
  select id into v_outbox_id from public.outbound_message_outbox where source_provider_message_id = 'wamid.D2';
  select * into v_accept from public.accept_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999', 'wamid.SHOULD-NOT-APPLY');
  if v_accept.result <> 'stale' then
    raise exception 'expected stale when accepting a terminally failed row, got %', v_accept.result;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: an expired third-attempt processing row becomes exhausted/
-- failed instead of remaining poison work forever.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_newer_pending_id uuid;
  v_claim record;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D3', 'c', '+15550033333', 'Delivery Owner Three', 'pet_identity', 'Hangi evcil hayvanınız icin yaziyorsunuz?'
  );

  -- Drive it to attempt 3 without ever releasing/accepting, then expire it
  -- again, simulating a worker that crashed mid-send on its last try.
  perform public.claim_outbound_message();
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;
  perform public.claim_outbound_message();
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;
  perform public.claim_outbound_message();
  if (select delivery_attempt_count from public.outbound_message_outbox where id = v_outbox_id) <> 3 then
    raise exception 'expected D3 to reach attempt 3 before the exhaustion probe';
  end if;
  update public.outbound_message_outbox set delivery_lease_until = now() - interval '1 second' where id = v_outbox_id;

  -- A newer due row must not starve the older crashed third attempt.
  v_newer_pending_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D3-NEWER', '0', '+15550033334', 'Delivery Owner Three B', 'intake_received', 'Newer pending reply.'
  );

  select * into v_claim from public.claim_outbound_message();
  if v_claim.result <> 'exhausted'
    or v_claim.outbox_id is not null
    or v_claim.claim_token is not null
    or v_claim.phone_number_id is not null
    or v_claim.recipient_e164 is not null
    or v_claim.content is not null
    or v_claim.attempt_count is not null then
    raise exception 'expected an all-null exhausted result, got %', to_json(v_claim);
  end if;

  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id
      and delivery_status = 'failed'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and failed_at is not null
      and failure_reason = 'attempts_exhausted'
      and delivery_attempt_count = 3
  ) then
    raise exception 'expected D3 to be terminally failed after the exhaustion claim';
  end if;

  -- Never resurfaces to a later claim.
  if (select count(*) from public.claim_outbound_message() where result = 'claimed' and outbox_id = v_outbox_id) <> 0 then
    raise exception 'a terminally failed row must never be claimed again';
  end if;

  delete from public.outbound_message_outbox where id = v_newer_pending_id;
end;
$$;

-- =========================================================================
-- Fixture 5: acceptance atomically inserts one outbound message row and
-- marks the outbox accepted; an exact replay returns already_accepted
-- without a duplicate. A different-provider replay raises. Real
-- `service_role` (not just the superuser test session) can run this path.
-- =========================================================================
set local role service_role;
do $$
declare
  v_outbox_id uuid;
  v_conversation_id uuid;
  v_token uuid;
  v_accept record;
  v_message_count integer;
  v_rejected boolean := false;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D4', 'd', '+15550044444', 'Delivery Owner Four', 'intake_received', 'Bilgileri aldik, tesekkurler.'
  );
  select conversation_id into v_conversation_id from public.outbound_message_outbox where id = v_outbox_id;

  select claim_token into v_token from public.claim_outbound_message();

  select * into v_accept from public.accept_outbound_message(v_outbox_id, v_token, 'wamid.PROVIDER-D4');
  if v_accept.result <> 'accepted' then
    raise exception 'expected accepted for D4, got %', v_accept.result;
  end if;

  if not exists (
    select 1 from public.messages
    where clinic_id = '18000000-0000-0000-0000-000000000001'
      and conversation_id = v_conversation_id
      and direction = 'outbound'
      and content = 'Bilgileri aldik, tesekkurler.'
      and whatsapp_message_id = 'wamid.PROVIDER-D4'
  ) then
    raise exception 'expected exactly one matching outbound history row for D4';
  end if;

  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id
      and delivery_status = 'accepted'
      and delivery_claim_token is null
      and delivery_lease_until is null
      and next_attempt_at is null
      and provider_message_id = 'wamid.PROVIDER-D4'
      and accepted_at is not null
  ) then
    raise exception 'expected D4 outbox row to be marked accepted with its provider id';
  end if;

  select count(*) into v_message_count from public.messages where whatsapp_message_id = 'wamid.PROVIDER-D4';

  -- Exact replay (e.g. the Worker's accept RPC succeeded but the response
  -- was lost): same provider id, stale token is irrelevant for a row
  -- already accepted with that exact id.
  select * into v_accept from public.accept_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999', 'wamid.PROVIDER-D4');
  if v_accept.result <> 'already_accepted' then
    raise exception 'expected already_accepted on an exact replay, got %', v_accept.result;
  end if;
  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.PROVIDER-D4') <> v_message_count then
    raise exception 'an exact replay must not insert a duplicate history row';
  end if;

  -- Different-provider replay must raise, not silently accept or overwrite.
  begin
    perform result from public.accept_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999', 'wamid.DIFFERENT-ID');
  exception
    when sqlstate 'P0001' then v_rejected := true;
  end;
  if not v_rejected then
    raise exception 'expected a different-provider replay to raise';
  end if;
  if (select provider_message_id from public.outbound_message_outbox where id = v_outbox_id) <> 'wamid.PROVIDER-D4' then
    raise exception 'a raised different-provider replay must not change the stored provider id';
  end if;
  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.DIFFERENT-ID') <> 0 then
    raise exception 'a raised different-provider replay must not insert a history row';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 6: a history-table provider-id collision raises and leaves the
-- outbox row unaccepted (no partial mutation).
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_conversation_id uuid;
  v_token uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D5', 'e', '+15550055555', 'Delivery Owner Five', 'human_handoff', 'Bir yetkiliyi arayin.'
  );
  select conversation_id into v_conversation_id from public.outbound_message_outbox where id = v_outbox_id;

  -- Pre-existing history row occupying the provider id within this clinic.
  insert into public.messages (clinic_id, conversation_id, direction, content, whatsapp_message_id)
  values ('18000000-0000-0000-0000-000000000001', v_conversation_id, 'outbound', 'Earlier send.', 'wamid.COLLIDE');

  select claim_token into v_token from public.claim_outbound_message();

  begin
    perform result from public.accept_outbound_message(v_outbox_id, v_token, 'wamid.COLLIDE');
    raise exception 'expected a history unique-index collision to raise';
  exception
    when unique_violation then null;
  end;

  if not exists (
    select 1 from public.outbound_message_outbox
    where id = v_outbox_id and delivery_status = 'processing' and delivery_claim_token = v_token
  ) then
    raise exception 'a raised history collision must leave the outbox row processing, unaccepted';
  end if;
  if (select count(*) from public.messages where clinic_id = '18000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.COLLIDE') <> 1 then
    raise exception 'a raised history collision must not insert a second colliding row';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 7: same-looking provider IDs across two different clinics remain
-- tenant-isolated (the history unique index is clinic-scoped).
-- =========================================================================
do $$
declare
  v_outbox_a uuid;
  v_outbox_b uuid;
  v_token_a uuid;
  v_token_b uuid;
  v_accept_a record;
  v_accept_b record;
begin
  v_outbox_a := pg_temp.make_outbox_row(
    '918000001', 'wamid.D6A', 'f', '+15550066661', 'Delivery Owner Six A', 'intake_received', 'Clinic A receipt.'
  );
  v_outbox_b := pg_temp.make_outbox_row(
    '918000002', 'wamid.D6B', '1', '+15550066662', 'Delivery Owner Six B', 'intake_received', 'Clinic B receipt.'
  );

  select claim_token into v_token_a from public.claim_outbound_message() where outbox_id = v_outbox_a;
  select claim_token into v_token_b from public.claim_outbound_message() where outbox_id = v_outbox_b;

  select * into v_accept_a from public.accept_outbound_message(v_outbox_a, v_token_a, 'wamid.SHARED-PROVIDER-ID');
  select * into v_accept_b from public.accept_outbound_message(v_outbox_b, v_token_b, 'wamid.SHARED-PROVIDER-ID');

  if v_accept_a.result <> 'accepted' or v_accept_b.result <> 'accepted' then
    raise exception 'expected both clinics to independently accept the same-looking provider id, got %/%', v_accept_a.result, v_accept_b.result;
  end if;
  if (select count(*) from public.messages where whatsapp_message_id = 'wamid.SHARED-PROVIDER-ID') <> 2 then
    raise exception 'expected exactly one history row per clinic for the shared-looking provider id';
  end if;
  if (select count(*) from public.messages where clinic_id = '18000000-0000-0000-0000-000000000001' and whatsapp_message_id = 'wamid.SHARED-PROVIDER-ID') <> 1
    or (select count(*) from public.messages where clinic_id = '18000000-0000-0000-0000-000000000003' and whatsapp_message_id = 'wamid.SHARED-PROVIDER-ID') <> 1 then
    raise exception 'the shared-looking provider id must resolve to one row per clinic, not a cross-tenant collision';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 8: raw state CHECK violations fail closed.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D7', '2', '+15550077777', 'Delivery Owner Seven', 'safety_questions', 'Kanama var mi?'
  );

  begin
    update public.outbound_message_outbox
      set delivery_status = 'processing', delivery_claim_token = null
      where id = v_outbox_id;
    raise exception 'expected a processing row with a null claim_token to violate the state CHECK';
  exception
    when check_violation then null;
  end;

  if (select delivery_status from public.outbound_message_outbox where id = v_outbox_id) <> 'pending' then
    raise exception 'a rejected CHECK violation must leave the row unchanged';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 9: `anon`/`authenticated` have no table privileges, no RLS
-- policy, and cannot execute any of the three new RPCs.
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
begin
  select id into v_outbox_id from public.outbound_message_outbox where source_provider_message_id = 'wamid.D7';

  set local role anon;
  begin
    perform 1 from public.outbound_message_outbox limit 1;
    raise exception 'expected anon to be denied table access';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.claim_outbound_message();
    raise exception 'expected anon to be denied claim_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.release_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999');
    raise exception 'expected anon to be denied release_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.accept_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999', 'wamid.DENIED');
    raise exception 'expected anon to be denied accept_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  reset role;

  set local role authenticated;
  begin
    perform 1 from public.outbound_message_outbox limit 1;
    raise exception 'expected authenticated to be denied table access';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.claim_outbound_message();
    raise exception 'expected authenticated to be denied claim_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.release_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999');
    raise exception 'expected authenticated to be denied release_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform result from public.accept_outbound_message(v_outbox_id, '99999999-9999-9999-9999-999999999999', 'wamid.DENIED');
    raise exception 'expected authenticated to be denied accept_outbound_message';
  exception
    when insufficient_privilege then null;
  end;
  reset role;
end;
$$;

-- =========================================================================
-- Fixture 10: parent erasure cascades remain intact with the new delivery
-- columns present (owner deletion still reaches a pending outbox row).
-- =========================================================================
do $$
declare
  v_outbox_id uuid;
  v_conversation_id uuid;
  v_owner_id uuid;
begin
  v_outbox_id := pg_temp.make_outbox_row(
    '918000001', 'wamid.D8', '3', '+15550088888', 'Delivery Owner Eight', 'intake_received', 'Cascade probe.'
  );
  select conversation_id into v_conversation_id from public.outbound_message_outbox where id = v_outbox_id;
  select owner_id into v_owner_id from public.conversations where id = v_conversation_id;

  delete from public.owners where id = v_owner_id;

  if exists (select 1 from public.outbound_message_outbox where id = v_outbox_id) then
    raise exception 'owner erasure must still cascade through conversations to the pending outbox row';
  end if;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in ('18000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000003')) as remaining_test_clinics,
  (select count(*) from public.whatsapp_accounts where id in ('18000000-0000-0000-0000-000000000002', '18000000-0000-0000-0000-000000000004')) as remaining_test_accounts,
  (select count(*) from public.outbound_message_outbox where clinic_id in ('18000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000003')) as remaining_test_outbox_rows,
  (select count(*) from public.messages where clinic_id in ('18000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000003')) as remaining_test_messages,
  (select count(*) from public.conversations where clinic_id in ('18000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000003')) as remaining_test_conversations,
  (select count(*) from public.owners where clinic_id in ('18000000-0000-0000-0000-000000000001', '18000000-0000-0000-0000-000000000003')) as remaining_test_owners;
