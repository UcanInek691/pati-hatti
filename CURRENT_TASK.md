# Current task — 023 single-slot WhatsApp appointment confirmation flow

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewers: Codex, then one read-only Claude Opus review limited to appointment
atomicity, explicit confirmation, tenant isolation, truthful copy, and KVKK.
Do not repeat Task 022's already-passed engine review.

## Goal

Wire the reviewed appointment engine into the existing intake Queue consumer
using the smallest truthful MVP flow:

```text
safe appointment request
  -> database selects and temporarily holds the earliest available slot
  -> WhatsApp asks for exact EVET / HAYIR
  -> EVET atomically confirms the current hold
  -> HAYIR atomically releases it and creates no appointment
```

Only an exact, deterministic `EVET` decision may confirm. LLM output must never
select a slot, provide an ID/token, or authorize confirmation. Emergency/human
safety decisions still take precedence over every appointment action.

The database transaction must keep the current Queue claim, conversation
state, slot mutation, outbox reply, and lease completion coherent. A held slot
is not a confirmed appointment. User-facing confirmation copy may be persisted
only after the database has changed the slot to `confirmed` in that same
transaction.

## Deliberately small MVP

Offer only the earliest eligible slot. Do not build multi-slot menus, free-text
date parsing, interactive WhatsApp buttons, alternate-slot browsing,
cancel/reschedule after confirmation, calendar/room/veterinarian assignment,
reminders, schedule generation, or external calendar sync.

`HAYIR` means “do not create this appointment”: release the current hold,
finish the conversation without a confirmed slot, and send truthful decline
copy. An unrecognized reply repeats the same held-slot prompt; it never
confirms or declines. If no slot exists or the hold expires before `EVET`,
route the conversation to human handoff and tell the owner to call the clinic.

This limitation is intentional: one candidate plus exact confirmation avoids
persisting an offer-list snapshot or trusting a changing ordinal selection.

## Starting context

- Starting HEAD: `deec7c8` on `main`; the worktree is clean.
- Task 022's `appointment_slots` table and three service-role RPCs are committed
  and passed disposable `vetai-test`, Codex, and Claude Opus review. They are
  not wired into runtime and are not applied to production.
- The Queue consumer already performs parse → claim → context → LLM extraction
  → deterministic safety/planning → atomic finalization/outbox/lease.
- `planIntakeTurn` holds `ready_for_triage`, `appointment_offer`,
  `appointment_selection`, and `appointment_confirmation` unless safety forces
  handoff. Persisted `intent = 'appointment_request'` is available after the
  safety gate.
- `advance_conversation_intake` permits only same-stage, one-step-forward, or
  human-handoff transitions. The new database finalizers may compose existing
  one-step operations within one transaction; do not weaken that function.
- `outbound_message_outbox` carries fixed reply categories/content and is sent
  by the existing scheduled sender. Staff work items already appear when a
  conversation reaches `human_handoff`; this is visibility, not notification.
- `APP_TIMEZONE` is `Europe/Istanbul`. PostgreSQL `timestamptz` remains
  authoritative; format appointment copy from the selected database instant,
  never from untrusted text.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify every fact from source, migrations, callers, tests, scripts, Git
status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration
  `supabase/migrations/20260810000200_whatsapp_appointment_flow.sql`.
- New rollback SQL test
  `supabase/tests/023_whatsapp_appointment_flow.sql`.
- New `src/appointmentFlow.ts` and `test/appointmentFlow.test.ts`.
- Narrow changes to:
  - `src/intakeConsumer.ts` and `test/intakeConsumer.test.ts`;
  - `src/intakeReply.ts` and `test/intakeReply.test.ts` only to extend the
    closed reply-category type/coverage; do not alter reviewed safety copy or
    precedence;
  - `docs/database-schema.md`, `docs/inbound-queue.md`,
    `docs/appointment-booking-engine.md`, and a new
    `docs/whatsapp-appointment-flow.md`.
- Fill only the **Observed context** and **Delivery record** sections below.

Do not change dependencies, lockfiles, Env bindings, `wrangler.toml`, Worker
routes/handlers, webhook parsing/signature behavior, Queue message shape,
prompts/OpenAI adapter/extraction schema, safety rules, staff UI, outbound
sender/Cron behavior, Task 022 migration/RPCs, or other existing migrations.
Do not add a table.

