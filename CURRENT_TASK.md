# Current task — 017 persist intake replies in an atomic outbox

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex, then Claude Opus for read-only architecture/RLS review

## Goal

Persist the reviewed deterministic intake reply in the same PostgreSQL
transaction that advances conversation state and completes the current intake
lease.

The closed operation becomes:

`current claim -> state advance -> optional outbound outbox insert -> lease completion`

Either all three database effects commit or none do. This closes the crash
window that would otherwise lose a reply after state completion or duplicate a
reply after retry.

This task also preserves the exact inbound WhatsApp account used for each
webhook event. A clinic may own more than one WhatsApp account; an eventual
sender must reply from the same account rather than guessing from `clinic_id`.

This task does not call Meta, send a WhatsApp message, claim/deliver outbox
rows, add a delivery Queue, create resources, deploy, implement staff
notification, triage, or appointments.

## Starting context

- Starting HEAD: `e0f9698` on `main`; worktree is clean.
- `planIntakeReply(currentStage, plan)` is pure and returns either `none` or
  one fixed-copy `send` plan. Codex and Opus reviews passed; it is not wired.
- `finalize_intake_queue_job` currently locks the exact inbound event, advances
  optimistic conversation state, and completes the lease in one transaction.
- `ingest_whatsapp_text_message` resolves `p_phone_number_id` to a WhatsApp
  account but currently persists only the clinic, losing the exact account.
- `whatsapp_accounts` permits multiple accounts per clinic.
- `messages` stores delivered conversation history. A pending outbox item must
  not be inserted there before Meta confirms delivery; Task 018 will own claim,
  send, completion, and delivered-message insertion.
- PostgreSQL executes one RPC statement transactionally: intermediate changes
  are all-or-nothing and invisible until commit. RLS with no applicable policy
  is default-deny for ordinary roles.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New migration
  `supabase/migrations/20260809000100_intake_reply_outbox.sql`.
- New rollback test `supabase/tests/017_intake_reply_outbox.sql`.
- `src/intakeJobLease.ts` and `test/intakeJobLease.test.ts`, limited to the
  finalization reply input/request contract.
- `src/intakeConsumer.ts` and `test/intakeConsumer.test.ts`, limited to calling
  the reviewed reply planner and passing its result to atomic finalization.
- `docs/database-schema.md`, `docs/inbound-queue.md`, and
  `docs/intake-replies.md`, limited to this outbox/account-link boundary.
- Fill only the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, environment bindings, Wrangler config,
`src/index.ts`, webhook/Queue producer behavior, reply copy or precedence,
extraction/planner/safety/pet semantics, existing historical migrations,
existing SQL fixture files, README, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Database contract

### Preserve the inbound WhatsApp account

In the new migration:

1. Add a composite uniqueness constraint on
   `public.whatsapp_accounts (id, clinic_id)` so tenant-safe composite foreign
   keys can target it.
2. Add nullable `whatsapp_account_id uuid` to `public.webhook_events` with a
   composite foreign key
   `(whatsapp_account_id, clinic_id) -> whatsapp_accounts(id, clinic_id)`.
   Keep it nullable only for rows created before this migration.
3. Replace the current `public.ingest_whatsapp_text_message` implementation
   without changing its seven-argument signature or two-column return shape.
   Resolve both `wa.id` and `wa.clinic_id`; new webhook-event inserts must
   persist both.
4. On an exact duplicate with the same payload hash:
   - a null legacy `whatsapp_account_id` may be backfilled to the currently
     resolved account before returning `duplicate`;
   - a different non-null account must raise and mutate nothing;
   - existing tenant-scoped conversation-locator behavior remains unchanged.

Do not add a one-account-per-clinic constraint. Do not accept a clinic or
account ID from Worker input.

### Add the pending outbox table

Create `public.outbound_message_outbox` with exactly these persisted fields:

- `id uuid primary key default gen_random_uuid()`;
- `clinic_id uuid not null`;
- `conversation_id uuid not null`;
- `whatsapp_account_id uuid not null`;
- `source_provider_message_id text not null`;
- `recipient_e164 text not null`;
- `reply_category text not null`;
- `content text not null`;
- `created_at timestamptz not null default now()`.

Constraints:

- composite conversation tenant FK
  `(conversation_id, clinic_id) -> conversations(id, clinic_id)`;
- composite account tenant FK
  `(whatsapp_account_id, clinic_id) -> whatsapp_accounts(id, clinic_id)`;
- composite source-event FK
  `(clinic_id, source_provider_message_id) ->
  webhook_events(clinic_id, provider_event_id)`;
- unique `(clinic_id, source_provider_message_id)`, enforcing at most one
  planned reply for one inbound event inside a tenant;
- provider-message length `1..512` characters;
- recipient must match the existing E.164 database regex;
- category must be one of the six current `IntakeReplyCategory` values;
- content length `1..4096` characters.

The table represents pending work only in this task. Do not add speculative
delivery states, leases, attempts, provider response bodies, error text,
timestamps, or message-history rows; Task 018 will add only what its concrete
sender protocol requires.

Add an index on `(created_at, id)` for the future bounded claimant.

Enable RLS, revoke all from `PUBLIC`, `anon`, and `authenticated`, grant table
access only to `service_role`, and create no RLS policies. Staff must not see
recipient phone numbers through this backend-only table. Do not expose a
general insert/select RPC.

### Extend atomic finalization

Drop the existing seven-argument `finalize_intake_queue_job` and recreate it
with the same first seven parameters plus trailing:

```sql
p_reply_category text default null,
p_reply_text text default null
```

Keep the existing three-column return shape and closed result semantics.
Defaults preserve compatibility with historical SQL tests and callers that
explicitly choose no reply.

Validate before mutation:

- both reply values null means `none` and creates no outbox row;
- exactly one null raises;
- a non-null category must be one of the six closed values;
- non-null reply text must have length `1..4096`.

For a valid send plan, derive every routing value inside the database:

- clinic and exact WhatsApp account from the locked inbound webhook event;
- conversation/owner relationship from the tenant-safe conversation row;
- `recipient_e164` from that conversation owner's row.

Never accept clinic, account, owner, or recipient as an RPC parameter. A
missing legacy account link, missing owner/recipient, or tenant mismatch must
raise and roll back the state advance, outbox insert, and lease completion.

After the existing state advance succeeds and before completing the lease,
insert exactly one outbox row for a send plan. Plain constraint failure must
raise; do not use `ON CONFLICT DO NOTHING`, because silently accepting an
existing mismatched reply would hide corruption. Then reuse
`complete_intake_queue_job` exactly as today.

The function stays `SECURITY INVOKER`, `VOLATILE`, empty `search_path`, fully
qualified, no dynamic SQL, revoked from `PUBLIC`/`anon`/`authenticated`, and
granted only to `service_role`. Update grants for the nine-argument signature.

Do not add `BEGIN`/`COMMIT` inside the migration or function and do not catch an
insert/transition exception in PL/pgSQL; errors must abort the outer RPC
statement so all changes roll back.

## Worker contract

### Finalization client

Change `FinalizeIntakeQueueJobInput` to require:

```ts
reply: IntakeReplyPlan;
```

Reuse the Task 016 type. In `finalizeIntakeQueueJob`, map it to the two new RPC
fields:

- `none` -> `p_reply_category: null`, `p_reply_text: null`;
- `send` -> exact category and exact text.

Do not change the finalization result union or add a second HTTP call.

### Intake consumer

Import and call `planIntakeReply` exactly once after the turn plan is available
and any planned-result handoff consistency check has passed:

- successful plan: pass the exact `PlanResult` and original
  `context.intakeStage`;
- poison/failed plan: pass the failed result and original stage, producing the
  reviewed fixed human-handoff reply unless completed;
- pass the resulting `IntakeReplyPlan` unchanged to
  `finalizeIntakeQueueJob`.

