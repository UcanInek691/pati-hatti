-- Rollback-only proof for Task 032: staff_work_items status/audit columns,
-- public.mark_staff_work_item_seen, public.claim_staff_work_item, and the
-- replaced public.resolve_staff_work_item. Never run this fixture script
-- against a real clinic database.
--
-- Single-session limit: this fixture proves the documented row-state
-- contract inside one PostgreSQL session using sequential calls. It does not
-- and cannot execute true two-session lock contention; the "for update" row
-- lock is instead verified from the stored function definitions, matching
-- Task 021's fixture.
-- Codex ran this fixture on disposable vetai-test on 2026-08-14: PASS with
-- zero remaining test clinics, users, work items, or outbox rows.

begin;

-- =========================================================================
-- Fixtures: two clinics, five Auth users (two persistent staff and one
-- disposable erasure-test staff at clinic A, one staff at clinic B, one
-- authenticated user with no clinic membership), and one WhatsApp account
-- for the automatic provider-failure case.
-- =========================================================================

insert into public.clinics (id, name)
values
  ('99800000-0000-0000-0000-000000000001', 'Staff Assignment Test Clinic A'),
  ('99800000-0000-0000-0000-000000000002', 'Staff Assignment Test Clinic B');

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('99810000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'saa-a1@example.invalid', now(), now()),
  ('99810000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'saa-a2@example.invalid', now(), now()),
  ('99810000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'saa-b@example.invalid', now(), now()),
  ('99810000-0000-0000-0000-000000000004', 'authenticated', 'authenticated', 'saa-nostaff@example.invalid', now(), now()),
  ('99810000-0000-0000-0000-000000000005', 'authenticated', 'authenticated', 'saa-erasure@example.invalid', now(), now());

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000001', 'admin'),
  ('99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000002', 'admin'),
  ('99800000-0000-0000-0000-000000000001', '99810000-0000-0000-0000-000000000005', 'admin'),
  ('99800000-0000-0000-0000-000000000002', '99810000-0000-0000-0000-000000000003', 'admin');
-- 99810000-...-000004 intentionally has no clinic_staff row.

insert into public.whatsapp_accounts (id, clinic_id, phone_number_id)
values ('99840000-0000-0000-0000-000000000001', '99800000-0000-0000-0000-000000000001', '998400001');

-- Local helper: creates one owner/conversation and drives it into
-- human_handoff, producing exactly one open staff_work_items row through the
-- unchanged Task 020 trigger. Returns that item's id.
create function pg_temp.make_handoff_item(
  p_clinic_id uuid, p_owner_id uuid, p_owner_name text, p_owner_phone text, p_conv_id uuid
) returns uuid
language plpgsql
as $$
declare
  v_item_id uuid;
begin
  insert into public.owners (id, clinic_id, full_name, phone_e164)
  values (p_owner_id, p_clinic_id, p_owner_name, p_owner_phone);
  insert into public.conversations (id, clinic_id, owner_id) values (p_conv_id, p_clinic_id, p_owner_id);
  update public.conversations set intake_stage = 'human_handoff', intake_data = '{}'::jsonb where id = p_conv_id;
  select id into v_item_id from public.staff_work_items where conversation_id = p_conv_id;
  return v_item_id;
end;
$$;

-- Local helper: runs the already-reviewed ingest -> claim -> finalize path
-- to produce one real, atomically-persisted pending outbox row. Copied from
-- supabase/tests/020_staff_work_items.sql / 018_outbound_delivery.sql.
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
-- Scenario items, created while running as the unrestricted session role
-- (matching Task 020/021 convention).
-- =========================================================================

do $$
declare
  v_item_full uuid;
  v_item_claim_direct uuid;
  v_item_identity uuid;
  v_item_busy uuid;
  v_item_reclaim uuid;
  v_item_not_claimed uuid;
  v_item_no_staff uuid;
  v_item_cross uuid;
begin
  v_item_full := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000001',
    'Full Flow Owner', '+15559940001', '99830000-0000-0000-0000-000000000001'
  );
  v_item_claim_direct := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000002',
    'Claim Direct Owner', '+15559940002', '99830000-0000-0000-0000-000000000002'
  );
  v_item_identity := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000003',
    'Identity Owner', '+15559940003', '99830000-0000-0000-0000-000000000003'
  );
  v_item_busy := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000004',
    'Busy Owner', '+15559940004', '99830000-0000-0000-0000-000000000004'
  );
  v_item_reclaim := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000005',
    'Reclaim Owner', '+15559940005', '99830000-0000-0000-0000-000000000005'
  );
  v_item_not_claimed := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000006',
    'Not Claimed Owner', '+15559940006', '99830000-0000-0000-0000-000000000006'
  );
  v_item_no_staff := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000001', '99820000-0000-0000-0000-000000000007',
    'No Staff Owner', '+15559940007', '99830000-0000-0000-0000-000000000007'
  );
  v_item_cross := pg_temp.make_handoff_item(
    '99800000-0000-0000-0000-000000000002', '99820000-0000-0000-0000-000000000008',
    'Cross Clinic Owner', '+15559940008', '99830000-0000-0000-0000-000000000008'
  );

  create table pg_temp.item_ids (key text primary key, value uuid not null);
  grant select on pg_temp.item_ids to authenticated;

  insert into pg_temp.item_ids (key, value) values
    ('full', v_item_full),
    ('claim_direct', v_item_claim_direct),
    ('identity', v_item_identity),
    ('busy', v_item_busy),
    ('reclaim', v_item_reclaim),
    ('not_claimed', v_item_not_claimed),
    ('no_staff', v_item_no_staff),
    ('cross', v_item_cross);
