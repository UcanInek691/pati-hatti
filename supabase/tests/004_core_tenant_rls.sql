begin;

do $$
declare
  expected_tables constant text[] := array[
    'clinic_staff', 'clinics', 'conversations', 'messages',
    'owners', 'pets', 'webhook_events', 'whatsapp_accounts'
  ];
  actual_tables text[];
  rls_table_count integer;
begin
  select array_agg(tablename order by tablename)
    into actual_tables
    from pg_catalog.pg_tables
   where schemaname = 'public';

  if actual_tables is distinct from expected_tables then
    raise exception 'unexpected public tables: %', actual_tables;
  end if;

  select count(*)
    into rls_table_count
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any(expected_tables)
     and c.relrowsecurity;

  if rls_table_count <> 8 then
    raise exception 'expected RLS on 8 tables, found %', rls_table_count;
  end if;

  if exists (
    select 1
      from information_schema.role_table_grants
     where grantee = 'anon'
       and table_schema = 'public'
       and table_name = any(expected_tables)
  ) then
    raise exception 'anon has an application-table grant';
  end if;
end;
$$;

insert into auth.users (id, aud, role, email, created_at, updated_at)
values
  ('10000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'rls-a@example.invalid', now(), now()),
  ('10000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'rls-b@example.invalid', now(), now());

insert into public.clinics (id, name)
values
  ('20000000-0000-0000-0000-000000000001', 'RLS Clinic A'),
  ('20000000-0000-0000-0000-000000000002', 'RLS Clinic B');

insert into public.clinic_staff (clinic_id, user_id, role)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002', 'admin');

insert into public.owners (id, clinic_id, full_name, phone_e164)
values
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Test Owner A', '+15550000001'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', 'Test Owner B', '+15550000002');

insert into public.pets (id, clinic_id, owner_id, name)
values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'Test Pet A'),
  ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', 'Test Pet B');

insert into public.conversations (id, clinic_id, owner_id, pet_id)
values
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001'),
  ('50000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002');

set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-000000000001', true);

do $$
begin
  if (select count(*) from public.clinics) <> 1 then
    raise exception 'staff user can see a clinic other than its own';
  end if;

  if (select count(*) from public.clinic_staff) <> 1 then
    raise exception 'staff user can see another clinic membership';
  end if;

  if (select count(*) from public.owners) <> 1 then
    raise exception 'staff user can see another clinic owner';
  end if;
end;
$$;

insert into public.owners (id, clinic_id, full_name, phone_e164)
values ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'Same Tenant Insert', '+15550000003');

update public.owners
   set full_name = 'Same Tenant Update'
 where id = '30000000-0000-0000-0000-000000000003';

do $$
begin
  begin
    insert into public.owners (clinic_id, full_name, phone_e164)
    values ('20000000-0000-0000-0000-000000000002', 'Cross Tenant Insert', '+15550000004');
    raise exception 'cross-tenant owner insert unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    update public.owners
       set clinic_id = '20000000-0000-0000-0000-000000000002'
     where id = '30000000-0000-0000-0000-000000000003';
    raise exception 'cross-tenant owner update unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;

  begin
    perform 1 from public.webhook_events;
    raise exception 'authenticated webhook_events read unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;

reset role;

do $$
begin
  begin
    insert into public.pets (clinic_id, owner_id, name)
    values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000002', 'Cross Clinic Pet');
    raise exception 'cross-clinic pet relationship unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into public.conversations (clinic_id, owner_id, pet_id)
    values ('20000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002');
    raise exception 'cross-clinic conversation relationship unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;

  begin
    insert into public.messages (clinic_id, conversation_id, direction, content)
    values ('20000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000002', 'system', 'fixture');
    raise exception 'cross-clinic message relationship unexpectedly succeeded';
  exception
    when foreign_key_violation then null;
  end;
end;
$$;

set local role anon;
do $$
begin
  begin
    perform 1 from public.clinics;
    raise exception 'anon application-table read unexpectedly succeeded';
  exception
    when insufficient_privilege then null;
  end;
end;
$$;
reset role;

rollback;

select
  'PASS' as result,
  (select count(*) from public.clinics where id in (
    '20000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000002'
  )) as remaining_test_clinics,
  (select count(*) from auth.users where id in (
    '10000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000002'
  )) as remaining_test_users;