Do not send the reply, enqueue another Queue message, insert into `messages`,
or perform any effect after successful finalization. Existing disposition
mapping stays unchanged: applied/already-completed/stale-claim acknowledge;
stale-state/failed retry.

If finalization commits but its HTTP response is lost, the later attempt sees
the intake event as completed and acknowledges; the already-committed unique
outbox row remains the sole pending reply.

## Required tests

### TypeScript

Mock all fetches. Update existing compact tests to prove:

- finalization sends both explicit null reply fields for `none`;
- every send category/text is forwarded unchanged;
- malformed Data API responses still fail closed and result mapping is
  unchanged;
- the consumer calls reply planning once per attempt that reaches planning;
- normal, emergency, human, safety-question, pet-clarification, complaint,
  receipt, poison-handoff, and completed-none paths pass the exact planned
  reply in the single finalization RPC body;
- inconsistent planned handoff still retries before reply/finalization;
- extraction/context/claim failures still create no reply/outbox request;
- no Meta/Graph API endpoint is called and no second persistence request is
  made after finalization;
- existing Queue acknowledgement/retry behavior remains unchanged;
- no sensitive value or reply body is logged.

Do not refactor existing clients into dependency-injection abstractions solely
for tests.

### Rollback SQL test

`supabase/tests/017_intake_reply_outbox.sql` must run inside `BEGIN`/`ROLLBACK`
and prove at least:

- new ingestion stores the exact account used, including two accounts in one
  clinic;
- exact duplicate behavior preserves/backfills the account link and rejects a
  conflicting account;
- service-role claim + send-plan finalization atomically advances state,
  completes the lease, and inserts one exact outbox row;
- the outbox row derives the correct clinic, conversation, source event,
  WhatsApp account, and owner phone without caller-supplied tenant/routing IDs;
- `none` finalization advances/completes but inserts no outbox row;
- stale claim, stale state, invalid transition/pet, malformed reply pair,
  unknown category, blank/oversized content, and missing legacy account link
  leave conversation, lease, and outbox unchanged;
- retry after an already-completed successful finalization creates no duplicate;
- the same provider message ID in two clinics creates independent rows;
- table constraints reject cross-tenant conversation/account/source
  combinations and duplicate source rows;
- `anon` and `authenticated` have zero table privileges/policies and cannot
  execute the finalizer; real `service_role` can execute the successful write;
- all fixtures roll back and leave zero residue.

The single-session rollback test cannot prove a real crash or concurrent
transaction schedule; document that limit instead of claiming it did.

## Documentation

Update the three allowed docs with:

- exact-account preservation and why clinic-only routing is insufficient;
- outbox fields, backend-only access, uniqueness, and data minimization;
- atomic state/outbox/lease guarantee and retry-after-lost-response behavior;
- the fact that an outbox row is pending intent, not proof of delivery;
- no Meta call, delivery claim, retry, provider ID, delivered `messages` row,
  staff notification, resource creation, or deployment yet;
- migration and SQL test explicitly `NOT APPLIED` until Codex validates them.

Reference:

- PostgreSQL transaction all-or-nothing semantics:
  https://www.postgresql.org/docs/current/tutorial-transactions.html
- PostgreSQL RLS default-deny behavior with no policy:
  https://www.postgresql.org/docs/current/ddl-rowsecurity.html

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not apply the migration or SQL fixture to any database. Mark both
database checks `NOT RUN`; Codex alone will inspect and run them against the
disposable `vetai-test` project after delivery.

Do not commit, push, deploy, call a real LLM/Meta/Supabase endpoint, create a
Queue/resource, install a plugin, or mutate any external service.

## Review gate

After Sonnet delivers, Codex reviews the migration, ingestion replacement,
tenant/account routing, atomic call graph, RLS/grants, Worker request shape,
tests, and docs. Codex then applies the migration and rollback fixture only to
disposable `vetai-test`, records evidence, makes targeted fixes, and reruns all
checks. Because this introduces a backend-only tenant-scoped outbox and changes
an atomic security boundary, Claude Opus performs one read-only architecture/
RLS review before Codex marks the task complete and commits it.