end;
$$;

-- =========================================================================
-- Fixture 0: existing open-row compatibility (no invented backfill values)
-- and function/table shape unchanged by this migration.
-- =========================================================================
do $$
declare
  v_row public.staff_work_items%rowtype;
  v_item_full uuid := (select value from pg_temp.item_ids where key = 'full');
begin
  select * into v_row from public.staff_work_items where id = v_item_full;
  if v_row.status <> 'open'
    or v_row.first_seen_at is not null or v_row.first_seen_by is not null
    or v_row.assigned_at is not null or v_row.assigned_to is not null
    or v_row.resolved_at is not null or v_row.resolved_by is not null then
    raise exception 'expected a freshly created open row to satisfy the new checks with all new columns null, got %', to_json(v_row);
  end if;
end;
$$;

do $$
declare
  v_proc record;
  v_def text;
  v_grantees text[];
  v_fn text;
begin
  foreach v_fn in array array['mark_staff_work_item_seen', 'claim_staff_work_item', 'resolve_staff_work_item']
  loop
    select p.prosecdef, p.provolatile, p.proconfig,
           pg_catalog.pg_get_userbyid(p.proowner)::text as owner_name
      into v_proc
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if not v_proc.prosecdef then
      raise exception 'expected % to be SECURITY DEFINER', v_fn;
    end if;
    if v_proc.provolatile <> 'v' then
      raise exception 'expected % to be VOLATILE, got %', v_fn, v_proc.provolatile;
    end if;
    if v_proc.proconfig is null or not (
      v_proc.proconfig @> array['search_path=']
      or v_proc.proconfig @> array['search_path=""']
    ) then
      raise exception 'expected % to SET search_path = '''', got %', v_fn, v_proc.proconfig;
    end if;

    select pg_catalog.pg_get_functiondef(p.oid) into v_def
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = v_fn;

    if v_def !~* 'for update' then
      raise exception 'expected % to lock the row with FOR UPDATE', v_fn;
    end if;

    select array_agg(distinct grantee::text order by grantee::text)
      into v_grantees
    from information_schema.routine_privileges
    where routine_schema = 'public' and routine_name = v_fn;

    if not ('authenticated' = any(v_grantees)) or exists (
      select 1 from unnest(v_grantees) as grantee
      where grantee not in ('authenticated', v_proc.owner_name)
    ) then
      raise exception 'expected only authenticated plus the function owner to have % privileges, got %', v_fn, v_grantees;
    end if;
  end loop;

  if not (
    select c.relrowsecurity
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'staff_work_items'
  ) then
    raise exception 'expected RLS to remain enabled on staff_work_items';
  end if;

  if (select count(*) from pg_catalog.pg_policies where schemaname = 'public' and tablename = 'staff_work_items') <> 1 then
    raise exception 'expected exactly one unchanged policy on staff_work_items';
  end if;

  if exists (
    select 1 from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'anon'
  ) then
    raise exception 'expected anon to have no staff_work_items grant';
  end if;

  if (
    select array_agg(distinct privilege_type::text order by privilege_type::text)
    from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'staff_work_items' and grantee = 'authenticated'
  ) is distinct from array['SELECT'] then
    raise exception 'expected authenticated to have exactly SELECT on staff_work_items';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 1: unauthorized execution of all three RPCs is denied outright.
-- =========================================================================
set local role anon;
do $$
begin
  begin
    perform result from public.mark_staff_work_item_seen('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected anon to be denied execute on mark_staff_work_item_seen';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.claim_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected anon to be denied execute on claim_staff_work_item';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected anon to be denied execute on resolve_staff_work_item';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

set local role service_role;
do $$
begin
  begin
    perform result from public.mark_staff_work_item_seen('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected service_role to be denied execute on mark_staff_work_item_seen';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.claim_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected service_role to be denied execute on claim_staff_work_item';
  exception when insufficient_privilege then null;
  end;
  begin
    perform result from public.resolve_staff_work_item('00000000-0000-0000-0000-000000000000'::uuid);
    raise exception 'expected service_role to be denied execute on resolve_staff_work_item';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 2: full same-clinic pipeline by one staff member, with idempotent
-- results at every step and exact identity/timestamp fields.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000001', true);

do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'full');
  v_result text;
  v_row public.staff_work_items%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'seen' then
    raise exception 'expected seen for an open item, got %', v_result;
  end if;
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.status <> 'seen' or v_row.first_seen_at <> v_now
    or v_row.first_seen_by <> '99810000-0000-0000-0000-000000000001'
    or v_row.assigned_at is not null or v_row.assigned_to is not null
    or v_row.resolved_at is not null or v_row.resolved_by is not null then
    raise exception 'unexpected row after mark_staff_work_item_seen: %', to_json(v_row);
  end if;

  -- Idempotent: seen -> already_seen, zero mutation.
  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'already_seen' then
    raise exception 'expected already_seen on replay, got %', v_result;
  end if;

  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected claimed for a seen item, got %', v_result;
  end if;
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.status <> 'in_progress' or v_row.first_seen_at <> v_now
    or v_row.first_seen_by <> '99810000-0000-0000-0000-000000000001'
    or v_row.assigned_at <> v_now or v_row.assigned_to <> '99810000-0000-0000-0000-000000000001'
    or v_row.resolved_at is not null or v_row.resolved_by is not null then
    raise exception 'unexpected row after claim_staff_work_item: %', to_json(v_row);
  end if;

  -- Idempotent: same assignee claims again -> already_claimed, zero mutation.
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'already_claimed' then
    raise exception 'expected already_claimed on replay by the same assignee, got %', v_result;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'resolved' then
    raise exception 'expected resolved for the current assignee, got %', v_result;
  end if;
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.status <> 'resolved' or v_row.resolved_at <> v_now
    or v_row.resolved_by <> '99810000-0000-0000-0000-000000000001' then
    raise exception 'unexpected row after resolve_staff_work_item: %', to_json(v_row);
  end if;

  -- Idempotent: resolved -> already_resolved, zero mutation (no rewrite).
  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'already_resolved' then
    raise exception 'expected already_resolved on replay, got %', v_result;
  end if;
end;
$$;

-- =========================================================================
-- Fixture 3: claim directly from open fills first-seen fields; a later
-- mark_staff_work_item_seen on the now in_progress row is a zero-mutation
-- already_seen.
-- =========================================================================
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'claim_direct');
  v_result text;
  v_row public.staff_work_items%rowtype;
  v_now timestamptz := pg_catalog.now();
begin
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected claimed directly from open, got %', v_result;
  end if;
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.status <> 'in_progress' or v_row.first_seen_at <> v_now
    or v_row.first_seen_by <> '99810000-0000-0000-0000-000000000001'
    or v_row.assigned_at <> v_now or v_row.assigned_to <> '99810000-0000-0000-0000-000000000001' then
    raise exception 'expected claim-from-open to fill first-seen fields, got %', to_json(v_row);
  end if;

  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'already_seen' then
    raise exception 'expected already_seen for an in_progress item, got %', v_result;
  end if;
  if exists (
    select 1 from public.staff_work_items where id = v_item and status <> 'in_progress'
  ) then
    raise exception 'expected zero mutation from mark_staff_work_item_seen on an in_progress item';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 4: claim from a seen item preserves the original first-seen
-- identity while assigning a different current user.
-- =========================================================================
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'identity');
  v_result text;
  v_row public.staff_work_items%rowtype;
begin
  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'seen' then
    raise exception 'expected seen, got %', v_result;
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000002', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'identity');
  v_result text;
  v_row public.staff_work_items%rowtype;
begin
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected the second staff member to claim a seen item, got %', v_result;
  end if;
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.first_seen_by <> '99810000-0000-0000-0000-000000000001' then
    raise exception 'expected claim to preserve the original first_seen_by identity, got %', v_row.first_seen_by;
  end if;
  if v_row.assigned_to <> '99810000-0000-0000-0000-000000000002' then
    raise exception 'expected the claiming user to become assigned_to, got %', v_row.assigned_to;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 5: a second same-clinic user cannot claim or resolve the current
-- owner's row (busy / not_owner), and the original owner's idempotent calls
-- are unaffected.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000001', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'busy');
  v_result text;
begin
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected the first staff member to claim, got %', v_result;
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000002', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'busy');
  v_result text;
  v_before public.staff_work_items%rowtype;
  v_after public.staff_work_items%rowtype;
begin
  select * into v_before from public.staff_work_items where id = v_item;

  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'busy' then
    raise exception 'expected busy for a different staff member, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation from a busy claim attempt';
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'not_owner' then
    raise exception 'expected not_owner for a different staff member, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation from a not_owner resolve attempt';
  end if;
end;
$$;
reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000001', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'busy');
  v_result text;
begin
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'already_claimed' then
    raise exception 'expected already_claimed for the current owner, got %', v_result;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'resolved' then
    raise exception 'expected the current owner to resolve, got %', v_result;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 6: an assignee erased via Auth-user deletion (ON DELETE SET NULL)
-- leaves a recoverable in_progress row; a non-assignee gets not_claimed
-- until another same-clinic user reclaims and resolves it.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000005', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'reclaim');
  v_result text;
begin
  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected the first staff member to claim, got %', v_result;
  end if;
end;
$$;
reset role;

-- Erase the assignee's Auth user as the unrestricted session role.
delete from auth.users where id = '99810000-0000-0000-0000-000000000005';

do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'reclaim');
  v_row public.staff_work_items%rowtype;
begin
  select * into v_row from public.staff_work_items where id = v_item;
  if v_row.status <> 'in_progress' or v_row.assigned_to is not null
    or v_row.first_seen_by is not null
    or v_row.first_seen_at is null or v_row.assigned_at is null then
    raise exception 'expected Auth-user erasure to null the actor UUIDs while keeping status/timestamps, got %', to_json(v_row);
  end if;
end;
$$;

set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000002', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'reclaim');
  v_result text;
  v_before public.staff_work_items%rowtype;
  v_after public.staff_work_items%rowtype;
begin
  select * into v_before from public.staff_work_items where id = v_item;
  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'not_claimed' then
    raise exception 'expected not_claimed for an in_progress row with an erased assignee, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation from a not_claimed resolve attempt';
  end if;

  select result into v_result from public.claim_staff_work_item(v_item);
  if v_result <> 'claimed' then
    raise exception 'expected another same-clinic user to reclaim an erased-assignee row, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_after.assigned_to <> '99810000-0000-0000-0000-000000000002' then
    raise exception 'expected the reclaiming user to become assigned_to, got %', v_after.assigned_to;
  end if;

  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'resolved' then
    raise exception 'expected the reclaiming user to resolve, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_after.resolved_by <> '99810000-0000-0000-0000-000000000002' then
    raise exception 'expected resolved_by to be the reclaiming user, got %', v_after.resolved_by;
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 7: resolve without a claim (open, then seen) returns not_claimed
-- with zero mutation.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000001', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'not_claimed');
  v_result text;
  v_before public.staff_work_items%rowtype;
  v_after public.staff_work_items%rowtype;
begin
  select * into v_before from public.staff_work_items where id = v_item;
  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'not_claimed' then
    raise exception 'expected not_claimed for an open item, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation resolving an open item';
  end if;

  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'seen' then
    raise exception 'expected seen, got %', v_result;
  end if;

  select * into v_before from public.staff_work_items where id = v_item;
  select result into v_result from public.resolve_staff_work_item(v_item);
  if v_result <> 'not_claimed' then
    raise exception 'expected not_claimed for a seen (unclaimed) item, got %', v_result;
  end if;
  select * into v_after from public.staff_work_items where id = v_item;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation resolving a seen (unclaimed) item';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 8: absent, cross-clinic, and no-membership targets are all
-- indistinguishably not_found with zero mutation; null ids fail before any
-- lookup.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000001', true);
do $$
declare
  v_item_cross uuid := (select value from pg_temp.item_ids where key = 'cross');
  v_unknown uuid := '99850000-0000-0000-0000-000000000099';
  v_result text;
  v_before public.staff_work_items%rowtype;
  v_after public.staff_work_items%rowtype;
  v_null_rejected boolean;
begin
  -- Cross-clinic item: not_found, zero mutation, for all three RPCs.
  select * into v_before from public.staff_work_items where id = v_item_cross;

  select result into v_result from public.mark_staff_work_item_seen(v_item_cross);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-clinic item (seen), got %', v_result;
  end if;
  select result into v_result from public.claim_staff_work_item(v_item_cross);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-clinic item (claim), got %', v_result;
  end if;
  select result into v_result from public.resolve_staff_work_item(v_item_cross);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a cross-clinic item (resolve), got %', v_result;
  end if;

  select * into v_after from public.staff_work_items where id = v_item_cross;
  if v_before is distinct from v_after then
    raise exception 'expected zero mutation of another clinic''s item';
  end if;

  -- Unknown id: not_found for all three RPCs.
  select result into v_result from public.mark_staff_work_item_seen(v_unknown);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown id (seen), got %', v_result;
  end if;
  select result into v_result from public.claim_staff_work_item(v_unknown);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown id (claim), got %', v_result;
  end if;
  select result into v_result from public.resolve_staff_work_item(v_unknown);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for an unknown id (resolve), got %', v_result;
  end if;

  -- Null id fails before lookup for all three RPCs.
  v_null_rejected := false;
  begin
    perform result from public.mark_staff_work_item_seen(null);
  exception when others then
    v_null_rejected := true;
  end;
  if not v_null_rejected then
    raise exception 'expected null work_item_id to raise for mark_staff_work_item_seen';
  end if;

  v_null_rejected := false;
  begin
    perform result from public.claim_staff_work_item(null);
  exception when others then
    v_null_rejected := true;
  end;
  if not v_null_rejected then
    raise exception 'expected null work_item_id to raise for claim_staff_work_item';
  end if;

  v_null_rejected := false;
  begin
    perform result from public.resolve_staff_work_item(null);
  exception when others then
    v_null_rejected := true;
  end;
  if not v_null_rejected then
    raise exception 'expected null work_item_id to raise for resolve_staff_work_item';
  end if;

  -- Direct table mutation remains denied for authenticated.
  begin
    update public.staff_work_items set status = 'seen', first_seen_at = now() where id = v_item_cross;
    raise exception 'expected authenticated direct UPDATE on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
    values ('99800000-0000-0000-0000-000000000001', '99830000-0000-0000-0000-000000000001', 'human_handoff', 'normal', 'human_handoff', 'open');
    raise exception 'expected authenticated direct INSERT on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from public.staff_work_items where id = v_item_cross;
    raise exception 'expected authenticated direct DELETE on staff_work_items to be denied';
  exception when insufficient_privilege then null;
  end;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 9: an authenticated caller with no clinic membership receives
-- not_found with zero mutation, even for an otherwise-valid open item.
-- =========================================================================
set local role authenticated;
select set_config('request.jwt.claim.sub', '99810000-0000-0000-0000-000000000004', true);
do $$
declare
  v_item uuid := (select value from pg_temp.item_ids where key = 'no_staff');
  v_result text;
begin
  select result into v_result from public.mark_staff_work_item_seen(v_item);
  if v_result <> 'not_found' then
    raise exception 'expected not_found for a caller with no clinic membership, got %', v_result;
  end if;
  if exists (select 1 from public.staff_work_items where id = v_item and status <> 'open') then
    raise exception 'expected zero mutation for a caller with no clinic membership';
  end if;
end;
$$;
reset role;

-- =========================================================================
-- Fixture 10: automatic provider_failed resolution covers both newly
-- reachable staff states and still resolves with resolved_by null.
-- =========================================================================
do $$
declare
  v_outbox_seen uuid;
  v_outbox_claimed uuid;
  v_item record;
begin
  v_outbox_seen := pg_temp.make_outbox_row(
    '998400001', 'wamid.T032-P1', 'e', '+15559950001', 'P1 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'accepted',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        provider_message_id = 'wamid.T032-P1-PROVIDER',
        accepted_at = now(),
        delivery_attempt_count = 1
    where id = v_outbox_seen;
  update public.outbound_message_outbox
    set provider_delivery_status = 'failed', provider_status_at = now()
    where id = v_outbox_seen;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_seen;
  if not found or v_item.status <> 'open' or v_item.reason <> 'provider_failed' then
    raise exception 'expected one open provider_failed item, got %', to_json(v_item);
  end if;

  update public.staff_work_items
    set status = 'seen',
        first_seen_at = pg_catalog.now(),
        first_seen_by = '99810000-0000-0000-0000-000000000001'
    where id = v_item.id;

  update public.outbound_message_outbox
    set provider_delivery_status = 'delivered', provider_status_at = now()
    where id = v_outbox_seen;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_seen;
  if v_item.status <> 'resolved' or v_item.resolved_at is null or v_item.resolved_by is not null then
    raise exception 'expected automatic provider_failed resolution from seen with resolved_by null, got %', to_json(v_item);
  end if;

  v_outbox_claimed := pg_temp.make_outbox_row(
    '998400001', 'wamid.T032-P2', 'f', '+15559950002', 'P2 Owner', 'intake_received', 'Bilgileri aldik.'
  );
  update public.outbound_message_outbox
    set delivery_status = 'accepted',
        delivery_claim_token = null,
        delivery_lease_until = null,
        next_attempt_at = null,
        provider_message_id = 'wamid.T032-P2-PROVIDER',
        accepted_at = now(),
        delivery_attempt_count = 1
    where id = v_outbox_claimed;
  update public.outbound_message_outbox
    set provider_delivery_status = 'failed', provider_status_at = now()
    where id = v_outbox_claimed;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_claimed;
  if not found or v_item.status <> 'open' or v_item.reason <> 'provider_failed' then
    raise exception 'expected second open provider_failed item, got %', to_json(v_item);
  end if;

  update public.staff_work_items
    set status = 'in_progress',
        first_seen_at = pg_catalog.now(),
        first_seen_by = '99810000-0000-0000-0000-000000000001',
        assigned_at = pg_catalog.now(),
        assigned_to = '99810000-0000-0000-0000-000000000001'
    where id = v_item.id;

  update public.outbound_message_outbox
    set provider_delivery_status = 'read', provider_status_at = now()
    where id = v_outbox_claimed;

  select * into v_item from public.staff_work_items where source_outbox_id = v_outbox_claimed;
  if v_item.status <> 'resolved' or v_item.resolved_at is null or v_item.resolved_by is not null then
    raise exception 'expected automatic provider_failed resolution from in_progress with resolved_by null, got %', to_json(v_item);
  end if;
end;
$$;

-- =========================================================================
-- Fixture 11: repeated handoff-stage updates deduplicate against both seen
-- and in_progress items; the latter can still upgrade to urgent in place.
-- =========================================================================
do $$
declare
  v_seen_item uuid := (select value from pg_temp.item_ids where key = 'not_claimed');
  v_progress_item uuid := (select value from pg_temp.item_ids where key = 'identity');
  v_seen_conversation uuid := '99830000-0000-0000-0000-000000000006';
  v_progress_conversation uuid := '99830000-0000-0000-0000-000000000003';
begin
  update public.conversations
    set state_version = state_version + 1
    where id = v_seen_conversation;

  if (select count(*) from public.staff_work_items where conversation_id = v_seen_conversation) <> 1
     or not exists (
       select 1 from public.staff_work_items
       where id = v_seen_item and status = 'seen'
     ) then
    raise exception 'seen handoff replay must keep exactly one non-resolved item';
  end if;

  update public.conversations
    set intake_data = '{"reported_safety_signals":{"future_signal":true}}'::jsonb,
        state_version = state_version + 1
    where id = v_progress_conversation;

  if (select count(*) from public.staff_work_items where conversation_id = v_progress_conversation) <> 1
     or not exists (
       select 1 from public.staff_work_items
       where id = v_progress_item
         and status = 'in_progress'
         and priority = 'urgent'
         and reason = 'emergency_handoff'
     ) then
    raise exception 'in_progress handoff replay must upgrade the existing item without duplicating it';
  end if;
end;
$$;

-- =========================================================================
-- Fixture 12: invalid state/actor combinations are rejected by the new
-- named checks (which specific constraint fires is not asserted; only that
-- one does).
-- =========================================================================
do $$
declare
  v_conv uuid := '99830000-0000-0000-0000-000000000001';
  v_clinic uuid := '99800000-0000-0000-0000-000000000001';
begin
  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, first_seen_at)
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'open', now());
    raise exception 'expected status=open with a non-null first_seen_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status)
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'seen');
    raise exception 'expected status=seen with a null first_seen_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (
      clinic_id, conversation_id, kind, priority, reason, status, first_seen_at, assigned_at
    )
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'seen', now(), now());
    raise exception 'expected status=seen with a non-null assigned_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, assigned_at)
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'in_progress', now());
    raise exception 'expected status=in_progress with a null first_seen_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, first_seen_at)
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'in_progress', now());
    raise exception 'expected status=in_progress with a null assigned_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (
      clinic_id, conversation_id, kind, priority, reason, status, first_seen_at, assigned_at, resolved_at
    )
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'in_progress', now(), now(), now());
    raise exception 'expected status=in_progress with a non-null resolved_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (clinic_id, conversation_id, kind, priority, reason, status, resolved_at)
    values (v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'resolved', null);
    raise exception 'expected status=resolved with a null resolved_at to violate a check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (
      clinic_id, conversation_id, kind, priority, reason, status, resolved_at, first_seen_by
    )
    values (
      v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'resolved', now(),
      '99810000-0000-0000-0000-000000000002'
    );
    raise exception 'expected a non-null first_seen_by with a null first_seen_at to violate the actor-timestamp check';
  exception when check_violation then null;
  end;

  begin
    insert into public.staff_work_items (
      clinic_id, conversation_id, kind, priority, reason, status, resolved_at, assigned_to
    )
    values (
      v_clinic, v_conv, 'human_handoff', 'normal', 'human_handoff', 'resolved', now(),
      '99810000-0000-0000-0000-000000000002'
    );
    raise exception 'expected a non-null assigned_to with a null assigned_at to violate the actor-timestamp check';
  exception when check_violation then null;
  end;
end;
$$;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '99800000-0000-0000-0000-000000000001',
    '99800000-0000-0000-0000-000000000002'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '99810000-0000-0000-0000-000000000001',
    '99810000-0000-0000-0000-000000000002',
    '99810000-0000-0000-0000-000000000003',
    '99810000-0000-0000-0000-000000000004',
    '99810000-0000-0000-0000-000000000005'
  )) as remaining_test_users,
  (select count(*) from public.staff_work_items where clinic_id in (
    '99800000-0000-0000-0000-000000000001',
    '99800000-0000-0000-0000-000000000002'
  )) as remaining_test_items,
  (select count(*) from public.outbound_message_outbox where clinic_id in (
    '99800000-0000-0000-0000-000000000001',
    '99800000-0000-0000-0000-000000000002'
  )) as remaining_test_outbox_rows;
