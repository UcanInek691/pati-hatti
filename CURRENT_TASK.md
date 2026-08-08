# Current task — 013 atomically finalize leased intake state

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewers: Codex, then Claude Opus (read-only architecture/security review)

## Goal

Add the missing database/client primitive that atomically advances conversation
intake state and completes the current Queue lease in one PostgreSQL
transaction. This prevents a crash or expired-lease reclaim from applying the
same persisted WhatsApp message to conversation state twice.

This task does not add a Cloudflare Queue consumer, call an LLM, evaluate
safety, generate/send a WhatsApp response, create a Queue, deploy, or change
the existing producer.

## Starting context

- Starting HEAD: `b72a595` on `main`; worktree is clean.
- Task 012 strictly validates Queue bodies and provides tenant-safe
  `claim_intake_queue_job` / `complete_intake_queue_job` leases on the exact
  persisted inbound message/event pair.
- Task 006 provides `advance_conversation_intake`, which validates pet tenant
  ownership, forward-only stages, terminal states, non-empty intake JSON, and
  optimistic `state_version`.
- A lease guarantees one successful completer, not one executing worker after
  expiry/reclaim. Calling state advance and lease completion as two HTTP RPCs
  would leave a crash window where the same message could advance state twice.
- The smallest safe boundary is one new service-role-only RPC that reuses the
  existing validated state transition and completion functions inside the same
  database transaction.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New migration:
  `supabase/migrations/20260808000200_finalize_intake_queue_job.sql`.
- New rollback SQL test:
  `supabase/tests/013_finalize_intake_queue_job.sql`.
- `src/intakeJobLease.ts` and `test/intakeJobLease.test.ts`, limited to the new
  finalization client and its tests.
- `docs/database-schema.md` and `docs/inbound-queue.md`, limited to this atomic
  state/lease boundary and its unapplied status.
- Fill the Observed context and Delivery record sections of this file.

Do not change previous migrations, dependencies, lockfiles, `Env`, Worker
routing, `wrangler.toml`, Queue producer behavior, existing ingestion/context/
advance/claim/complete semantics, prompts, OpenAI/extraction/safety modules,
README, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Database contract

Add exactly one `SECURITY INVOKER`, `VOLATILE`, empty-search-path RPC:

`public.finalize_intake_queue_job(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_claim_token uuid,
  p_expected_version integer,
  p_next_stage text,
  p_pet_id uuid,
  p_intake_data jsonb
)`

Return exactly one row with:

- `result text`;
- `intake_stage text`;
- `state_version integer`.

Validate all inputs at least as strictly as the existing lease and state RPCs.
Use no caller-supplied clinic ID and no dynamic SQL.

Resolve and lock the exact tenant-safe inbound processed message/event pair
using the same relationship as Task 012: conversation ID, the message's own
clinic ID, requested provider ID matching both message/event IDs, inbound
direction, and processed persistence status.

Closed outcomes:

- `applied`: only when the event is currently `processing`, its stored token
  equals `p_claim_token`, and `advance_conversation_intake` succeeds for
  `p_expected_version`. Complete the same lease in the same transaction and
  return the resulting non-null stage/version.
- `already_completed`: the exact event was already completed; return null
  stage/version and make no conversation change.
- `stale_claim`: the exact pair is missing, not processing, or held by a
  different/newer token; return null stage/version and make no conversation
  change.
- `stale_state`: the current lease token is valid but the optimistic state
  version no longer matches; keep the lease in `processing`, return null
  stage/version, and make no conversation change.

The conversation update and event completion must commit or roll back together.
If the reused state transition raises for invalid stage/data/pet ownership, or
if current-token completion unexpectedly cannot succeed after the state update,
the entire RPC must fail and neither row may be partially changed.

Reuse the existing validated `advance_conversation_intake` and
`complete_intake_queue_job` operations rather than copying their transition,
pet-ownership, status, or completion logic. Re-check the current token under
the locked event row before invoking either operation.

