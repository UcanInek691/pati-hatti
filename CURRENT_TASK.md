# Current task — 024 production readiness and dead-letter handoff

Status: `COMPLETE`

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

- Read `AGENTS.md`, `PROJECT_CONTEXT.md`, and this file in order before any edit.
- Confirmed `src/env.ts`'s `Env` interface exactly: `APP_TIMEZONE`,
  `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`, `OPENAI_API_KEY`,
  `INTAKE_QUEUE: Queue<IntakeQueueMessage>`, `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_GRAPH_API_VERSION`. `APP_TIMEZONE` was previously unused anywhere
  in `src/` outside this declaration and `wrangler.toml`, so its validation in
  `readiness.ts` has no existing repo pattern to reuse; used the native
  throw-on-invalid-timeZone behavior of `Intl.DateTimeFormat` instead of a
  hardcoded IANA list or new dependency.
- Confirmed `src/intakeJobLease.ts`'s exact RPC-client shape
  (`isLoopbackHttpUrl`, `buildEndpoint`, `callRpc`, `asPlainRecord`, all
  re-implemented per-file rather than shared, per its own `ponytail:`
  precedent) and used it as the direct structural template for
  `src/intakeDeadLetter.ts`, simplified to the new function's single `{result}`
  row shape and no claim token.
- Confirmed `src/intakeQueue.ts`'s `parseIntakeQueueMessage` and
  `IntakeQueueMessage` shape (`version: 1`, `conversationId`,
  `providerMessageId`) — reused unchanged, not modified.
- Confirmed `src/intakeConsumer.ts`'s exact disposition table and that it
  `ack`s on parse failure (a retry can never succeed on the same malformed
  bytes); the new DLQ processor deliberately inverts this to `retry` on parse
  failure, so a malformed body still reaches the terminal parking queue via
  `vetai-intake-dlq`'s own `max_retries` rather than disappearing on first
  DLQ delivery.
- Confirmed `advance_conversation_intake` already permits a direct transition
  to `human_handoff` from any non-completed stage, and that the existing
  `sync_human_handoff_work_item` trigger on `conversations` creates the
  tenant-scoped `staff_work_items` row automatically — the new finalizer calls
  the existing function and adds no trigger, no direct `staff_work_items`
  write, and no hardcoded safety-signal name.
- Confirmed the existing finalizer lock order (webhook event, then
  conversation) via `claim_intake_queue_job`/`finalize_intake_queue_job` and
  preserved it in `finalize_intake_dead_letter`.
- Confirmed `wrangler.toml`'s existing `vetai-intake` consumer block
  (`max_batch_size 1`, `max_batch_timeout 5`, `max_retries 3`, `retry_delay
  120`, `dead_letter_queue = "vetai-intake-dlq"`) was already present with no
  DLQ consumer configured.
- Confirmed `src/staffPage.ts` already exports `STAFF_SECURITY_HEADERS`
  (`Cache-Control: no-store`, `X-Content-Type-Options: nosniff`) and was
  already imported into `src/index.ts`, so `/ready` reuses it directly instead
  of duplicating an equivalent headers object.
- Confirmed `src/whatsappSend.ts`'s `GRAPH_VERSION_PATTERN`
  (`/^v\d+\.0$/`) and duplicated it in `readiness.ts` (same per-file
  convention as the RPC-client helpers above).
- Starting HEAD matched the value already recorded above; the worktree was
  clean apart from this task's own new/edited files.

## Delivery record — Sonnet fills after coding

- New migration `supabase/migrations/20260810000300_intake_dead_letter_handoff.sql`
  defines `public.finalize_intake_dead_letter(p_conversation_id uuid,
  p_provider_message_id text) returns table(result text)` per the contract
  above (`SECURITY INVOKER`, `VOLATILE`, `SET search_path = ''`,
  service_role-only). **Not applied to any database.**
- New rollback fixture `supabase/tests/024_intake_dead_letter_handoff.sql`
  covers function shape/grants, the four closed results, an urgent-priority
  safety-signal handoff, replay idempotency, an already-terminal conversation,
  five fail-closed negative cases (absent/mismatched/outbound/cross-tenant/
  invalid-UUID/direct-role-call), an induced-failure atomic-rollback proof,
  and zero fixture residue. **Not run against any database — Sonnet did not
  execute it; Codex validates it on disposable `vetai-test`.**
- New `src/intakeDeadLetter.ts` (RPC client + `processIntakeDeadLetterQueueMessage`)
  and `test/intakeDeadLetter.test.ts`.
- New `src/readiness.ts` (`checkReadiness`) and `test/readiness.test.ts`.
- `src/index.ts`: added the `GET /ready` route (200/503/405, `STAFF_SECURITY_HEADERS`
  on all three) and routed `queue()` by `batch.queue` to the primary or
  dead-letter processor, with an unknown queue name failing closed to `retry`
  for every message. `test/index.test.ts` extended to match. `/health` and
  every other existing route are unchanged.
