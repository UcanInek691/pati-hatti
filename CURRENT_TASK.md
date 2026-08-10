# Current task — 024 production readiness and dead-letter handoff

Status: `READY`

Primary implementer: Claude Sonnet

Reviewers: Codex, then one narrow read-only Claude Opus review limited to the
new dead-letter database finalizer, tenant isolation, staff visibility, and
fail-closed Queue behavior. Do not repeat earlier appointment, intake, staff
UI, or outbound-delivery reviews.

## Goal

Close the final code-level MVP production blocker without adding product
features:

```text
intake retries exhausted
  -> Cloudflare moves the original bounded job to vetai-intake-dlq
  -> the same Worker validates it
  -> one service-role RPC atomically terminates the intake event
     and moves the conversation to human_handoff
  -> the existing database trigger creates the tenant-scoped staff work item
```

Also add a configuration-only `/ready` endpoint and one production runbook.
The endpoint must reveal only ready/unavailable, never secret names or values.
The runbook must distinguish code readiness from actual production approval.

This task does not deploy anything. It does not make the system production-
approved: clinic-veterinarian copy approval, Turkish legal/KVKK decisions,
real credentials/resources, operational ownership, and controlled end-to-end
smoke tests remain explicit human release gates.

## Deliberately small MVP

Reuse the existing versioned Queue message, conversation transition RPC,
human-handoff trigger, `staff_work_items` table, Worker Queue handler, and
native `fetch`. Add no table, column, product notification, assignment,
analytics, tracing vendor, SDK, dependency, admin feature, retry framework,
or automatic retention/deletion job.

The final terminal parking queue is operational recovery, not a third Worker
workflow. It has no consumer in this task. It exists so a database outage
during DLQ handling does not immediately delete the last recoverable message.

## Starting context

- Starting HEAD: `17fa0bf` on `main`; the worktree is clean.
- Task 023 and every earlier migration are committed and validated on the
  disposable `vetai-test` project, but none is applied to production migration
  history.
- `vetai-intake` already has bounded retries and
  `dead_letter_queue = "vetai-intake-dlq"`, but the DLQ has no consumer.
- The existing Queue body contains only `version`, `conversationId`, and
  `providerMessageId`, and `parseIntakeQueueMessage` is its trust boundary.
- `advance_conversation_intake` already permits a non-terminal conversation to
  move directly to `human_handoff`; the existing trigger atomically upserts a
  same-tenant `staff_work_items` row without claiming anyone was notified.
- The existing finalizer lock order is webhook event, then conversation. Keep
  that order.
- `/health` is liveness only and must remain unchanged.
- Official Cloudflare Queue behavior reviewed on 2026-08-10: a DLQ can have
  its own consumer; after that consumer reaches `max_retries`, a configured
  second DLQ receives the message. A DLQ without an active consumer retains
  messages for four days. The production runbook must treat that interval as
  a recovery deadline, not permanent storage.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify every fact from source, migrations, callers, tests, scripts, Git
status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration:
  `supabase/migrations/20260810000300_intake_dead_letter_handoff.sql`.
- New rollback SQL test:
  `supabase/tests/024_intake_dead_letter_handoff.sql`.
- New `src/intakeDeadLetter.ts` and `test/intakeDeadLetter.test.ts`.
- New `src/readiness.ts` and `test/readiness.test.ts`.
- Narrow changes to:
  - `src/index.ts` and `test/index.test.ts`;
  - `wrangler.toml`;
  - `README.md`, `docs/inbound-queue.md`, `docs/database-schema.md`;
  - new `docs/production-readiness.md`.
- Fill only the **Observed context** and **Delivery record** sections below.

Do not change dependencies, lockfiles, Env fields, secret examples, webhook
parsing/signature behavior, Queue message shape, intake/appointment planners,
prompts/OpenAI adapter, safety rules/copy, staff UI, outbound sender/Cron,
existing migrations/RPCs, or production resources. Do not add a table,
column, policy, or browser-visible service-role value.

## Database finalizer

Create exactly:

```text
public.finalize_intake_dead_letter(
  p_conversation_id uuid,
  p_provider_message_id text
)
returns table(result text)
```

The function must be `SECURITY INVOKER`, `VOLATILE`,
`SET search_path = ''`, revoked from `PUBLIC`/`anon`/`authenticated`, and
executable only by `service_role`.

Behavior:

1. Reject null/invalid UUID and blank, padded, or over-512-code-point provider
   message identifiers before mutation.
