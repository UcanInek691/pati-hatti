# Current task — 015 wire a bounded intake Queue consumer

Status: `READY`

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

- Starting HEAD:
- Initial worktree state:
- Relevant code/tests/config evidence:
- Planned files:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands and exact results:
- Checks not run and why:
- Known limitations:
- Risks for Codex review:
