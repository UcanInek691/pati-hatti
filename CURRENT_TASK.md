# Current task — 019 persist outbound WhatsApp status callbacks

Status: `READY`

Primary implementer: Claude Sonnet

Reviewer: Codex. Claude Opus is not a mandatory gate unless Codex finds a new
critical tenant/RLS/PII design uncertainty.

## Goal

Persist Meta's signed outbound-message status callbacks against the exact
tenant, WhatsApp account, accepted outbox row, and recipient without treating
Meta request acceptance as delivery.

The webhook path becomes:

`signed Meta webhook -> strict status extraction -> tenant-safe status RPC -> acknowledged callback`

Meta documents `sent`, `delivered`, `read`, and `failed` status callbacks and
warns that notification arrival order may not match event time. The stored
summary must therefore be deterministic, idempotent, and non-regressing.

This task does not send messages, change intake/reply/safety behavior, store
raw provider errors, notify staff, build monitoring UI, prune PII, implement
appointments, deploy, create resources, or configure real secrets.

## Starting context

- Starting HEAD: `26f1b25` on `main`; worktree is clean.
- Task 018 is committed. A scheduled Worker claims at most ten globally due
  outbox rows per run, sends through the exact account, and atomically records
  Meta acceptance plus one outbound `messages` row.
- `outbound_message_outbox.delivery_status = 'accepted'` means the send API
  accepted the request. It is not delivered/read proof.
- Accepted outbox rows contain `provider_message_id`, `whatsapp_account_id`,
  `recipient_e164`, and tenant/conversation links. RLS is enabled with no
  client policy; only `service_role` has table access.
- The signed POST webhook already verifies HMAC over bounded raw bytes before
  JSON parsing. `extractTextMessages()` ignores status-only callbacks, so they
  currently return HTTP 200 without persistence.
- Meta's official status example nests callbacks under
  `entry[].changes[].value`, with `field = 'messages'`,
  `value.metadata.phone_number_id`, and `value.statuses[]` entries containing
  `id`, `status`, `timestamp`, and `recipient_id`.
- The official reference says notification order may not reflect event order;
  `timestamp` describes provider event time.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify all facts from repository source, callers, tests, migrations,
scripts, Git status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration
  `supabase/migrations/20260809000300_outbound_status_tracking.sql`.
- New rollback test `supabase/tests/019_outbound_status_tracking.sql`.
- New `src/whatsappStatus.ts` and `test/whatsappStatus.test.ts`.
- New `src/supabaseOutboundStatus.ts` and
  `test/supabaseOutboundStatus.test.ts`.
- `src/index.ts` and `test/index.test.ts`, limited to status extraction,
  persistence, response behavior, and count-only logging inside the existing
  signed WhatsApp POST route.
- New `docs/outbound-status.md` plus narrowly relevant updates to
  `docs/database-schema.md` and `docs/outbound-delivery.md`.
- Fill only the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, Env bindings, Wrangler configuration,
signature verification, body limits, GET routes, Queue/Cron behavior, inbound
text normalization/RPC behavior, outbound sending, reply copy, extraction
prompt, planning, safety, pet selection, existing migrations/fixtures,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Database contract

### Stored summary

Extend `public.outbound_message_outbox` with exactly:

- `provider_delivery_status text` nullable;
- `provider_status_at timestamptz` nullable.

Add named checks requiring either both fields null, or:

- the row's existing `delivery_status` is `accepted`;
- `provider_delivery_status` is one of `sent | failed | delivered | read`;
- `provider_status_at` is non-null.

Existing accepted rows backfill coherently with both fields null. Do not add
raw payload, recipient, error text, pricing, conversation, or failure-detail
columns. Recipient and fixed reply PII already exist in the protected outbox;
this task must not duplicate them.

### Status RPC

Create one predefined operation:

```text
public.record_whatsapp_outbound_status(
  p_phone_number_id text,
  p_provider_message_id text,
  p_recipient_e164 text,
  p_provider_status text,
  p_provider_timestamp timestamptz
) returns table(result text)
```

It must be `SECURITY INVOKER`, `VOLATILE`, `SET search_path = ''`, revoked
from `PUBLIC`, `anon`, and `authenticated`, and executable only by
`service_role`.

Validate all inputs before mutation:

- numeric phone-number ID, length `1..64`;
- provider message ID, `1..512` Unicode code points;
- exact E.164 recipient;
- closed provider status;
- non-null provider timestamp.

Resolve and lock exactly one row by joining the accepted outbox row to its
exact tenant-scoped `whatsapp_account_id`, then matching all three provider
facts: `phone_number_id`, `provider_message_id`, and `recipient_e164`. Never
select an account from `clinic_id` alone and never accept a caller-supplied
clinic or outbox UUID.

Return only:

- `recorded` — summary inserted or advanced;
- `duplicate` — exact current status and timestamp already stored;
- `stale` — valid callback did not improve the stored summary;
- `not_found` — exact account/message/recipient/accepted-row link is absent.

Use this deterministic precedence:

```text
sent = 1, failed = 2, delivered = 3, read = 4
```

- Higher rank replaces lower rank even when callbacks arrive out of order.
- Lower rank never replaces higher rank, regardless of timestamp.
- Same rank with a newer provider timestamp updates `provider_status_at` and
  returns `recorded`.
- Same rank with the same timestamp returns `duplicate`.
- Same rank with an older timestamp returns `stale`.

This is a bounded operational summary, not a full provider-event ledger.
`delivered` or `read` may supersede an earlier `failed`; `failed` may not
regress delivered/read evidence. Raise on database invariant errors so the
whole RPC rolls back.

Do not create RLS policies or grant new table access. Preserve all erasure
cascades and the existing accepted-row idempotency behavior.

## Runtime contract

### Status extractor

`src/whatsappStatus.ts` exports a closed item type and one pure asynchronous
extractor for the already signature-verified webhook body.

For each `field = 'messages'` change with a `statuses` property:

- require `statuses` to be an array;
- tolerate unrelated enumerable JSON fields at every provider-owned level;
- ignore status names outside this task's four-value set so a future additive
  provider status does not make valid webhooks retry forever;
- for each supported status, require a plain status object, numeric
  `metadata.phone_number_id` length `1..64`, message ID length `1..512`,
  numeric `recipient_id` convertible to exact E.164, and a positive Unix-
  seconds timestamp that is a safe integer and converts to a valid ISO time;
- reject the whole webhook extraction if any supported status item is
  malformed;
- return no raw errors, pricing, conversation metadata, or provider body.

Deduplicate exact in-payload repetitions by the canonical tuple
`[phoneNumberId, providerMessageId, recipientE164, status, timestamp]` while
preserving first-seen order. Do not log or mutate input.

### Supabase client

`src/supabaseOutboundStatus.ts` exposes one native-fetch helper around the RPC
and follows the existing Supabase transport policy:

- non-blank URL/service-role configuration;
- HTTPS or loopback HTTP only;
- service-role headers;
- exact argument names and values;
- exact one-row Data API response with one `result` field;
- closed result mapping plus generic `failed` for config/network/HTTP/JSON/
  getter/prototype/shape errors;
- no body, identifier, phone, key, or provider detail logging.

Do not refactor existing private transport helpers just to share code.

### Signed webhook wiring

Inside the existing POST handler, after signature verification and envelope
validation but before any mutation:

1. extract statuses;
2. extract inbound text messages;
3. if either extractor rejects, return 400 and perform no status/text
   persistence or Queue send;
4. persist each status item sequentially;
5. treat `recorded | duplicate | stale | not_found` as acknowledged; only
   client `failed` makes the request return 503;
6. then run the existing inbound text persistence/Queue behavior unchanged.

Status-only callbacks never enqueue intake work. Mixed callbacks are allowed;
replay after a partial transport failure is safe because both persistence
paths are idempotent. Log only aggregate status counts, never IDs, phone
numbers, timestamps, content, provider bodies, or secrets.

Unknown account/message/recipient callbacks return HTTP 200 after a valid RPC
`not_found` result so Meta does not retry permanent non-matches forever.