Revoke the new function from `PUBLIC`, `anon`, and `authenticated`; grant only
to `service_role`. Do not add columns, tables, triggers, retry counters, an
outbox, generic job abstractions, or configurable lease duration.

## TypeScript client contract

Extend `src/intakeJobLease.ts` with one native-fetch helper and reuse its
existing transport/row-validation code.

Input:

- conversation ID;
- provider-message ID;
- claim-token UUID;
- expected positive integer state version;
- existing `IntakeStage` next stage;
- nullable pet UUID;
- non-empty intake-data object;
- `Env`.

Closed result:

- `{ kind: "applied", intakeStage: IntakeStage, stateVersion: number }`;
- `{ kind: "already_completed" }`;
- `{ kind: "stale_claim" }`;
- `{ kind: "stale_state" }`;
- `{ kind: "failed" }`.

Treat the Data API response as untrusted: exactly one plain row with exactly
`result`, `intake_stage`, and `state_version`; accept a known intake stage and
positive integer version only for `applied`; require null stage/version for
every other recognized result. Network/HTTP/JSON/configuration/shape failures
return `failed`. Never log IDs, intake data, message content, response bodies,
tokens, or secrets.

Do not wire the helper into `src/index.ts` or a Queue handler yet.

## Required tests

TypeScript tests must cover exact request shape; every valid result; exact
plain-row/column enforcement; unknown results; invalid stage/version/null
combinations; network/HTTP/JSON/configuration failures; HTTPS/loopback rules;
and no sensitive logging.

The rollback SQL test must prove:

- under `set local role service_role`, a real pending fixture can be claimed
  and finalized successfully (closing Task 012's read-only grant-test gap);
- `applied` advances conversation state exactly once and completes/clears the
  same lease atomically;
- a repeat finalize returns `already_completed` without another version bump;
- a superseded/incorrect token returns `stale_claim` without state or event
  mutation;
- a valid token with stale expected version returns `stale_state`, leaves the
  conversation unchanged, and keeps the same processing lease available for a
  corrected retry;
- invalid stage, empty/non-object intake data, and cross-tenant pet input fail
  without partial conversation or event changes;
- two clinics may reuse the same provider ID without cross-tenant effects;
- `anon` and `authenticated` cannot execute the RPC;
- rollback leaves zero fixture rows.

The single rollback script does not need to simulate two browser/database
sessions; Task 012's event-row lock remains the concurrency primitive.

Do not claim database validation passed unless Codex applies the migration and
runs the SQL test against disposable `vetai-test`. Sonnet must not mutate a
database.

## Documentation requirements

Document the atomic state+lease guarantee and its limits:

- it prevents one persisted message from committing conversation state twice;
- LLM work may still execute more than once after lease expiry/reclaim;
- no external WhatsApp send or other irreversible side effect is covered;
- future external effects still require an idempotent/outbox-style boundary;
- no Queue consumer/orchestration/deploy exists yet.

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
read-only review of tenant binding, atomic state+completion semantics,
stale-claim/state handling, rollback behavior, and privileges before completion.

## Observed context — Sonnet fills before coding

- Starting HEAD: `6cefe31` ("docs: define atomic intake finalization task") on
  `main`; its parent `b72a595` ("feat: lease queued intake jobs") matches the
  contract's stated starting HEAD for code — `6cefe31` only adds this task's
  own contract text, so there is no conflict. Worktree was clean
  (`git status` reported nothing to commit).
- Initial worktree state: clean; no untracked or modified files.
- Relevant code/tests/migration evidence: read
  `supabase/migrations/20260806000200_conversation_intake_state.sql` in full
  to get `advance_conversation_intake`'s exact signature/behavior (raises on
  invalid conversation_id/expected_version/next_stage/intake_data/unknown
  conversation/cross-tenant pet/illegal or terminal transition; returns zero
  rows only on an optimistic `state_version` mismatch; otherwise returns one
  row of `(intake_stage, state_version)`). Read `src/conversationState.ts` in
  full for the `IntakeStage` union (`isIntakeStage` there is private, not
  exported, so it is not reusable from `src/intakeJobLease.ts` without
  touching a file outside this task's allowed-changes list). Re-read
  `src/intakeJobLease.ts` and `test/intakeJobLease.test.ts` in full and
  confirmed via `git log` that neither changed since Task 012's `b72a595`
  commit, so no drift to reconcile before extending them.
- Planned files: new migration
  `supabase/migrations/20260808000200_finalize_intake_queue_job.sql`; new
  rollback test `supabase/tests/013_finalize_intake_queue_job.sql`; extend
  `src/intakeJobLease.ts` and `test/intakeJobLease.test.ts`; extend
  `docs/database-schema.md` and `docs/inbound-queue.md`; fill this file.
- Conflicts or blockers: none.

## Delivery record — Sonnet fills after coding

- Changed files:
  - `supabase/migrations/20260808000200_finalize_intake_queue_job.sql` (new):
    adds `public.finalize_intake_queue_job(p_conversation_id, p_provider_message_id,
    p_claim_token, p_expected_version, p_next_stage, p_pet_id, p_intake_data)`
    returning `(result, intake_stage, state_version)`. It locks the exact
    tenant-safe message/event pair with the same `FOR UPDATE OF we` join as
    Task 012, resolves `stale_claim`/`already_completed` purely from that
    locked read, and only then calls `public.advance_conversation_intake`
    followed by `public.complete_intake_queue_job` as ordinary nested function
    calls (reusing, not duplicating, their transition/pet-ownership/
    completion logic) inside the same transaction. A zero-row result from
    `advance_conversation_intake` (optimistic-version mismatch) maps to
    `stale_state` without calling completion, leaving the lease untouched for
    a retry. If `advance_conversation_intake` raises, or if
    `complete_intake_queue_job` unexpectedly returns anything but
    `completed` after a successful advance, the function raises so the whole
    call — including the nested advance's own `UPDATE` — is rolled back.
    `SECURITY INVOKER`, `VOLATILE`, `set search_path = ''`; revoked from
    `public`/`anon`/`authenticated`, granted only to `service_role`.
  - `supabase/tests/013_finalize_intake_queue_job.sql` (new): a single
    `begin; ... rollback;` script proving, using real
    `ingest_whatsapp_text_message` + `claim_intake_queue_job` fixtures under
    `set local role service_role`: (1) a real service_role claim-and-finalize
    write succeeds (closing Task 012's read-only grant-test gap); (2) applied
    advances state exactly once and completes/clears the lease atomically;
    (3) a repeat finalize with the stale token returns `already_completed`
    without a further version bump; (4) a wrong claim token returns
    `stale_claim` with zero conversation/event mutation; (5) the correct
    token with a wrong expected_version returns `stale_state`, leaves the
    conversation unchanged, and keeps the same processing lease intact, then
    a corrected retry with that same token applies successfully; (6) an
    invalid next_stage, an empty intake_data object, a non-object intake_data
    value, and a cross-tenant pet_id each raise and are caught, with an
    assertion afterward that conversation state and the lease row are still
    completely untouched; (7) two clinics reusing the same provider ID each
    apply independently; (8) `authenticated` and `anon` both get
    `insufficient_privilege`; (9) the trailing `select 'PASS', ...` reports
    zero surviving fixture rows across clinics/whatsapp_accounts/owners/pets/
    conversations/messages/webhook_events for both test clinics.
  - `src/intakeJobLease.ts`: added `FinalizeIntakeQueueJobResult`,
    `FinalizeIntakeQueueJobInput`, a local `IntakeStage`-membership check
    (duplicated from `conversationState.ts`'s private, non-exported
    `isIntakeStage`, since that file is outside this task's allowed-changes
    list), and `finalizeIntakeQueueJob(input, env)`. It reuses the existing
    `buildEndpoint`/`callRpc`/`asPlainRecord` transport helpers, requires
    exactly one plain row with exactly `result`/`intake_stage`/`state_version`
    (via `Reflect.ownKeys`), accepts a known `IntakeStage` and positive
    integer version only for `applied`, requires both null for every other
    recognized result, and returns `{ kind: "failed" }` on any network/HTTP/
    JSON/shape/configuration mismatch. Not wired into `src/index.ts` or a
    Queue handler.
  - `test/intakeJobLease.test.ts`: added a `describe("finalizeIntakeQueueJob", ...)`
    block (26 new tests) covering the exact request shape/body, every valid
    result (`applied` with and without a pet id, `already_completed`,
    `stale_claim`, `stale_state`), exact plain-row/column enforcement
    (non-array body, zero/multiple rows, extra column, non-plain
    `Object.create(null)` row, hidden symbol-keyed extra column), unknown
    results, every invalid stage/version/null combination for `applied` and
    for the null-payload results, HTTPS/loopback-only transport rules,
    network/HTTP/JSON/configuration failures, and no sensitive logging.
  - `docs/database-schema.md`: new "## Atomic intake finalization" section
    documenting the RPC's contract, closed outcomes, atomicity/rollback
    guarantee, and its explicit limits, marked `NOT APPLIED`.
  - `docs/inbound-queue.md`: new paragraph under the existing "Future
    consumer" section documenting `finalizeIntakeQueueJob`, its purpose, and
    its limits, marked `NOT APPLIED`.
  - `CURRENT_TASK.md`: this Observed context / Delivery record.
- Acceptance criteria satisfied: database contract (signature, return shape,
  closed outcomes, tenant-safe lock/re-check, reuse instead of duplication,
  atomic commit-or-rollback, revoke/grant) implemented per spec; TypeScript
  client contract (input shape, closed result type, strict untrusted-response
  validation, no sensitive logging, not wired into the Worker) implemented
  per spec; required SQL and TypeScript test coverage implemented per spec;
  documentation requirements (all five limits, `NOT APPLIED` marking on both
  new artifacts) satisfied; no disallowed file was touched (verified with
  `git status --short`, only the eight files listed above changed).
- Commands and exact results:
  - `pnpm install --frozen-lockfile` → `Already up to date. Done in ...ms`.
  - `pnpm typecheck` (`tsc --noEmit`) → completed with no output/errors.
  - `pnpm test` → `Test Files 13 passed (13)`, `Tests 333 passed (333)`
    (307 prior + 26 new `finalizeIntakeQueueJob` tests); no failures.
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
    succeeded; bindings listed are unchanged (`env.INTAKE_QUEUE`,
    `env.APP_TIMEZONE`); `--dry-run: exiting now.`
  - `git diff --check` → exit code 0; only CRLF-normalization notices, no
    reported whitespace errors.
- Checks not run and why: the new migration was not applied and
  `supabase/tests/013_finalize_intake_queue_job.sql` was not executed against
  any database — **NOT RUN**. Per the contract and AGENTS.md, Sonnet must not
  mutate a database; Codex must apply this migration and run the rollback
  test against the disposable `vetai-test` project and report the exact
  result before this can be considered database-verified. No true concurrent
  two-session test was run (as with Task 012, the single rollback script
  cannot simulate two live database sessions); the locking/atomicity argument
  rests on the same `FOR UPDATE OF we` semantics already reviewed and passed
  for Task 012, plus normal PL/pgSQL exception-rollback semantics for the
  raise-on-invalid-input and raise-on-unexpected-stale-completion paths.
- Known limitations: `finalize_intake_queue_job` prevents one persisted
  message from committing conversation state twice, but LLM work may still
  execute more than once if a lease expires and is reclaimed before
  finalization; no WhatsApp send or other irreversible external side effect
  is covered by this boundary; future external effects still need their own
  idempotent/outbox-style boundary; no Queue consumer, orchestration, or
  deployment exists yet, and this task did not add any of those.
- Risks for Codex/Opus review: (1) confirm the precedence of the four closed
  outcomes matches intent — `already_completed` is checked strictly before
  the token/status match check, so a completed event always reports
  `already_completed` regardless of the token supplied, which was a
  deliberate reading of "the exact event was already completed" taking
  priority over "held by a different/newer token"; (2) confirm the
  defensive `raise exception` after an unexpected non-`completed` result from
  `complete_intake_queue_job` (following a successful `advance_conversation_intake`)
  is dead code in practice — reachable only if some future change breaks the
  invariant that holding the `FOR UPDATE OF we` lock for the whole call
  prevents any concurrent change to that row's status/token between the two
  nested calls; (3) confirm reusing `advance_conversation_intake` and
  `complete_intake_queue_job` as plain nested function calls (rather than
  re-implementing their logic) gives the intended atomicity — a raise
  anywhere in `finalize_intake_queue_job`, including inside a nested call,
  aborts the entire top-level statement and rolls back any partial effect of
  that same invocation, so no savepoint/subtransaction handling was added
  around the nested calls; (4) the SQL rollback test's invalid-input/no-
  mutation assertions (fixture 3) wrap each expected-to-raise call in its own
  `begin ... exception when others then null; end;` block, which is the same
  pattern Task 012's test used for `check_violation` — confirm `when others`
  is acceptable here too, since these are expected to be `raise exception`s
  from `advance_conversation_intake`/`finalize_intake_queue_job` rather than a
  specific named condition.

## Codex review record

- Decision: `PASS` on 2026-08-08 after both Codex and the mandatory Claude
  Opus read-only review passed.
- Reviewed the full diff, existing state/lease RPCs, nested call path,
  tenant-safe event lock, optimistic state handling, privileges, TypeScript
  response boundary, tests, and documentation. No Queue consumer or other
  scope expansion was introduced.
- Targeted fixes made during review:
  - qualified nested RPC result columns so the wrapper's `result`,
    `intake_stage`, and `state_version` OUT parameters cannot create ambiguous
    PL/pgSQL column references;
  - added early expected-version, stage, and intake-data validation so every
    input is validated even when the event would otherwise return
    `stale_claim` or `already_completed` before the nested state RPC;
  - changed invalid-input SQL proofs to raise their sentinel outside the
    `WHEN OTHERS` blocks, preventing the test from catching its own
    "unexpectedly accepted" error and falsely passing.
- Local verification after fixes: `pnpm install --frozen-lockfile` passed;
  `pnpm typecheck` passed; `pnpm test` passed with 333/333 tests in 13 files;
  `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` passed with
  the existing producer binding only; `git diff --check` passed; focused secret
  and NUL-byte scans found nothing.
- Disposable database verification: applied
  `20260808000200_finalize_intake_queue_job.sql` to Supabase project
  `vetai-test`, then ran `supabase/tests/013_finalize_intake_queue_job.sql`.
  The migration succeeded and the rollback test returned `PASS` with every
  visible fixture count at zero. Because the horizontally virtualized result
  grid omitted the final column, Codex separately queried the Task 013 clinic
  IDs in `webhook_events`; the count was also zero. This SQL Editor integration
  test is not a Supabase CLI migration-history entry.
- Claude Opus review: `PASS`. It independently confirmed tenant binding, event
  locking/current-token checks, nested-call transaction atomicity, result
  precedence, stale-state preservation, full rollback, privileges, and the
  Codex SQL fixes. It found no correctness or security defect.
- Follow-up decisions accepted for the next consumer task:
  - `stale_state` preserves but does not renew the original 120-second lease;
    retries must be bounded and may become `stale_claim` after reclaim;
  - completed jobs validate all inputs before returning `already_completed`,
    so malformed poison payloads fail closed and must not be retried forever;
  - the closed stage allow-list remains duplicated at current boundaries; do
    not add another copy, and consolidate only when a scoped change can expose
    one shared TypeScript source without weakening database validation.
- Final cleanup after Opus: corrected the SQL test's validation header and
  narrowed all four expected invalid-input errors to SQLSTATE `P0001` plus the
  exact expected message; unexpected database errors now fail the test.