## Deterministic appointment decision

In `src/appointmentFlow.ts`, add a pure parser that:

- accepts only a string;
- applies NFKC, trims, collapses internal whitespace, and Turkish lowercase;
- returns `confirm` only for the entire normalized message `evet`;
- returns `decline` only for the entire normalized message `hayır` or `hayir`;
- returns `repeat` for everything else;
- never extracts an ID, token, time, date, or action from model output;
- never mutates or logs input.

Add a pure routing decision over current context plus the already-produced
`PlanResult`:

- safety/human-handoff outcomes return no appointment action and continue
  through the existing finalizer/reply path;
- when the planned result is safe, has a matched pet, carries persisted
  `intent = 'appointment_request'`, and reaches/holds `ready_for_triage` or
  `appointment_offer`, choose `offer`;
- at `appointment_selection`, choose the exact parsed
  `confirm | decline | repeat` decision;
- all other stages choose no appointment action;
- `completed` and `human_handoff` remain terminal.

Do not call the appointment RPC clients directly from this pure planner.

## Database migration contract

### Reply categories

Replace only the named outbox reply-category CHECK so it preserves the six
existing values and adds exactly:

- `appointment_offer`;
- `appointment_confirmed`;
- `appointment_declined`;
- `appointment_unavailable`.

No table privilege, RLS, delivery-state, index, routing, or erasure behavior
may change.

### Shared boundaries for both finalizers

Create exactly two new RPCs. Both must be `SECURITY INVOKER`, `VOLATILE`,
`SET search_path = ''`, revoked from `PUBLIC`/`anon`/`authenticated`, and
executable only by `service_role`.

Both functions must:

- reject null/invalid identifiers, claim tokens, versions, stages/decisions,
  pet IDs, and non-object/empty intake data before mutation;
- resolve and lock the exact inbound message/webhook-event pair using the
  existing tenant-safe `(conversation_id, provider_message_id)` path;
- return `already_completed` for an already-completed event, `stale_claim` for
  an absent/non-current claim, and `stale_state` for optimistic version drift;
- derive clinic, WhatsApp account, owner, recipient, conversation, pet, slot,
  token, and times from persisted rows; callers supply none of those routing
  values except the already-validated conversation/event/claim identifiers;
- insert at most one reply for the inbound event using the existing outbox
  uniqueness and no `ON CONFLICT DO NOTHING`;
- call the existing lease completion operation last;
- raise on any impossible nested result so PostgreSQL rolls back conversation,
  appointment, outbox, and lease changes together;
- never store/log phone numbers or message text outside the existing outbox
  operation and never expose them in a return row.

Copy the smallest local finalization code necessary; do not create a generic
SQL execution framework or weaken existing RPCs.

### RPC 1: offer earliest slot atomically

Create:

```text
public.finalize_appointment_offer_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_planned_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table(result text, intake_stage text, state_version integer)
```

`p_planned_next_stage` is closed to `ready_for_triage | appointment_offer`.
Using the existing `advance_conversation_intake`, listing, and hold RPCs inside
one transaction:

1. Apply the planner's validated next stage/data/pet using the expected
   version.
2. Advance one step at a time until `appointment_offer` (never skip by direct
   conversation update).
3. Select only the earliest eligible slot for the conversation's clinic in
   the next 31 days and attempt to hold it through the reviewed hold RPC.
4. On `held`, advance to `appointment_selection`, persist one
   `appointment_offer` outbox row containing the exact held slot time rendered
   with `Europe/Istanbul`, then complete the claim.
5. If no eligible slot exists, advance to `human_handoff`, persist one
   `appointment_unavailable` reply, and complete the claim.
6. If an advisory-list race loses before hold, raise so the transaction rolls
   back and Queue retry can select again; do not commit a stage without a
   matching hold/reply.

Closed results:

- `offered` with `appointment_selection` and the final state version;
- `unavailable` with `human_handoff` and the final state version;
- `already_completed | stale_claim | stale_state` with null stage/version.

### RPC 2: decide the current hold atomically

Create:

