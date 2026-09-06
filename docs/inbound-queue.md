# Inbound intake queue (producer and bounded consumer)

Last verified: 2026-08-14.

## What this step does

After a signed inbound WhatsApp text message is durably persisted through the
`ingest_whatsapp_text_message` RPC (see `docs/database-schema.md`), the Worker
publishes one small versioned job to a Cloudflare Queue named `vetai-intake`
before it acknowledges the webhook with HTTP 200. The webhook response
`await`s the Queue send; it does not use `waitUntil` and does not return
early.

- Both `processed` and exact-`duplicate` persistence outcomes under the
  current `ai` route are enqueued.
  Enqueuing duplicates is deliberate: it repairs the case where the database
  write committed but the first Queue send or webhook HTTP response failed
  before the sender's retry, so the retry's duplicate outcome still gets a job
  published.
- `unknown_account` and `failed` persistence outcomes are never enqueued.
- `unknown_account` is acknowledged with HTTP 200 and counted under its own
  `unknown_account` key in the persistence log line, not as `failed`
  (changed 2026-08-23). An unrecognized phone number ID is a permanent
  condition: no retry can resolve it, and returning 5xx to Meta for every
  such delivery risks Meta throttling webhook delivery for the whole
  account. The dedicated counter keeps a misconfigured or stale
  `whatsapp_accounts.phone_number_id` visible instead of silently folding it
  in with `ignored`. This was found in staging, where the account row still
  pointed at a retired test number and Meta's own webhook test payload — which
  carries a fabricated phone number ID — reproduced it on demand.
- `manual` and `ignored` persistence outcomes (Task 033 selective automation,
  see [`docs/selective-automation.md`](selective-automation.md)) are also
  never enqueued, but are still successful HTTP-200 outcomes — they are not
  counted as `failed`.
  An exact redelivery under a route that is currently `manual` also returns
  `manual`, not `duplicate`, so it cannot reopen AI Queue work.
- If the required enqueue fails for any item, that item counts as `failed`
  and the webhook returns its existing HTTP 503 response, unchanged from
  Task 010. HTTP 200 is only returned after every processed/duplicate item's
  Queue send has resolved.

### Group traffic is not intake traffic

Recognizable WhatsApp group messages are acknowledged but excluded at
`src/whatsappIngest.ts`, before contact-route resolution or any access to
contacts, nested message content, hashing, persistence, Queue, OpenAI, or
reply creation. The guard recognizes Meta's message-level `group_id` plus
additive `recipient_type: "group"` and `context.group_id`/value-level group
discriminators. It skips only the group candidate, so a direct message in the
same signed batch continues normally. Group lifecycle fields and
`smb_message_echoes` are not inbound `messages` candidates and remain ignored.

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

### Selective automation short-circuit (Task 033)

`claim_intake_queue_job` also returns the claimed job's current WhatsApp
automation mode (`ai | manual | personal`), with `message_text` strictly
null whenever the mode is not `ai` (see
[`docs/selective-automation.md`](selective-automation.md)). This closes the
race where a contact's route changes after its message was persisted as
`ai` but before a worker claims the Queue job: `src/intakeConsumer.ts`
checks `claim.automationMode !== "ai"` immediately after a successful claim
and, if true, calls `completeIntakeQueueJob` right away — before context
lookup, safety hashing, any OpenAI call, planning, appointment calls,
clinic-hours lookup, or reply creation — and acknowledges the message with
no further work.

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

All Supabase RPC fetches on the webhook/Queue path have a local 10-second
timeout and fail closed. Together with the existing 30-second OpenAI bound,
this keeps a normal attempt below the fixed 120-second lease rather than
allowing a stalled database subrequest to overlap a reclaimed worker.

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
   message text, the hashed identifier, and — when eligible (Task 029, see
   below) — one bounded prior clinic question.
6. `planIntakeTurn` — deterministic merge, pet resolution, safety
   evaluation, and next-stage selection.
7. `planAppointmentAction` (`src/appointmentFlow.ts`) — a pure, safety-first
   check of whether this turn is an appointment slot offer, an
   `EVET`/`HAYIR` decision, or neither. See
   [`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md)
   (**validated only on disposable `vetai-test`; not production**) for the
   full single-slot contract; a
   safety/handoff decision always takes step 8 instead, at any stage.
8. `finalizeIntakeQueueJob`, or — only for an `"offer"`/`"decision"`
   appointment action — `finalizeAppointmentOfferQueueJob` /
   `finalizeAppointmentDecisionQueueJob`: exactly one atomic state-advance +
   lease completion per attempt, using the planned (or poison-fallback)
   stage/pet/data.

No step is retried in-process; a later Queue delivery re-claims, re-fetches,
re-extracts, and re-plans from whatever is currently persisted.

### Disposition table

| Step        | Outcome                              | Disposition |
|-------------|---------------------------------------|-------------|
| parse       | invalid body                          | `ack`       |
| claim       | `completed` / `not_found` / `superseded` | `ack`    |
| claim       | `overflow` -> no-model `human_handoff` finalize | `ack` (or `retry` on that finalize's own `retry` outcomes) |
| claim       | `busy` / `failed`                     | `retry`     |
| claim       | non-`ai` mode -> immediate `completeIntakeQueueJob` | `ack` |
| context     | `not_found` / `failed`                | `retry`     |
| extraction  | provider/refusal/malformed failure    | `retry`     |
| safety check| inconsistent handoff vs. planned stage| `retry`     |
| finalize    | `applied` / `already_completed` / `stale_claim` / `suppressed` | `ack` |
| finalize    | `stale_state` / `failed`              | `retry`     |
| (any)       | unexpected thrown exception           | `retry`     |

`suppressed` (Task 033) means the claimed job was still `ai` at claim time
but its route changed to `manual`/`personal` before the finalizer's own
recheck; the finalizer completes the lease and makes zero conversation,
appointment, or outbox mutation on that attempt. See
[`docs/selective-automation.md`](selective-automation.md).

`completeIntakeQueueJob` is never called from the consumer; exactly one of
`finalizeIntakeQueueJob`, `finalizeAppointmentOfferQueueJob`, or
`finalizeAppointmentDecisionQueueJob` is the state-mutating call for a given
attempt, and it runs at most once per attempt. See
[`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md) for the
two appointment finalizers' own disposition table (**validated only on
disposable `vetai-test`; not production**).

### Data minimization

Only the exact claimed message text, plus — when eligible (Task 029, see
below) — one bounded prior clinic question, is sent to OpenAI: never the full
recent message history, and never the persisted intake snapshot. The
`safety_identifier` sent to OpenAI is a lowercase 64-character hex SHA-256
digest derived from the owner ID; the raw owner ID, conversation ID, clinic
ID, owner name, and phone number are never sent in that field or logged. No
log line or returned value contains message text, identifiers, claim tokens,
or provider response bodies — only fixed, generic warning strings
(`terminal_safety_signal`, `poison_intake_state`) are ever emitted, with no
interpolated values.

### Bounded previous-question context (Task 029)

If the conversation's last stored message is the current owner reply and the
nearest prior outbound message is a single short eligible clinic question
(contains `?`, at most 4096 code points), the consumer passes that one
question through to `extractIntakeViaOpenAi` as bounded context. Only the
most recent outbound item before the matching final inbound is considered;
no other history is sent or summarized, and context is never sent when the
conversation is already at `human_handoff` or `completed`.

### No-model terminal/budget path and no-progress fallback (Task 029)

Two consumer-level paths finalize a turn without calling OpenAI at all, both
through the same atomic `finalizeIntakeQueueJob` call as a normal plan:

- **Terminal/budget short-circuit**: if the conversation is already at
  `human_handoff`, or has reached `stateVersion >= 12` and is not
  `completed`, the consumer builds a `human_handoff` plan straight from the
  last persisted snapshot (`readCanonicalPersistedSnapshot`, which fails
  closed on any malformed shape exactly like the poison-snapshot path below)
  and re-runs the deterministic safety gate over that canonical snapshot
  before finalizing it — no extraction call is made. Persisted explicit danger
  therefore keeps the emergency reply precedence.
- **No-progress fallback**: if the two most recent outbound clinic messages
  are identical and eligible, and the current turn's extraction carries no
  actionable fact at all, the consumer forces that turn's plan to
  `human_handoff` instead of finalizing a plan that would just repeat the
  same question again. A `completed` conversation is exempt and remains
  terminal.

### Unsupported-media marker path (Task 030)

`extractInboundMessages` admits the closed owner-media set `audio, contacts,
document, image, location, sticker, video` into the same durable path as
text. Such an item is validated against the identical `phone_number_id`,
message `id`, `from`, and `timestamp` bounds (malformed recognized media
rejects the whole webhook with 400 before any persistence), and its
`messageText` is the fixed ASCII marker `__vetai_unsupported_media__`. The
canonical hash covers only those validated envelope identifiers, the
timestamp, the marker, and the declared type — the nested media payload is
never inspected or extracted, so a caption, media id, MIME type, or coordinate
change cannot alter the hash, and none of it is logged or persisted. A conflicting declared
type or text body for the same `(phone_number_id, message.id)` key still fails
closed. Everything downstream — ingest RPC, Queue job shape, lease, retry/DLQ,
outbox, and delivery — is unchanged, so exact webhook and Queue redelivery
still produce at most one reply.

