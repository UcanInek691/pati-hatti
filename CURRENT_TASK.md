# Current task — 022 appointment booking database engine

Status: `READY`

Primary implementer: Claude Sonnet

Reviewers: Codex, then one read-only Claude Opus architecture/RLS/KVKK and
concurrency review. Opus is required once because this task creates the
authoritative appointment mutation boundary. Do not repeat that review unless
Codex makes a material security or booking-state design change.

## Goal

Build the smallest authoritative appointment engine needed by the next
WhatsApp task:

```text
pre-provisioned clinic slot
  -> list as available for the conversation's own clinic
  -> hold for 10 minutes while the owner confirms
  -> confirm only with the current hold token
```

The database, not prompts or Worker timing, must prevent a slot from being
confirmed twice. Tenant, owner, pet, and conversation routing must be derived
from persisted relationships; callers never supply a clinic or owner ID.

Use one backend-only `appointment_slots` table and exactly three predefined
service-role RPCs. A held slot is not an appointment. Only the confirm RPC
changes it to `confirmed`; the next task may call that RPC only after an
explicit WhatsApp confirmation.

This task does not generate clinic schedules, create a calendar UI, modify the
staff page, send WhatsApp messages, parse appointment replies, advance
conversation state, create an outbox reply, cancel/reschedule appointments,
assign veterinarians/rooms/services, send reminders, sync external calendars,
deploy, or configure real resources. Slots are fixed 30-minute rows provisioned
outside this runtime; production provisioning remains a later operational
requirement.

## Starting context

- Starting HEAD: `6432556` on `main`; the worktree is clean.
- Task 021 is complete with Codex and Claude Opus approval. No production
  migration or deployment has occurred.
- There is no appointment or schedule table. Conversations already have the
  forward-only stages `appointment_offer`, `appointment_selection`, and
  `appointment_confirmation`, but the existing intake planner deliberately
  holds those stages and performs no booking operation.
- `conversations` already enforces `(owner_id, clinic_id)` and optional
  `(pet_id, owner_id, clinic_id)` relationships. The new engine must preserve
  that structure instead of trusting caller-supplied routing.
- Backend RPC clients use native `fetch`, the existing `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` bindings, HTTPS/loopback-only endpoints, strict
  response parsing, and generic fail-closed results.
- PostgreSQL `timestamptz` is authoritative. Store instants, not local-time
  strings; the later WhatsApp flow will render them in `Europe/Istanbul`.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify every fact from source, migrations, callers, tests, scripts, Git
status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration
  `supabase/migrations/20260810000100_appointment_booking_engine.sql`.
- New rollback SQL test
  `supabase/tests/022_appointment_booking_engine.sql`.
- New `src/appointmentEngine.ts` and `test/appointmentEngine.test.ts`.
- New `docs/appointment-booking-engine.md` and a narrow appointment-engine
  section in `docs/database-schema.md`.
- Fill only the **Observed context** and **Delivery record** sections of this
  file.

Do not change dependencies, lockfiles, `wrangler.toml`, Env bindings, Worker
routes/handlers, existing migrations or SQL fixtures, the staff surface,
webhook/Queue/Cron/outbox behavior, intake extraction/planning/replies,
conversation-state code, prompts, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Database contract

### Table: `public.appointment_slots`

Create one table with exactly these responsibilities:

- `id uuid primary key default gen_random_uuid()`;
- `clinic_id uuid not null` with clinic erasure cascade;
- `starts_at timestamptz not null`, `ends_at timestamptz not null`;
- `status text not null default 'available'`, closed to
  `available | held | confirmed`;
- nullable `conversation_id`, `owner_id`, `pet_id`, `booking_token`,
  `hold_until`, and `confirmed_at`;
- `created_at` and `updated_at` non-null timestamps using existing project
  conventions.

Add the minimum supporting unique key to `public.conversations` needed for a
composite FK that proves the slot's `owner_id` is the conversation's owner.
Use composite foreign keys so any non-available row proves all of the
following structurally:

- the conversation belongs to the slot's clinic and owner;
- the pet belongs to that owner and clinic;
- owner, pet, conversation, and slot cannot be mixed across tenants.

Booked/held rows must cascade with clinic, owner, pet, or conversation erasure.
Deleting such a source may delete the slot row; KVKK erasure takes precedence
over preserving an availability hole or immutable appointment history.

Named checks must enforce exactly:

- `ends_at = starts_at + interval '30 minutes'`;
- `starts_at` is aligned to a whole or half hour (minute `0 | 30`, second and
  fractional second zero);
- `available`: all routing/token/hold/confirmation fields are null;
- `held`: conversation/owner/pet/token/hold are non-null and confirmation is
  null;
