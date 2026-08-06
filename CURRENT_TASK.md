# Current task — 005 atomic inbound WhatsApp persistence

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

After the existing signature and envelope checks pass, persist supported
inbound WhatsApp text messages to Supabase exactly once. Resolve the clinic by
Meta `phone_number_id`, upsert the owner, reuse or create one open
conversation, insert the inbound message, and record the webhook event in one
atomic predefined database operation.

This task does not send WhatsApp messages, call an LLM, perform triage, identify
pets, create appointments, add queues, or deploy production services.

## Starting context

- Starting commit: `797af1d` on `main`.
- The worktree is clean.
- The signed Worker webhook currently validates only the outer WhatsApp
  envelope and returns `{ received: true }` without persistence.
- `Env` already declares `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; local
  placeholders already exist.
- Task 004 applied and validated the core schema/RLS in disposable
  `vetai-test`. Production deployment remains out of scope.
- No Supabase JavaScript SDK is installed.

Before editing, follow `AGENTS.md`, verify these facts from the repository, and
fill the Observed context section. Stop if repository evidence conflicts.

## Allowed changes

- `src/index.ts`.
- New small modules under `src/` for WhatsApp text extraction/event hashing and
  the Supabase RPC call. Prefer at most two modules.
- Existing/new tests under `test/`.
- `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`.
- `supabase/tests/005_ingest_whatsapp_text_message.sql`.
- `docs/database-schema.md` only for the new RPC/open-conversation decision.
- The Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, `Env`, Wrangler configuration, secret
files, the already-applied core migration, `AGENTS.md`, `PROJECT_CONTEXT.md`,
or unrelated Worker behavior.

## WhatsApp extraction contract

Use Meta's documented shape beneath
`entry[].changes[].value`: `metadata.phone_number_id`, matching
`contacts[].wa_id/profile.name`, and
`messages[].id/from/timestamp/type/text.body`.

- Support inbound messages whose `type` is exactly `text`.
- Ignore delivery/read/status-only events and unsupported non-text message
  types for now; a valid signed webhook containing only those still returns
  HTTP 200 with zero processed messages.
- If an item declares `type: "text"` but required text fields are malformed,
  reject the webhook with HTTP 400 and perform no persistence calls.
- Convert a sender containing 2–15 digits and a nonzero first digit to E.164 by
  prefixing `+`. Reject malformed senders.
- Use the matching contact profile name after trimming, capped at 200
  characters; use `WhatsApp user` when it is absent/empty. Never use a phone
  number as the fallback display name.
- Preserve message text exactly, but require 1–65,536 characters.
- Parse the message timestamp as positive Unix seconds and pass an ISO timestamp
  to the database.
- Deduplicate repeated `(phone_number_id, message.id)` items inside one webhook
  before persistence.
- Compute a lowercase SHA-256 hex hash with Web Crypto from a stable JSON array
  of the normalized event fields: phone-number ID, message ID, normalized
  sender, original timestamp, and text. Do not hash the full batch envelope;
  the same message may be redelivered in a differently batched envelope.

No raw webhook payload, contact object, token, key, signature, phone number, or
message text may be logged.

## Database migration contract

Create one partial unique index allowing at most one open conversation per
`(clinic_id, owner_id)`, where open means status `active` or `handoff`. Add a
short `ponytail:` comment noting that this MVP owner-level ceiling should be
revisited only if concurrent per-pet conversations become a verified need.

Create exactly one Data API function:

`public.ingest_whatsapp_text_message(...) returns table (result text)`

Inputs must cover phone-number ID, provider/message ID, stable payload hash,
sender E.164, owner name, message text, and provider timestamp.

Requirements:

- Use PL/pgSQL, `SECURITY INVOKER`, `VOLATILE`, an empty `search_path`, fully
  qualified objects, and no dynamic SQL.
- Validate phone-number ID and provider ID at 1–512 characters, owner name at
  1–200 characters, message text at 1–65,536 characters, the E.164 sender, a
  non-null provider timestamp, and the 64-character lowercase hex hash.
- Resolve exactly one clinic through the globally unique
  `whatsapp_accounts.phone_number_id`. Return `unknown_account` without writing
  when no account exists.
- Claim idempotency by inserting `webhook_events` with `ON CONFLICT DO NOTHING
  RETURNING`; this must be safe for concurrent duplicate deliveries.
- If an existing event has the same hash, return `duplicate` without changing
  owners, conversations, or messages. If the same provider ID has a different
  hash, raise an error and write nothing.
- Upsert the owner by `(clinic_id, phone_e164)`. Do not overwrite a non-fallback
  existing name merely because a WhatsApp profile name changed.
- Atomically reuse the owner's `active`/`handoff` conversation or create one
  `active` conversation, then insert one `messages` row with direction
  `inbound`, the provider timestamp, and `whatsapp_message_id`.
- Mark the claimed webhook event `processed` with `processed_at`, then return
  `processed`. Any failure must roll back the entire RPC call.
- Revoke execution from `PUBLIC`, `anon`, and `authenticated`; grant execution
  only to `service_role`. Do not use `SECURITY DEFINER`.
- Add no table, enum, trigger, extension, or dependency.

## Worker persistence contract

- Call the function using native `fetch` and construct
  `/rest/v1/rpc/ingest_whatsapp_text_message` with `new URL(...,
  SUPABASE_URL)`; do not install `@supabase/supabase-js`.
- Send the service-role key only in `apikey` and `Authorization: Bearer ...`
  headers. Never put it in a URL, response, or log.
- Require HTTPS, except that HTTP is allowed for loopback localhost testing,
  and require both Supabase env values to be nonempty before making a request.
  Fail closed.
- Accept only the documented one-row result containing `processed`,
  `duplicate`, or `unknown_account`; treat malformed/non-2xx responses as
  failures without logging the response body.
- A fully persisted or duplicate webhook returns HTTP 200. A valid webhook with
  no supported messages returns HTTP 200 without requiring Supabase config.
- Missing configuration, unknown account, hash conflict, or Supabase/network
  failure returns HTTP 503 so Meta can retry. Do not expose internal details.
- When a batch contains multiple supported messages, any failure makes the
  webhook response 503; successful earlier items remain safe because a retry
  will receive `duplicate` for them.
- Preserve all existing 400/401/413/415 behavior and GET routes.
- Logs may contain only generic event names and aggregate processed/duplicate
  counts.

## Required tests

Use official-shape fixtures and mocked native `fetch`; use no real secrets or
external calls in unit tests.

- Extract one and multiple inbound text messages, including matching contact
  names and fallback names.
- Ignore status-only and unsupported-type events.
- Reject malformed declared-text messages, senders, timestamps, and oversized
  text; prove oversized contact names are capped to 200 characters.
- Prove stable event hashing is independent of surrounding batch packaging.
- Prove in-payload duplicate IDs cause one RPC call.
- Assert RPC URL, method, headers, input body, accepted results, missing config,
  network/non-2xx failure, and malformed RPC response behavior.
- Assert Worker responses for processed, duplicate, empty/status-only,
  malformed text, missing Supabase configuration, and persistence failure.
- Keep every existing test green.

Add a rollback-based SQL test that proves:

- First RPC call returns `processed`; identical/concurrent-safe retry returns
  `duplicate` and leaves exactly one event, owner, open conversation, and
  message.
- Same provider ID with another hash fails without mutation.
- Unknown phone-number ID returns `unknown_account` without mutation.
- An existing verified owner name is not overwritten.
- An existing `handoff` conversation is reused.
- `anon` and `authenticated` cannot execute the RPC; `service_role` can.
- All fixtures are gone after rollback.

Sonnet must not apply the migration to Supabase. Codex will review first, then
apply and run the SQL test only in `vetai-test`.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, link the repository to Supabase, mutate external
services, or write real credentials.

## References

- Meta official WhatsApp collection, received text payload:
  https://www.postman.com/meta/whatsapp-business-platform/request/cy6hnq7/received-text-message
- Supabase Data REST API:
  https://supabase.com/docs/guides/api
- Supabase database-function security:
  https://supabase.com/docs/guides/database/functions

## Observed context — Sonnet fills before coding

- Starting HEAD: `7b3ee3d` ("docs: define inbound persistence task") on `main`, matches the task contract's stated starting commit lineage (`797af1d` is its parent, task 004's commit).
- Initial worktree state: clean (`git status --porcelain` empty).
- Relevant call path and tests: `src/index.ts` → `handleWebhookPost` currently validates content-type, 256 KiB size limit, `X-Hub-Signature-256` (via `verifyHmacSignature` in `src/webhookSignature.ts`), strict UTF-8 JSON parse, and the outer `{ object, entry[] }` envelope, then logs a generic line and returns `Response.json({ received: true })` with no persistence. `src/env.ts` already declares `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`. `test/index.test.ts` covers routing/400/401/413/415 with a shared `env` fixture (`SUPABASE_URL: "https://example.supabase.co"`) and a `signHmacSha256` helper in `test/signHelper.ts` — new tests reuse both. The applied core migration `supabase/migrations/20260806000000_core_tenant_schema.sql` defines `public.webhook_events` with `unique (clinic_id, provider_event_id)` (the idempotency target for `ON CONFLICT`), `public.messages` with a clinic-scoped partial unique index on `whatsapp_message_id`, `public.conversations.pet_id` FK using `on delete no action`, and privileged helpers living in a separate `vetai_private` schema with `search_path = ''` — this task's new function follows the same empty-search_path/fully-qualified convention but stays in `public` (per contract) since PostgREST only exposes functions in the API-exposed schema. `supabase/tests/004_core_tenant_rls.sql` is the existing rollback-test pattern (`begin; ... rollback; select 'PASS' ...` with a final row-count assertion) to mirror for `005_ingest_whatsapp_text_message.sql`.
- Planned files: `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`, `src/whatsappIngest.ts` (extraction + hashing), `src/supabaseIngest.ts` (RPC caller), edits to `src/index.ts`, `test/whatsappIngest.test.ts`, `test/supabaseIngest.test.ts`, additions to `test/index.test.ts`, `supabase/tests/005_ingest_whatsapp_text_message.sql`, a short addition to `docs/database-schema.md`.
- Conflicts or blockers: none. PROJECT_CONTEXT.md confirms task 004's disposable-project gate passed and the next phase is exactly this Worker-to-Supabase persistence wiring; repository evidence matches the task contract.

## Delivery record — Sonnet fills after coding

- Changed files:
  - Modified: `CURRENT_TASK.md` (Observed context/Delivery record only), `docs/database-schema.md` (new "Inbound WhatsApp text message ingestion" section), `src/index.ts` (persistence wiring in `handleWebhookPost`), `test/index.test.ts` (added `worker whatsapp persistence` describe block + two small fixture helpers).
  - New: `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql`, `src/whatsappIngest.ts`, `src/supabaseIngest.ts`, `test/whatsappIngest.test.ts`, `test/supabaseIngest.test.ts`, `supabase/tests/005_ingest_whatsapp_text_message.sql`.
  - No changes to `Env`, Wrangler config, secrets, dependencies/lockfiles, the already-applied core migration, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

- Acceptance criteria satisfied:
  - Extraction (`src/whatsappIngest.ts`): supports `type: "text"` only; ignores status-only/unsupported-type events; validates sender (2–15 digits, nonzero first digit → `+E.164`), 1–65,536-char text, positive-integer Unix timestamp; rejects the whole webhook (`{ ok: false }`) on any malformed declared-text item; contact-name matching with trim, 200-char cap, and `WhatsApp user` fallback; in-payload dedup on `(phone_number_id, message.id)` via `JSON.stringify([...])` keys (no raw NUL/unsafe separator); stable SHA-256 hex hash over `[phoneNumberId, id, senderE164, timestamp, text]`, independent of batch packaging.
  - RPC caller (`src/supabaseIngest.ts`): builds `/rest/v1/rpc/ingest_whatsapp_text_message` via `new URL(path, SUPABASE_URL)`; native `fetch` only, no SDK; service-role key sent only in `apikey`/`Authorization: Bearer` headers; requires HTTPS except loopback HTTP; fails closed on empty config; accepts only `processed`/`duplicate`/`unknown_account`, everything else (network error, non-2xx, malformed body) maps to `"failed"`; never logs a response body.
  - Worker wiring (`src/index.ts`): runs extraction only after existing signature/envelope checks; 400 on malformed declared-text; 200 with no Supabase call when zero supported messages; loops all items (no short-circuit) tallying processed/duplicate/failed; logs only the aggregate counts; 503 if any item failed, else 200; all prior routes/status codes (400/401/413/415/404, GET routes) unchanged.
  - Migration (`...000100_ingest_whatsapp_text_message.sql`): adds the single partial unique index with the required `ponytail:` comment, and exactly one `SECURITY INVOKER`, `VOLATILE`, empty-`search_path`, fully-qualified, no-dynamic-SQL function matching every validation/idempotency/upsert/reuse/grant rule in the contract; adds no other table/enum/trigger/extension/dependency.
  - Tests: unit tests cover every bullet under "Required tests" (see command output below); SQL rollback test covers processed→duplicate idempotent retry, hash-mismatch failure with no mutation, unknown-account no-mutation, preserved verified owner name, reused handoff conversation, `anon`/`authenticated` denial vs. `service_role` success, and full fixture rollback.

- Commands and exact results:
  - `pnpm install --frozen-lockfile` → `Already up to date. Done in 574ms using pnpm v11.9.0`.
  - `pnpm typecheck` → `tsc --noEmit`, no output, exit 0.
  - `pnpm test` → `68 passed (68)` across all test files (30 pre-existing + 38 new: 15 in `whatsappIngest.test.ts`, 9 in `supabaseIngest.test.ts`, 8 in `index.test.ts`'s new persistence block, remainder pre-existing files), 0 failed.
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` → `Total Upload: 10.70 KiB / gzip: 3.47 KiB`, only the pre-existing `APP_TIMEZONE` binding listed, `--dry-run: exiting now.`, no errors.
  - `git diff --check` → exit 0, no whitespace/conflict-marker errors (only benign LF→CRLF autocrlf warnings on 4 modified files).

