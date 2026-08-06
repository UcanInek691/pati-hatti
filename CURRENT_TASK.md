# Current task — 005 atomic inbound WhatsApp persistence

Status: `READY`

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

- Starting HEAD:
- Initial worktree state:
- Relevant call path and tests:
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