```text
public.finalize_appointment_decision_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_decision text,
  p_pet_id uuid,
  p_intake_data jsonb
)
returns table(result text, intake_stage text, state_version integer)
```

`p_decision` is closed to `confirm | decline | repeat`. Require the locked
conversation to be active at `appointment_selection` with the expected state
version. Lock its single current `held | confirmed` appointment row after the
conversation, preserving Task 022's conversation→slot lock order.

- `confirm`: require a non-expired held row whose start is still future; use
  its persisted token with `confirm_appointment_slot`. Advance
  `appointment_selection -> appointment_confirmation -> completed` only
  through existing one-step RPC calls. Insert `appointment_confirmed` copy
  with the confirmed `Europe/Istanbul` time, then complete the claim.
- `decline`: release a held row back to the exact coherent `available` shape
  (if the hold already expired it is still safe to release), create no
  confirmed slot, advance one step at a time to `completed`, insert
  `appointment_declined` copy, then complete the claim.
- `repeat`: never mutate the slot/token/lease. Same-stage advance only to
  persist the validated intake snapshot, repeat the exact held-slot prompt,
  then complete the claim.
- For `confirm | repeat`, if no current unexpired future hold exists, advance
  to `human_handoff`, insert `appointment_unavailable` copy, complete the
  claim, and return `stale_hold`. Never confirm a replacement slot silently.
- A pre-existing confirmed row outside an exact completed replay is an
  impossible/corrupt state: raise and roll back rather than invent success.

Closed results:

- `confirmed | declined` with `completed` and the final state version;
- `repeated` with `appointment_selection` and the final state version;
- `stale_hold` with `human_handoff` and the final state version;
- `already_completed | stale_claim | stale_state` with null stage/version.

### Exact appointment copy

Generate these database-owned replies from trusted slot rows. The placeholder
`{TIME}` is `DD.MM.YYYY HH24:MI` in `Europe/Istanbul`:

- offer/repeat:
  `En erken uygun randevu saati: {TIME}. Bu saat geçici olarak ayrıldı; randevu henüz kesinleşmedi. Onaylamak için yalnızca EVET, vazgeçmek için HAYIR yazın.`
- confirmed:
  `Randevunuz {TIME} için oluşturuldu.`
- declined:
  `Randevu oluşturulmadı.`
- no slot:
  `Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen kliniğimizi telefonla arayın.`
- expired/missing hold:
  `Ayırılan randevu saati artık kullanılamıyor. Lütfen kliniğimizi telefonla arayın.`

Do not claim staff notification, response time, general clinic availability,
or appointment confirmation before the confirmed branch commits.

## TypeScript RPC clients and consumer wiring

`src/appointmentFlow.ts` also exposes minimal native-`fetch` clients for the
two RPCs, following the existing service-role rules:

- HTTPS or loopback HTTP only, existing Supabase bindings only;
- strict local input validation before fetch;
- exact fixed RPC paths and closed request bodies;
- strict one-row/result/stage/version/null-coherence parsing;
- network/non-2xx/JSON/shape errors collapse to fresh `failed` results;
- never throw, mutate input, or log URL/body/token/identifier/error data.

Wire `processIntakeQueueMessage` after extraction and `planIntakeTurn`:

1. Preserve the existing safety-consistency guard and poison fallback.
2. Compute the pure appointment action.
3. For `offer`, call only the appointment-offer finalizer.
4. For `confirm | decline | repeat`, call only the decision finalizer.
5. For no appointment action, preserve the current reply planner and existing
   finalizer byte-for-byte in behavior.

Disposition:

- appointment `offered | unavailable | confirmed | declined | repeated |
  stale_hold | already_completed | stale_claim` → `ack`;
- `stale_state | failed` → `retry`.

Never call the LLM a second time. Never call Meta directly. Replies continue
through the existing outbox/Cron sender. A safety/human signal in the same
message as `EVET` must take the existing handoff path and must not call either
appointment finalizer.

## Required tests

### TypeScript

Prove at least:

- exact normalization/acceptance/rejection for `EVET`, `HAYIR`, and unknown
  text; `evet lütfen`, embedded words, model fields, IDs, dates, and times
  never confirm;
- appointment routing only after a safe matched-pet appointment request and
  only at the specified stages;