## Required tests

### TypeScript

Prove at least:

- official-shaped `sent`, `delivered`, `read`, and `failed` extraction;
- multiple entries/changes/statuses, deterministic order, exact in-payload
  dedupe, additive fields, and unsupported string statuses ignored;
- malformed statuses array, supported item, phone ID, provider ID, recipient,
  unsafe/invalid timestamp, prototype/getter/symbol/hidden cases fail closed;
- the extractor does not mutate or log input and never returns provider error
  details;
- exact RPC endpoint, headers, argument body, all four closed results, and
  generic failure for invalid config/URL/network/HTTP/JSON/extra-or-missing
  response fields/non-plain/getter shapes;
- a valid status-only signed webhook calls the status RPC, never calls inbound
  ingestion or Queue, and returns 200;
- `not_found`, `duplicate`, and `stale` return 200; client failure returns 503;
- malformed mixed callbacks perform zero persistence/Queue calls;
- a valid mixed callback persists status and retains the existing inbound
  text/Queue behavior;
- unrelated/status-free callbacks keep their existing 200 behavior;
- existing fetch, signature, inbound, Queue, and scheduled tests remain green;
- no sensitive value or provider error body is logged or returned.

Mock every fetch; do not call real Meta or Supabase.

### Rollback SQL test

`supabase/tests/019_outbound_status_tracking.sql` runs inside
`BEGIN`/`ROLLBACK` and proves at least:

- Task 018 accepted rows backfill with a coherent null summary;
- exact account + provider ID + recipient records `sent` under real
  `service_role`;
- exact replay is `duplicate`; same-status newer time updates; older time is
  `stale`;
- out-of-arrival-order higher rank advances even with an older timestamp;
- lower rank cannot regress delivered/read; failed may supersede sent and may
  later be superseded by delivered/read;
- wrong account, provider ID, recipient, non-accepted row, and unknown row are
  `not_found` with zero mutation;
- the same-looking provider ID in another clinic cannot cross tenant/account
  boundaries;
- invalid direct inputs and state-check violations fail with no partial write;
- RLS remains enabled with zero policies; anon/authenticated have no table or
  RPC access; only service_role executes successfully;
- owner/account/source erasure cascades remain intact;
- rollback leaves zero fixture residue.

The single-session fixture cannot prove true concurrent lock contention or
real Meta ordering/delivery. Document those limits.

## Documentation and references

Create `docs/outbound-status.md` describing:

- accepted versus sent/delivered/read/failed;
- exact-account/recipient tenant routing;
- non-regressing rank and same-rank timestamp rules;
- unsupported/additive provider-field tolerance;
- backend-only PII boundary and no raw error storage;
- status callback idempotency and out-of-order limitation;
- no dashboard, alert, retention job, deployment, or real provider test;
- migration/test `NOT APPLIED` until Codex validates them.

Use Meta's official WhatsApp Business Platform Postman documentation:

- Message Status Update Notifications:
  https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications
- Statuses Object:
  https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object
- Webhook Payload Reference:
  https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not apply the migration or SQL fixture. Mark both database checks
`NOT RUN`; Codex alone reviews and runs them on disposable `vetai-test`.

Do not commit, push, deploy, call a real Meta/LLM/Supabase endpoint, create a
resource, install a plugin, or mutate an external service.

## Review gate

After Sonnet delivers, Codex reviews the full signed-webhook/status/RPC path,
tenant/account/recipient matching, rank and timestamp rules, RLS/grants,
erasure behavior, additive provider parsing, logging, tests, and docs. Codex
applies the migration and rollback fixture only to disposable `vetai-test`,
makes minimal fixes, reruns all checks, updates `PROJECT_CONTEXT.md`, and
commits the verified result.

This is a bounded extension of the already-reviewed webhook and outbound
tables. A third-agent review is not automatic; Codex requests Opus only if a
new critical architecture, RLS, PII, or external-side-effect ambiguity remains.

## Observed context — Sonnet fills before coding

Pending.

## Delivery record — Sonnet fills after coding

Pending.
