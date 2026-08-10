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
   `payload_hash` returns `duplicate` with no further mutation, and a
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

A lease guarantees one successful completer, not one executing worker after
expiry/reclaim (see [`docs/inbound-queue.md`](inbound-queue.md)). Calling
`advance_conversation_intake` and `complete_intake_queue_job` as two separate
HTTP RPCs would leave a crash window where the same persisted message could
advance conversation state twice. `public.finalize_intake_queue_job(
p_conversation_id, p_provider_message_id, p_claim_token, p_expected_version,
p_next_stage, p_pet_id, p_intake_data, p_reply_category, p_reply_text)`
closes that window by composing both existing, already-validated operations
inside one transaction instead of duplicating their
transition/pet-ownership/completion logic, and now also persists the planned
reply (if any) in the same transaction. It is `SECURITY INVOKER`, `VOLATILE`,
empty-`search_path`, and granted to `service_role` only (revoked from
`PUBLIC`, `anon`, `authenticated`).

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
