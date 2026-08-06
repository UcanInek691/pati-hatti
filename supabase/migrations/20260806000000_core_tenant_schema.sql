-- Core tenant schema and RLS foundation for VetAI.
-- NOT YET APPLIED to any real Supabase project. Claude Opus security review
-- is complete; migration/RLS testing in a disposable project is still
-- required before use against real data. See docs/database-schema.md.

-- Keep privileged helper functions outside Supabase's API-exposed `public`
-- schema. Authenticated users may invoke only the explicitly granted helpers;
-- they cannot create or replace objects in this schema.
create schema vetai_private;
revoke all on schema vetai_private from public, anon, authenticated;
grant usage on schema vetai_private to authenticated, service_role;

-- =========================================================================
-- Tables
-- =========================================================================

create table public.clinics (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.clinic_staff (
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'veterinarian', 'receptionist')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (clinic_id, user_id)
);

create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  phone_number_id text not null unique,
  display_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.owners (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  full_name text not null,
  phone_e164 text not null check (phone_e164 ~ '^\+[1-9]\d{1,14}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (clinic_id, phone_e164),
  -- lets `pets` FK on (owner_id, clinic_id) to block cross-clinic ownership.
  unique (id, clinic_id)
);

create table public.pets (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  owner_id uuid not null,
  name text not null,
  species text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, clinic_id) references public.owners (id, clinic_id) on delete cascade,
  -- lets `conversations` FK on (pet_id, owner_id, clinic_id) to enforce the
  -- pet belongs to both the conversation's owner and its clinic.
  unique (id, owner_id, clinic_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  owner_id uuid not null,
  pet_id uuid,
  status text not null default 'active' check (status in ('active', 'handoff', 'completed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (owner_id, clinic_id) references public.owners (id, clinic_id) on delete cascade,
  -- NO ACTION preserves direct pet-delete protection while allowing related
  -- cascades in the same statement to settle before the FK is checked.
  foreign key (pet_id, owner_id, clinic_id) references public.pets (id, owner_id, clinic_id) on delete no action,
  unique (id, clinic_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  conversation_id uuid not null,
  direction text not null check (direction in ('inbound', 'outbound', 'system')),
  content text not null,
  whatsapp_message_id text,
  created_at timestamptz not null default now(),
  foreign key (conversation_id, clinic_id) references public.conversations (id, clinic_id) on delete cascade
);

-- clinic-scoped: the same WhatsApp message id must not collide within a
-- clinic, but the column is optional (system-generated messages have none).
create unique index messages_clinic_whatsapp_message_id_key
  on public.messages (clinic_id, whatsapp_message_id)
  where whatsapp_message_id is not null;

create table public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  clinic_id uuid not null references public.clinics (id) on delete cascade,
  provider_event_id text not null,
  payload_hash text not null,
  processing_status text not null default 'received'
    check (processing_status in ('received', 'processing', 'processed', 'failed')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  -- sanitized summary only, never raw payload/token content; length-capped
  -- as a backstop against accidental dumping of large/sensitive text.
  last_error text check (last_error is null or char_length(last_error) <= 500),
  unique (clinic_id, provider_event_id)
);

-- =========================================================================
-- updated_at trigger
-- =========================================================================

create function vetai_private.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = pg_catalog.now();
  return new;
end;
$$;

revoke all on function vetai_private.set_updated_at() from public, anon, authenticated;

create trigger set_updated_at before update on public.clinics
  for each row execute function vetai_private.set_updated_at();

create trigger set_updated_at before update on public.clinic_staff
  for each row execute function vetai_private.set_updated_at();

create trigger set_updated_at before update on public.whatsapp_accounts
  for each row execute function vetai_private.set_updated_at();

create trigger set_updated_at before update on public.owners
  for each row execute function vetai_private.set_updated_at();

create trigger set_updated_at before update on public.pets
  for each row execute function vetai_private.set_updated_at();

create trigger set_updated_at before update on public.conversations
  for each row execute function vetai_private.set_updated_at();

-- =========================================================================
-- Tenant-membership helper
-- =========================================================================

-- SECURITY DEFINER with a fixed search_path so it cannot be hijacked by a
-- session-local search_path, and no dynamic SQL so there is no injection
-- surface.
create function vetai_private.is_clinic_staff(target_clinic_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select exists (
    select 1
    from public.clinic_staff cs
    where cs.clinic_id = target_clinic_id
      and cs.user_id = (select auth.uid())
  );
$$;

revoke all on function vetai_private.is_clinic_staff(uuid) from public, anon, authenticated;
grant execute on function vetai_private.is_clinic_staff(uuid) to authenticated, service_role;

-- =========================================================================
-- Row-level security
-- =========================================================================

alter table public.clinics enable row level security;
alter table public.clinic_staff enable row level security;
alter table public.whatsapp_accounts enable row level security;
alter table public.owners enable row level security;
alter table public.pets enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.webhook_events enable row level security;

-- service_role has BYPASSRLS in Supabase, but table privileges are a
-- separate check from RLS, so every table still needs explicit grants.
revoke all on public.clinics, public.clinic_staff, public.whatsapp_accounts,
  public.owners, public.pets, public.conversations, public.messages,
  public.webhook_events
  from anon, authenticated, public;

grant select on public.clinics, public.clinic_staff, public.whatsapp_accounts to authenticated;
grant select, insert, update, delete on public.owners, public.pets, public.conversations, public.messages to authenticated;

grant all on public.clinics, public.clinic_staff, public.whatsapp_accounts,
  public.owners, public.pets, public.conversations, public.messages,
  public.webhook_events
  to service_role;

-- Read-only, same-tenant. Management of clinics/staff/whatsapp accounts is
-- service-role-only (no authenticated write policy).
create policy clinics_select on public.clinics
  for select to authenticated
  using (vetai_private.is_clinic_staff(id));

create policy clinic_staff_select on public.clinic_staff
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

create policy whatsapp_accounts_select on public.whatsapp_accounts
  for select to authenticated
  using (vetai_private.is_clinic_staff(clinic_id));

-- Same-tenant staff may fully manage owners/pets/conversations/messages.
create policy owners_all on public.owners
  for all to authenticated
  using (vetai_private.is_clinic_staff(clinic_id))
  with check (vetai_private.is_clinic_staff(clinic_id));

create policy pets_all on public.pets
  for all to authenticated
  using (vetai_private.is_clinic_staff(clinic_id))
  with check (vetai_private.is_clinic_staff(clinic_id));

create policy conversations_all on public.conversations
  for all to authenticated
  using (vetai_private.is_clinic_staff(clinic_id))
  with check (vetai_private.is_clinic_staff(clinic_id));

create policy messages_all on public.messages
  for all to authenticated
  using (vetai_private.is_clinic_staff(clinic_id))
  with check (vetai_private.is_clinic_staff(clinic_id));

-- webhook_events: no anon/authenticated policy is created, so with RLS
-- enabled and no matching policy those roles get zero rows/writes by
-- default; only service_role (which bypasses RLS) can touch this table.

-- =========================================================================
-- Indexes
-- =========================================================================

create index clinic_staff_user_id_idx on public.clinic_staff (user_id);
create index whatsapp_accounts_clinic_id_idx on public.whatsapp_accounts (clinic_id);
create index pets_owner_id_idx on public.pets (owner_id);
create index conversations_owner_id_idx on public.conversations (owner_id);
create index conversations_clinic_status_idx on public.conversations (clinic_id, status);
create index messages_conversation_id_created_at_idx on public.messages (conversation_id, created_at);
create index webhook_events_clinic_status_idx on public.webhook_events (clinic_id, processing_status);
create index webhook_events_received_at_idx on public.webhook_events (received_at);
