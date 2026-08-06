# Current task — 010 return conversation locator from inbound persistence

Status: `READY`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

Extend the already-atomic WhatsApp text-ingestion RPC and its TypeScript client
so a successfully processed or exact-duplicate inbound message returns the
tenant-scoped conversation ID. This is the minimum prerequisite for later
queue/orchestration work.

This task does not call an LLM, evaluate safety, fetch conversation context,
advance intake state, enqueue work, send WhatsApp messages, deploy, or change
the webhook's HTTP response contract.

## Starting context

- Starting HEAD: `88a1ce9` on `main`; worktree is clean.
- Task 005's applied migration returns only `result text` from
  `ingest_whatsapp_text_message`, although the function already resolves the
  conversation internally.
- `src/supabaseIngest.ts` therefore returns only a string outcome, and
  `src/index.ts` can count outcomes but cannot identify the conversation for a
  later asynchronous job.
- Task 006 already provides conversation-context/state RPC clients, but they
  are not wired.
- Task 009's reviewed safety gate is committed but not wired.

Before editing, follow `AGENTS.md`, verify these facts from the repository, and
fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New migration:
  `supabase/migrations/20260806000300_ingest_whatsapp_conversation_locator.sql`.
- New rollback-based SQL test:
  `supabase/tests/010_ingest_whatsapp_conversation_locator.sql`.
- `src/supabaseIngest.ts`.
- `src/index.ts`, only to consume the structured outcome without changing the
  existing response/status behavior.
- `test/supabaseIngest.test.ts` and `test/index.test.ts`.
- `docs/database-schema.md`, limited to the revised RPC result.
- Fill the Observed context and Delivery record sections of this file.

Do not modify previously applied migrations, dependencies, lockfiles, prompts,
OpenAI/extraction/safety modules, conversation-state code, `Env`, Wrangler
bindings, webhook parsing/signature behavior, `AGENTS.md`, or
`PROJECT_CONTEXT.md`.

## Database contract

Add a forward-only migration; never edit Task 005's applied migration. Replace
the existing RPC signature safely so it returns exactly one row with:

- `result text`
- `conversation_id uuid`

Required behavior:

- `processed` returns the conversation ID that owns the newly inserted
  inbound message.
- An exact `duplicate` returns the conversation ID of the already-persisted
  message. Resolve it using both `clinic_id` and `whatsapp_message_id`; never
  search by provider ID without tenant scope.
- If an exact-duplicate event has no matching persisted message, raise an
  exception rather than returning a nullable/synthetic locator.
- `unknown_account` returns `conversation_id = null` and writes nothing.
- Payload-hash mismatch continues to raise an exception.
- Preserve all existing validation, atomicity, owner-name behavior,
  conversation reuse, grants, and search-path/security properties.
- Only `service_role` may execute the revised function; `public`, `anon`, and
  `authenticated` must not.

Do not add a second public ingestion RPC, table, queue, trigger, or dependency.

## TypeScript contract

Replace the string result with this closed shape (equivalent naming is fine):

- `{ kind: "processed", conversationId: string }`
- `{ kind: "duplicate", conversationId: string }`
- `{ kind: "unknown_account" }`
- `{ kind: "failed" }`

Treat the Supabase response as untrusted:

- require an array containing exactly one plain object;
- accept only the three database result values;
- require a syntactically valid UUID conversation ID for `processed` and
  `duplicate`;
- require a null conversation ID for `unknown_account`;
- return `{ kind: "failed" }` for network, HTTP, JSON, shape, result/ID, or
  configuration failures;
- never log request/response bodies, credentials, message text, or identifiers.

Update `src/index.ts` only enough to count `outcome.kind`: `processed` and
`duplicate` remain successful, while `unknown_account` and `failed` remain
failures. Preserve the current 200/503 behavior and do not start downstream
processing.

## Required tests

TypeScript tests must cover:

- valid processed, duplicate, and unknown-account responses;
- processed/duplicate missing, null, malformed, or non-string IDs fail closed;
- unknown-account with a non-null ID fails closed;
- unknown result, extra/missing row, non-object row, malformed JSON, non-2xx,
  network failure, invalid URL/protocol, and blank secrets fail closed;
- `src/index.ts` still returns 200 when every item is processed/duplicate and
  503 when any item is unknown-account/failed;
- existing webhook behavior remains unchanged.

The rollback SQL test must prove:

- processed returns the inserted message's conversation ID;
- exact duplicate returns that same ID and creates no additional event,
  owner, conversation, or message;
- unknown account returns a null ID and writes nothing;
- hash mismatch still raises;
- a deliberately orphaned exact-duplicate event raises instead of returning a
  locator;
- function grants remain service-role-only;
- all fixtures are rolled back and no fixture rows survive.

Do not claim the SQL test passed unless it ran against a real disposable
PostgreSQL/Supabase database. Sonnet must leave the migration unapplied; Codex
owns the `vetai-test` application and verification step.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, call an LLM, mutate Supabase, or touch another
external service.

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
- Risks for Codex review:
