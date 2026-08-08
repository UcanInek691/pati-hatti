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

## Inbound WhatsApp text message ingestion

Defined in
`supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql` and
revised by
`supabase/migrations/20260806000300_ingest_whatsapp_conversation_locator.sql`.

> **Disposable validation passed.** On 2026-08-06 the migration was applied to
> `vetai-test` and `supabase/tests/005_ingest_whatsapp_text_message.sql`
> returned `PASS`. Its fixtures were rolled back. Production still requires
> the managed Supabase migration workflow.

> **Locator validation passed.** On 2026-08-08 the `20260806000300` migration
> was applied to `vetai-test` and
> `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` returned
> `PASS` with every fixture count at zero. Production still requires the
> managed Supabase migration workflow.

`public.ingest_whatsapp_text_message(...)` is the single Data API entry
point the Worker calls after signature/envelope validation. It is
`SECURITY INVOKER`, `VOLATILE`, has an empty `search_path`, and is granted
to `service_role` only (revoked from `PUBLIC`, `anon`, `authenticated`),
so it runs with the caller's own privileges — service-role's table grants
and RLS bypass, not an elevated definer identity. It returns exactly one row
of `(result text, conversation_id uuid)`. In one call it:

1. Resolves the clinic from `whatsapp_accounts.phone_number_id`, writing
   nothing and returning `unknown_account` with a null `conversation_id` if
   no match exists.
2. Claims idempotency via `webhook_events (clinic_id, provider_event_id)`
   with `ON CONFLICT DO NOTHING RETURNING`; a redelivery with a matching
   `payload_hash` returns `duplicate` with no further mutation, and a
   redelivery with a different hash for the same provider event ID raises
   an error and writes nothing.
   The `duplicate` locator is resolved from `public.messages` by
   `(clinic_id, whatsapp_message_id)` — never by provider ID alone, because
   that ID is only unique within a clinic. If a claimed event has no
   matching persisted message the function raises instead of returning a
   null or synthetic locator.
3. Upserts the owner by `(clinic_id, phone_e164)`, preserving any existing
   name that isn't the `WhatsApp user` fallback.
4. Reuses the owner's open (`active`/`handoff`) conversation or creates one,
   then inserts the inbound message, marks the webhook event `processed`,
   and returns that conversation's ID as the locator.

A partial unique index, `conversations_one_open_per_owner_idx` on
`(clinic_id, owner_id) where status in ('active', 'handoff')`, caps this at
one open conversation per owner rather than per pet.

> `ponytail:` one open conversation per owner (not per pet) is an MVP
> ceiling; revisit only if concurrent per-pet conversations become a
> verified need.

## Persisted conversation intake state

Defined in
`supabase/migrations/20260806000200_conversation_intake_state.sql`.

> **Disposable validation passed.** On 2026-08-06 the migration was applied to
> `vetai-test` and `supabase/tests/006_conversation_intake_state.sql` returned
> `PASS`. Its fixtures were rolled back. Production still requires the managed
> Supabase migration workflow.

`conversations` carries three new columns:

- `intake_stage text not null default 'pet_identification'`, constrained to
  the nine-value stage graph below.
- `intake_data jsonb not null default '{}'::jsonb`, constrained to a JSON
  object. It is a structured working document, not a raw webhook copy.
- `state_version integer not null default 1`, constrained to be positive,
  used for optimistic concurrency.

The stage graph is forward-only:
`pet_identification -> complaint_collection -> safety_check ->
ready_for_triage -> appointment_offer -> appointment_selection ->
appointment_confirmation -> completed`, with a side-channel transition to
`human_handoff` permitted from any non-completed stage. `human_handoff` and
`completed` are terminal — only a same-stage data refresh is allowed once a
conversation reaches either one. Moving to `human_handoff` sets operational
`status = 'handoff'`; moving to `completed` sets `status = 'completed'`.

Two `SECURITY INVOKER` Data API functions, both with an empty `search_path`,
fully qualified relations, no dynamic SQL, and granted to `service_role`
only (revoked from `PUBLIC`, `anon`, `authenticated`):

- `public.get_conversation_intake_context(p_conversation_id uuid)` — reads
  one conversation's clinic/owner/pet ids, operational status, intake
  stage/data/version, the owner's display name, the owner's pets ordered by
  creation time then id, and the latest 12 messages in chronological order.
  Returns zero rows for an unknown conversation. Never returns phone
  numbers, WhatsApp ids, or webhook hashes.
- `public.advance_conversation_intake(p_conversation_id, p_expected_version,
  p_next_stage, p_pet_id, p_intake_data)` — validates the next stage against
  the graph above and that any assigned pet belongs to the conversation's
  own owner and clinic (the tenant-safety boundary is the existing
  owner/pet/clinic composite relationship, not a caller-supplied clinic id),
  then updates only when `state_version` matches the caller's expected
  value, incrementing it by exactly one on success. A stale version returns
  zero rows with no mutation; every other invalid input (bad stage,
  nonpositive version, unknown conversation, foreign pet, empty/non-object
  `intake_data`) raises and mutates nothing.

Neither function calls an LLM, sends a WhatsApp message, or is wired into
the webhook handler; `src/conversationState.ts` exposes native-`fetch`
Worker helpers for both, unused until a later task calls them.
