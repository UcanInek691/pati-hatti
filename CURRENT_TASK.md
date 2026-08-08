# Current task — 011 enqueue persisted inbound work

Status: `READY`

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