- `confirmed`: conversation/owner/pet/token/confirmation are non-null and
  hold is null.

Add:

- one unique `(clinic_id, starts_at)` key; fixed aligned 30-minute slots then
  cannot overlap;
- one partial unique key allowing at most one `held | confirmed` slot per
  conversation;
- the smallest index needed by clinic/time availability listing;
- the existing `vetai_private.set_updated_at()` trigger.

Enable RLS. Revoke all table privileges from `PUBLIC`, `anon`, and
`authenticated`; grant table access only to `service_role`. Add no
authenticated policy or browser access in this task. The table must not store
phone numbers, owner/pet names, message text, complaint/safety data, provider
IDs, or raw external payloads.

### RPC 1: list availability

Create exactly:

```text
public.list_available_appointment_slots(
  p_conversation_id uuid,
  p_from timestamptz,
  p_to timestamptz,
  p_limit integer default 5
)
returns table(slot_id uuid, starts_at timestamptz, ends_at timestamptz)
```

It must be `SECURITY INVOKER`, `STABLE`, `SET search_path = ''`, revoked from
`PUBLIC`/`anon`/`authenticated`, and executable only by `service_role`.

Reject null/invalid inputs. Require `1 <= p_limit <= 10`, `p_to > p_from`, and
a window no longer than 31 days. Resolve the conversation internally. Return
zero rows unless it is `active`, has a selected pet, and is currently in
`appointment_offer | appointment_selection | appointment_confirmation`.

Return only that conversation's clinic slots which:

- start no earlier than both `p_from` and database `now()` and before `p_to`;
- are `available` or have an expired `held` lease;
- are ordered by `starts_at`, then `id`, limited by `p_limit`.

This read is advisory: a listed slot is not reserved and may lose a race to
the hold RPC.

### RPC 2: hold/switch a slot

Create exactly:

```text
public.hold_appointment_slot(
  p_conversation_id uuid,
  p_slot_id uuid
)
returns table(
  result text,
  booking_token uuid,
  starts_at timestamptz,
  ends_at timestamptz
)
```

It must be `SECURITY INVOKER`, `VOLATILE`, empty-search-path, service-role-only.

Behavior:

- reject null identifiers before lookup;
- lock the conversation, then lock the target and any active slot belonging to
  that conversation in deterministic slot-ID order;
- derive clinic, owner, and pet only from the locked conversation;
- return `not_found` for an absent conversation or target outside its clinic;
- return `not_ready` unless the conversation is active, has a selected pet,
  and is in one of the three appointment stages;
- return `conflict` when that conversation already has a confirmed slot;
- return `unavailable` when the target is confirmed, held by another
  conversation with an unexpired lease, or no longer starts in the future;
- if the same conversation already holds the same target with an unexpired
  lease, return `held` with the existing token/times without extending it;
- otherwise atomically release any different held slot for that conversation,
  reclaim an expired target hold if necessary, and hold the target until
  `pg_catalog.now() + interval '10 minutes'` with a fresh UUID token;
- return `held` with non-null token/times; every other result returns null
  token/times.

An unavailable target must not destroy the conversation's current valid hold.
The partial unique key is the final defense against two active slots for one
conversation.

### RPC 3: confirm the current hold

Create exactly:

```text
public.confirm_appointment_slot(
  p_conversation_id uuid,
  p_slot_id uuid,
  p_booking_token uuid
)
returns table(result text, starts_at timestamptz, ends_at timestamptz)
```

It must be `SECURITY INVOKER`, `VOLATILE`, empty-search-path, service-role-only.

Behavior:

- reject null identifiers/token before lookup;
- lock the conversation, then the exact same-clinic slot;
- return `not_found` for an absent conversation or a target outside its
  clinic;
- an exact replay of a slot already confirmed for the same conversation and
  retained token returns `already_confirmed` with the same times, even if the
  conversation later advanced;
- otherwise return `not_ready` unless the conversation is active and currently
  at `appointment_confirmation`;
- change `held -> confirmed` only when conversation, slot, token, and an
  unexpired `hold_until` all match; clear `hold_until`, retain the token for
  replay identity, set `confirmed_at = pg_catalog.now()`, and return
  `confirmed` with times;
- any expired, released, reclaimed, wrong-token, wrong-conversation, or
  otherwise non-current hold returns `stale` with null times and no mutation.

No RPC accepts a clinic, owner, pet, start time, end time, status, or arbitrary
data document from the caller. None advances conversation state or writes a
message/outbox row.

## TypeScript client contract

`src/appointmentEngine.ts` exposes only:

