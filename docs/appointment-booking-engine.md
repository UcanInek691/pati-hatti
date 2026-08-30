# Appointment booking database engine

**Status: validated only on disposable `vetai-test` on 2026-08-10.** The
migration was not applied to production or recorded in migration history.
The rollback fixture passed with zero residue. Claude Opus's read-only review
and narrow recheck of the corrected same-target lock branch both passed.

Migration: `supabase/migrations/20260810000100_appointment_booking_engine.sql`.
Rollback-only proof fixture (never run against a real clinic database):
`supabase/tests/022_appointment_booking_engine.sql`.

## Goal

The smallest authoritative appointment engine: a pre-provisioned clinic slot
can be listed as available for a conversation's own clinic, held for 10
minutes while the owner confirms, and confirmed only with the current hold
token. The database — not Worker timing or prompt logic — is the single
authority that prevents a slot from being confirmed twice.

Out of scope for this task: schedule/slot generation, calendar UI, staff
page changes, WhatsApp sending, reply parsing, conversation-state
advancement, outbox creation, cancel/reschedule, veterinarian/room/service
assignment, reminder delivery, external-calendar synchronization, and deploy.

## Table: `public.appointment_slots`

One row per bookable 30-minute slot at a clinic.

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key. |
| `clinic_id` | `uuid` | `references clinics (id) on delete cascade`. |
| `starts_at` / `ends_at` | `timestamptz` | Must be exactly 30 minutes apart, and `starts_at` must fall on a UTC `:00` or `:30` boundary. |
| `status` | `text` | `'available'` \| `'held'` \| `'confirmed'`. |
| `conversation_id`, `owner_id`, `pet_id` | `uuid` | Null while available; all three set together while held/confirmed. |
| `booking_token` | `uuid` | Opaque confirmation capability retained after confirmation for exact idempotent replay; null while available. |
| `hold_until` | `timestamptz` | Set only while held; null once confirmed or released. |
| `confirmed_at` | `timestamptz` | Set only once confirmed. |

Constraints enforce that these fields move together as a matched set:

- `appointment_slots_available_state_check` — all of `conversation_id`,
  `owner_id`, `pet_id`, `booking_token`, `hold_until`, `confirmed_at` are
  null while `status = 'available'`.
- `appointment_slots_held_state_check` — `conversation_id`, `owner_id`,
  `pet_id`, `booking_token`, `hold_until` are all non-null and
  `confirmed_at` is null while `status = 'held'`.
- `appointment_slots_confirmed_state_check` — `conversation_id`,
  `owner_id`, `pet_id`, `booking_token`, `confirmed_at` are all non-null and
  `hold_until` is null while `status = 'confirmed'`.
- `appointment_slots_duration_check` / `appointment_slots_alignment_check` —
  fixed 30-minute, half-hour-aligned slots only.
- `unique (clinic_id, starts_at)` — a clinic cannot have two slots at the
  same start time; this also serves as the availability-listing index.