## Observed context — Sonnet fills before coding

- HEAD is `59d06e3` (docs-only: this file), one commit after the stated
  starting point `e0f9698`; worktree clean. No outbox migration, no
  `reply`-related code exists anywhere in `src/` yet — Task 017 has not been
  started.
- `src/intakeReply.ts` exports `planIntakeReply(currentStage: IntakeStage,
  result: PlanResult): IntakeReplyPlan` (not `plan`, matching `PlanResult`
  from `src/intakeTurn.ts`, whose `.kind` is `"planned" | "failed"`).
  `IntakeReplyCategory` has exactly the six documented values. It is pure and
  unwired, confirmed by `docs/intake-replies.md`.
- `public.ingest_whatsapp_text_message` current signature (from
  `20260806000300_ingest_whatsapp_conversation_locator.sql`) takes the
  documented seven params and returns exactly `(result text, conversation_id
  uuid)` — two columns, confirmed.
- `public.finalize_intake_queue_job` current signature (from
  `20260808000200_finalize_intake_queue_job.sql`) takes the documented seven
  params, locks the message/webhook_events pair, calls
  `advance_conversation_intake` then `complete_intake_queue_job`, and returns
  exactly `(result text, intake_stage text, state_version integer)` — three
  columns, confirmed.
- `public.whatsapp_accounts (id uuid pk, clinic_id fk -> clinics, phone_number_id
  text unique, ...)` has no `(id, clinic_id)` composite unique yet — must be
  added. `public.webhook_events` already has `unique (clinic_id,
  provider_event_id)`, directly usable as the outbox's source-event composite
  FK target. `public.owners`, `public.pets`, `public.conversations` already
  follow the `unique (id, <parent>_id, clinic_id)`-style composite-FK pattern
  this task must extend to `whatsapp_accounts`.
- The established backend-only RLS pattern (used for `webhook_events`):
  `alter table ... enable row level security;` +
  `revoke all on ... from anon, authenticated, public;` +
  `grant all on ... to service_role;` with **no** policy created. This is the
  exact pattern to replicate for `outbound_message_outbox`.
- `src/intakeJobLease.ts`: `FinalizeIntakeQueueJobInput` currently has the
  seven fields matching the RPC's seven params 1:1 (`conversationId`,
  `providerMessageId`, `claimToken`, `expectedVersion`, `nextStage`, `petId`,
  `intakeData`). `finalizeIntakeQueueJob` posts them as `p_*` fields and
  parses the response row with `Reflect.ownKeys(row).length !== 3` (must stay
  3 columns) via a shared `asPlainRecord`/`callRpc`/`buildEndpoint` helper set
  also used by `claimIntakeQueueJob`/`completeIntakeQueueJob`.
- `src/intakeConsumer.ts`: after `const plan = planIntakeTurn(context,
  extraction);`, `plan.kind === "planned"` builds `nextStage`/`petId`/
  `intakeData`; the `else` branch is the poison path (`plan.kind ===
  "failed"`) that builds a fresh fallback snapshot for finalization only.
  `planIntakeReply` must be called once on the raw `plan` (not the poison
  fallback) together with `context.intakeStage`, since `planIntakeReply`
  itself already special-cases `result.kind === "failed"` to the fixed
  human-handoff reply per `docs/intake-replies.md`'s documented precedence.
- Test conventions confirmed in `test/intakeJobLease.test.ts` and
  `test/intakeConsumer.test.ts`: Vitest, `vi.stubGlobal("fetch", ...)`, a
  `routedFetch`/`happyRoutes` helper in the consumer test keyed by URL
  substring, and a `bodyOf(fetchMock, callIndex)` helper that JSON-parses a
  given call's request body for exact-shape assertions.

## Delivery record — Sonnet fills after coding

Changed/new files (`git status --porcelain`):