- every safety/human precedence case bypasses appointment RPCs;
- both clients validate input/config/request/response shapes, return fresh
  failures, never mutate/log, and make no real request;
- consumer offer/confirm/decline/repeat/no-slot/stale-hold/stale-state/failure
  dispositions and exact RPC bodies;
- existing poison, safety, ordinary intake, Queue, outbox, and sender tests
  remain unchanged in behavior.

### Rollback SQL fixture

Inside one `BEGIN`/`ROLLBACK`, prove at least:

- exact category CHECK, both function signatures/security/grants, and no new
  anon/authenticated table access;
- service-role offer chooses only the earliest same-clinic future slot,
  creates a current 10-minute hold, advances one step at a time to selection,
  writes exact Istanbul copy, and completes the exact claim atomically;
- no-slot routes to handoff with exact copy and no appointment mutation;
- list/hold race failure, stale version, stale claim, invalid input, and
  cross-tenant attempts leave state/slot/outbox/lease unchanged;
- exact confirm produces one confirmed slot, completed conversation, exact
  confirmation copy, and completed claim in one transaction;
- decline releases the hold, produces no confirmed slot, completes the
  conversation, writes decline copy, and completes the claim;
- repeat preserves slot/token/hold time exactly and writes the same offer copy;
- expired/missing hold never confirms, routes to handoff, and writes exact
  unavailable copy;
- duplicate/replayed events remain idempotent and cannot create a second
  outbox row or confirmation;
- owner/account/source/clinic erasure cascades remain intact;
- rollback leaves zero fixture rows.

Sonnet must not apply the migration or SQL fixture. Codex alone validates them
on disposable `vetai-test`.

## Documentation

Create `docs/whatsapp-appointment-flow.md` describing the exact single-slot
journey, deterministic command grammar, safety precedence, atomic boundaries,
Istanbul rendering, truthful hold/confirm semantics, failure/handoff behavior,
and every omitted appointment feature. Update the three allowed existing docs
narrowly. Mark migration/fixture `NOT APPLIED` until Codex validates them.

State plainly that the staff item is durable visibility, not notification;
the user is told to call when automation cannot safely finish.

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

After Sonnet delivers, Codex reviews the complete consumer→RPC→slot→state→
outbox→lease path, runs all checks, and applies the new migration/fixture only
to disposable `vetai-test`. Claude Opus then performs one read-only review
limited to the new atomic finalizers, explicit-confirmation proof, safety
precedence, tenant/KVKK boundaries, and truthful copy. This is the final
appointment review; only a material blocking fix gets a narrow recheck.

## Observed context — Sonnet fills before coding

Confirmed the starting state matched this contract's "Starting context"
section before writing any code: worktree was clean at HEAD `deec7c8` on
`main` (this session later observed later docs-only commits land on `main`
ahead of that as work proceeded; no uncommitted change from any other source
was present at any point). Task 022's migration
(`20260810000100_appointment_booking_engine.sql`) and its three RPCs
(`list_available_appointment_slots`, `hold_appointment_slot`,
`confirm_appointment_slot`) were present, committed, and reviewed, but
`src/appointmentEngine.ts` was not imported anywhere outside its own test —
confirmed by reading `src/appointmentEngine.ts` and `docs/appointment-booking-engine.md`
in full. Read `src/intakeConsumer.ts`, `src/intakeTurn.ts`,
`src/conversationState.ts`, `src/intakeReply.ts`, and `src/intakeJobLease.ts`
in full: the consumer's existing parse -> claim -> context -> extract -> plan
-> finalize pipeline, `planIntakeTurn`'s stage machine (which already holds a
conversation at `appointment_offer` / `appointment_selection` /
`appointment_confirmation` unless a handoff-grade safety decision fires —
confirmed via `decideNextStage`'s fall-through `return currentStage` for
those three stages), `advance_conversation_intake`'s same-stage /
one-step-forward / any-non-terminal-to-human_handoff transition rule, and the
existing `outbound_message_outbox_reply_category_check` / `finalize_intake_queue_job`
atomic-finalization boundary all matched the contract's description exactly,
with no undocumented divergence found. `APP_TIMEZONE=Europe/Istanbul` was
confirmed as the project's existing time-zone convention (already used by
Task 022's own slot-rendering boundary). No RPC client convention in this
codebase (`appointmentEngine.ts`, `conversationState.ts`, `intakeJobLease.ts`)
is shared through an imported helper; each duplicates its own
`isLoopbackHttpUrl`/`buildEndpoint`/`callRpc`/plain-record-check, so
`src/appointmentFlow.ts` follows that same duplication convention rather than
introducing a new shared module, which this contract does not list as an
allowed new file.

