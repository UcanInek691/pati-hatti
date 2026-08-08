# Current task — 017 persist intake replies in an atomic outbox

Status: `READY`

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

Pending.

## Delivery record — Sonnet fills after coding

Pending.
