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
  bindings (see below). Also unique on `(id, clinic_id)` so other tables can
  hold a composite, tenant-safe foreign key to a specific account (a clinic
  may own more than one).
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
  provider_event_id)`. Also carries the resolved `whatsapp_account_id` (a
  composite, tenant-safe foreign key into `whatsapp_accounts`) so a later
  reply can be sent from the same account the inbound message arrived on.
- **outbound_message_outbox** — one planned-but-not-yet-sent WhatsApp reply
  per inbound event, inserted atomically alongside intake-state finalization
  (see "Atomic intake finalization" below). Backend-only, `service_role`-only,
  no RLS policy. Composite tenant-safe foreign keys tie it to the exact
  conversation, WhatsApp account, and source `webhook_events` row; `unique
  (clinic_id, source_provider_message_id)` caps it at one planned reply per
  inbound event. All three parent relationships cascade deletion so a pending
  reply—and its copied recipient phone—cannot block owner/clinic erasure or
  survive deletion of its account/source event. `delivery_status`, lease,
  attempt-count, and outcome columns added by
  `supabase/migrations/20260809000200_outbound_delivery.sql` are described
  in [`docs/outbound-delivery.md`](outbound-delivery.md). `provider_delivery_status`
  and `provider_status_at`, added by
  `supabase/migrations/20260809000300_outbound_status_tracking.sql`, record
  Meta's later sent/delivered/read/failed status callback and are described
  in [`docs/outbound-status.md`](outbound-status.md).

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
`supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`,
revised by
`supabase/migrations/20260806000300_ingest_whatsapp_conversation_locator.sql`,
and revised again by
`supabase/migrations/20260809000100_intake_reply_outbox.sql` to preserve the
exact inbound `whatsapp_accounts` row.

> **Disposable validation passed.** On 2026-08-06 the migration was applied to
> `vetai-test` and `supabase/tests/005_ingest_whatsapp_text_message.sql`
> returned `PASS`. Its fixtures were rolled back. Production still requires
> the managed Supabase migration workflow.

> **Locator validation passed.** On 2026-08-08 the `20260806000300` migration
> was applied to `vetai-test` and
> `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` returned
> `PASS` with every fixture count at zero. Production still requires the
> managed Supabase migration workflow.

> **Account-preservation validation passed (2026-08-09).** Codex applied the
> `20260809000100` migration to disposable `vetai-test`; the rollback-only
> `supabase/tests/017_intake_reply_outbox.sql` returned `PASS` with zero fixture
> residue. Production still requires the managed migration workflow.

`public.ingest_whatsapp_text_message(...)` is the single Data API entry
point the Worker calls after signature/envelope validation. It is
`SECURITY INVOKER`, `VOLATILE`, has an empty `search_path`, and is granted
to `service_role` only (revoked from `PUBLIC`, `anon`, `authenticated`),
so it runs with the caller's own privileges — service-role's table grants
and RLS bypass, not an elevated definer identity. It returns exactly one row
of `(result text, conversation_id uuid)`. In one call it:

1. Resolves the clinic and exact `whatsapp_accounts` row from
   `whatsapp_accounts.phone_number_id`, writing nothing and returning
   `unknown_account` with a null `conversation_id` if no match exists.
2. Claims idempotency via `webhook_events (clinic_id, provider_event_id)`
   with `ON CONFLICT DO NOTHING RETURNING`, storing the resolved
   `whatsapp_account_id` on the new row; a redelivery with a matching
   `payload_hash` returns `duplicate` under an AI route (or `manual` under
   a currently manual route) with no further mutation, and a
   redelivery with a different hash for the same provider event ID raises
   an error and writes nothing.
   A `duplicate` redelivery also backfills a null `whatsapp_account_id` on
   the existing row (covering events persisted before this account link
   existed) and raises if the redelivery resolves to a different,
   already-linked account — the exact account is never silently
   overwritten.
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
`pet_identification -> complaint_collection -> intake_confirmation ->
safety_check -> ready_for_triage -> appointment_offer ->
appointment_selection -> appointment_confirmation -> completed`, with a
side-channel transition to
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

## Intake queue job lease

Defined in `supabase/migrations/20260808000100_intake_job_lease.sql`.

> **Disposable validation passed (2026-08-08).** Codex applied this migration
> to `vetai-test` and the rollback test
> `supabase/tests/012_intake_job_lease.sql` returned `PASS 0 0 0 0 0 0`.
> This SQL Editor integration test did not add a Supabase CLI migration-history
> entry; production must still apply the migration through the managed
> migration workflow.

This is the fail-closed idempotency boundary a future Cloudflare Queue
consumer will need before it may call an LLM, evaluate safety, or advance
conversation state; no consumer, orchestration, or deploy exists yet.

`webhook_events` carries four new columns tracking downstream intake
processing, distinct from the existing `processing_status` (which only
tracks inbound persistence):

- `intake_status text not null default 'pending'`, constrained to
  `pending | processing | completed`.
- `intake_claim_token uuid` — the current lease holder's token.
- `intake_lease_until timestamptz` — the fixed 120-second lease expiry.
- `intake_completed_at timestamptz`.

A table check constraint enforces that these four columns are only ever
coherent as a group: `pending` requires all three of token/lease/completed
time to be null; `processing` requires token and lease non-null with
completed time null; `completed` requires token/lease null with completed
time non-null. No other combination can be stored.

Two `SECURITY INVOKER`, `VOLATILE`, empty-`search_path` functions, granted to
`service_role` only (revoked from `PUBLIC`, `anon`, `authenticated`):

- `public.claim_intake_queue_job(p_conversation_id, p_provider_message_id)` —
  resolves the exact tenant-safe inbound message and its processed webhook
  event (tenant safety comes from the message's own `clinic_id`, never a
  caller-supplied one), locks the event row so concurrent claims serialize,
  and returns one row of `(result, claim_token, message_text)`. A `pending`
  job or one whose 120-second lease has expired is claimed with a fresh
  UUID token and message text; an unexpired lease returns `busy`; an
  already-`completed` job returns `completed`; anything that doesn't
  resolve to an exact inbound/processed pair returns `not_found`. Every
  non-`claimed` result returns a null token and null text.
- `public.complete_intake_queue_job(p_conversation_id, p_provider_message_id,
  p_claim_token)` — atomically marks the same tenant-safe job `completed`,
  clearing the token/lease and setting the completion time, only when the
  event is currently `processing` and its stored token equals the supplied
  token. A missing job, an already-completed job, a still-pending job, or a
  token that doesn't match the current lease holder (for example a stale
  worker whose lease expired and was reclaimed by another worker) all
  collapse to the same `stale` result, so a stale worker can never complete
  a lease it no longer holds.

Neither function stores phone numbers, owner/pet data, clinic identifiers
beyond what tenant-safe resolution requires, payload hashes, or webhook
error text in its return rows. `src/intakeJobLease.ts` exposes native-`fetch`
Worker helpers for both, following the same HTTPS/loopback-only,
fail-closed-on-blank-configuration transport rules as
`src/conversationState.ts`; neither helper is wired into `src/index.ts` or
any Queue handler yet.

## Atomic intake finalization

Defined in `supabase/migrations/20260808000200_finalize_intake_queue_job.sql`
and extended by
`supabase/migrations/20260809000100_intake_reply_outbox.sql` to add an atomic
outbox insert.

> **Disposable validation passed (2026-08-08).** Codex applied this migration
> to `vetai-test`; `supabase/tests/013_finalize_intake_queue_job.sql` returned
> `PASS` with zero fixture rows. This SQL Editor integration test did not add a
> Supabase CLI migration-history entry; production still requires the managed
> migration workflow.

> **Outbox extension validation passed (2026-08-09).** Codex applied the
> `20260809000100` migration to disposable `vetai-test`; the rollback-only
> `supabase/tests/017_intake_reply_outbox.sql` returned `PASS` with zero fixture
> residue, including owner/conversation, account, and source-event cascade
> deletion of pending replies. The earlier seven-argument finalizer fixture
> also still returned `PASS`, confirming the two trailing defaults preserve
> compatibility.
> Production still requires the managed migration workflow.

> **Second-pet atomicity validation passed (2026-08-27).** Codex applied
> `20260827000100_second_pet_registration_atomicity.sql` only to disposable
> `vetai-test` through the SQL Editor. The updated rollback-only
> `supabase/tests/037_second_pet_registration_atomicity.sql` passed and a
> separate residue query returned `fixture_clinics = 0`. This SQL Editor run
> did not add a CLI migration-history row. Staging and production remain
> unchanged.

A lease guarantees one successful completer, not one executing worker after
expiry/reclaim (see [`docs/inbound-queue.md`](inbound-queue.md)). Calling
`advance_conversation_intake` and `complete_intake_queue_job` as two separate
HTTP RPCs would leave a crash window where the same persisted message could
advance conversation state twice. `public.finalize_intake_queue_job(
p_conversation_id, p_provider_message_id, p_claim_token, p_expected_version,
p_next_stage, p_pet_id, p_intake_data, p_reply_category, p_reply_text,
p_create_pet_name, p_create_pet_species)`
closes that window by composing both existing, already-validated operations
inside one transaction instead of duplicating their
transition/pet-ownership/completion logic, and now also persists the planned
reply (if any) in the same transaction. It is `SECURITY INVOKER`, `VOLATILE`,
empty-`search_path`, and granted to `service_role` only (revoked from
`PUBLIC`, `anon`, `authenticated`).

On every AI-path finalization, the current version first locks the exact
tenant-scoped conversation row and checks `p_expected_version` before any
optional pet insert or other mutation. A mismatch returns `stale_state` with
the current lease unchanged and no pet/state/outbox mutation. After the lock
succeeds, a zero-row advance is an invariant violation that raises, rolling
back pet creation with the entire call. The AI-path normalized duplicate-name
guard remains application-level; no table-wide uniqueness rule was added for
staff writes.

`p_reply_category` and `p_reply_text` must both be null (no reply owed) or
both non-null (a planned reply); a mismatched pair, an unrecognized category,
or an out-of-range reply text (1-4096 code points) raises before anything is
locked or changed. They mirror `IntakeReplyCategory`/`IntakeReplyPlan` from
`src/intakeReply.ts` exactly — this RPC does not itself decide whether to
reply, it only persists the caller's already-planned decision.

It resolves and locks the exact tenant-safe inbound processed message/event
pair using the same relationship as `claim_intake_queue_job`, re-checks the
current lease token under that lock, and returns one row of `(result,
intake_stage, state_version)` with a closed outcome set:

- `applied` — the event was `processing` with a matching token and
  `advance_conversation_intake` succeeded for the supplied expected version;
  if a reply was requested, exactly one row is inserted into
  `outbound_message_outbox` deriving its clinic, conversation, WhatsApp
  account, and recipient phone number entirely from the locked event and
  conversation (never from caller-supplied routing data); the same lease is
  completed in the same transaction and the resulting non-null stage/version
  is returned. A null reply pair inserts no outbox row.
- `already_completed` — the exact event was already completed; no
  conversation, lease, or outbox change, null stage/version.
- `stale_claim` — the exact pair is missing, not processing, or held by a
  different/newer token; no conversation, lease, or outbox change, null
  stage/version.
- `stale_state` — the token is valid but the optimistic state version no
  longer matches; the lease stays `processing` (available for a corrected
  retry only until its original 120-second expiry), no conversation or
  outbox change, null stage/version. A reclaim before that retry changes the
  outcome to `stale_claim`.

If the reused state transition raises (invalid stage, invalid/empty intake
data, or pet ownership outside the conversation's own owner/clinic), if a
reply was requested but the locked event has no linked
`whatsapp_account_id` or the conversation's owner has no recipient phone
number, or if current-token completion unexpectedly fails after a successful
state advance, the whole call raises and neither the conversation row, the
lease row, nor the outbox table is left partially changed.

This closes the double-advance window for one persisted message and, when a
reply is planned, the lost/duplicate-reply window between state advance and
outbox persistence. It does not cover LLM work repeating after a lease
expiry/reclaim, or the actual WhatsApp send and its own retry/delivery
tracking — see [`docs/outbound-delivery.md`](outbound-delivery.md) for the
claim/send/accept pipeline that now owns those rows. `src/intakeJobLease.ts`
exposes a native-`fetch` `finalizeIntakeQueueJob` Worker helper following the
same transport and untrusted-response rules as the other functions on this
page. It is wired into `src/intakeConsumer.ts`, which calls `planIntakeReply`
and forwards its result as the reply pair.

## Outbound WhatsApp delivery

Defined in `supabase/migrations/20260809000200_outbound_delivery.sql`.
Disposable validation passed on `vetai-test` on 2026-08-09: the migration
applied successfully and `supabase/tests/018_outbound_delivery.sql` returned
`PASS` with zero fixture residue. Production still requires the managed
migration workflow. See
[`docs/outbound-delivery.md`](outbound-delivery.md) for the full four-state
lifecycle, the three claim/release/accept RPCs, exact-account routing, the
at-least-once delivery guarantee, and Cron cadence.

## Outbound WhatsApp status callbacks

Defined in `supabase/migrations/20260809000300_outbound_status_tracking.sql`.
The migration and its rollback fixture,
`supabase/tests/019_outbound_status_tracking.sql`, passed against disposable
`vetai-test` on 2026-08-09 with zero fixture residue. See
[`docs/outbound-status.md`](outbound-status.md) for the
accepted-vs-sent/delivered/read/failed distinction, the tenant-safe
`record_whatsapp_outbound_status` RPC, and the non-regressing rank/timestamp
rules.

## Staff work items

Defined in `supabase/migrations/20260809000400_staff_work_items.sql`.
Disposable validation passed on `vetai-test` on 2026-08-09: apply-time
backfill produced the three expected work kinds/reasons, and
`supabase/tests/020_staff_work_items.sql` returned `PASS` with zero fixture
residue. See [`docs/staff-work-items.md`](staff-work-items.md) for the two
work kinds, the human-handoff and delivery-failure triggers, the tenant/RLS
boundaries, and why durable visibility is not notification. It has not been
applied to production.

## Staff workflow resolution RPC

Defined in `supabase/migrations/20260809000500_staff_workflow.sql`:
`public.resolve_staff_work_item(p_work_item_id uuid) returns table(result
text)`. `SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`, executable
only by `authenticated` (revoked from `PUBLIC`, `anon`, `service_role`). It
locks the target row, authorizes with the caller's identity via the existing
`vetai_private.is_clinic_staff(clinic_id)` helper, and returns exactly one of
`resolved | already_resolved | not_found` — never distinguishing an absent
item from one outside the caller's clinics. It adds no column, policy, table
grant, or general-purpose mutation endpoint; `authenticated` direct table
`UPDATE` remains denied. See [`docs/staff-workflow.md`](staff-workflow.md)
for the full login/list/detail/resolve flow. The migration and rollback SQL
fixture passed on disposable `vetai-test` on 2026-08-09 with zero fixture
residue; they have not been applied to production or recorded in Supabase
migration history.

## Staff ownership, status, and alerts (Task 032)

Defined in
`supabase/migrations/20260814000200_staff_assignment_and_alerts.sql`. Adds
five nullable columns to `public.staff_work_items` — `first_seen_at
timestamptz`, `first_seen_by uuid references auth.users (id) on delete set
null`, `assigned_at timestamptz`, `assigned_to uuid references auth.users
(id) on delete set null`, `resolved_by uuid references auth.users (id) on
delete set null` — with no backfill for existing rows. Replaces the status
check with a four-value `open | seen | in_progress | resolved` enum, adds a
named per-status CHECK constraint requiring each status's exact set of
timestamp/actor fields, and three actor-implies-timestamp CHECK constraints
that stay valid after `on delete set null` erases an actor id but leaves its
timestamp. Table RLS, policy, and grants are unchanged from Task 020.
The two partial unique indexes and their trigger predicates now cover every
non-resolved status rather than only `open`; this preserves one current item
per conversation/outbox row after a person marks it seen or claims it, and a
later `delivered`/`read` callback still automatically resolves a seen or
claimed `provider_failed` item.

Adds two new closed `SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`
RPCs, revoked from `PUBLIC`/`anon`/`service_role`, granted only to
`authenticated`:

- `public.mark_staff_work_item_seen(p_work_item_id uuid) returns
  table(result text)` — `open` → `seen`; `seen`/`in_progress` → already
  `already_seen`; `resolved` → `already_resolved`; absent/cross-clinic →
  `not_found`.
- `public.claim_staff_work_item(p_work_item_id uuid) returns table(result
  text)` — `open`/`seen` → `claimed` (filling any missing first-seen
  fields); `in_progress` with the caller already assigned → `already_claimed`;
  `in_progress` with a different live assignee → `busy`; `in_progress` with
  an erased assignee → `claimed` (reclaim); `resolved` → `already_resolved`;
  absent/cross-clinic → `not_found`.

Also replaces `public.resolve_staff_work_item` (same signature; see above)
with an expanded version returning `resolved | already_resolved |
not_claimed | not_owner | not_found`: `not_claimed` when the item is not
currently claimed by anyone with a live assignee, `not_owner` when it is
claimed by a different user, `resolved` (setting `resolved_by` to the
caller) only for the item's current live assignee.

All three RPCs reject a null work-item id before lookup, lock the row,
authorize via the same `vetai_private.is_clinic_staff` helper, derive the
acting identity only from `auth.uid()`, and return exactly one row with one
`result` field from a fixed closed set — never a raw identifier, PII, or
database error detail. See [`docs/staff-workflow.md`](staff-workflow.md) for
the full status machine, ownership-label UI, 30-second poll, and the
PII-free active-page browser-alert boundary. Codex applied the migration to
disposable PostgreSQL 17 `vetai-test` on 2026-08-14 and the rollback fixture
(`supabase/tests/032_staff_assignment_and_alerts.sql`) returned
`PASS 0/0/0/0`. They have not been applied to production or recorded in
Supabase migration history.

## Appointment booking engine

Defined in `supabase/migrations/20260810000100_appointment_booking_engine.sql`:
one table, `public.appointment_slots` (pre-provisioned 30-minute clinic
slots moving through `available -> held -> confirmed`, with composite
tenant-consistency foreign keys to `conversations` and `pets`, a partial
unique index enforcing at most one active slot per conversation, and RLS
with no policy — `service_role` only), plus exactly three `SECURITY
INVOKER`, `SET search_path = ''` RPCs granted only to `service_role`:
`list_available_appointment_slots`, `hold_appointment_slot` (10-minute
hold, deterministic ascending-id lock order to avoid cross-conversation
deadlocks), and `confirm_appointment_slot` (idempotent replay via exact
token match, refusing an already-started slot, and collapsing every other
failure mode to `stale`). Slot times are UTC-aligned `timestamptz` instants
rendered as `Europe/Istanbul` by future user-facing flows; the slot's `pet_id`
is a booking-time snapshot and is not rewritten by later conversation changes. See
[`docs/appointment-booking-engine.md`](appointment-booking-engine.md) for
the full state-machine contract. The migration and rollback fixture were
validated only on disposable PostgreSQL 17 `vetai-test` on 2026-08-10; the
fixture returned `PASS` with zero residue. They have not been applied to
production or recorded in migration history. The read-only Claude Opus review
and its narrow recheck of the corrected same-target lock branch both passed.

## WhatsApp appointment flow

Defined in
`supabase/migrations/20260810000200_whatsapp_appointment_flow.sql`
(**validated only on disposable `vetai-test` on 2026-08-10**; the rollback
fixture returned `PASS` with zero residue; not applied to production; see
[`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md) for the
full contract). Adds no new table. Extends
`outbound_message_outbox_reply_category_check` with four values —
`appointment_offer`, `appointment_confirmed`, `appointment_declined`,
`appointment_unavailable` — alongside the existing categories from
[`docs/intake-replies.md`](intake-replies.md), so `finalize_intake_queue_job`
above continues to accept the widened set unchanged. Adds exactly two new
`SECURITY INVOKER`, `VOLATILE`, `SET search_path = ''` RPCs granted only to
`service_role`:

- `finalize_appointment_offer_queue_job(p_conversation_id,
  p_provider_message_id, p_claim_token, p_expected_version,
  p_planned_next_stage, p_pet_id, p_intake_data)` — composes the existing
  `advance_conversation_intake`, `list_available_appointment_slots`,
  `hold_appointment_slot`, and `complete_intake_queue_job` (none of which are
  modified) in one transaction to hold the single earliest eligible slot and
  write its offer reply, or to hand off to a human with a no-slot reply.
- `finalize_appointment_decision_queue_job(p_conversation_id,
  p_provider_message_id, p_claim_token, p_expected_version, p_decision,
  p_pet_id, p_intake_data)` — composes the same primitives plus
  `confirm_appointment_slot` (also unmodified) to confirm, decline, repeat,
  or hand off a `EVET`/`HAYIR`-style decision on the currently held slot.

Both follow `finalize_intake_queue_job`'s own boundary exactly: current claim
token and expected state version are re-checked under lock, every mutation
(conversation stage, slot state, outbox row, lease completion) happens in the
same transaction, and any unreachable/inconsistent state raises rather than
returning a false success row. Neither RPC changes
`public.appointment_slots`'s columns, constraints, or the three Task 022 RPCs
themselves.

## Dead-letter intake handoff

Defined in
`supabase/migrations/20260810000300_intake_dead_letter_handoff.sql`:
`public.finalize_intake_dead_letter(p_conversation_id uuid,
p_provider_message_id text) returns table(result text)`. **Not yet
validated on production** — Codex applied the migration only to disposable
`vetai-test` on 2026-08-10; the rollback fixture returned `PASS` with zero
test clinics/owners/conversations/messages/webhook events/staff work items.
It is not recorded in production migration history. The function is
`SECURITY INVOKER`, `VOLATILE`, `SET search_path = ''`, and
granted to `service_role` only (revoked from `PUBLIC`, `anon`,
`authenticated`).

