# Current task — 010 return conversation locator from inbound persistence

Status: `COMPLETE`

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

- Starting HEAD: `6b5fd5f` ("docs: define inbound conversation locator task") on
  `main`. This is one commit ahead of the `88a1ce9` stated above; `88a1ce9`
  ("feat: add deterministic safety decision gate") is its parent, so the
  difference is only this task's own contract commit. Not treated as a
  conflict.
- Initial worktree state: clean (`git status --porcelain` empty).
- Relevant code/tests/migration evidence:
  - `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`
    declares `returns table (result text)` and already resolves
    `v_conversation_id` internally (conversation upsert at the `processed`
    path). It is `security invoker`, `volatile`, `set search_path = ''`,
    revoked from `public, anon, authenticated`, granted to `service_role`.
  - `supabase/migrations/20260806000000_core_tenant_schema.sql` defines
    `messages_clinic_whatsapp_message_id_key` — a partial unique index on
    `(clinic_id, whatsapp_message_id) where whatsapp_message_id is not null`
    — so the duplicate locator lookup is tenant-scoped and unique.
  - `src/supabaseIngest.ts` returned the bare string union
    `"processed" | "duplicate" | "unknown_account" | "failed"` and read only
    `row.result`.
  - `src/index.ts` compared that string at lines 60-62 and returns 503 when
    `failed > 0`, otherwise 200.
  - `test/index.test.ts` stubs global `fetch` (not the module), so its RPC
    response fixtures had to gain `conversation_id`.
  - `20260806000200_conversation_intake_state.sql` establishes the precedent
    that `returns table` OUT parameter names may shadow table column names,
    because every in-body column reference is alias-qualified.
  - No UUID validation helper exists anywhere in `src/`, so one was added
    locally in `src/supabaseIngest.ts`.
- Planned files: the new migration, the new SQL test, `src/supabaseIngest.ts`,
  `src/index.ts`, `test/supabaseIngest.test.ts`, `test/index.test.ts`,
  `docs/database-schema.md`, and these two sections.
- Conflicts or blockers: none blocking. Two notes: the HEAD difference above,
  and `rtk` is still unavailable in this shell (`rtk --version` fails), so
  native commands were used as `AGENTS.md` permits.

## Delivery record — Sonnet fills after coding

- Changed files:
  - `supabase/migrations/20260806000300_ingest_whatsapp_conversation_locator.sql`
    (new, unapplied)
  - `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` (new, not run)
  - `src/supabaseIngest.ts`
  - `src/index.ts`
  - `test/supabaseIngest.test.ts`
  - `test/index.test.ts`
  - `docs/database-schema.md`
  - `CURRENT_TASK.md` (these two sections only)
- Acceptance criteria satisfied:
  - Forward-only migration; Task 005's file is untouched. The return type
    changes, so the old signature is dropped and recreated in the same
    (implicitly transactional) migration batch.
  - The function now returns exactly one row of
    `(result text, conversation_id uuid)`.
  - `processed` returns the conversation that owns the newly inserted message;
    `duplicate` resolves the locator from `public.messages` by both
    `clinic_id` and `whatsapp_message_id`, never by provider ID alone.
  - An exact-duplicate event with no matching persisted message raises
    `... duplicate event has no persisted message for provider_event_id %`
    instead of returning a nullable/synthetic locator.
  - `unknown_account` returns `conversation_id = null` and still writes
    nothing; payload-hash mismatch still raises.
  - All prior validation, atomicity, owner-name preservation, conversation
    reuse, `security invoker`, empty `search_path`, and the
    revoke-from-`public`/`anon`/`authenticated` + grant-to-`service_role`
    pattern are carried over verbatim. No second RPC, table, queue, trigger,
    or dependency was added.
  - TypeScript now returns the closed shape `{ kind: "processed" |
    "duplicate", conversationId }`, `{ kind: "unknown_account" }`, or
    `{ kind: "failed" }`. The response is treated as untrusted: exactly one
    array element, a plain non-array object row, only the three database
    result values, a syntactically valid UUID for `processed`/`duplicate`, a
    strictly `null` ID for `unknown_account`, and `failed` for every network,
    HTTP, JSON, shape, result/ID, or configuration failure. No body,
    credential, message text, or identifier is logged.
  - `src/index.ts` changed only from `outcome === ...` to
    `outcome.kind === ...`; the 200/503 contract and log line are unchanged
    and no downstream processing was started.