2. Resolve and lock the exact inbound message/webhook-event pair through the
   existing tenant-safe `(conversation_id, provider_message_id)` relationship.
   Derive `clinic_id` only from persisted rows; never accept it from the
   caller. Lock the webhook event before the conversation.
3. Missing or mismatched input returns `not_found` without mutation or tenant
   existence disclosure.
4. An already-completed intake event returns `already_completed` without
   changing conversation state/version or duplicating staff work.
5. Lock the exact conversation. If it is already terminal `completed`, mark
   this exact event coherently completed, clear claim/lease fields, and return
   `already_terminal`; never regress the conversation or create a false staff
   item.
6. Otherwise call the existing `advance_conversation_intake` with the locked
   conversation's current version, pet, and intake document to move or keep it
   at `human_handoff`. Do not duplicate its transition logic or directly
   insert a staff work item. Require its exact successful row or raise.
7. Last, mark the exact webhook event `completed`, clear claim token/lease,
   set `intake_completed_at`, and return `handed_off`.
8. Any unexpected nested result or constraint failure must raise so the
   conversation update, trigger-created staff item, and event completion all
   roll back together. No exception handler/subtransaction may swallow it.

Closed results are exactly:

- `handed_off`;
- `already_completed`;
- `already_terminal`;
- `not_found`.

The function returns no identifiers, phone numbers, content, payload, token,
or error detail. It adds no user reply and makes no notification claim.

## Dead-letter Worker path

In `src/intakeDeadLetter.ts`, add the smallest native-fetch client/processor:

- reuse `parseIntakeQueueMessage` unchanged;
- HTTPS or loopback HTTP only and existing Supabase bindings only;
- strict local validation before fetch and one fixed RPC path/body;
- accept exactly one plain row with exactly `result` in the closed set;
- network/non-2xx/JSON/shape/config errors return `retry` without throwing or
  logging secret, URL, body, identifier, or raw error data;
- malformed Queue bodies return `retry`, so they reach the terminal parking
  queue rather than disappearing silently;
- `handed_off | already_completed | already_terminal | not_found` return
  `ack`;
- return fresh values, never mutate input, and make no Meta/OpenAI call.

Update `src/index.ts` without changing the existing primary consumer behavior:

- `batch.queue === "vetai-intake"` uses `processIntakeQueueMessage` exactly as
  today;
- `batch.queue === "vetai-intake-dlq"` uses the new dead-letter processor;
- an unknown queue name retries every message fail-closed;
- one message exception affects only that message.

Add this exact second consumer shape to `wrangler.toml`:

```toml
[[queues.consumers]]
queue = "vetai-intake-dlq"
max_batch_size = 1
max_batch_timeout = 5
max_retries = 3
retry_delay = 300
dead_letter_queue = "vetai-intake-terminal-dlq"
```

Do not add a producer or consumer binding for the terminal parking queue.

## Configuration readiness

In `src/readiness.ts`, add a pure configuration check and generic response:

- require every existing string Env value used by runtime to be present,
  trimmed, non-placeholder, and syntactically valid where the codebase already
  has a closed format (`SUPABASE_URL`, `APP_TIMEZONE`, Graph API version);
- require `INTAKE_QUEUE` to expose a callable `send` binding;
- allow HTTPS Supabase origins and loopback HTTP for local validation, while
  rejecting credentials, non-root path, query, and fragment;
- do not call Supabase, Meta, OpenAI, Queue, or any network service;
- do not return/log the missing key name, value, URL, or secret;
- return only `{ status: "ready" }` or `{ status: "unavailable" }` as fresh
  objects.

Wire `GET /ready` in `src/index.ts`:

- `200` with the exact ready object when configuration is valid;
- `503` with the exact unavailable object otherwise;
- `Cache-Control: no-store` and `X-Content-Type-Options: nosniff` in both
  cases;
- other methods on exact `/ready` return `405` with `Allow: GET` and the same
  security headers;
- `/health` and all other routes remain unchanged.

This endpoint proves configuration shape only, not external reachability or
production approval.

## Required tests

### TypeScript

Prove at least:

- readiness accepts one valid complete Env and rejects every missing, blank,
  padded placeholder, unsafe URL, wrong timezone/version, and missing Queue
  binding case without leaking/logging values;