- `wrangler.toml`: added the exact second `[[queues.consumers]]` block for
  `vetai-intake-dlq` specified above. No producer/consumer binding added for
  `vetai-intake-terminal-dlq`.
- New `docs/production-readiness.md`: the 7-section runbook (human gates;
  managed data rollout; Cloudflare/Meta/OpenAI setup; seed/admin
  prerequisites; a 10-step controlled smoke journey including deliberate DLQ
  retry-exhaustion and recovery-before-four-day-retention; operations; go/no-go
  and rollback), citing Cloudflare's dead-letter-queue documentation and
  explicitly stating that passing this task's own review gate is not
  production approval.
- `docs/inbound-queue.md`: added a "Dead-letter handoff consumer" subsection
  documenting the DLQ path, its inverted parse-failure disposition, and the
  `vetai-intake-dlq` Cloudflare config block; corrected the stale "no DLQ
  resource or consumer" line to reflect that the code-level consumer now
  exists while the real Cloudflare resource still does not.
- `docs/database-schema.md`: added a "Dead-letter intake handoff" section
  documenting `finalize_intake_dead_letter`'s exact signature, lock order,
  behavior, and closed result set, matching the sibling RPC sections' style,
  and explicitly marked not yet validated on any database.
- `README.md`: added a `GET /ready` line to the existing Turkish route list.
- Verification run and results (all local, no deploy):
  - `pnpm install --frozen-lockfile` — already up to date.
  - `pnpm typecheck` — clean, zero errors.
  - `pnpm test` — full suite passed (1007 tests).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` —
    succeeded; confirmed bindings and exited before any real deploy
    (`--dry-run: exiting now`).
  - `git diff --check` — no whitespace errors.
- No migration or SQL test file was applied to any database. No commit, push,
  deploy, or real Meta/OpenAI/Supabase call was made. No dependency, lockfile,
  Queue/Cron/user/slot resource, or production resource was created or
  mutated. `rtk` (the user's global shell-prefix tooling) is not installed in
  this environment, so verification commands above were run directly instead.

## Codex review record — 2026-08-10

**Decision: PASS.** Codex
traced the primary Queue → DLQ → strict parser/client → locked webhook event
→ locked conversation → existing advance RPC/trigger → staff item → event
completion path. Scope matches the allowed list and no dependency, Env,
secret example, webhook, intake/appointment planner, safety copy, staff UI,
outbound sender, existing migration, or production-resource drift was found.

Targeted fixes made during review:

- readiness now rejects the repository's real `[placeholder]` syntax and
  enforces the product boundary `APP_TIMEZONE = Europe/Istanbul` rather than
  accepting any valid IANA zone;
- the dead-letter RPC client validates UUID/provider identifiers before fetch,
  tolerates runtime-missing config without throwing, and returns fresh failure
  objects;
- the finalizer now handles the most important first-message failure case:
  when all primary attempts failed before a snapshot existed, it replaces
  only the rejected `{}` default with the non-sensitive terminal marker
  `{ "dead_letter_handoff": true }`, completes the event, and creates the
  existing trigger-driven staff item atomically;
- the SQL fixture now proves that empty-snapshot path and the unchanged
  owner/account/source erasure chains, in addition to its original RLS,
  replay, urgent, terminal, cross-tenant, and rollback cases;
- documentation was corrected to match the real existing-`human_handoff`
  result, acknowledge a possible slow primary worker serialized by the same
  event lock, and keep failure injection out of shared production config.

Verification after fixes:

- `pnpm install --frozen-lockfile` — passed, no dependency/lockfile change;
- `pnpm typecheck` — passed;
- `pnpm test` — **1013/1013 passed across 26 files**;
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — passed;
- `git diff --check` — passed (line-ending advisories only);
- migration — applied successfully only to disposable `vetai-test`;
- strengthened rollback fixture — returned `PASS` with all six residue counts
  at `0`;
- production, real services, Cloudflare resources, and production migration
  history remain untouched.

## Claude Opus review record — 2026-08-10

**Decision: PASS.** The narrow read-only review found no blocking atomicity,
lock-order, tenant-isolation, RLS/service-role, staff-visibility, Queue
disposition, truthful-copy, or KVKK-erasure issue. Its two documentation
follow-ups were applied without changing runtime behavior:

- the runbook now explicitly requires creation of the unconsumed
  `vetai-intake-terminal-dlq` resource;
- durable context and operations guidance now state that an empty-snapshot
  dead-letter handoff's normal priority means unassessed risk, not low risk.

Task 024 is approved for commit. Production approval remains gated by the
unchecked human and operational requirements in `docs/production-readiness.md`.