## Delivery record — Sonnet fills after coding

**Scope discipline.** Touched only files inside this contract's "Allowed
changes" list. New files: `supabase/migrations/20260810000200_whatsapp_appointment_flow.sql`,
`supabase/tests/023_whatsapp_appointment_flow.sql`, `src/appointmentFlow.ts`,
`test/appointmentFlow.test.ts`, `docs/whatsapp-appointment-flow.md`. Narrow
edits: `src/intakeConsumer.ts` (five-step appointment wiring inserted between
the existing `planIntakeTurn` call and the existing `planIntakeReply` call,
no other line touched), `test/intakeConsumer.test.ts` (two new `describe`
blocks plus two new route helpers, all existing tests byte-for-byte
unaffected since new route overrides default to `undefined`),
`src/intakeReply.ts` (four-value union widening only, no copy/precedence
change), `test/intakeReply.test.ts` (one new coverage test), and narrow
additions to `docs/database-schema.md`, `docs/inbound-queue.md`,
`docs/appointment-booking-engine.md`. `CURRENT_TASK.md` itself: only this
section and "Observed context" were filled in. No dependency, lockfile, Env
binding, `wrangler.toml`, Worker route/handler, webhook, Queue message shape,
prompt/extraction, safety-rule, staff-UI, outbound-sender, or Task 022
migration/RPC file was touched.

**What was built.** `src/appointmentFlow.ts` exports a pure deterministic
`EVET`/`HAYIR` parser (`parseAppointmentDecision`), a pure safety-first
router (`planAppointmentAction`), and two native-`fetch` service-role RPC
clients (`finalizeAppointmentOfferQueueJob`,
`finalizeAppointmentDecisionQueueJob`) matching this project's existing RPC
client conventions exactly (strict local validation, exact-key-count row
checks, `{ kind: "failed" }` on any transport/shape failure, no
throw/no log). `src/intakeConsumer.ts` now calls `planAppointmentAction`
right after `planIntakeTurn` and routes an `"offer"`/`"decision"` action to
the matching new finalizer instead of the existing
`planIntakeReply`/`finalize_intake_queue_job` path; a `"none"` action is
unchanged from before this task. The new migration
(`20260810000200_whatsapp_appointment_flow.sql`) extends
`outbound_message_outbox_reply_category_check` with four values and adds the
two new `SECURITY INVOKER` / `SET search_path = ''` /
`service_role`-only RPCs the client module calls, composing Task 022's three
unmodified RPCs plus `advance_conversation_intake` /
`complete_intake_queue_job` inside single transactions. Full behavioral
contract, safety precedence, atomic boundaries, Istanbul rendering, and every
omitted feature are documented in
`docs/whatsapp-appointment-flow.md`, which is marked **NOT APPLIED to any
database** throughout, as are the narrow additions in
`docs/database-schema.md`, `docs/inbound-queue.md`, and
`docs/appointment-booking-engine.md`.

**Constraints honored throughout.** The new migration
(`20260810000200_whatsapp_appointment_flow.sql`) and its rollback fixture
(`supabase/tests/023_whatsapp_appointment_flow.sql`) were never applied,
executed, or run against any database, disposable or otherwise — Codex alone
validates them on `vetai-test`. No real Meta, OpenAI, or Supabase API call
was made; every test exercises the pure functions directly or stubs `fetch`.
No git commit, push, or deploy was performed; `wrangler deploy --dry-run`
below only validated configuration and did not create any Cloudflare
resource.

**Verification (all run locally, no database/network side effects).**

