# Current task — 012 validate and lease queued intake jobs

Status: `READY`

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

- Starting HEAD:
- Initial worktree state:
- Relevant code/tests/migration evidence:
- Planned files:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands and exact results:
- Checks not run and why:
- Known limitations:
- Risks for Codex/Opus review:
