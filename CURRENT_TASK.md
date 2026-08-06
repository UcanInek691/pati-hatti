# Current task — 006 persisted conversation intake state

Status: `READY`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

Add the smallest durable conversation-state foundation needed before AI
extraction. Store each conversation's current intake stage and structured
intake data in Supabase, expose narrowly scoped service-role RPCs to load and
advance that state, and call those RPCs through native Worker `fetch` helpers.

This task does not call an LLM, generate or send WhatsApp replies, classify
triage, create appointments, add queues, or wire state advancement into the
webhook handler.

## Starting context

- Starting commit: `5fc3ffb` on `main`.
- The worktree is clean.
- Task 005 persists signed inbound WhatsApp text messages atomically through
  `public.ingest_whatsapp_text_message(...)` and passed its disposable
  `vetai-test` SQL gate.
- `conversations` already carries `clinic_id`, `owner_id`, optional `pet_id`,
  and operational `status`; do not create a second conversation-state table.
- The Worker uses native `fetch` for Supabase RPC calls and has no Supabase SDK.

Before editing, follow `AGENTS.md`, verify these facts from the repository, and
fill the Observed context section. Stop if repository evidence conflicts.

## Allowed changes

- New migration
  `supabase/migrations/20260806000200_conversation_intake_state.sql`.
- New rollback SQL test
  `supabase/tests/006_conversation_intake_state.sql`.
- One small Worker module, preferably `src/conversationState.ts`.
- Tests for that module under `test/`.
- `docs/database-schema.md` for the new columns/RPCs.
- The Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, webhook routing, Task 004/005
migrations, `Env`, Wrangler configuration, `AGENTS.md`, `PROJECT_CONTEXT.md`,
or unrelated behavior.

## Database contract

Alter `public.conversations` with:

- `intake_stage text not null default 'pet_identification'` constrained to:
  `pet_identification`, `complaint_collection`, `safety_check`,
  `ready_for_triage`, `appointment_offer`, `appointment_selection`,
  `appointment_confirmation`, `human_handoff`, `completed`.
- `intake_data jsonb not null default '{}'::jsonb`, constrained to a JSON
  object. It is a structured working document, not a raw webhook copy.
- `state_version integer not null default 1`, constrained to be positive.

Do not add a table, enum, trigger, extension, or dependency. Existing rows must
receive the defaults without data loss.

Create exactly two Data API functions:

1. `public.get_conversation_intake_context(p_conversation_id uuid)`
2. `public.advance_conversation_intake(...)`

Both functions must use `SECURITY INVOKER`, an empty `search_path`, fully
qualified objects, no dynamic SQL, and execution granted only to
`service_role` after revoking `PUBLIC`, `anon`, and `authenticated`.

### Context read RPC

Return exactly one row for an existing conversation containing:

- conversation ID, clinic ID, owner ID, optional pet ID;
- operational status, intake stage, intake data, and state version;
- owner display name;
- the owner's pets as a JSON array of `{ id, name, species }`, ordered
  deterministically by creation time then ID;
- at most the latest 12 messages as a chronological JSON array of
  `{ direction, content, created_at }`.

Return zero rows for an unknown conversation. Do not return phone numbers,
WhatsApp IDs, webhook hashes, secrets, or data from another owner/clinic.

### State advance RPC

Inputs must include conversation ID, expected state version, next stage,
optional pet ID, and a complete replacement `intake_data` JSON object. Keep
the update atomic and use optimistic concurrency:

- Reject an invalid/empty JSON document, invalid stage, nonpositive expected
  version, unknown conversation, or pet that does not belong to the
  conversation's owner and clinic.
- Permit the same stage (an idempotent data refresh).
- Otherwise permit only forward transitions in this graph:
  `pet_identification -> complaint_collection -> safety_check -> ready_for_triage -> appointment_offer -> appointment_selection -> appointment_confirmation -> completed`.
- Permit transition from any non-completed stage to `human_handoff`.
- `human_handoff` and `completed` are terminal in this task; only a same-stage
  refresh is allowed.
- Update only when `state_version = p_expected_version`; on success increment
  the version exactly once and return one row containing the new stage and
  version.
- Return zero rows for a stale version. Raise on all other invalid input. A
  rejected update must not mutate the conversation.
- When moving to `human_handoff`, also set operational `status = 'handoff'`.
  When moving to `completed`, set operational `status = 'completed'`.
  Other transitions must not silently reopen a handoff/completed conversation.

Use the existing composite pet/owner/clinic relationship as the tenant-safety
boundary; do not trust a caller-provided clinic ID.

## Worker helper contract

Add typed native-fetch helpers for the two RPCs. Follow the existing
`src/supabaseIngest.ts` transport rules instead of introducing a generic client
or abstraction layer:

- Construct RPC URLs with `new URL`.
- Require nonblank Supabase URL/key and HTTPS except loopback HTTP.
- Put the service-role key only in `apikey` and `Authorization` headers.
- Validate response shapes at runtime; never cast an unchecked response into a
  success value.
- Distinguish `not_found`, `stale`, and `failed` without exposing/logging
  response bodies.
- Never log intake data, message content, owner/pet identifiers, keys, or URLs.
- Do not modify `src/index.ts` in this task.

Keep the module small and direct. A little duplicated transport validation is
preferable to a speculative framework.

## Required tests

Unit tests with mocked native `fetch` must cover:

- exact RPC URLs, methods, headers, and request bodies;
- valid context parsing including null pet, pet list, and chronological recent
  messages;
- zero-row context as `not_found`;
- valid state advancement and returned version;
- zero-row advancement as `stale`;
- malformed/non-2xx/network responses and blank/insecure configuration as
  `failed`;
- no response body or sensitive inputs are logged.

Add a rollback SQL test proving:

- the new columns have the required defaults/constraints and a newly inserted
  conversation receives those defaults;
- context contains only the target owner/clinic, ordered pets, and the latest
  12 messages in chronological order;
- a valid forward transition and same-stage refresh each increment the version
  once;
- a stale update returns zero rows with no mutation;
- skipped/backward/terminal transitions fail without mutation;
- a cross-owner or cross-clinic pet assignment fails;
- handoff/completed transitions synchronize operational status;
- `anon` and `authenticated` cannot execute either RPC while `service_role`
  can;
- rollback removes every fixture.

Keep every existing test green.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not commit, push, deploy, link the repository to Supabase, mutate
external services, or write real credentials. Sonnet must not apply the
migration. Codex reviews first, then applies and tests it only in the
disposable `vetai-test` project.

## Observed context — Sonnet fills before coding

- Starting HEAD:
- Initial worktree state:
- Relevant schema/RPC/test evidence:
- Planned files:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands and exact results:
- Database checks actually run:
- Checks not run and why:
- Known limitations:
- Risks for Codex review:
