# Current task — 012 validate and lease queued intake jobs

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewers: Codex, then Claude Opus (read-only architecture/security review)

## Goal

Create the fail-closed idempotency boundary needed by the future Cloudflare
Queue consumer: strictly revalidate each untrusted Queue body, atomically lease
the exact persisted inbound message, and complete work only with the current
lease token.

This task provides parser and database/client primitives only. It does not add
a `queue()` handler, configure a Queue consumer, call an LLM, evaluate safety,
advance conversation state, generate/send replies, create a Queue, or deploy.

## Starting context

- Starting HEAD: `2f2beff` on `main`; worktree is clean.
- Task 011's producer publishes exactly `{ version: 1, conversationId,
  providerMessageId }` after persistence, but Queue and webhook delivery are
  both at least once.
- `messages` uniquely identifies WhatsApp messages by
  `(clinic_id, whatsapp_message_id)` and links them to conversations.
- `webhook_events` uniquely identifies provider events by
  `(clinic_id, provider_event_id)` but currently tracks only inbound
  persistence, not downstream intake processing.
- The Queue consumer must never rely on TypeScript types, Queue ordering, RLS
  under `service_role`, or an in-memory duplicate set for correctness.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New migration:
  `supabase/migrations/20260808000100_intake_job_lease.sql`.
- New rollback SQL test:
  `supabase/tests/012_intake_job_lease.sql`.
- `src/intakeQueue.ts` and `test/intakeQueue.test.ts`.
- New `src/intakeJobLease.ts` and `test/intakeJobLease.test.ts`.
- `docs/database-schema.md` and `docs/inbound-queue.md`, limited to this
  lease/idempotency boundary and its unapplied status.
- Fill the Observed context and Delivery record sections of this file.

Do not change previous migrations, dependencies, lockfiles, `Env`, Worker
routing, `wrangler.toml`, Queue producer behavior, Supabase ingestion or
conversation-state clients, prompts, OpenAI/extraction/safety modules, README,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Queue-body validation contract

Add a strict runtime parser for untrusted `unknown` Queue bodies. Accept only a
plain object with exactly these keys:

- `version`, exactly numeric literal `1`;
- `conversationId`, a syntactically valid UUID string;
- `providerMessageId`, a non-empty, already-trimmed string of at most 512
  Unicode code points.

Reject missing/extra keys, arrays, exotic prototypes, wrong types, other
versions, malformed UUIDs, empty/whitespace-only or leading/trailing-whitespace
provider IDs, overlength IDs, and any thrown/proxy input. Do not normalize or
silently change the persisted identifier. Return a fresh validated object or
`{ ok: false }`; never mutate or log the input.

Do not accept message text, phone/clinic/owner/pet data, claim tokens, actions,
or arbitrary metadata in the Queue body.

## Database lease contract

Add forward-only intake-processing fields to `public.webhook_events`:

- `intake_status text not null default 'pending'`, constrained to
  `pending | processing | completed`;
- `intake_claim_token uuid`;
- `intake_lease_until timestamptz`;
- `intake_completed_at timestamptz`.

Add a table check constraint enforcing coherent states:

- pending: token/lease/completed time are all null;
- processing: token and lease are non-null, completed time is null;
- completed: token/lease are null, completed time is non-null.

Add exactly two `SECURITY INVOKER`, `VOLATILE`, empty-search-path RPCs. Revoke
them from `PUBLIC`, `anon`, and `authenticated`; grant only to `service_role`.
Use no dynamic SQL.

### `claim_intake_queue_job`

Inputs: conversation UUID and provider-message ID. Validate both. Resolve one
exact inbound message and its webhook event using all of:

- message conversation ID;
- message clinic ID = event clinic ID;
- message WhatsApp ID = requested provider ID = event provider ID;
- message direction is `inbound`;
- event persistence status is `processed`.

Lock the event row so concurrent claims serialize. Return exactly one row:

- `claimed`: create a fresh UUID claim token, set status `processing`, set a
  fixed 120-second lease, and return token plus exact persisted message text;
- `completed`: already completed, with null token/text;
- `busy`: an unexpired processing lease exists, with null token/text;
- `not_found`: no exact tenant-safe message/event pair, with null token/text.

A pending job and an expired processing lease are claimable. Never accept a
clinic ID from the caller. Never return phone, owner/pet, clinic, payload hash,
or webhook error data.

### `complete_intake_queue_job`

Inputs: conversation UUID, provider-message ID, claim-token UUID. Validate all.
Atomically mark the exact job `completed` only when the event is currently
`processing` and its stored token equals the supplied token. Clear token and
lease and set completion time. Return exactly one row:

- `completed` when the current token won;
- `stale` when the job is missing, already completed, pending, or owned by a
  different/newer token.

Completion must use the same tenant-safe message/event relationship as claim.
A stale worker must never complete a lease reclaimed by a newer worker.

Do not add a table, trigger, configurable lease duration, retry counter,
cleanup job, dead-letter behavior, or generic job framework.

## TypeScript client contract

Add native-fetch service-role helpers following the existing
`src/conversationState.ts` transport rules: HTTPS or loopback HTTP only, blank
configuration fails closed, no dependency, no body/ID/secret logging.

Closed claim result:

- `{ kind: "claimed", claimToken: string, messageText: string }`
- `{ kind: "completed" }`
- `{ kind: "busy" }`
- `{ kind: "not_found" }`
- `{ kind: "failed" }`

Closed completion result:

- `{ kind: "completed" }`
- `{ kind: "stale" }`
- `{ kind: "failed" }`

Treat every Data API response as untrusted: exactly one plain row with exactly
the documented columns, an exact known result, UUID token and
1..65536-code-point text only for `claimed`, null token/text for every other
claim result, and no unexpected success shape. Network/HTTP/JSON/configuration/
shape failures return `failed`.

Do not wire these helpers into `src/index.ts` or any Queue handler yet.

## Required tests

TypeScript tests must cover strict Queue parser acceptance, every rejection
class above, immutability/fresh output, valid claim/completion responses, exact
RPC request shapes, HTTPS/loopback rules, missing config, and all network/HTTP/
JSON/row/result/token/text failure paths.

The rollback SQL test must prove:

- pending claim returns exact message text and a token;
- concurrent/second claim before expiry returns busy;
- expired lease is reclaimed with a different token;
- stale old token cannot complete; current token completes;
- completed job remains completed and cannot be reclaimed;
- two clinics may reuse the same provider ID without cross-tenant leakage;
- wrong conversation/provider pair and non-inbound/non-processed fixtures
  return not_found;
- state check constraint rejects incoherent rows;
- only service_role can execute both RPCs;
- rollback leaves zero fixture rows.

Do not claim database validation passed unless Codex applies the migration and
runs the SQL test against the disposable `vetai-test` project. Sonnet must not
mutate any database.

## Documentation requirements

Document the lease states, 120-second expiry/reclaim behavior, token-protected
completion, exact message binding, service-role-only access, untrusted Queue
revalidation, and the fact that no consumer/orchestration/deploy exists yet.
Mark the migration and SQL test `NOT APPLIED` until Codex verifies them.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, create a Queue, call an LLM, mutate Supabase, or
touch another external service.

## Mandatory review gate

After Sonnet delivers, Codex must review all code and run the real `vetai-test`
migration/rollback test. If Codex passes it, Claude Opus must perform a
read-only review of tenant binding, claim concurrency, lease expiry, stale-token
completion, privileges, and fail-closed parsing before the task can complete.

## Observed context — Sonnet fills before coding

- Starting HEAD: `8f123b2` on `main` ("docs: define intake job lease task"); worktree clean before this task's edits.
- Initial worktree state: clean; no other in-progress changes.
- Relevant code/tests/migration evidence: `supabase/migrations/20260806000000_core_tenant_schema.sql` confirms `messages(id, clinic_id, conversation_id, direction, content, whatsapp_message_id, created_at)` with unique `(clinic_id, whatsapp_message_id)` where non-null, and `webhook_events(id, clinic_id, provider_event_id, payload_hash, processing_status, received_at, processed_at, last_error)` with unique `(clinic_id, provider_event_id)`. `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql` confirms `messages.whatsapp_message_id = webhook_events.provider_event_id = p_provider_message_id` for one inbound message. `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` is the direct template for the new rollback test's fixtures/style. `src/conversationState.ts` and `src/supabaseIngest.ts` are the transport templates for `src/intakeJobLease.ts` (HTTPS/loopback-only `buildEndpoint`, fail-closed on blank config, array-of-one-row response validation, no logging).
- Planned files: `supabase/migrations/20260808000100_intake_job_lease.sql`, `supabase/tests/012_intake_job_lease.sql`, `src/intakeQueue.ts` (add parser only), `test/intakeQueue.test.ts`, `src/intakeJobLease.ts`, `test/intakeJobLease.test.ts`, `docs/database-schema.md`, `docs/inbound-queue.md`, this file's Observed context/Delivery record.
- Conflicts or blockers: none.

## Delivery record — Sonnet fills after coding

- Changed files:
  - `supabase/migrations/20260808000100_intake_job_lease.sql` (new) — adds `intake_status`/`intake_claim_token`/`intake_lease_until`/`intake_completed_at` to `webhook_events` plus a state-coherence check constraint; adds `claim_intake_queue_job(uuid, text)` and `complete_intake_queue_job(uuid, text, uuid)`, both `security invoker volatile set search_path = ''`, revoked from `public`/`anon`/`authenticated`, granted to `service_role` only.
  - `supabase/tests/012_intake_job_lease.sql` (new) — rollback SQL test covering every required proof point (see below). **Not executed against any database.**
  - `src/intakeQueue.ts` — added `parseIntakeQueueMessage`, a strict runtime parser for untrusted Queue bodies (exact 3-key plain object, literal `version: 1`, UUID `conversationId`, non-empty/trimmed/≤512-code-point `providerMessageId`; rejects exotic prototypes and thrown/proxy input; never mutates/logs; returns a fresh object).
  - `test/intakeQueue.test.ts` — added tests for every acceptance/rejection class, immutability, and Unicode code-point counting (astral-character boundary at 512/513).
  - `src/intakeJobLease.ts` (new) — `claimIntakeQueueJob` and `completeIntakeQueueJob` native-fetch service-role clients following `conversationState.ts`'s transport rules; strict untrusted-response validation (exact row shape, exact known result, UUID token + 1..65536-code-point text only for `claimed`, null token/text otherwise).
  - `test/intakeJobLease.test.ts` (new) — request-shape, HTTPS/loopback, missing-config, network/HTTP/JSON/shape-failure, and no-logging tests for both functions.
  - `docs/database-schema.md` — new "Intake queue job lease" section documenting the columns, check constraint, both RPCs, and the `Not applied` status.
  - `docs/inbound-queue.md` — new "Future consumer: strict revalidation and lease" section documenting the parser, the lease client, and the `Not applied` status.
  - `CURRENT_TASK.md` — this Observed context/Delivery record.
- Acceptance criteria satisfied: Queue-body validation contract (strict 3-field parser, all rejection classes, no mutation/logging); database lease contract (columns, check constraint, both RPCs with exact `claimed`/`completed`/`busy`/`not_found` and `completed`/`stale` semantics, tenant safety from the message's own `clinic_id`, service-role-only grants, no dynamic SQL); TypeScript client contract (closed result types, HTTPS/loopback-only, fail-closed on blank config, strict response validation, not wired into `src/index.ts` or any Queue handler); documentation requirements met in both docs files; no `Env`/`wrangler.toml`/producer/routing changes made.
- Commands and exact results:
  - `pnpm install --frozen-lockfile` → passed ("Already up to date").
  - `pnpm typecheck` → passed, no errors.
  - `pnpm test` → passed, 304/304 tests (including all new `intakeQueue`/`intakeJobLease` tests).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` → passed; bindings unchanged from Task 011 (`env.INTAKE_QUEUE (vetai-intake)` Queue, `env.APP_TIMEZONE` var); confirms no accidental producer/consumer wiring.
  - `git diff --check` → passed, no whitespace conflicts (only pre-existing CRLF-normalization warnings on two touched files, not diff conflicts).
