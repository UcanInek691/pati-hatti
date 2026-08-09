# Inbound intake queue (producer and bounded consumer)

Last verified: 2026-08-09.

## What this step does

After a signed inbound WhatsApp text message is durably persisted through the
`ingest_whatsapp_text_message` RPC (see `docs/database-schema.md`), the Worker
publishes one small versioned job to a Cloudflare Queue named `vetai-intake`
before it acknowledges the webhook with HTTP 200. The webhook response
`await`s the Queue send; it does not use `waitUntil` and does not return
early.

- Both `processed` and exact-`duplicate` persistence outcomes are enqueued.
  Enqueuing duplicates is deliberate: it repairs the case where the database
  write committed but the first Queue send or webhook HTTP response failed
  before the sender's retry, so the retry's duplicate outcome still gets a job
  published.
- `unknown_account` and `failed` persistence outcomes are never enqueued.
- If the required enqueue fails for any item, that item counts as `failed`
  and the webhook returns its existing HTTP 503 response, unchanged from
  Task 010. HTTP 200 is only returned after every processed/duplicate item's
  Queue send has resolved.

## Message contract

`src/intakeQueue.ts` exports a closed, versioned message shape with exactly
three fields:

```text
version: 1
conversationId: string
providerMessageId: string
```

It never includes message text, phone number, owner or pet name, clinic ID,
payload hash, extraction output, prompts, secrets, or any provider response
data. A future consumer re-fetches whatever context it needs from Supabase
using `conversationId` through the existing service-role-only, tenant-scoped
RPC; it does not rely on service-role RLS enforcement.

## Delivery semantics

Cloudflare Queues confirm a message is durably written to disk once
`Queue.send()` resolves, and delivery is at least once. Combined with
WhatsApp's own webhook retry behavior, the same job can be enqueued more than
once for the same message. This is expected and accepted at this stage: the
consumer (`src/intakeConsumer.ts`, below) validates the message again and
behaves idempotently; no deploy or production use is approved yet.

## Strict revalidation and lease

Because Queue and WhatsApp webhook delivery are both at least once, the
consumer must never trust a Queue body as-is and must never assume it is the
only worker processing a given job. Two primitives exist for that, both now
wired into the `queue()` handler below:

- `parseIntakeQueueMessage` in `src/intakeQueue.ts` strictly revalidates an
  untrusted Queue body: it accepts only a plain object with exactly
  `version: 1`, a syntactically valid UUID `conversationId`, and a
  non-empty, already-trimmed `providerMessageId` of at most 512 Unicode code
  points, rejecting every other shape (missing/extra keys, arrays, exotic
  prototypes, wrong types, malformed UUIDs, whitespace issues, overlength
  IDs, and thrown/proxy input) without mutating or logging the input.
- `src/intakeJobLease.ts` exposes `claimIntakeQueueJob` and
  `completeIntakeQueueJob`, native-`fetch` service-role clients for the new
  `claim_intake_queue_job` / `complete_intake_queue_job` database functions
  (see `docs/database-schema.md`). Claiming locks the exact tenant-safe
  inbound message/webhook-event pair, issues a fresh claim token, and sets a
  fixed 120-second lease; an unexpired lease returns `busy` to a concurrent
  claimer, while an expired lease is reclaimed with a new token. Only the
  current token can complete the job — a worker whose lease was reclaimed
  gets `stale`, never `completed`, if it tries to finish late.

> **Disposable validation passed (2026-08-08).** Codex applied the migration
> to `vetai-test`; the rollback test returned `PASS 0 0 0 0 0 0`. This was an
> SQL Editor integration test rather than a Supabase CLI migration-history
> entry, so production still needs the managed migration workflow.

A lease guarantees one successful completer, not one executing worker after
expiry/reclaim: calling state advance and lease completion as two separate
HTTP RPCs would leave a crash window where the same persisted message could
advance conversation state twice. `finalizeIntakeQueueJob` in
`src/intakeJobLease.ts` closes that window by calling the new
`finalize_intake_queue_job` database function (see
`docs/database-schema.md`), which atomically re-checks the current lease
token, advances conversation intake state, and completes the same lease in
one transaction, returning a closed `applied` / `already_completed` /
`stale_claim` / `stale_state` / `failed` result. The consumer below is wired
to this boundary and also calls `planIntakeReply` (`src/intakeReply.ts`),
forwarding its result so a planned reply is inserted into
`outbound_message_outbox` in that same transaction (see
`docs/database-schema.md`'s "Atomic intake finalization" section and
`docs/intake-replies.md`). It still does not cover the actual WhatsApp send
or any other irreversible external effect beyond conversation-state and
outbox finalization — Task 018 owns claiming and sending outbox rows.

A `stale_state` result preserves the current token but does not extend its
original 120-second lease. A corrected retry is valid only before expiry and
before another worker reclaims the job; after reclaim it correctly becomes
`stale_claim`. The consumer's disposition table (below) bounds retries
accordingly, rather than retrying `failed`/invalid payloads forever.

> **Disposable validation passed (2026-08-08).** Codex applied
> `supabase/migrations/20260808000200_finalize_intake_queue_job.sql` to
> `vetai-test`; its rollback test returned `PASS` with zero fixture rows. This
> was an SQL Editor integration test, not a Supabase CLI migration-history
> entry; production still needs the managed migration workflow.