- `/ready` exact 200/503/405 bodies and headers, with `/health` unchanged;
- primary Queue batches preserve the current processor/dispositions exactly;
- DLQ batches call only the dead-letter processor; unknown queues retry;
- malformed body, missing/unsafe config, network, HTTP, JSON, extra/missing
  keys, wrong row count, and unknown result all retry with no logging;
- four valid RPC results ack, request path/body is exact, inputs are not
  mutated, and no real request is made;
- batch siblings are independently acknowledged/retried.

### Rollback SQL fixture

Inside one `BEGIN`/`ROLLBACK`, prove at least:

- exact signature, invoker/volatile/empty-search-path/grants, unchanged RLS,
  table grants, policies, and staff constraints;
- service-role pending and expired-processing events atomically reach coherent
  completed state, the conversation reaches `human_handoff`, and exactly one
  existing-trigger-created same-tenant staff item exists;
- a persisted true safety signal uses the existing trigger to create/upgrade
  urgent work without hardcoding a signal name in the new function;
- replay returns `already_completed` with no second work item or state-version
  change;
- completed conversation returns `already_terminal`, completes only the exact
  event, and creates no false staff item;
- absent, wrong conversation/message pair, outbound message, cross-tenant
  same provider ID, invalid UUID/text, and direct anon/authenticated calls
  fail closed with zero partial mutation;
- an induced failure after conversation advancement rolls back conversation,
  staff item, and event together;
- owner/account/source/clinic erasure cascades remain intact;
- rollback leaves zero fixture rows.

Sonnet must not apply the migration or SQL fixture. Codex alone validates them
on disposable `vetai-test`.

## Production runbook

Create `docs/production-readiness.md` as one executable checklist, not a claim
of approval. It must include:

1. **Human gates:** named clinic operational owner; veterinarian approval of
   every Turkish safety/appointment reply; Turkish legal/KVKK approval of
   notice, lawful basis, roles, retention periods, deletion/export process,
   and processor agreements. Do not invent retention durations.
2. **Managed data rollout:** backup/rollback owner, chronological production
   migration application through the real migration-history workflow, catalog
   and RLS/grant verification, and fixture prohibition on production.
3. **Cloudflare/Meta/OpenAI setup:** create the real intake queue, deploy the
   configured DLQ chain, set secrets through secret bindings, configure Cron
   and webhook, allow-list correct Meta/OpenAI models/versions, and never copy
   secret values into the document or shell history.
4. **Seed/admin prerequisites:** real clinic/account/staff membership and
   future appointment slots through an authorized administrative process;
   explicitly note that this repository has no full admin provisioning UI.
5. **Controlled smoke journey:** `/health`, `/ready`, webhook challenge and
   signed inbound text, Queue/LLM/state, safety handoff/staff visibility,
   outbox send/status callback, exact appointment `EVET`/`HAYIR`, deliberate
   primary retry exhaustion into DLQ, and recovery before terminal parking
   retention expires. Use synthetic non-patient data only.
6. **Operations:** alert/inspect Worker errors, primary/DLQ/terminal queue
   backlog, failed outbox, urgent/open staff work, webhook failures, and model
   failures; document owner and response process. Staff visibility is not
   notification.
7. **Go/no-go and rollback:** no-go on any failed gate, secret/config leak,
   tenant/RLS failure, missing DLQ monitoring, unapproved copy/privacy policy,
   or inability to disable webhook/Worker safely. Include rollback order but
   no destructive command.

Reference official Cloudflare DLQ documentation and state that the terminal
parking queue is temporary four-day recovery storage, not an audit archive.
Update existing docs narrowly and remove any now-stale statement that the DLQ
has no consumer. Do not mark production gates complete.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, apply SQL, call real Meta/OpenAI/Supabase, create
Queue/Cron/user/slot resources, install a plugin/dependency, or mutate any
external service.

## Review gate

After Sonnet delivers, Codex reviews the complete primary Queue → DLQ → RPC →
conversation → existing trigger → staff item → event-completion path, reruns
all checks, and validates the migration/fixture only on disposable
`vetai-test`. Claude Opus then performs one final narrow read-only review of
that database/RLS/safety boundary. Documentation/readiness-only edits do not
need a second independent review; only a material blocking fix gets a narrow
recheck.

After this task passes, code-level MVP implementation is complete. Remaining
steps are the human/operator release checklist and actual authorized
production rollout, not additional feature tasks.

## Observed context — Sonnet fills before coding

Pending.

## Delivery record — Sonnet fills after coding

Pending.