- `listAvailableAppointmentSlots(...)`;
- `holdAppointmentSlot(...)`;
- `confirmAppointmentSlot(...)`;
- the minimal input/result/slot types needed by those functions.

Follow the existing native-fetch service-role client rules without changing or
refactoring the older clients:

- require nonblank Supabase URL/key and allow HTTPS or loopback HTTP only;
- validate UUIDs, limit, and date-window inputs before any fetch;
- POST only to the three fixed RPC names;
- never log inputs, tokens, URLs, response bodies, or errors;
- treat network, non-2xx, JSON, row-count, extra/missing-key, result-set,
  timestamp, token, and null-coherence failures as closed `failed` outcomes;
- preserve database timestamps as validated strings; do not format local time;
- return fresh result objects and never mutate caller input.

Closed TypeScript outcomes:

- list: `{ kind: 'listed'; slots } | { kind: 'failed' }`;
- hold: `held` with token/slot, or `not_found | not_ready | unavailable |
  conflict | failed` with no token/slot;
- confirm: `confirmed | already_confirmed` with slot, or `not_found |
  not_ready | stale | failed` with no slot.

Do not import or wire this module from `src/index.ts` or any existing runtime
module in this task.

## Required tests

### TypeScript

Prove at least:

- all local input rejection paths perform zero fetches;
- HTTPS and the three loopback HTTP hosts are accepted; other HTTP/malformed
  configuration fails closed;
- each RPC uses its exact path, headers, method, and closed body;
- list ordering is preserved and exact slot rows are required;
- each allowed hold/confirm result is parsed with correct null coherence;
- UUID/token/timestamp, extra-key, wrong-row-count, malformed JSON, non-2xx,
  and network failures return `failed`;
- no input/result is mutated and no `console` method is called;
- no real Supabase request occurs.

### Rollback SQL fixture

`supabase/tests/022_appointment_booking_engine.sql` runs inside
`BEGIN`/`ROLLBACK` and proves at least:

- table columns/checks, fixed duration/alignment, unique keys, composite FKs,
  RLS/grants, trigger, and all three function shapes;
- invalid duration, alignment, duplicate start, incoherent state, and
  cross-tenant owner/pet/conversation combinations fail with zero partial
  mutation;
- listing is same-clinic, future/window bounded, ordered/limited, includes an
  expired hold, and excludes other-clinic/unexpired-held/confirmed slots;
- hold success derives the exact conversation clinic/owner/pet, creates a
  10-minute token lease, and exact replay does not extend it;
- switching slots is atomic; an unavailable target leaves the previous valid
  hold unchanged;
- a confirmed slot conflicts, while an expired target can be reclaimed with a
  new token and no old-conversation authority;
- confirm succeeds only for the exact current token at
  `appointment_confirmation`, exact replay is idempotent, and wrong/expired/
  released/reclaimed/cross-conversation tokens cannot confirm;
- unknown/cross-clinic inputs do not reveal or mutate another tenant;
- `PUBLIC`, `anon`, and `authenticated` cannot access the table or execute the
  RPCs; `service_role` exercises the successful write path;
- owner/pet/conversation/clinic erasure cascades related held/confirmed rows;
- single-session tests do not claim to prove real lock blocking, while stored
  definitions and deterministic lock order are asserted;
- rollback leaves zero fixture clinics, users, owners, pets, conversations,
  or slots.

Sonnet must not apply the migration or SQL fixture. Codex alone validates them
on disposable `vetai-test`.

## Documentation

Create `docs/appointment-booking-engine.md` describing the one-table state
machine, 30-minute slot assumption, 10-minute hold, advisory listing,
hold/switch/confirm semantics, current-token idempotency, tenant derivation,
RLS/grants, erasure behavior, UTC storage/Europe-Istanbul display boundary,
and every omitted feature.

Update `docs/database-schema.md` narrowly. Mark migration and SQL test
`NOT APPLIED` until Codex validates them. Never claim a randevu is confirmed
by a hold, that a user was notified, or that clinic availability is generated
automatically.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, apply SQL, call real Meta/OpenAI/Supabase, create
real slots/users/resources, install a plugin/dependency, or mutate an external
service.

## Review gate

After Sonnet delivers, Codex reviews the full schema/RPC/client path, runs all
checks, applies the migration and rollback fixture only to disposable
`vetai-test`, and makes minimum fixes. Then Claude Opus performs one read-only
review focused on tenant/composite-FK isolation, booking state coherence,
double-booking/switch/expiry concurrency, current-token confirmation,
service-role boundaries, KVKK erasure, and truthful claims. PASS closes the
task; only a material blocking fix requires a narrow re-check.

## Observed context — Sonnet fills before coding

Pending.

## Delivery record — Sonnet fills after coding

Pending.