## Bounded consumer (`src/intakeConsumer.ts`)

The Worker's `queue()` handler processes each message in a batch
independently: for every message it awaits
`processIntakeQueueMessage(message.body, env)` and then calls exactly one of
`message.ack()` / `message.retry()`. A rejected processor call is caught per
message and treated as `retry`, so one bad message never blocks the batch's
other messages from receiving their own disposition. The handler never calls
`ackAll`/`retryAll` and never `waitUntil`s the work.

`processIntakeQueueMessage(body, env)` runs one untrusted Queue body through,
in order:

1. `parseIntakeQueueMessage` — strict body revalidation.
2. `claimIntakeQueueJob` — locks the exact message/event pair under a fresh
   120-second database lease and returns the exact persisted message text.
3. `getConversationIntakeContext` — tenant-scoped owner/pet/state context.
4. A native Web Crypto SHA-256 hash of the domain-separated string
   `vetai-owner:<ownerId>`, sent as OpenAI's `safety_identifier`.
5. `extractIntakeViaOpenAi` — exactly one call, given only the claimed
   message text and the hashed identifier.
6. `planIntakeTurn` — deterministic merge, pet resolution, safety
   evaluation, and next-stage selection.
7. `finalizeIntakeQueueJob` — exactly one atomic state-advance + lease
   completion, using the planned (or poison-fallback) stage/pet/data.

No step is retried in-process; a later Queue delivery re-claims, re-fetches,
re-extracts, and re-plans from whatever is currently persisted.

### Disposition table

| Step        | Outcome                              | Disposition |
|-------------|---------------------------------------|-------------|
| parse       | invalid body                          | `ack`       |
| claim       | `completed` / `not_found`             | `ack`       |
| claim       | `busy` / `failed`                     | `retry`     |
| context     | `not_found` / `failed`                | `retry`     |
| extraction  | provider/refusal/malformed failure    | `retry`     |
| safety check| inconsistent handoff vs. planned stage| `retry`     |
| finalize    | `applied` / `already_completed` / `stale_claim` | `ack` |
| finalize    | `stale_state` / `failed`              | `retry`     |
| (any)       | unexpected thrown exception           | `retry`     |

`completeIntakeQueueJob` is never called from the consumer; `finalizeIntakeQueueJob`
is the only state-mutating call, and it runs at most once per attempt.

### Data minimization

Only the exact claimed message text is sent to OpenAI — not recent message
history, not the persisted intake snapshot. The `safety_identifier` sent to
OpenAI is a lowercase 64-character hex SHA-256 digest derived from the owner
ID; the raw owner ID, conversation ID, clinic ID, owner name, and phone
number are never sent in that field or logged. No log line or returned value
contains message text, identifiers, claim tokens, or provider response
bodies — only fixed, generic warning strings (`terminal_safety_signal`,
`poison_intake_state`) are ever emitted, with no interpolated values.

### Poison snapshot -> atomic handoff

If `planIntakeTurn` returns `failed` (a corrupt persisted snapshot, or a
selected pet no longer present in the tenant's pet list), the consumer
treats the working state as poisoned rather than retrying it forever: it
builds a fresh, schema-valid snapshot from only the current validated
extraction (`schema_version: 1`), passes `petId: null` so the database
preserves any already-selected pet, and sets the next stage to
`human_handoff` — unless the conversation's current stage is already
`completed`, which stays terminal. This replacement is applied through the
same single atomic `finalizeIntakeQueueJob` call as a normal plan, so the
lease still completes and the corrupt snapshot cannot cause an infinite
retry loop. The conversation's persisted messages remain the true record;
only the bounded working snapshot is replaced.

The consumer also independently checks a successful plan's `safetyDecision`
rather than inferring safety from `nextStage` alone: an `emergency_handoff`
or `human_handoff` decision must correspond to a `human_handoff` next stage
(or a terminal `completed` stage that was already `completed`); any other
combination is treated as inconsistent and fails closed to `retry` without
finalizing. A `needs_safety_check` decision at `ready_for_triage` or an
appointment stage may persist that same stage in this task, since no
triage/appointment action executes here — later triage code must still
consume the safety decision before acting.

### Cloudflare configuration

```toml
[[queues.consumers]]
queue = "vetai-intake"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
retry_delay = 120
dead_letter_queue = "vetai-intake-dlq"
```

The 120-second `retry_delay` matches the database lease's fixed 120-second
expiry, so a retried delivery finds the lease already expired and reclaims
it cleanly rather than colliding with a still-running attempt. After three
retryable failures, Cloudflare routes the message to the
`vetai-intake-dlq` dead-letter queue instead of silently dropping it. See
Cloudflare's [explicit acknowledgements/retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
and [dead-letter queues](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/)
docs, and OpenAI's [safety identifier guidance](https://platform.openai.com/docs/api-reference/responses).

LLM extraction work may repeat across retries/reclaims — it has no side
effects of its own — but conversation-state finalization stays atomic:
exactly one `finalize_intake_queue_job` call per attempt, guarded by the
current claim token and expected state version.

## Not implemented in this step

- No outbound WhatsApp response, deterministic triage action, or appointment
  mutation happens from this consumer.
- No real Cloudflare Queue or dead-letter-queue resource has been created,
  and the Worker has not been deployed.
- No production credentials are used and this task is not production
  approval; `wrangler deploy --dry-run` only validates configuration.
