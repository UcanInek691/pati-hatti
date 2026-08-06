# Core tenant database schema

Defined in `supabase/migrations/20260806000000_core_tenant_schema.sql`.

> **Disposable validation passed.** On 2026-08-06 the migration was applied to
> the `vetai-test` Supabase project and `supabase/tests/004_core_tenant_rls.sql`
> passed against PostgreSQL 17. The test verified tenant isolation and rolled
> back every fixture. This is not a production deployment; production must use
> the managed Supabase CLI migration workflow.

## Tables

- **clinics** — one row per tenant. Every other application table hangs off
  a `clinic_id`.
- **clinic_staff** — links `auth.users` to a clinic with a `role`
  (`admin`, `veterinarian`, `receptionist`). Primary key is
  `(clinic_id, user_id)`, so a user's access is always evaluated per clinic,
  never globally.
- **whatsapp_accounts** — a clinic's WhatsApp Business phone number
  (`phone_number_id`, globally unique — Meta assigns it globally). No
  token or secret is stored here; those live only in Worker secret
  bindings (see below).
- **owners** — pet owners contacting a clinic, keyed by
  `(clinic_id, phone_e164)` with a basic E.164 format check.
- **pets** — belongs to one owner. The foreign key is on
  `(owner_id, clinic_id)` against `owners (id, clinic_id)`, so a pet can
  never be attached to an owner from a different clinic even if application
  code passes the wrong `clinic_id`.
- **conversations** — belongs to one owner and, optionally, one pet. The
  pet foreign key is three columns, `(pet_id, owner_id, clinic_id)` against
  `pets (id, owner_id, clinic_id)`, so the database — not application
  code — rejects a conversation whose pet belongs to a different owner or
  clinic than the conversation itself.
- **messages** — belongs to one conversation via `(conversation_id,
  clinic_id)`. A clinic-scoped partial unique index on
  `whatsapp_message_id` prevents duplicate ingestion of the same WhatsApp
  message within a clinic, while leaving the column optional for
  system-generated messages.
- **webhook_events** — records that a provider webhook event was received
  and its processing outcome, keyed uniquely per `(clinic_id,
  provider_event_id)`.

## Tenant isolation

Every tenant-owned table carries a `clinic_id`. Cross-tenant relationships
are blocked by composite foreign keys (not application-level checks): a
pet's owner-and-clinic pair, a conversation's owner/pet/clinic triple, and a
message's conversation-and-clinic pair are all enforced by the database, so
a bug or a malicious `clinic_id` in application code cannot create a
cross-tenant link.

## RLS and access

Row-level security is enabled on all eight tables.

- `anon` has no access to any application table.
- `authenticated` users can only ever see rows in clinics where they have a
  `clinic_staff` row — enforced through the
  `vetai_private.is_clinic_staff(clinic_id)` helper. The helper is kept
  outside the API-exposed `public` schema and uses `SECURITY DEFINER`, an
  empty `search_path`, fully qualified relations, and no dynamic SQL.
- `authenticated` gets **read-only** access to `clinics`, `clinic_staff`,
  and `whatsapp_accounts` — managing those is service-role-only.
- `authenticated` gets full same-tenant CRUD on `owners`, `pets`,
  `conversations`, and `messages`, gated by `is_clinic_staff` in both the
  `USING` and `WITH CHECK` clauses so a write can't smuggle in a different
  `clinic_id` than the caller is staff of.
- `webhook_events` has no `anon`/`authenticated` policy at all; only the
  Worker's service-role connection (which bypasses RLS in Supabase) can
  read or write it. Table privileges are granted explicitly to
  `service_role` regardless, since RLS bypass and table `GRANT`s are
  independent checks.

## Why no raw webhook payload is stored

`webhook_events` stores a `payload_hash` and a length-capped, sanitized
`last_error`, never the raw webhook body. Raw payloads and clinical
messages are not copied into logs or embeddings by default (see
`PROJECT_CONTEXT.md`); keeping this table free of raw payload content
means a leak of this table can't leak WhatsApp tokens or full clinical
conversation content, and it prevents the audit table from becoming a
second, unprotected copy of sensitive data.

## Why service-role credentials stay in Worker bindings

`SUPABASE_SERVICE_ROLE_KEY` bypasses RLS entirely, so it must never reach
client code or any environment outside the Cloudflare Worker's secret
bindings (already declared on `Env` in `src/env.ts`, unused until the
Worker is wired to Supabase). All authenticated (non-service-role) access
goes through RLS policies described above instead.