- Checks not run and why: **NOT RUN** — applying `supabase/migrations/20260808000100_intake_job_lease.sql` to any database, and running `supabase/tests/012_intake_job_lease.sql` (including against the disposable `vetai-test` project). Per explicit instruction, Sonnet must not mutate any database; Codex will apply the migration and run the rollback test against `vetai-test` and report the result.
- Known limitations: fixed 120-second lease with no configurable duration, retry counter, or cleanup job (ponytail-marked ceiling in the migration, matching the task's stated scope). No queue consumer, LLM call, safety evaluation, or state-orchestration wiring exists; these clients are unused until a later task wires them in.
- Risks for Codex/Opus review: please specifically re-verify (1) the `claim_intake_queue_job`/`complete_intake_queue_job` tenant-safety join (clinic id always comes from the message row, never a caller-supplied id), (2) that `for update of we` actually serializes concurrent claims under real concurrency (the rollback test only proves it sequentially, since Sonnet could not run it), (3) that the state check constraint text matches exactly what the migration enforces, and (4) that the TypeScript response-shape validation in `src/intakeJobLease.ts` can't be satisfied by a malformed/partial Data API response.

## Codex review record

- Decision: `PASS` on 2026-08-08 after both Codex and the mandatory Claude
  Opus read-only review passed.
- Reviewed the complete diff, callers, prior schema/ingestion migrations,
  tenant-safe message/event relationship, row-lock lease transitions,
  completion token check, grants, Queue parser, Data API response parser, and
  documentation. No Queue consumer or other scope expansion was introduced.
- Targeted fixes made during review:
  - exact-key checks now use all own keys, so hidden or symbol metadata cannot
    bypass the Queue-body or Data API row contracts;
  - Data API rows must have `Object.prototype` and fail closed if prototype or
    property inspection throws;
  - the rollback SQL test now attempts completion with the actual superseded
    lease token after reclaim, rather than proving only that an unrelated
    random token is stale.
- Local verification after the fixes: `pnpm install --frozen-lockfile` passed;
  `pnpm typecheck` passed; `pnpm test` passed with 307/307 tests in 13 files;
  `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` passed with
  the existing producer binding only; `git diff --check` passed; focused secret
  and NUL-byte scans found nothing.
- Disposable database verification: applied
  `20260808000100_intake_job_lease.sql` to Supabase project `vetai-test`, then
  ran `supabase/tests/012_intake_job_lease.sql`. The migration returned success
  and the rollback test returned `PASS 0 0 0 0 0 0`, confirming zero fixture
  rows remained. This was an SQL Editor integration test, not a Supabase CLI
  migration-history entry; later production application must still use the
  managed migration workflow.
- Claude Opus review: `PASS`. It independently confirmed tenant-safe binding,
  `FOR UPDATE` claim serialization under PostgreSQL `READ COMMITTED`, lease
  expiry/reclaim, superseded-token rejection, the state constraint,
  service-role isolation, and fail-closed Queue/Data API parsing. It noted two
  evidence limits without blocking the task: the rollback test's second claim
  is sequential rather than a two-session lock test, and its service-role grant
  check exercises `not_found` rather than a successful write path. The existing
  schema grants cover the write path, and no code defect was found.
- Binding design note for the next task: a lease guarantees one successful
  completer, not that only one worker can execute after an expiry/reclaim.
  Irreversible effects must therefore be independently idempotent or committed
  atomically with current-token completion.