This is the terminal parking-lot finalizer for the Cloudflare Queue
dead-letter path described in
[`docs/inbound-queue.md`](inbound-queue.md#dead-letter-handoff-consumer-srcintakedeadletterts):
once `vetai-intake` exhausts its own retries and Cloudflare routes a message
to `vetai-intake-dlq`, this function is the only mutation the dead-letter
consumer performs. It resolves and locks the exact tenant-safe inbound
processed message/webhook-event pair using the same relationship as
`claim_intake_queue_job` — never a caller-supplied clinic ID — then:

- If the event is already `completed`, returns `already_completed` with no
  mutation.
- Otherwise locks the conversation. If its intake stage is `completed`,
  returns `already_terminal`, still marks the event `completed` (so a repeat
  delivery of the same exhausted message does not reprocess it), and creates
  no false staff work item.
- For every other stage, including an existing `human_handoff`, calls the
  existing `advance_conversation_intake` to move or keep the conversation at
  `human_handoff`, preserving `intake_data` and any
  already-selected pet exactly as that function already does, then marks
  the event `completed` and returns `handed_off`. The existing
  `sync_human_handoff_work_item` trigger on `conversations` creates the
  usual `staff_work_items` row from that same update — this function adds no
  trigger, no direct `staff_work_items` write, and no branching on any
  specific safety-signal name.
- If all first-message attempts failed before any intake snapshot existed,
  the core default is still `{}` and the reused advance RPC would reject it.
  Only for that case the finalizer stores the fixed non-sensitive terminal
  marker `{ "dead_letter_handoff": true }`; a later message on the handoff
  conversation follows the existing poison-snapshot fallback and replaces it
  with a validated current-turn snapshot.
- An absent, cross-tenant, mismatched, or outbound-direction
  conversation/message pair returns `not_found` with no mutation, matching
  `claim_intake_queue_job`'s fail-closed resolution.

Unlike `claim_intake_queue_job` and `finalize_intake_queue_job`, this
function does not require the old intake claim token. A slow or replayed
primary worker may still exist after retry exhaustion, so correctness comes
from the shared webhook-event row lock: whichever finalizer wins completes
the event, and the later one observes completed/stale state rather than
committing a second outcome. Every mutation (event completion, conversation
advance, and the trigger-driven staff work item) happens in one transaction;
if the reused state transition raises for any reason, the whole call raises
and nothing is left partially changed. It returns only the
closed `result` column — never a conversation ID, phone number, message
text, payload, claim token, or error detail — and never inserts an outbound
reply or otherwise implies a message was sent to the owner.
`src/intakeDeadLetter.ts` exposes a native-`fetch` `finalizeIntakeDeadLetter`
Worker helper following the same transport and untrusted-response rules as
the other functions on this page; it is wired into the Worker's `queue()`
handler for the `vetai-intake-dlq` queue only.

## Clinic operational profile and hours (Task 031)

`supabase/migrations/20260814000100_clinic_operations.sql`.

> **Disposable validation passed (2026-08-14).** Codex applied the migration
> to `vetai-test`; `supabase/tests/031_clinic_operations.sql` returned `PASS`
> with zero remaining test clinics, users, weekly-hours rows, or closure rows.
> This migration has not been applied to production.

`public.clinics` gains nullable `contact_phone_e164 text` (constrained to
canonical E.164, `^\+[1-9]\d{1,14}$`) and `public_address text` (constrained
to trimmed, non-empty text of at most 500 characters with no control
characters). Two new tables hold the rest of the profile:

- `public.clinic_weekly_hours`: `clinic_id uuid`, `iso_weekday smallint`,
  `opens_at time without time zone`, `closes_at time without time zone`, and
  timestamps. Primary key `(clinic_id, iso_weekday)`; `iso_weekday` is
  restricted to `1..7`; a check constraint requires `opens_at < closes_at`
  (no overnight intervals, at most one interval per weekday); the row is
  erased when its clinic is.
- `public.clinic_closure_dates`: `clinic_id uuid`, `closed_on date`, and
  `created_at`. Primary key `(clinic_id, closed_on)`; the row is erased when
  its clinic is.

Both tables enable RLS with no default/public/anon/authenticated privileges.
Authenticated clinic staff get read-only `SELECT` through one same-clinic
`vetai_private.is_clinic_staff(clinic_id)` policy per table, matching the
existing read-only access pattern for `public.clinics` itself; only
`service_role` can write either table.

`public.get_conversation_clinic_operational_context(p_conversation_id uuid,
p_at timestamptz default pg_catalog.now())` is `security invoker`, `stable`,
`set search_path = ''`, and executable only by `service_role` — unlike the
`vetai_private` `SECURITY DEFINER` helpers elsewhere on this page, it needs no
elevated privilege because it only reads rows the service role can already
see. It resolves `clinic_id` solely through the given conversation row (the
caller never supplies a clinic ID directly, so one tenant's conversation can
never read another tenant's clinic), and always returns exactly one row:

- `result text`: `configured | unconfigured | not_found`, plus
  `clinic_name text`, `contact_phone_e164 text`, `public_address text`, and
  `is_open boolean`.
- An absent conversation returns `not_found` with all four payload fields
  null.
- A clinic is `configured` only when its name and phone are valid and it has
  at least one `clinic_weekly_hours` row; otherwise `unconfigured`, again with
  all four payload fields null.
- For a configured clinic, `p_at` is converted to `Europe/Istanbul` inside
  PostgreSQL and `is_open` is true only when the local ISO weekday/time falls
  inside that weekday's half-open interval `[opens_at, closes_at)` — open at
  the exact opening instant, already closed at the exact closing instant —
  and there is no matching `clinic_closure_dates` row for that local date. A
  configured clinic with no weekly-hours row for that weekday is closed for
  the whole day.

`src/clinicOperations.ts` exposes a native-`fetch`
`getConversationClinicOperationalContext` Worker helper following the same
transport and untrusted-response rules as the other functions on this page.
`src/intakeConsumer.ts` calls it, and passes its result to
`applyClinicHandoffContext` (`src/intakeReply.ts`), only once a turn's reply
has already resolved to `human_handoff` — see
[`docs/clinic-operations.md`](clinic-operations.md) for the personalization
behavior and [`docs/inbound-queue.md`](inbound-queue.md) for where this fits
in the Queue consumer's pipeline.

## Selective WhatsApp automation and manual takeover (Task 033)

Task 033 and the strict-allowlist follow-up were validated on disposable
`vetai-test` on 2026-08-22: both rollback fixtures passed with zero residue and
the final default/CHECK/RLS/catalog audit returned seven closed `true` checks.
The strict migration was then applied to `vetai-staging`; its six-check catalog
audit passed and migration history matched 18/18. It is not applied to
production.

`supabase/migrations/20260814000300_selective_automation.sql`. **Codex applied
the migration and ran `supabase/tests/033_selective_automation.sql` on
disposable `vetai-test` on 2026-08-14: PASS with zero fixture residue. It is
not applied to production.**

`public.whatsapp_accounts` originally gained `automation_default`; the
forward-only `20260822000100_strict_ai_allowlist.sql` migration changes its
default and constraint to the single value `personal`. A new
`public.whatsapp_contact_routes`
table holds `(whatsapp_account_id, clinic_id, contact_e164, mode, created_at,
updated_at)`: primary key `(whatsapp_account_id, contact_e164)`;
`contact_e164` constrained to canonical E.164; `mode` constrained to
`ai | manual | personal`; `(whatsapp_account_id, clinic_id)` references
`whatsapp_accounts (id, clinic_id) on delete cascade`. RLS is enabled with no
default/public/anon privileges; authenticated clinic staff get read-only
`SELECT` through one same-clinic `is_clinic_staff(clinic_id)` policy,
matching the read-only pattern used elsewhere on this page; only
`service_role` can write. No audit/history table — the current row is the
whole model.

Two private helpers back every route decision:
`vetai_private.effective_contact_automation_mode(whatsapp_account_id,
contact_e164)` (`stable`, `security invoker`) returns the contact's override
if one exists, else the account's `automation_default`; and
`vetai_private.lock_owner_and_resolve_automation(clinic_id,
whatsapp_account_id, owner_id)` (`volatile`, `security invoker`) locks the
owner row `for update` before resolving its effective mode, so route
mutation and finalization always serialize on the same owner lock.

`public.resolve_whatsapp_contact_automation(p_phone_number_id text,
p_contact_e164 text)` is `security invoker`, `stable`, `set search_path=''`,
and executable only by `service_role`. It returns exactly one closed
`ai | manual | personal | unknown_account` result and exposes no identifier.
`public.set_whatsapp_contact_route(p_whatsapp_account_id uuid,
p_contact_e164 text, p_mode text)` is `security definer`, `volatile`, `set
search_path=''`, and executable only by `authenticated` — the one other
`SECURITY DEFINER` write pattern this schema already has, alongside the
staff work-item RPCs. `p_mode` accepts `ai | manual | personal | inherit`
(`inherit` deletes the override); it locks the target account row,
authorizes its clinic through `is_clinic_staff`, and returns the same
`not_found` for an absent or cross-tenant account so the two are
indistinguishable. It returns only `updated | unchanged | not_found` — never
an account, clinic, contact, or owner identifier. When the resulting mode is
`manual` or `personal`, still-`pending` outbox rows for that account/owner's
conversations are deleted in the same transaction; `processing`, `accepted`,
and `failed` rows are never touched. A preserved `processing` row can be
reclaimed/retried after lease expiry within the existing attempt ceiling; a
request already handed to Meta cannot be recalled.

The strict-allowlist migration also deletes existing `pending | processing`
outbox rows unless their exact `(whatsapp_account_id, recipient_e164)` has
an explicit `ai` route. Deleting `processing` prevents lease-expiry
reclaim/retry, but cannot recall a single network request already handed to
Meta. Terminal `accepted | failed` history remains. Thereafter unlisted
contacts resolve `personal`; only an exact `ai` override enters ingest.

`ingest_whatsapp_text_message` is replaced (same signature) to recheck the
account and `(account, sender E.164)` override inside the ingest
transaction, while holding a key-share lock on the exact account row and
before any event/owner/conversation/message write: `personal`
returns `ignored` with a null conversation ID and zero writes; `manual`
persists the same sanitized record `ai` traffic does but marks the event's
intake state terminally completed and returns `manual` with its conversation
ID; exact redelivery under a currently manual route remains `manual` and is
not enqueued; `ai` behavior is unchanged; unknown accounts remain
`unknown_account`.

`claim_intake_queue_job` now also returns the claimed job's current
automation mode, with `message_text` strictly null for `manual | personal`.
`finalize_intake_queue_job`, `finalize_appointment_offer_queue_job`, and
`finalize_appointment_decision_queue_job` are replaced (same signatures) to
lock/recheck the effective route via `lock_owner_and_resolve_automation`
after validating and locking the current event/claim, but before any
conversation, slot, or outbox mutation; a non-`ai` route completes the
current lease via the existing `complete_intake_queue_job` and returns a new
closed `suppressed` result with null stage/version instead of mutating any
state. See [`docs/selective-automation.md`](selective-automation.md) for the
full routing/privacy contract and
[`docs/inbound-queue.md`](inbound-queue.md) for the consumer-side race
closure this enables.

## Per-pet appointment guard, cancellation, and inbound bursts (Task 039)

`supabase/migrations/20260829000100_pet_appointment_guard_and_cancellation.sql`
(Part A + Part B) and
`supabase/migrations/20260829000200_inbound_message_bursts.sql` (Part C).
Rollback-only fixtures: `supabase/tests/039_pet_appointment_guard_and_cancellation.sql`,
`supabase/tests/039_inbound_message_bursts.sql`. **Not applied to any
database by the implementer; SQL fixtures are `NOT RUN`.**

**Part A — per-pet appointment guard.** A non-unique lookup index
(`appointment_slots_active_pet_idx` on `pet_id` where `status in ('held',
'confirmed')`) backs a guard enforced entirely by locked-RPC logic, never a
unique index, because "no future confirmed slot and no unexpired hold for
this pet" cannot be expressed as a `now()`-independent partial unique
constraint. `hold_appointment_slot` is replaced (same signature) to return
two new result kinds ahead of `held`: `existing_confirmed` (the pet already
has a future confirmed appointment; no hold is created) and `in_progress`
(a different conversation already holds an unexpired slot for the same pet;
no second hold is created and its time is never disclosed).
`finalize_appointment_offer_queue_job` handles both by advancing to
`completed`/`human_handoff` respectively with a fixed `appointment_unavailable`
reply — the `existing_confirmed` reply is the only one of the two that names
the pet and its existing date/time. Lock order is identical across every RPC
this migration touches: conversation row, then the tenant-scoped `pets` row,
then `appointment_slots` row(s); two conversations for the same pet always
lock their own distinct conversation row first, so they only ever contend on
the shared pet lock and never deadlock.

**Part B — owner-initiated cancellation.** One new closed intake stage,
`appointment_cancel_confirmation`, and a new backend-only table,
`public.appointment_cancellations (clinic_id, appointment_slot_id, owner_id,
pet_id, conversation_id, appointment_starts_at, appointment_ends_at,
cancelled_at)` — RLS enabled, no `authenticated` privileges, `service_role`
only; there is no staff-facing read path yet. Two new RPCs mirror the
existing appointment offer/decision RPCs' claim-validation, suppression-check,
and lock-order template exactly: `finalize_appointment_cancel_offer_queue_job`
looks up exactly one future confirmed appointment for the resolved pet
without writing a cancellation, and pins the exact slot id into
`intake_data.pending_cancel_slot_id` so the decision RPC re-validates that
same appointment rather than any replacement that might exist by the time
`EVET`/`HAYIR` arrives; `finalize_appointment_cancel_decision_queue_job`
re-checks that pinned slot is still `confirmed` and in the future before any
mutation. A successful cancellation inserts the audit row, releases the slot
(`status = 'available'`, all holder columns nulled), and advances the
conversation to `completed` in one transaction — insert, release, lease
completion, and outbox write share one commit; any error rolls back all of
them. A stale/mismatched slot returns `stale_appointment`/`stale_hold`
truthfully with zero mutation. The freed slot becomes available to any later
eligible conversation immediately; the audit row has no automatic erasure —
its retention rule is an open legal decision (see
`docs/onay-paketleri/task-039-kvkk-inceleme-paketi.md`).

**Part C — inbound message bursts.** `public.webhook_events` gains
`ai_burst_eligible boolean not null default false`, written exactly once at
ingest by `ingest_whatsapp_text_message` (same signature) — true only for a
text message that actually reaches the `ai` route; manual/personal/group/
media and any pre-migration historical row stay `false` forever and are
never aggregated. `claim_intake_queue_job` is replaced (same signature) to
add two new closed result kinds ahead of `claimed`: `superseded` (a newer
eligible message already exists for this conversation; this job is
acknowledged with zero model call) and `overflow` (more than 4 eligible
messages, or more than 65536 combined characters, are pending in one fixed,
non-overlapping window anchored at its first incomplete message and spanning
at most 3 seconds — see `src/intakeQueue.ts`'s `delaySeconds: 3` on every
intake enqueue — so the burst is deliberately never truncated into the
model; it routes straight through the existing no-model `human_handoff`
boundary instead). Only the earliest incomplete window may claim; a later
window returns `busy` and stays pending for the bounded Queue retry. The
newest representative atomically completes its older siblings, so reversed
Queue execution cannot discard or duplicate their content. Exact-confirmation stages
(`intake_confirmation`, `appointment_selection`,
`appointment_cancel_confirmation`, `human_handoff`, `completed`) are never
aggregated: they always claim and see only their own current raw message,
so a deterministic `EVET`/`HAYIR` grammar never reads a burst-assembled
string. See [`docs/inbound-queue.md`](inbound-queue.md) for the consumer-side
handling of both new result kinds and
[`docs/ai-behavior-and-safety.md`](ai-behavior-and-safety.md) for the
burst-safety extraction contract.

## Clinic lifecycle: provisioning, suspension and offboarding (Task 041)

`supabase/migrations/20260831000100_clinic_lifecycle.sql` and
`supabase/tests/041_clinic_lifecycle.sql`. The implementer did not apply or
run them. Codex subsequently applied the reviewed migration through the SQL
Editor on disposable `vetai-test` and the corrected rollback fixture returned
`PASS` with zero fixture residue; staging and production remain untouched.

`public.clinics` gains `operational_status` (`suspended | active |
offboarding`, closed `CHECK`, default `suspended`; existing rows backfilled to
`active`), `suspended_at`, `offboarding_started_at`, and `offboarding_token`.
A pair of `CHECK` constraints enforces `suspended_at` non-null iff status is
`suspended`, and `offboarding_started_at`/`offboarding_token` non-null iff
status is `offboarding`. A new
`public.clinic_offboarding_receipts` table (`clinic_id`, SHA-256
`offboarding_token_hash`, fixed `action = 'offboarded'`, `offboarded_at`) has no foreign key to `clinics` —
so it survives that clinic's own cascade-delete in the same transaction — and
carries the same RLS-enabled-zero-policies plus service-role-only grant
pattern as `public.webhook_events`.

Five new `SECURITY INVOKER`, `set search_path = ''`, service-role-only RPCs
(`provision_clinic_v1`, `suspend_clinic_v1`, `resume_clinic_v1`,
`prepare_clinic_offboarding_v1`, `finalize_clinic_offboarding_v1`) and one
forward-only recreate each of `vetai_private.effective_contact_automation_mode`
(gates on clinic status before route/default lookup) and
`public.claim_outbound_message_v2()` (adds an `operational_status = 'active'`
join filter) implement the full lifecycle and its runtime suspension
boundary. The resolver holds a clinic `FOR KEY SHARE` lock through its caller
transaction so lifecycle `FOR UPDATE` transitions cannot race a stale active
decision. See [`docs/clinic-lifecycle.md`](clinic-lifecycle.md) for the
closed result sets, the runtime boundary, and the pilot activation/offboarding
order.

## Clinic AI usage ledger and monthly reconciliation (Task 042)

`supabase/migrations/20260831000200_usage_metering.sql` and
`supabase/tests/042_usage_metering.sql`. The implementer did not apply or run
them. Codex later applied the migration only to disposable `vetai-test`; the
rollback fixture passed with zero residue. Staging/production remain unchanged
and mandatory read-only Opus review passed.

A new `public.clinic_ai_usage_events` table records one row per logical
successful intake-AI turn: `clinic_id`, fixed `event_kind = 'intake_ai_turn'`,
SHA-256 `source_event_hash`/`conversation_hash` (hex, derived from internal
random UUIDs, never a raw identifier, but still treated as protected
pseudonymous data), `model`/`prompt_version` text, a
nullable-as-a-coherent-triplet `input_tokens`/`output_tokens`/`total_tokens`,
and `occurred_at`. It carries no foreign key to `messages` or
`webhook_events`, so it survives their retention and outlives a redelivery
window, but cascades on `clinics` delete. Unlike every other table in this
project, RLS is enabled with **no policy** and **no grant at all** —
including `service_role` — so the ledger is reachable only through two
`SECURITY DEFINER`, `set search_path = ''` RPCs:

- `record_intake_ai_usage_v1(p_conversation_id, p_provider_message_id,
  p_claim_token, p_model, p_prompt_version, p_input_tokens, p_output_tokens,
  p_total_tokens)` re-resolves and locks the representative
  `webhook_events` row through the already-claimed
  `(conversation_id, provider_message_id, claim_token)` itself — the caller
  never supplies `clinic_id` or either hash — and deduplicates at-least-once
  Queue delivery via `unique (clinic_id, event_kind, source_event_hash)` +
  `on conflict do nothing`, returning `recorded`, `duplicate`, `stale_claim`,
  or `not_found`.
- `get_clinic_monthly_usage_v1(p_clinic_id, p_month_start)` returns
  clinic-scoped aggregates (turn count, AI-touched-conversation count, token
  sums, missing-token count) over an `Europe/Istanbul` calendar month, never
  event rows, hashes, or content.

This is measurement only: no currency amount, plan, quota, or runtime
enforcement is introduced. See [`docs/usage-metering.md`](usage-metering.md)
for the full contract, the internal-cost-versus-billing distinction, and the
offboarding export requirement.
