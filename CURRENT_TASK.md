# Current task — 013 atomically finalize leased intake state

Status: `READY`

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