- Database checks actually run:
  - None against a real database — no Docker/psql/live Postgres is available in this environment (same constraint as Task 003). `supabase/tests/005_ingest_whatsapp_text_message.sql` was written and manually traced statement-by-statement against the migration's actual column/constraint/grant definitions but was NOT executed anywhere, per this task's explicit instruction ("Sonnet must not apply the migration to Supabase").

- Checks not run and why:
  - No live SQL execution of the new migration or `005_ingest_whatsapp_text_message.sql` — explicitly reserved for Codex against the disposable `vetai-test` project after review, matching the Task 003/004 precedent.
  - No manual/browser end-to-end test of a real WhatsApp webhook delivery — out of scope; this is a backend-only Worker with no UI, and `wrangler dev` against a real Supabase project would require live credentials this task must not create or use.

- Known limitations:
  - One open conversation per **owner**, not per pet (contract-mandated MVP ceiling; `ponytail:` comment in the migration marks it).
  - `src/supabaseIngest.ts`'s malformed-response handling only checks for a one-row array with a valid `result` string; it does not attempt to distinguish *why* a response was malformed (kept minimal per "no response body logging" and no over-engineering).
  - Aggregate log counts (`processed`/`duplicate`/`failed`) are emitted even when the webhook eventually returns 503, so a single log line already tells an operator how many of a batch succeeded before the failure — no per-item logging was added since the contract caps logging to generic aggregates only.