- `pnpm install --frozen-lockfile` — already up to date, no lockfile change.
- `pnpm typecheck` (`tsc --noEmit`) — zero errors.
- `pnpm test` (`vitest run`, full suite, no path filter) — **895/895 tests
  passed across 24 test files**, including the 115 new tests in
  `test/appointmentFlow.test.ts`, the 50 tests in the extended
  `test/intakeConsumer.test.ts`, and the 32 tests in the extended
  `test/intakeReply.test.ts`.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — built
  and validated bindings only (`INTAKE_QUEUE`, `APP_TIMEZONE`,
  `WHATSAPP_GRAPH_API_VERSION`); exited at `--dry-run: exiting now.` with no
  deployment.
- `git diff --check` — no whitespace errors reported against tracked file
  changes. This command diffs only tracked files already known to git, so it
  did not (and by its own nature cannot) cover the five new untracked files
  listed above; those were reviewed by hand instead.

**Deviation from user instructions (environment-forced, disclosed
plainly).** The user's global `~/.claude/CLAUDE.md` instructs every shell
command to be prefixed with `rtk` (Rust Token Killer). `rtk` is not installed
in this environment: `rtk pnpm install --frozen-lockfile` failed with
`rtk: command not found` (confirmed again just before this verification
pass, via Bash). Every command in this delivery record was therefore run
unprefixed via plain `pnpm`/`git`/`wrangler`. This is a deviation forced by
the environment, not a choice, and no `rtk`-branded token-savings figures are
claimed anywhere in this record.

**Known open item (unchanged from Task 022, not in this task's scope).** The
"true two-session lock blocking" behavior of the underlying `hold_appointment_slot`
row-lock ordering remains reviewed from PostgreSQL semantics rather than
proven by a single-session SQL fixture, exactly as already stated in
`docs/appointment-booking-engine.md`; this task's own new rollback fixture
inherits the same single-session limitation and does not claim otherwise.

## Codex review record — 2026-08-10

**Decision: PASS.** Codex
traced the consumer -> deterministic appointment action -> service-role RPC ->
conversation/slot -> outbox -> Queue lease path and kept Task 022's reviewed
engine unchanged. Scope matches the allowed list; no dependency, Env,
Wrangler, route, webhook, prompt, extraction, safety-rule, staff-UI, sender,
or Task 022 migration drift was found.

Targeted fixes made during review:

- `planAppointmentAction` now treats `needs_safety_check` as non-safe and
  bypasses appointment RPCs, so only `continue_intake` may offer or decide;
- both Data API clients enforce exact result/stage coherence and return fresh
  failure objects, with strict plain non-empty `intakeData` validation;
- both SQL finalizers reject a null `p_pet_id` before mutation, matching the
  shared contract;
- the rollback fixture was corrected for Supabase's two valid empty
  `search_path` catalog encodings, service-role access to its temporary time
  table, valid-pet replay inputs, and isolated account-erasure cascade proof;
- documentation now accurately states that the existing extraction/safety
  pass still runs once before raw-text appointment decision parsing.

Verification after fixes:

- `pnpm install --frozen-lockfile` — passed, no dependency/lockfile change;
- `pnpm typecheck` — passed;
- `pnpm test` — **904/904 passed across 24 files**;
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — passed,
  no deployment and bindings unchanged;
- `git diff --check` — passed (only existing LF/CRLF notices);
- migration `20260810000200_whatsapp_appointment_flow.sql` — applied
  successfully only to disposable `vetai-test`;
- rollback fixture `023_whatsapp_appointment_flow.sql` — returned `PASS` with
  remaining clinics/accounts/owners/pets/conversations/slots/outbox all `0`.

Production, Meta, OpenAI, Cloudflare deployment, and real clinic data remain
untouched.

## Claude Opus review record — 2026-08-10

**Decision: PASS.** The required read-only review found no blocking issue in
the two atomic finalizers, exact raw-text `EVET` confirmation proof,
deterministic safety precedence, tenant/RLS/KVKK boundaries, or truthful user
copy. It independently confirmed that LLM output cannot confirm an
appointment or provide a slot/token, outbox insertion remains in the same
transaction as confirmation, and failed finalization rolls back the entire
operation.

Two non-blocking lifecycle notes were promoted to durable project invariants:
LLM-inferred intent may create only a reversible ten-minute offer, and a hold
interrupted by safety/handoff precedence may remain only until its fixed
expiry. No additional implementation was justified for this task.
