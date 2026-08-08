# Current task — 011 enqueue persisted inbound work

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

After an inbound WhatsApp text message is durably persisted, publish one small
versioned job to a Cloudflare Queue and await confirmation before returning
HTTP 200. This separates the signed webhook acknowledgement path from future
LLM/state orchestration without implementing the consumer yet.

This task does not consume queue messages, call an LLM, evaluate safety, fetch
conversation context, advance state, generate replies, send WhatsApp messages,
create Cloudflare resources, deploy, or change Supabase.

## Starting context

- Starting HEAD: `4e3102c` on `main`; worktree is clean.
- Task 010 returns a validated conversation ID for both `processed` and exact
  `duplicate` ingestion outcomes. It passed 226 tests and real `vetai-test`
  migration/rollback verification.
- `src/index.ts` currently discards that locator and acknowledges the webhook
  after persistence.
- No Queue binding, producer helper, consumer handler, or queue resource exists.
- Cloudflare's current Queue API confirms a message is written to disk when
  `Queue.send()` resolves. Queue delivery is at least once, so downstream
  consumers must later be idempotent.

Official references reviewed by Codex on 2026-08-08:

- https://developers.cloudflare.com/queues/configuration/configure-queues/
- https://developers.cloudflare.com/queues/configuration/javascript-apis/
- https://developers.cloudflare.com/queues/reference/how-queues-works/

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/intakeQueue.ts`.
- New `test/intakeQueue.test.ts`.
- `src/env.ts`.
- `src/index.ts`, limited to producer wiring and existing result counts/status.
- `wrangler.toml`, limited to one producer binding.
- `test/index.test.ts`.
- `test/supabaseIngest.test.ts`, `test/conversationState.test.ts`, and
  `test/openaiIntake.test.ts` only for the new required Env fixture binding.
- New `docs/inbound-queue.md` limited to this producer-only step.
- Fill the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, migrations, SQL tests, Supabase clients,
WhatsApp parsing/signatures, prompts, extraction/safety/conversation-state
logic, README, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Queue contract

Use the existing Cloudflare Workers types and native Queue binding. Do not add
a wrapper class, provider abstraction, schema library, or dependency.

Configure exactly one producer in `wrangler.toml`:

```toml
[[queues.producers]]
queue = "vetai-intake"
binding = "INTAKE_QUEUE"
```

Add a required, strongly typed `INTAKE_QUEUE` binding to `Env`.

Export a closed versioned message type with exactly these serialized fields:

```text
version: 1
conversationId: string
providerMessageId: string
```

Do not include message text, phone number, owner/pet name, clinic ID, payload
hash, extraction, prompt, secret, or provider response.

Add one small producer helper that:

- accepts the Queue binding plus the already-validated conversation and
  provider-message IDs;
- calls and awaits `queue.send(message, { contentType: "json" })`;
- returns success only after that promise resolves;
- catches a missing binding or send rejection and fails closed;
- never logs the message or identifiers.

## Webhook wiring contract

- For both `processed` and `duplicate` persistence outcomes, enqueue the same
  minimal job using the returned conversation ID and the normalized item's
  provider message ID.
- Enqueue exact duplicates too: this repairs the case where database
  persistence committed but the first Queue send or webhook response failed.
- Do not enqueue `unknown_account` or `failed` outcomes.
- If any required enqueue fails, count that item as failed and return the
  existing HTTP 503 response. Return 200 only after every processed/duplicate
  item has been confirmed by Queue.
- Preserve all signature, envelope, normalization, deduplication, persistence,
  status-only event, 400/401/413/415, and logging behavior. Never log the queue
  body or identifiers.
- Do not use `waitUntil`; the webhook must await durable Queue confirmation.
- Do not add a `queue()` consumer handler or `[[queues.consumers]]` config in
  this task. The producer-only configuration must not be deployed until a
  reviewed consumer exists.

Cloudflare Queue delivery and webhook retries can both create duplicate jobs.
This is expected. Task 012 must validate the message again and provide
idempotent consumer behavior before deployment.

## Required tests

- Producer helper sends exactly the three-field versioned JSON message and
  uses `contentType: "json"`.
- Producer helper resolves success only when `send()` resolves; missing binding
  and thrown/rejected send fail closed without logging.
- A processed persistence outcome enqueues once and returns 200.
- An exact duplicate persistence outcome also enqueues once and returns 200.
- Queue rejection after either successful persistence outcome returns 503.
- Unknown-account and failed persistence outcomes never call Queue and return
  503.
- Status-only and unsupported webhook events never call Queue.
- In-payload duplicate normalization still produces one persistence call and
  one Queue send.
- The Queue body never contains message text, sender, owner name, clinic ID,
  payload hash, or secrets.
- Keep every existing test green.

Use small inert Queue stubs in unrelated Env fixtures; do not create a shared
test framework solely for this binding.

## Documentation requirements

`docs/inbound-queue.md` must explain:

- persistence completes before enqueue and HTTP 200 waits for Queue send;
- processed and exact-duplicate outcomes are both enqueued for retry repair;
- the message contains only the three contract fields;
- duplicate delivery is expected and the future consumer must be idempotent;
- no consumer, LLM/state orchestration, outbound message, real Queue resource,
  deploy, or production approval exists yet.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

The Wrangler dry-run must show the `INTAKE_QUEUE` producer binding. Do not
create a Queue, deploy, commit, push, call an LLM, mutate Supabase, or touch
another external service.

## Observed context — Sonnet fills before coding

- Starting HEAD: `ff28120` (`docs: define inbound queue producer task`), one
  commit ahead of the documented starting HEAD `4e3102c` — the extra commit
  is exactly the CURRENT_TASK.md update for this task, no conflicting code
  changes. Worktree was clean.
- Initial worktree state: clean, nothing to commit.
- Relevant code/tests/config evidence: `src/index.ts` awaited
  `ingestWhatsAppTextMessage` and only tallied `processed`/`duplicate`/`failed`
  counts, discarding the returned `conversationId`. `src/supabaseIngest.ts`
  exports `IngestOutcome` as `{ kind: "processed" | "duplicate";
  conversationId: string } | { kind: "unknown_account" } | { kind: "failed"
  }`. `src/whatsappIngest.ts` exposes `providerMessageId` on each
  `WhatsAppIngestItem`. `src/env.ts` had no Queue binding. `wrangler.toml` had
  no `[[queues.producers]]` block. `@cloudflare/workers-types` (already a
  devDependency, referenced in `tsconfig.json`) declares the global
  `Queue<Body>` interface with `send(message, { contentType, delaySeconds
  })`. `test/index.test.ts`, `test/supabaseIngest.test.ts`,
  `test/conversationState.test.ts`, and `test/openaiIntake.test.ts` each
  construct an `Env` object that needed the new required binding.
- Planned files: `src/intakeQueue.ts` (new), `src/env.ts`, `src/index.ts`,
  `wrangler.toml`, `test/intakeQueue.test.ts` (new), `test/index.test.ts`,
  `test/supabaseIngest.test.ts`, `test/conversationState.test.ts`,
  `test/openaiIntake.test.ts`, `docs/inbound-queue.md` (new).
- Conflicts or blockers: none. Repository evidence matched the task contract.

## Delivery record — Sonnet fills after coding

- Changed files:
  - New: `src/intakeQueue.ts`, `test/intakeQueue.test.ts`,
    `docs/inbound-queue.md`.
  - Modified: `src/env.ts` (added required `INTAKE_QUEUE: Queue<IntakeQueueMessage>`),
    `src/index.ts` (producer wiring only, same result counts/status logic),
    `wrangler.toml` (one `[[queues.producers]]` block), `test/index.test.ts`
    (queue stub/assertions plus new rejection tests), `test/supabaseIngest.test.ts`,
    `test/conversationState.test.ts`, `test/openaiIntake.test.ts` (each only
    gained an inert `INTAKE_QUEUE` fixture binding and its type import).
  - `CURRENT_TASK.md`: filled Observed context and this Delivery record.
- Acceptance criteria satisfied:
  - Closed 3-field versioned message (`version: 1`, `conversationId`,
    `providerMessageId`) exported from `src/intakeQueue.ts`; no wrapper class,
    provider abstraction, schema library, or new dependency was added.
  - `enqueueIntakeJob` awaits `queue.send(message, { contentType: "json" })`,
    resolves `true` only after that promise resolves, and returns `false`
    (fails closed, no logging) on a missing/undefined binding or a
    thrown/rejected send.
  - `src/index.ts` enqueues once for both `processed` and `duplicate`
    outcomes using the returned `conversationId` and the item's
    `providerMessageId`; `unknown_account`/`failed` outcomes are never
    enqueued; a failed enqueue is counted as `failed` and yields the existing
    503 response; 200 is returned only once every item's Queue send
    resolved. No `waitUntil`, no `queue()` consumer, no
    `[[queues.consumers]]` config was added.
  - All required tests from the task list are present and passing (producer
    field/contentType shape, missing-binding and rejected/thrown-send
    failure without logging, processed/duplicate enqueue-once, Queue
    rejection after either outcome returning 503, unknown_account/failed
    never calling Queue, status-only/malformed-400 never calling Queue,
    in-payload duplicate producing one persistence call and one Queue send,
    and an explicit payload-shape assertion proving no extra fields).
  - `docs/inbound-queue.md` covers all five required points.
- Commands and exact results:
  - `pnpm install --frozen-lockfile` → `Already up to date. Done in 491ms`.
  - `pnpm typecheck` → `tsc --noEmit` completed with no output/errors.
  - `pnpm test` → `Test Files 12 passed (12)`, `Tests 232 passed (232)`
    (226 previous + 6 net new/expanded assertions in `test/index.test.ts` +
    4 new in `test/intakeQueue.test.ts`, no regressions).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
    printed binding table including
    `env.INTAKE_QUEUE (vetai-intake)  Queue`, exited on `--dry-run: exiting
    now.` with no resource created.
  - `git diff --check` → exit code 0, no whitespace errors.
- Checks not run and why: none of the required commands were skipped; no
  database/RLS checks apply since this task does not touch Supabase or
  migrations.
- Known limitations:
  - No Queue resource has been created and nothing was deployed; the
    producer binding only exists in `wrangler.toml` and the dry-run output.
  - No consumer, idempotency handling, or downstream orchestration exists —
    intentionally out of scope for this task per the contract.
  - Duplicate WhatsApp webhook retries plus at-least-once Queue delivery can
    both still produce duplicate jobs; this is explicitly accepted and
    documented as Task 012's responsibility.
- Risks for Codex review:
  - `src/env.ts` and `src/intakeQueue.ts` have a type-only circular
    reference (`env.ts` imports `IntakeQueueMessage` from `intakeQueue.ts`;
    `intakeQueue.ts` uses the ambient global `Queue<Body>` type and does not
    import `Env`), so there is no runtime cycle, but worth a second look.
  - The three unrelated test files were only given an inert `INTAKE_QUEUE`
    stub (`{ send: async () => {} } as unknown as Queue<IntakeQueueMessage>`)
    cast to satisfy the type — confirm that's acceptable rather than a
    shared test helper, per the task's "small inert Queue stubs" instruction.

## Codex review and verification

- Decision: `PASS`.
- Reviewed the Queue message contract, all producer callers, webhook ordering,
  retry-repair behavior, binding/config, Env fixtures, logging, tests, and
  documentation. The type-only import creates no runtime cycle, and the small
  inert test stubs are appropriate at this scope.
- Corrected one documentation claim: the future service-role consumer must use
  the existing restricted tenant-scoped RPC and cannot rely on RLS, because
  `service_role` bypasses RLS.
- Codex reran the frozen install, typecheck, all 232 tests, Wrangler dry-run
  (12.32 KiB / gzip 3.83 KiB), `git diff --check`, focused secret scan, and
  NUL-byte scan; all passed.
- Wrangler dry-run confirmed `env.INTAKE_QUEUE (vetai-intake)` as the only
  Queue binding. No Queue resource, consumer, deploy, external call, or
  Supabase mutation occurred.