- Commands and exact results:
  - `pnpm install --frozen-lockfile` — PASS (lockfile up to date; pnpm printed
    an unrelated "newer pnpm available" notice).
  - `pnpm typecheck` — PASS (`tsc --noEmit`, no output, exit 0).
  - `pnpm test` — PASS, exit 0: `Test Files 11 passed (11)`,
    `Tests 226 passed (226)`.
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — PASS,
    exit 0 (wrangler 4.118.0, 11.76 KiB / 3.70 KiB gzip).
  - `git diff --check` — PASS, exit 0 (no whitespace errors).
  - `git status --porcelain` — only the seven files listed above; nothing else
    modified, nothing committed, pushed, or deployed.
  - Git needed `-c safe.directory=...` per command because `.git` is owned by
    another local account; no global Git config was written.
- Checks not run and why:
  - The migration was **not applied** and
    `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` was **NOT
    RUN**. No real PostgreSQL/Supabase database was touched. Per this
    contract, Codex owns applying and verifying both in `vetai-test`. All SQL
    below is static-reviewed only.
  - No LLM call, no outbound WhatsApp call, no external-service mutation.
- Known limitations:
  - The duplicate locator lookup depends on the message actually having been
    persisted with `whatsapp_message_id` set. That is guaranteed by this
    function's own insert, but a webhook event claimed by some future writer
    that does not persist a message will now raise rather than degrade — this
    is the intended fail-closed behavior, not a silent locator.
  - The Worker still discards the returned conversation ID; wiring it to
    downstream orchestration is explicitly out of scope.
  - `unknown_account` requires the key to be present and strictly `null`. A
    provider that omitted the column entirely would fail closed rather than
    be accepted; that is a deliberate reading of the contract.
  - UUID validation is syntactic only (hex layout, case-insensitive); it does
    not pin version or variant bits, matching what PostgreSQL's `uuid` type
    accepts.
- Risks for Codex review:
  - `drop function` + `create function` is required because PostgreSQL cannot
    change a function's return type with `create or replace`. Confirm the
    Supabase migration batch is transactional in the applied environment so
    the RPC is never observably absent.
  - The new OUT parameter `conversation_id` shares a name with
    `public.messages.conversation_id` and `public.conversations`-related
    columns. Every in-body reference is alias-qualified or an INSERT/UPDATE
    target column list, so plpgsql should not report ambiguity — but this is
    exactly the kind of thing only a real `create function` proves. Please
    confirm on application.
  - The SQL test's cross-tenant case reuses provider message ID `wamid.LOC1`
    under a second clinic to prove the locator lookup is clinic-scoped; verify
    it passes rather than tripping the partial unique index.
  - The orphaned-duplicate case inserts a `webhook_events` row directly to
    simulate a claimed-but-unpersisted event; confirm the raised message still
    matches the `%no persisted message%` filter after any wording change.
  - `test/supabaseIngest.test.ts` was rewritten rather than patched; it is a
    superset of the previous cases (all prior assertions retained, converted
    to the new object shape).

## Codex review and verification

- Decision: `PASS`; no implementation correction was required.
- Reviewed the full diff, original/replacement RPC bodies, every caller, the
  structured response parser, TypeScript tests, rollback SQL test, grants,
  tenant-scoped duplicate lookup, docs, secret scan, and NUL-byte scan.
- Codex reran the frozen install, typecheck, all 226 tests, Wrangler dry-run
  (11.76 KiB / gzip 3.70 KiB), and `git diff --check`; all passed.
- Applied `20260806000300_ingest_whatsapp_conversation_locator.sql` to the
  disposable `vetai-test` project through its authenticated SQL editor. The
  drop/create batch completed successfully.
- Ran `supabase/tests/010_ingest_whatsapp_conversation_locator.sql` against
  the real PostgreSQL database. It returned `PASS` with zero remaining test
  clinics, WhatsApp accounts, owners, conversations, messages, and webhook
  events.
- Real execution confirmed processed/duplicate locators, unknown-account null,
  hash mismatch, orphan fail-closed behavior, cross-tenant provider-ID scope,
  OUT-parameter disambiguation, and service-role-only execution.
- The SQL-editor application is integration evidence only and is not recorded
  in Supabase CLI migration history; production still requires the managed
  migration workflow.
