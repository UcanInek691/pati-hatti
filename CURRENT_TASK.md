# Current task — 015 wire a bounded intake Queue consumer

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

Wire the existing reviewed primitives into one bounded Cloudflare Queue
consumer:

`parse body -> claim lease -> fetch context -> extract current message -> plan
turn -> atomically finalize state+lease -> explicit ack/retry`.

This is the first runtime connection for structured extraction and deterministic
safety planning. It must remain fail-closed, individually acknowledge each
message, bound transient retries through Cloudflare configuration, and route a
corrupt persisted intake snapshot to staff rather than retrying forever.

This task does not generate or send a WhatsApp response, implement triage or
appointments, add a staff panel, change database schema/RPCs, create external
resources, deploy, or make a real OpenAI/Supabase/Queue call.

## Starting context

- Starting HEAD: `a493c1a` on `main`; worktree is clean.
- Queue bodies already have a strict `parseIntakeQueueMessage` boundary.
- `claimIntakeQueueJob` returns the exact persisted inbound message text under a
  120-second database lease.
- `getConversationIntakeContext` returns tenant-scoped owner/pet/state context.
- `extractIntakeViaOpenAi` sends exactly one message with `store: false` and
  returns only a runtime-validated `IntakeExtraction`.
- `planIntakeTurn` owns multi-turn merge, pet identity, safety evaluation, and
  database-valid stage selection.
- `finalizeIntakeQueueJob` atomically advances state and completes the current
  claim, returning a closed result.
- Cloudflare supports per-message `ack()` / `retry()`, bounded `max_retries`, a
  retry delay, and a dead-letter queue. Explicit acknowledgement prevents one
  failed message from replaying already-completed siblings.
- OpenAI recommends a stable, privacy-preserving per-user
  `safety_identifier`, such as a hashed identifier; raw owner/conversation IDs
  must not be sent in that field.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/intakeConsumer.ts`.
- New `test/intakeConsumer.test.ts`.
- `src/index.ts`, limited to adding the Queue handler and imports.
- `test/index.test.ts`, limited to Queue-handler integration tests and fixtures.
- `wrangler.toml`, limited to one consumer block.
- `docs/inbound-queue.md`, limited to the consumer behavior/configuration.
- Fill the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, `Env`, `.dev.vars.example`, migrations,
database tests/RPCs, producer behavior, webhook behavior, extraction prompt or
provider request contract, planner/safety/pet-resolution semantics, README,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Consumer module contract

Add one exported orchestration function in `src/intakeConsumer.ts`:

`processIntakeQueueMessage(body: unknown, env: Env): Promise<"ack" | "retry">`

It must catch unexpected exceptions and return `"retry"`; it must never throw
message content, identifiers, provider bodies, claim tokens, or secrets.

Reuse the existing functions directly. Do not copy their parsers, HTTP clients,
safety rules, stage graph, or database behavior. Do not introduce dependency
injection containers, classes, factories, generic pipelines, custom retry
frameworks, or a new dependency.

## Exact processing order and dispositions

For one untrusted Queue body:

1. Run `parseIntakeQueueMessage` before any network call.
   - Invalid body: `ack`. It contains no trusted locator and retry cannot repair
     it. Do not log the body.
2. Call `claimIntakeQueueJob` with the parsed IDs.
   - `completed` or `not_found`: `ack`.
   - `busy` or `failed`: `retry`.
   - `claimed`: continue using only its claim token and message text.
3. Call `getConversationIntakeContext` with the parsed conversation ID.
   - `not_found` or `failed`: `retry`.
4. Derive the OpenAI safety identifier from `context.ownerId` using native Web
   Crypto SHA-256 over the UTF-8 bytes of the domain-separated string
   `vetai-owner:<ownerId>`. Send the lowercase 64-character hex digest only.
   Never send the raw owner ID, conversation ID, clinic ID, name, phone number,
   or provider ID in `safety_identifier`.
5. Call `extractIntakeViaOpenAi` exactly once with the claimed message text,
   derived safety identifier, and `Env`.
   - Failure/refusal/malformed provider result: `retry`; do not finalize.
6. Call `planIntakeTurn` with the fetched context and validated extraction.
   - `planned`: use its exact `nextStage`, `petId`, and `intakeData` for
     finalization. Do not infer safety from `nextStage`; retain/read the returned
     `safetyDecision` as described below.
   - `failed`: treat the persisted state as poison. Build a fresh valid
     `PersistedIntakeData` containing `schema_version: 1` and a deep-enough copy
     of the validated current extraction, use `petId: null` so the database
     preserves any selected pet, and choose `human_handoff` unless the current
     stage is already `completed` (then keep `completed`). This deliberately
     replaces the corrupt working snapshot; persisted messages remain the
     conversation record. Attempt atomic finalization instead of retrying the
     same poison state forever.
7. Call `finalizeIntakeQueueJob` exactly once with the parsed IDs, current claim
   token, fetched `stateVersion`, selected/fallback stage and pet, and selected/
   fallback snapshot.
   - `applied`, `already_completed`, or `stale_claim`: `ack`.
   - `stale_state` or `failed`: `retry`.

Do not call `completeIntakeQueueJob` separately. Do not implement an in-process
retry loop: a later Queue attempt must reclaim/refetch/re-extract/replan from
current persisted state.

## Safety-result handling

The consumer must explicitly inspect a successful plan's `safetyDecision`:

- `emergency_handoff` and `human_handoff` must be consistent with a
  `human_handoff` next stage unless the current stage is `completed`.
- An inconsistent plan fails closed to `retry` without finalization.
- A `completed` stage remains terminal. If its decision is
  `emergency_handoff` or `human_handoff`, finalization may keep `completed`, but
  emit only a generic operational warning reason such as
  `terminal_safety_signal`; never include IDs, message text, clinical facts,
  names, tokens, or provider output.
- `needs_safety_check` at `ready_for_triage` or an appointment stage may persist
  the same stage in this task because no triage/appointment action is executed.
  Later triage code must consume the safety decision again before acting.

When the planner fails and the poison fallback is used, emit at most one generic
warning reason such as `poison_intake_state`, with no sensitive values. The
database `human_handoff` state is the durable staff-facing signal for every
non-completed conversation.

## Queue handler and Cloudflare configuration

Extend the Worker's default export with:

`queue(batch: MessageBatch<unknown>, env: Env): Promise<void>`

Process messages without `waitUntil`. For every message, await
`processIntakeQueueMessage(message.body, env)` and then call exactly one of:

- `message.ack()` for `ack`;
- `message.retry()` for `retry`.

Catch a rejected processor call per message and retry that message; one message
must not prevent later batch messages from receiving their own explicit
disposition. Do not call `ackAll`, `retryAll`, or throw the whole batch.

Add exactly one consumer block to `wrangler.toml`:

```toml
[[queues.consumers]]
queue = "vetai-intake"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
retry_delay = 120
dead_letter_queue = "vetai-intake-dlq"
```

The explicit 120-second delay lets an abandoned database lease expire before a
new attempt. After three retryable failures, Cloudflare must route the message
to the DLQ instead of silently deleting it. This task only declares the
configuration; Sonnet must not create either Queue or deploy the Worker.

## Required tests

Mock every external `fetch`; no test may call OpenAI, Supabase, or Cloudflare.
Use compact/table-driven cases where practical. Cover at least:

- invalid body -> ack with zero network calls;
- claim `completed`/`not_found` -> ack and `busy`/network/shape failure -> retry;
- context missing/failure -> retry without OpenAI/finalization;
- the SHA-256 safety identifier is stable, 64 lowercase hex characters,
  differs for different owners, and contains none of the raw owner,
  conversation, clinic, provider identifiers or owner name;
- only the claimed message text reaches OpenAI; recent history and snapshot
  text are not added to the provider input;
- extraction failure/refusal -> retry without finalization;
- normal, emergency, human-request, needs-safety-check, and terminal plans pass
  the exact planner output into atomic finalization;
- an inconsistent handoff safety decision is retried without finalization;
- corrupt snapshot and missing-selected-pet planner failures use the fresh
  poison fallback, set non-completed state to `human_handoff`, preserve pet by
  passing null, and finalize rather than retry forever;
- every finalization result maps to the exact disposition above;
- no separate completion RPC, no in-process retry loop, and at most one OpenAI
  call/finalization call per processing attempt;
- Queue handler explicitly acks/retries each message exactly once and continues
  after a per-message failure;
- no log or returned/thrown value contains message text, IDs, clinical facts,
  claim tokens, API/service-role secrets, or provider response bodies;
- existing fetch/webhook producer behavior remains unchanged.

Tests may verify call order through mocked endpoint URLs and request bodies;
do not refactor the existing clients solely to make them injectable.

## Documentation requirements

Update `docs/inbound-queue.md` with:

- the end-to-end consumer order and closed ack/retry table;
- the hashed owner safety identifier and data-minimization boundary;
- poison snapshot -> atomic handoff behavior;
- explicit per-message acknowledgement and the 120-second/3-retry/DLQ policy;
- the fact that LLM work may repeat but state finalization remains atomic;
- explicit limits: no outbound response, triage, appointment mutation, Queue
  creation, deployment, production credentials, or production approval.

Reference the official behavior used by this contract:

- Cloudflare explicit acknowledgements/retries:
  https://developers.cloudflare.com/queues/configuration/batching-retries/
- Cloudflare dead-letter queues:
  https://developers.cloudflare.com/queues/configuration/dead-letter-queues/
- OpenAI safety identifiers:
  https://platform.openai.com/docs/api-reference/responses

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

The dry-run must show both the existing producer binding and the new consumer
configuration without creating resources.

Do not commit, push, deploy, create a Queue/DLQ, call a real LLM, mutate
Supabase, install a plugin/MCP integration, or touch another external service.

## Review gate

After Sonnet delivers, Codex reviews the full orchestration, ack/retry map,
privacy boundary, poison handoff, tests, and dry-run output, then applies only
targeted fixes and commits if all checks pass. Claude Opus is not mandatory for
this task unless Codex finds a new unresolved safety, privacy, tenant, or
concurrency decision outside the reviewed contracts.

## Observed context — Sonnet fills before coding

- Starting HEAD: `7ebb5ab` on `main` (task states `a493c1a`; `git diff --stat
  a493c1a 7ebb5ab -- . ':!CURRENT_TASK.md'` is empty, so the only difference
  is this task-definition commit itself). Worktree was clean.
- Initial worktree state: clean, matching the stated baseline.
- Relevant code/tests/config evidence: `src/intakeQueue.ts`
  (`parseIntakeQueueMessage`, `enqueueIntakeJob`), `src/intakeJobLease.ts`
  (`claimIntakeQueueJob`, `finalizeIntakeQueueJob`, `FinalizeIntakeQueueJobInput`),
  `src/conversationState.ts` (`getConversationIntakeContext`,
  `ConversationIntakeContext`, `IntakeStage`), `src/openaiIntake.ts`
  (`extractIntakeViaOpenAi`), `src/intakeTurn.ts` (`planIntakeTurn`,
  `PersistedIntakeData`, `PlanResult`), `src/safetyDecision.ts`
  (`SafetyDecision`), `src/intakeExtraction.ts` (`IntakeExtraction`),
  `src/env.ts`, `src/index.ts`, `wrangler.toml`, `docs/inbound-queue.md`,
  and existing test conventions in `test/intakeJobLease.test.ts` and
  `test/index.test.ts` (mocked-fetch routing by RPC/endpoint URL, `stubQueue`
  helper, `Env` fixture shape).
- Planned files: new `src/intakeConsumer.ts` and `test/intakeConsumer.test.ts`;
  additive edits to `src/index.ts` (Queue handler + import), `wrangler.toml`
  (one consumer block), `test/index.test.ts` (Queue-handler tests + fixtures),
  and `docs/inbound-queue.md` (consumer documentation).
- Conflicts or blockers: none. All referenced primitives' exported signatures
  matched the task's "Starting context" claims exactly.

## Delivery record — Sonnet fills after coding

- Changed files: `src/intakeConsumer.ts` (new), `test/intakeConsumer.test.ts`
  (new), `src/index.ts` (added `queue()` handler + import), `wrangler.toml`
  (added `[[queues.consumers]]` block), `test/index.test.ts` (added Queue
  handler tests + `fakeMessage`/`fakeBatch` helpers + import), `docs/inbound-queue.md`
  (documented the consumer), `CURRENT_TASK.md` (this section).
- Acceptance criteria satisfied: exact processing order (parse -> claim ->
  context -> hashed safety identifier -> extract -> plan -> atomic finalize);
  every disposition mapping in the contract; independent `safetyDecision`
  consistency check (retries on mismatch) rather than inferring from
  `nextStage`; terminal `completed` stage kept terminal with only a generic
  `terminal_safety_signal` warning; poison-snapshot/missing-pet planner
  failures replaced with a fresh `schema_version: 1` snapshot, `petId: null`,
  `human_handoff` unless already `completed`, finalized (not retried forever)
  with only a generic `poison_intake_state` warning; no separate
  `completeIntakeQueueJob` call; at most one OpenAI call and one finalize
  call per attempt; Queue handler acks/retries each message exactly once and
  a rejected per-message processor call doesn't block sibling messages'
  disposition; `wrangler.toml` consumer block matches the contract exactly
  (`max_batch_size = 1`, `max_batch_timeout = 5`, `max_retries = 3`,
  `retry_delay = 120`, `dead_letter_queue = "vetai-intake-dlq"`).
- Commands and exact results:
  - `pnpm install --frozen-lockfile` — `Already up to date. Done in 598ms
    using pnpm v11.9.0`.
  - `pnpm typecheck` (`tsc --noEmit`) — passed, zero errors.
  - `pnpm test` — passed, 413/413 (386 prior + 27 new: 25 in
    `intakeConsumer.test.ts`, 2 Queue-handler tests in `index.test.ts`).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — exit
    0. Bindings table lists `env.INTAKE_QUEUE (vetai-intake)` and
    `env.APP_TIMEZONE`, unchanged from before. Wrangler's dry-run bindings
    table only reflects `env`-accessible bindings; queue consumers have no
    `env` binding and are not listed there, so the consumer block's presence
    is confirmed by the dry-run succeeding (exit 0, no config error) with
    the new `[[queues.consumers]]` block in `wrangler.toml`, not by a table
    row. Flagging this for Codex to double-check independently.
  - `git diff --check` — required `git -c safe.directory='*'` because the
    repository's `.git` is owned by a different local Windows account than
    the one running this shell (`dubious ownership` error otherwise); this
    was a per-invocation flag, not a persisted global config change. Result:
    only benign LF/CRLF autocrlf notices for `src/index.ts`,
    `test/index.test.ts`, `wrangler.toml`; no conflict markers or
    whitespace errors.
- Checks not run and why: no real Supabase/OpenAI/Cloudflare Queue call was
  made anywhere (all tests mock `fetch`/`Queue`), per the task's explicit
  scope; no Queue/DLQ resource was created and nothing was deployed.
- Known limitations: the inconsistent-handoff-safety-decision test and the
  Queue-handler's own per-message-exception test both use `vi.spyOn` to
  override `planIntakeTurn` / `processIntakeQueueMessage` respectively,
  since the real deterministic planner and the real happy-path processor
  cannot organically produce those specific defensive/failure conditions;
  every other required test scenario drives the real exported functions
  through mocked `fetch` only. The `intakeData` value is passed to
  `finalizeIntakeQueueJob` via `as unknown as Record<string, unknown>` at
  the call site in `src/intakeConsumer.ts`, matching the existing cast
  pattern already used for the same interface-to-index-signature gap in
  `test/intakeTurn.test.ts`; `PersistedIntakeData` itself was not modified
  (out of this task's allowed-changes scope).
- Risks for Codex review: (1) the `isHandoffConsistent` guard in
  `src/intakeConsumer.ts` is currently unreachable via the real
  `planIntakeTurn` (it is deterministic and already enforces this
  invariant) — confirm this is acceptable as defense-in-depth against a
  future planner regression rather than dead code to remove; (2) confirm
  the wrangler dry-run's bindings-table omission of consumer config is
  expected Wrangler behavior and not a sign the consumer block was
  misconfigured or ignored; (3) confirm the `safe.directory` override used
  only for local verification commands needs no repository-side action.

## Codex review record

- Decision: `PASS` on 2026-08-09. No implementation fix was required.
- Scope matched the contract exactly. The Queue consumer reuses the reviewed
  parser, lease, context, extraction, planner, and atomic-finalization
  boundaries; it does not add a second completion call, in-process retries,
  outbound messaging, database changes, or external-resource mutation.
- The complete disposition map, per-message acknowledgement behavior, poison
  snapshot handoff, privacy-preserving safety identifier, generic-only warning
  paths, and rejection containment were reviewed against the call graph and
  tests. The extra handoff-consistency check is accepted as a small fail-closed
  regression guard around the deterministic planner.
- Wrangler accepted the consumer configuration in a dry-run. Consumer triggers
  are configuration, not `env` bindings, so their absence from the binding
  table is expected; the bundled Worker contains the `queue` handler.
- Codex independently reran the frozen install, strict typecheck, all 413 tests,
  and Wrangler dry-run successfully. `git diff --check` passed with only local
  LF/CRLF notices. Focused scans found no NUL bytes, embedded credentials,
  sensitive consumer logging, `waitUntil`, or separate completion call.
- No live OpenAI, Supabase, WhatsApp, or Cloudflare Queue request was made; no
  Queue/DLQ was created and nothing was deployed or pushed.
- Claude Opus review was not required: no new unresolved safety, privacy,
  tenant-isolation, or concurrency decision was introduced beyond the already
  reviewed contracts.