The consumer checks for the exact marker immediately after claim and context
load, before previous-question selection, safety-identifier hashing, and any
OpenAI call, so a media message consumes zero paid model work. It reads
`context.intakeData` through `readCanonicalPersistedSnapshot` (malformed state
retries and is never finalized as success), preserves the current pet and
canonical snapshot, and finalizes through the same atomic
`finalizeIntakeQueueJob` call with the fixed unsupported-media reply, normally
keeping the current stage. Two exceptions preserve existing behavior: an
already-persisted explicit `true` emergency signal routes a non-completed
conversation to `human_handoff` with the existing emergency copy; an existing
`human_handoff` stage or state version 12+ uses the truthful handoff reply so
media-only input cannot bypass the finite-work ceiling; and a `completed`
conversation stays completed with no reply (a defensive branch —
ingestion does not reuse completed conversations). The
`applied | already_completed | stale_claim` ack and `stale_state`/failure retry
dispositions are unchanged.

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

### Fresh conversation after a resolved handoff (Task 051)

When `resolve_staff_work_item` completes a linked terminal handoff (see
`docs/database-schema.md`), the conversation reaches `completed`. That status
falls outside
`conversations_one_open_per_owner_idx`'s scope (`where status in ('active',
'handoff')`, `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`),
so it no longer blocks a new conversation row for the same
`(clinic_id, owner_id)`. The next inbound message from that owner is ingested
as a brand-new conversation at the default intake stage, not a continuation:
none of the terminal conversation's persisted messages, pet selection, or
safety signals carry over, and the consumer-level exemptions above that key
off an existing `completed` conversation (bounded previous-question context,
the no-progress fallback, the unsupported-media marker path, and the
poison-snapshot handoff) do not apply to this new row, because it is not the
same conversation. Safety-first intake runs in full from message one, exactly
as it would for an owner who had never messaged the clinic before.

### Selected-pet conflict and second-pet registration (Task 037)

An explicit pet name with zero exact normalized matches is a
`new_candidate`. When the current conversation has no selected `pet_id`, this
candidate may follow the ordinary complaint and combined-confirmation flow;
only the owner's exact `EVET` authorizes the atomic finalizer to create and
link the second pet. The number of other pets already owned does not block
that path, and an explicit name with multiple normalized matches remains
`needs_clarification` rather than guessing.

When the conversation already has a selected pet, a different, ambiguous, or
unmatched explicit name is not allowed to relink it. The turn moves to the
truthful human-handoff path while preserving the selected pet's stored
identity and clinical snapshot. The conflicting animal's name, species,
complaint, and symptoms are not merged. Safety is evaluated separately:
sticky prior `true` signals remain true, while the conflicting turn's current
`true | false | null` values otherwise remain authoritative, so an old pet's
`false` cannot turn the other animal's unknown status into a false assurance.
Detecting this first conflict uses the normal single extraction call; later
messages in the persisted `human_handoff` stage use the existing no-model
path.

The consumer also independently checks a successful plan's `safetyDecision`
rather than inferring safety from `nextStage` alone: an `emergency_handoff`
or `human_handoff` decision must correspond to a `human_handoff` next stage
(or a terminal `completed` stage that was already `completed`); any other
combination is treated as inconsistent and fails closed to `retry` without
finalizing. A `needs_safety_check` decision at `ready_for_triage` or an
appointment stage may persist that same stage in this task, since no
triage/appointment action executes here — later triage code must still
consume the safety decision before acting.

### Meaning-based extraction, invitation routing and usage evidence (Task 038)

The model input boundary is unchanged: the exact current message plus at most
one eligible preceding clinic question. Prompt `2026-08-28.1` interprets
colloquial, misspelled, inflected, negated and elliptical Turkish by meaning;
there is no runtime phrase table or regular-expression appointment shortcut.
For the fixed safety list, clear aggregate negatives may set the listed values
false, named present conditions set only justified values true, other reported
symptoms remain present, and ambiguity remains `null`.

A safely confirmed pet/intake turn now writes the fixed question
`Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?`.
Because it is the single
eligible previous question, a natural affirmative may extract as
`appointment_request` and then follows the existing planner and atomic
appointment-offer RPC. The model never chooses or invents availability. Once
a real slot is held, only the existing exact raw-text `EVET | HAYIR` grammar
can confirm or release it. All safety, pet, stage, stale-state and unavailable
slot outcomes remain fail-closed.

After a successful OpenAI extraction, the consumer records one row to the
`clinic_ai_usage_events` ledger (Task 042) via `record_intake_ai_usage_v1`,
containing model name, prompt version and validated token counts, keyed by a
hash of the source event rather than the source event itself. There is no
such row on a failed/no-model path. When provider usage is missing/malformed,
the logical turn is still recorded but its three token fields are `null`. No
message text, previous question, identity, provider id, safety identifier,
secret, response body or price is stored. A queue retry may perform another
extraction against the provider, but the ledger insert is keyed by the source event's hash, so the
retried logical turn is recorded at most once even though the provider was
called again; finalization remains atomic and idempotent as described above.

### Clinic personalization of `human_handoff` replies (Task 031)

Immediately before calling `finalizeIntakeQueueJob` at each of the three
places above that can produce a reply — the normal `planIntakeTurn` path
(step 8), the no-model terminal/budget short-circuit, and the
unsupported-media marker path — the consumer checks whether that turn's
resolved reply is exactly `{ kind: "send", category: "human_handoff" }`. Only
then does it call `getConversationClinicOperationalContext(conversationId,
env)` (`src/clinicOperations.ts`) and pass the closed result to
`applyClinicHandoffContext` (`src/intakeReply.ts`), which substitutes the
clinic's name/phone and a truthful open/closed statement for the generic
handoff text, or leaves the generic text unchanged on any failure or
unconfigured profile. This costs at most one extra native-`fetch` RPC call
per attempt, never an extra OpenAI call, and never changes which reply
category was chosen or any stage/pet/safety decision. See
[`docs/clinic-operations.md`](clinic-operations.md) for the exact copy and
fail-closed rules.

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

### Dead-letter handoff consumer (`src/intakeDeadLetter.ts`)

When `vetai-intake` exhausts its three retries, Cloudflare routes the same
message body to `vetai-intake-dlq`. The Worker's `queue()` handler
distinguishes the two queues by `batch.queue` and routes
`vetai-intake-dlq` messages through `processIntakeDeadLetterQueueMessage`
instead of `processIntakeQueueMessage`; every other part of the handler
(per-message `ack`/`retry`, one bad message never blocking its batch
siblings, no `ackAll`/`retryAll`, no `waitUntil`) is unchanged and shared
across both queues.

`processIntakeDeadLetterQueueMessage(body, env)` re-validates the body with
the same `parseIntakeQueueMessage` used by the primary consumer, then calls
`finalizeIntakeDeadLetter`, a native-`fetch` service-role client for the new
`finalize_intake_dead_letter` database function (see
`docs/database-schema.md`). That function locks the exact tenant-safe
message/webhook-event pair, and — unless the event is already `completed` or
the conversation is already terminal — moves the conversation straight to
`human_handoff` via the existing `advance_conversation_intake`, so the
existing `sync_human_handoff_work_item` trigger creates the usual staff work
item. It never re-attempts extraction, re-plans a turn, or sends any reply;
a message that reached the DLQ has already exhausted the primary consumer's
normal retries, so this path only parks the conversation for a human.

If every first-message attempt failed before a snapshot was persisted, the
conversation still contains the core `{}` default that the existing advance
RPC rejects. The dead-letter finalizer replaces only that empty value with
the fixed, non-sensitive `{ "dead_letter_handoff": true }` terminal marker;
otherwise it preserves the existing intake document.

> **Corrected (Task 053).** This marker is not a valid schema-versioned
> snapshot, so a later message used to fail `readCanonicalPersistedSnapshot`
> and retry forever instead of ever reaching the poison-snapshot fallback.
> The consumer now recognizes this exact marker while `intakeStage` is
> `human_handoff` and acks the job without replying or touching the stored
> document — the conversation stays parked until staff resolve it via
> `/staff`, it does not self-heal on the next inbound message.

Its disposition table deliberately inverts the primary consumer's parse-step
row:

| Step     | Outcome                                                        | Disposition |
|----------|------------------------------------------------------------------|-------------|
| parse    | invalid body                                                      | `retry`     |
| finalize | `handed_off` / `already_completed` / `already_terminal` / `not_found` | `ack`  |
| finalize | `failed`                                                          | `retry`     |
| (any)    | unexpected thrown exception                                       | `retry`     |

The primary consumer `ack`s an unparseable body because a retry would never
succeed on the same malformed bytes. The DLQ consumer instead `retry`s an
unparseable body: `vetai-intake-dlq` has its own bounded `max_retries`
(configured below) and its own `dead_letter_queue`, so a malformed message
still reaches a terminal parking queue instead of silently disappearing on
its first DLQ delivery. `finalize_intake_dead_letter` returns only a closed
`result` value — never an identifier, phone number, message content, or
error detail — matching the same data-minimization rule the primary
consumer follows.

```toml
[[queues.consumers]]
queue = "vetai-intake-dlq"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
retry_delay = 300
dead_letter_queue = "vetai-intake-terminal-dlq"
```

`vetai-intake-terminal-dlq` intentionally has no consumer configured
anywhere in this project. A message only reaches it after both the primary
queue's and the DLQ's retries are exhausted; see
[`docs/production-readiness.md`](production-readiness.md) for the
operational monitoring and manual-recovery expectations that go with an
unconsumed terminal queue.

A configuration-only `GET /ready` endpoint (`src/readiness.ts`) reports
`200 { "status": "ready" }` only when every `Env` binding this Worker
depends on — including `INTAKE_QUEUE` — looks structurally present and
non-placeholder, and `503 { "status": "unavailable" }` otherwise. It never
makes a network call and never returns or logs which field failed.

> **Disposable validation passed (2026-08-10).** Codex applied
> `20260810000300_intake_dead_letter_handoff.sql` only to `vetai-test`; the
> strengthened rollback fixture returned `PASS` with all six residue counts
> at zero. This is not a production migration-history entry.

## Burst aggregation (Task 039)

`enqueueIntakeJob` (`src/intakeQueue.ts`) sends every intake job with
`delaySeconds: 3`, allowing rapid follow-up messages to land before the first
job is claimable. `claim_intake_queue_job` partitions incomplete eligible
messages into non-overlapping windows anchored at each window's first message
and spanning at most 3 seconds (see
[`docs/database-schema.md`](database-schema.md#per-pet-appointment-guard-cancellation-and-inbound-bursts-task-039))
to add two closed result kinds ahead of `claimed`:

- `superseded` — a newer eligible message already exists in the same fixed
  window by the time this job is claimed. The event is completed and
  acknowledged with zero model call and zero reply, but its text remains
  visible to the current-turn representative until that representative's
  outbound boundary; only the newest representative reaches extraction.
- `overflow` — more than 4 eligible messages, or more than 65536 combined
  characters, are pending. Never truncated into the model: the claim itself
  returns a valid claim token with null message/mode, and
  `processIntakeQueueMessage` routes it straight through the existing
  no-model `human_handoff` boundary (same `buildHandoffPlan` +
  `prepareOutboundReply` path the safety-parser-failure case uses), so an
  oversized burst can never silently drop a possible emergency.

Fixed windows are processed in receipt order. If a later window's Queue job
runs first, claim returns `busy`, restores that event to `pending`, and relies
on the existing bounded 120-second Queue retry. Once the earlier
representative finishes, a still-incomplete later window remains independently
claimable even if its receipt predates that representative's outbound;
unprocessed content is not discarded by the outbound boundary.

Only a message whose `webhook_events.ai_burst_eligible` is `true` — stamped
once at ingest, forever, for a text message that actually reached the `ai`
route — is ever aggregated or counted; manual/personal/group/media messages
and any row from before this migration are excluded structurally, not by a
runtime check. The five stages with a deterministic raw-text grammar
(`intake_confirmation`, `appointment_selection`,
`appointment_cancel_confirmation`, `human_handoff`, `completed`) always claim
and see only their own current message, never an assembled burst.
`prompts/intake-extraction-prompt.ts`'s `## Burst messages` section (prompt
version `2026-08-28.2`) treats a labelled `"Mesaj 1: ..."` block as ordered,
untrusted owner data spanning one turn: later parts add to earlier ones, and
only an explicit correction (e.g. "hayır, Pamuk değil Karamel") overwrites a
fact already stated earlier in the same block.

## Not implemented in this step

- No outbound WhatsApp response or deterministic triage action happens from
  this consumer. A single-slot appointment offer/confirm/decline mutation
  does happen from this consumer (see
  [`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md)), but
  its migration is **validated only on disposable `vetai-test` and not applied
  to production**; no real WhatsApp send occurs anywhere in this project yet —
  only outbox rows are written.
- The code-level `vetai-intake-dlq` consumer and `/ready` endpoint exist as
  of this task, but no real Cloudflare Queue resource (`vetai-intake`,
  `vetai-intake-dlq`, or `vetai-intake-terminal-dlq`) has been created, and
  the Worker has not been deployed.
- No production credentials are used and this task is not production
  approval; `wrangler deploy --dry-run` only validates configuration.