- `appointment_slots_active_conversation_uniq` — a partial unique index on
  `conversation_id` where `status in ('held', 'confirmed')`, the final
  defense (beyond the RPCs' own logic) against one conversation ending up
  with two active slots under a race.

Two composite foreign keys prove tenant consistency structurally instead of
trusting caller input:

- `(conversation_id, owner_id, clinic_id) references conversations (id, owner_id, clinic_id) on delete cascade`
- `(pet_id, owner_id, clinic_id) references pets (id, owner_id, clinic_id) on delete cascade`

Both cascade on delete: KVKK (Turkish personal-data-protection) erasure of
an owner, pet, conversation, or clinic takes precedence over preserving an
immutable booking-history row. This differs from `conversations.pet_id`'s
own foreign key to `pets`, which is `on delete no action` — a conversation
that still references a pet blocks that pet's own direct deletion, even
though an `appointment_slots` row referencing the same pet does not.

RLS is enabled with no policy; only `service_role` is granted table access.
There is no browser or authenticated-staff path to this table in this task.

### Time and pet snapshot boundaries

Slot times are stored as absolute `timestamptz` instants and aligned on UTC
half-hour boundaries. A later WhatsApp or staff-facing flow must render those
instants in the product time zone, `Europe/Istanbul`; callers must not persist
or compare unzoned local-time strings.

The `pet_id` copied from the conversation when a hold is created is the
booking-time pet snapshot. A later change to `conversations.pet_id` does not
silently rewrite an existing held or confirmed appointment. A future flow that
changes the selected pet must release/re-hold explicitly before confirmation
and must not present the old slot row as reflecting the new selection.

## RPCs

All three are `security invoker`, run with `set search_path = ''`, and are
granted to `service_role` only (revoked from `public`, `anon`,
`authenticated`). Tenant/eligibility routing always comes from the calling
conversation's own persisted state, never from a caller-supplied clinic id.

### `list_available_appointment_slots(p_conversation_id, p_from, p_to, p_limit default 5)`

Returns `(slot_id, starts_at, ends_at)` rows for the conversation's own
clinic, in `starts_at, id` order, capped at `p_limit` (1-10). Raises on a
null conversation id, a null/invalid/inverted/too-wide (`> 31 days`) time
window, or an out-of-range limit.

Returns zero rows (never an error) unless the conversation is `status =
'active'`, has a `pet_id`, and its `intake_stage` is one of
`appointment_offer`, `appointment_selection`, or `appointment_confirmation`.
A listed slot is advisory only — it is not reserved, and may lose a race to
`hold_appointment_slot` before the caller acts on it. A slot counts as
available for listing if it is `'available'`, or `'held'` with an already
expired `hold_until`.

### `hold_appointment_slot(p_conversation_id, p_slot_id)`

Returns exactly one row `(result, booking_token, starts_at, ends_at)` with
`result` one of:

- `not_found` — unknown conversation, unknown slot, or the slot belongs to
  a different clinic than the conversation.
- `not_ready` — conversation is not `active`, has no `pet_id`, or its
  `intake_stage` is not one of `appointment_offer`, `appointment_selection`,
  `appointment_confirmation`.
- `conflict` — the conversation already has a *confirmed* slot; it cannot
  hold a different one through this RPC regardless of which target was
  requested.
- `unavailable` — the target is confirmed, held by a different conversation
  with an unexpired hold, or already in the past. The conversation's own
  existing hold (if any) is left completely untouched.
- `held` — success. If this is an exact replay of the conversation's own
  current unexpired hold on the same slot, the same token and times are
  returned unchanged (no extension). Otherwise a fresh `booking_token` is
  issued, `hold_until` is set to `now() + 10 minutes`, and if the
  conversation held a *different* slot, that other slot is released back to
  `available` first (so the one-active-slot-per-conversation index is never
  violated mid-transaction).

Locks the conversation row first (serializing every hold/confirm call for
that conversation behind one row lock), then locks the target slot and any
distinct existing active slot for that conversation in deterministic
ascending-`id` order, to avoid a cross-conversation deadlock when two
conversations race to hold each other's current slot. Existing-slot ownership
is checked again after the row lock is obtained, so an expired slot reclaimed
by another conversation while the lock was pending cannot be released by its
former holder.

### `confirm_appointment_slot(p_conversation_id, p_slot_id, p_booking_token)`

Returns exactly one row `(result, starts_at, ends_at)` with `result` one of:

- `not_found` — unknown conversation, unknown slot, or cross-clinic slot.
- `already_confirmed` — exact replay: the slot is already confirmed for
  this exact conversation and token. This check runs *before* the
  conversation-stage check, so a replay stays idempotent even if the
  conversation has since advanced past `appointment_confirmation`.
- `not_ready` — conversation is not `active` or its `intake_stage` is not
  `appointment_confirmation`.
- `stale` — the slot is not held, or is held by a different conversation,
  or the token does not match, or the hold has expired, or the slot has
  already started. All of these
  collapse to the same result with zero mutation, so a caller cannot
  distinguish "someone else took it" from "you were too slow" from
  probing.
- `confirmed` — success. Sets `status = 'confirmed'`, clears `hold_until`,
  stamps `confirmed_at`.

All three RPCs raise on missing required input (null ids/token/window)
rather than returning a result row, since that indicates a caller bug, not
a legitimate business outcome.

## Client: `src/appointmentEngine.ts`

A thin, dependency-free wrapper over the Supabase Data API (`POST
/rest/v1/rpc/<name>`) for these three RPCs, following the same shape as the
project's other native-`fetch` Supabase clients. Validates all inputs and
response shapes defensively (UUID format, ISO timestamp parsing, exact
expected key sets) and collapses any transport failure, non-2xx response,
or malformed body to a `{ kind: "failed" }` result. Each Data API request has
a 10-second timeout, so a stalled RPC cannot consume the intake lease. The
client never throws and never logs request or response contents (inputs,
tokens, URLs, bodies, or errors).

**Not wired into any runtime path in this task.** It is not imported by
`src/index.ts` or any other runtime module.

Task 023 (see
[`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md),
**validated only on disposable `vetai-test`; not production**) composes these same three RPCs from two new SQL
functions, `finalize_appointment_offer_queue_job` and
`finalize_appointment_decision_queue_job`, to wire list/hold/confirm into the
intake Queue consumer's `EVET`/`HAYIR` flow. This file's three RPCs, this
migration, and `src/appointmentEngine.ts` itself are unmodified by that task;
`src/appointmentEngine.ts` remains unwired into any runtime path.

## Per-pet guard and cancellation (Task 039)

`hold_appointment_slot` is replaced (same signature, still in
`supabase/migrations/20260810000100_appointment_booking_engine.sql`'s lineage
via the Task 039 migration) to check a pet-scoped guard before ever holding a
slot: it returns `existing_confirmed` when the pet already has a future
confirmed appointment, and `in_progress` when a different conversation holds
an unexpired slot for the same pet, in both cases without creating a hold.
`list_available_slots` is unchanged; `confirm_appointment_slot` now follows
the same conversation → tenant-scoped pet → slot lock order as the hold path,
and the public decision finalizer establishes that prefix before entering its
reviewed private locked body. A
sibling pair of RPCs, `finalize_appointment_cancel_offer_queue_job` and
`finalize_appointment_cancel_decision_queue_job`, mirror this file's
offer/decision RPCs' claim-validation and lock-order template to add
owner-initiated cancellation; see
[`docs/database-schema.md`](database-schema.md#per-pet-appointment-guard-cancellation-and-inbound-bursts-task-039)
for the full contract and
[`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md) for the
conversational flow. `src/appointmentEngine.ts` is unmodified and remains
unwired into any runtime path.

## Verification

Proof lives in `supabase/tests/022_appointment_booking_engine.sql`, a single
`begin ... rollback` transaction that seeds fixture rows, exercises every
branch of all three RPCs (including role-denial for `anon` and
`authenticated`, catalog-level shape assertions for RLS/grants/constraints/
function security properties, and the four KVKK erasure-cascade paths), and
asserts zero fixture rows survive after rollback. Codex ran the corrected
fixture against disposable PostgreSQL 17 `vetai-test`; it returned `PASS`
with zero remaining clinics, owners, pets, conversations, or slots. True
two-session lock blocking remains reviewed from PostgreSQL semantics rather
than claimed by this single-session fixture.