- Risks for Codex review:
  - The RPC's idempotency/upsert/reuse logic (ON CONFLICT DO NOTHING + DO UPDATE-then-touch pattern) mirrors the reasoning already applied and reviewed in Task 003/005's prior sibling migration, but this is a new function body and warrants its own read, especially the `on conflict (clinic_id, owner_id) where status in ('active', 'handoff') do update set clinic_id = excluded.clinic_id` arbiter clause against the new `conversations_one_open_per_owner_idx` partial index.
  - `src/whatsappIngest.ts` originally had a raw NUL byte (`0x00`) accidentally embedded in the dedupe-key template literal instead of the intended escape sequence; this was caught and fixed before delivery by switching to `JSON.stringify([phoneNumberId, id])`, and re-verified byte-clean via a Node byte-dump. Worth a deliberate second look since it silently produced a binary file the first time.
  - `src/supabaseIngest.ts` allows plain HTTP only for `localhost`/`127.0.0.1`/`[::1]` hostnames; confirm this loopback allowlist matches what local `wrangler dev` + local Supabase actually present before relying on it.

## Codex review and verification

- Reviewed the Worker call path, extraction/hashing logic, native Data API
  client, migration, grants, partial-index conflict inference, and rollback SQL
  test. No unresolved blocking finding remains.
- Tightened parser boundaries before approval: only `field: "messages"` changes
  are inspected; IDs are capped at 512 characters; Unix timestamps must be
  safe integers representable by JavaScript dates; contact names are capped by
  Unicode code point; identical in-payload duplicates make one RPC call, while
  the same key with different normalized content is rejected. Whitespace-only
  Supabase credentials now fail closed.
- Rechecked the disclosed NUL-byte risk: the new source, migration, and test
  files contain no NUL bytes.
- Codex verification: frozen install passed; strict typecheck passed; 75/75
  tests passed; Wrangler dry-run passed; final diff checks passed.
- Applied `20260806000100_ingest_whatsapp_text_message.sql` only to the
  disposable `vetai-test` Supabase project. The SQL editor reported success.
- Ran `supabase/tests/005_ingest_whatsapp_text_message.sql` against that
  project. It returned `PASS` with zero surviving test clinics, WhatsApp
  accounts, owners, and webhook events after rollback.
- Decision: `PASS`. Production deployment remains out of scope and must use a
  managed Supabase migration workflow.