- `supabase/migrations/20260809000100_intake_reply_outbox.sql` (new) —
  composite unique on `whatsapp_accounts (id, clinic_id)`; nullable
  `webhook_events.whatsapp_account_id` with composite FK; replaced
  `ingest_whatsapp_text_message` to resolve/persist the exact account and
  backfill/reject on duplicate; new `outbound_message_outbox` table
  (backend-only RLS, three composite FKs, unique `(clinic_id,
  source_provider_message_id)`, length/category/E.164 checks, `(created_at,
  id)` index); `finalize_intake_queue_job` recreated with the nine-argument
  signature, reply-pair validation, and the exactly-one-outbox-insert step
  before lease completion.
- `supabase/tests/017_intake_reply_outbox.sql` (new) — single-transaction
  rollback test covering every bullet in "Required tests > Rollback SQL
  test": exact-account storage across two accounts in one clinic, duplicate
  backfill/conflict-reject, full claim+finalize with exactly one outbox row
  and no duplicate on already-completed retry, `none`-reply zero-outbox
  path, stale claim/state/invalid transition/cross-tenant pet/malformed
  reply pair/unknown category/blank+oversized content/missing account link
  all leaving conversation/lease/outbox unchanged, same provider message ID
  in two clinics producing independent rows, direct-insert FK/unique
  violations, `anon`/`authenticated` privilege denial on the table and the
  finalizer, and a final zero-residue row count after `rollback;`.
- `src/intakeJobLease.ts` — `FinalizeIntakeQueueJobInput` gained `reply:
  IntakeReplyPlan`; `finalizeIntakeQueueJob` maps it to `p_reply_category`/
  `p_reply_text` (both null for `none`, exact values for `send`). Response
  parsing (three-column shape) unchanged.
- `src/intakeConsumer.ts` — calls `planIntakeReply(context.intakeStage,
  plan)` once, on the raw `planIntakeTurn` result before poison-fallback
  substitution, and passes the result as `reply` on the finalize input. No
  other consumer behavior changed.
- `test/intakeJobLease.test.ts` — `baseInput` now includes `reply: { kind:
  "none" }`; the exact-body-shape test asserts both `p_reply_category` and
  `p_reply_text` are null; a new test asserts a `send`-kind plan maps to the
  exact `p_reply_category`/`p_reply_text` values.
- `test/intakeConsumer.test.ts` — added `p_reply_category`/`p_reply_text`
  assertions to the normal-continue, emergency, human-requested,
  needs-safety-check, terminal-completed, corrupt-snapshot, and
  missing-pet-fallback finalize-reaching cases, each expected category
  derived by hand from `docs/intake-replies.md`'s precedence rules against
  that test's fixture.
- `docs/database-schema.md`, `docs/inbound-queue.md`, `docs/intake-replies.md`
  — updated to describe the account-preservation columns, the outbox table,
  the nine-argument finalizer contract, the consumer wiring, and marked the
  new migration/test `NOT APPLIED` pending Codex validation.
- `CURRENT_TASK.md` — Observed context and this Delivery record.

Verification run (none touched a database):

- `pnpm install --frozen-lockfile` — pass.
- `pnpm typecheck` (`tsc --noEmit`) — pass, no errors.
- `pnpm test` (`vitest run`) — pass, 445/445 across 16 test files.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — pass;
  Total Upload 51.58 KiB / gzip 12.42 KiB; bindings listed:
  `INTAKE_QUEUE` Queue, `APP_TIMEZONE` env var.
- `git diff --check` — pass, exit 0, no whitespace errors.
- Applying `supabase/migrations/20260809000100_intake_reply_outbox.sql` to
  any database — **NOT RUN**. Per the explicit instruction for this
  delivery and `AGENTS.md`, Sonnet has no disposable database access in
  this role; Codex applies it to `vetai-test` after review.
- Running `supabase/tests/017_intake_reply_outbox.sql` — **NOT RUN**, same
  reason; Codex runs it against `vetai-test` after review and records the
  result.

Self-caught issue (fixed before delivery, no DB involved): the SQL test's
first draft declared a nested `procedure` inside a `do $$ ... $$` anonymous
block, which PL/pgSQL does not support. Replaced with a top-level `create
function assert_outbox_fixture6_unchanged(...)` used by that fixture's
negative-path assertions; re-verified against the migration source
afterward.

Not done, by contract: no commit, push, deploy, real Meta/LLM/Supabase call,
resource creation, or database mutation of any kind.

## Codex review record — 2026-08-09

Decision: `PASS`. Codex validation and the mandatory read-only Opus gate are
complete.

Targeted fixes made during review:

- Moved `planIntakeReply` after the planned-result handoff-consistency check,
  preserving exactly one call only on attempts that may reach finalization.
- Added missing consumer coverage for pet-clarification and complaint replies,
  explicit planner-call ordering/count coverage, and all six send-category
  passthrough cases.
- Added `FOR UPDATE` to the duplicate webhook-event lookup so concurrent
  redeliveries cannot race while backfilling a legacy null account link; after
  the first writer, a different account observes the non-null link and raises.
- Strengthened the source-event FK fixture so the rejected provider event now
  really exists under the other clinic instead of being absent everywhere.

Codex verification after those fixes:

- `pnpm install --frozen-lockfile` — pass, already up to date.
- `pnpm typecheck` — pass, no errors.
- `pnpm test` — pass, 452/452 across 16 test files.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — pass;
  51.58 KiB / gzip 12.42 KiB, existing Queue/timezone bindings only.
- `git diff --check` — pass; only Git's existing LF/CRLF notices.

Disposable database validation (`vetai-test` only):

- A first SQL Editor attempt was rejected at parse time because that editor
  had retained unrelated historical text after the pasted migration. A
  read-only follow-up proved `outbound_message_outbox` was absent and
  `webhook_events.whatsapp_account_id` did not exist, so no partial migration
  state remained.
- Applied `supabase/migrations/20260809000100_intake_reply_outbox.sql` from a
  fresh query: success, no rows returned.
- Ran `supabase/tests/017_intake_reply_outbox.sql`: `PASS`; every reported
  fixture count was zero after rollback.
- Re-ran `supabase/tests/013_finalize_intake_queue_job.sql`: `PASS`, proving
  historical seven-argument finalizer calls still resolve through the two
  trailing defaulted parameters.
- Final read-only introspection: outbox exists; account-link column exists;
  RLS enabled; policy count 0; outbox row count 0; finalizer defaulted-argument
  count 2; `service_role` can execute; `anon` and `authenticated` cannot.

Not run: a true two-session concurrent legacy-backfill race. The new row lock
and read-committed recheck were reviewed from PostgreSQL locking semantics;
the rollback fixture remains intentionally single-session.

### Opus review response — 2026-08-09

Opus returned `CHANGES_REQUIRED` with one blocking erasure finding; the other
eight requested architecture/security areas passed.

Resolved before re-review:

- Added `ON DELETE CASCADE` to all three outbox composite foreign keys. A
  pending reply and its copied recipient phone can no longer block deletion of
  its owner/conversation, WhatsApp account, source event, or clinic cascade.
- Added `and whatsapp_account_id is null` to the legacy backfill update as a
  local fail-closed guard in addition to the existing row lock.
- Extended the rollback fixture to exercise conversation/owner erasure and
  the account/source-event cascade actions independently.
- Applied the targeted function/FK update to disposable `vetai-test`; the
  updated Task 017 rollback test returned `PASS` with zero residue.
- Read-only catalog verification returned three total outbox foreign keys,
  three cascade actions, the local null guard present, and zero outbox rows.
- Post-fix local verification passed: frozen install, typecheck, 452/452 tests,
  Worker dry-run (unchanged bindings), and `git diff --check`.

Final Opus re-review: `PASS`. The reviewer confirmed all three cascade actions
are tenant-safe, the owner/KVKK erasure path is restored, the local null guard
is correct, and no RLS, privilege, atomic-order, validation-order, tenant, or
privacy regression was introduced. Task 017 is approved for commit.
