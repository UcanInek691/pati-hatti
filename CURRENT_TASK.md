# Current task — 019 persist outbound WhatsApp status callbacks

Status: `COMPLETE`

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

- Implementation starting HEAD: `0f75a41` on `main`; worktree was clean.
  `26f1b25` is the Task 018 product-code baseline immediately before the
  separate Task 019 contract commit.
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

- Starting HEAD confirmed at `0f75a41` on `main`, worktree clean. The original
  `26f1b25` value was the Task 018 product-code baseline before Codex's
  separate Task 019 contract commit.
- `supabase/migrations/20260809000200_outbound_delivery.sql` (Task 018, read
  in full) confirms: `outbound_message_outbox` has `delivery_status text not
  null default 'pending'` (`pending|processing|accepted|failed`),
  `provider_message_id text` (1-512 chars), `accepted_at timestamptz`, and a
  named CHECK (`outbound_message_outbox_delivery_state_check`) that only
  allows `provider_message_id`/`accepted_at` to be non-null when
  `delivery_status = 'accepted'`. This makes it structurally impossible for a
  non-accepted row to ever carry a provider message ID, which the new RPC's
  `not_found` path and the SQL fixture's non-accepted-row case both rely on.
- `whatsapp_accounts (id, clinic_id)` is unique (Task 017), so the new RPC can
  join an accepted outbox row to its own tenant-scoped account without ever
  trusting a caller-supplied clinic or outbox UUID.
- `claim_outbound_message()`, `release_outbound_message()`, and
  `accept_outbound_message()` are all `SECURITY INVOKER`, `VOLATILE`, empty
  `search_path`, revoked from `PUBLIC`/`anon`/`authenticated`, granted to
  `service_role` only — the new RPC follows the identical privilege shape.
- `src/whatsappSend.ts` wraps its entire untrusted-response validation block
  in `try { ... } catch { return FAILED; }` specifically to fail closed
  against a throwing property getter on provider data; `src/whatsappStatus.ts`
  mirrors this around its whole extraction loop.
- `src/whatsappIngest.ts`'s `extractTextMessages` skips a non-object item in
  its message array rather than rejecting the whole webhook; confirmed via a
  failing test that `src/whatsappStatus.ts` must follow the same precedent
  for a non-object `statuses[]` item (only a supported-but-malformed status
  item rejects the whole webhook).
- `src/intakeJobLease.ts` / `src/outboundDelivery.ts` establish the Data API
  transport pattern this task's `src/supabaseOutboundStatus.ts` duplicates
  per the contract: HTTPS-or-loopback-only fail-closed config validation,
  exact one-row response-shape validation, no shared/refactored private
  helpers, no `AbortSignal.timeout` (none of the internal Supabase helpers use
  a fetch timeout; only the external Meta call in `whatsappSend.ts` does, for
  a lease-overrun reason not applicable here).
- `supabase/tests/018_outbound_delivery.sql` (read in full) is the direct
  structural template for `019_outbound_status_tracking.sql`: `begin`/
  `rollback` wrapper, `pg_temp` fixture helpers, numbered `do $$ ... $$;`
  blocks with `raise exception` assertions, `set local role
  service_role/anon/authenticated` blocks for real-role privilege proof, and
  a final zero-residue `select 'PASS' ...` query after `rollback;`.

## Delivery record — Sonnet fills after coding

### Changed/new files

- `supabase/migrations/20260809000300_outbound_status_tracking.sql` (new) —
  adds `provider_delivery_status text` and `provider_status_at timestamptz`
  (both nullable) to `outbound_message_outbox`, a named CHECK enforcing
  "both null, or `delivery_status = 'accepted'` and a closed status value and
  a non-null timestamp," a partial index, and
  `public.record_whatsapp_outbound_status(p_phone_number_id,
  p_provider_message_id, p_recipient_e164, p_provider_status,
  p_provider_timestamp)` implementing the rank/timestamp state machine.
  `SECURITY INVOKER`, `VOLATILE`, empty `search_path`, `service_role`-only.
  **NOT APPLIED to any database.**
- `supabase/tests/019_outbound_status_tracking.sql` (new) — rollback-only
  fixture covering every case in "Required rollback SQL test" below.
  **NOT RUN against any database.**
- `src/whatsappStatus.ts` (new) — `extractOutboundStatuses`, the pure status
  extractor.
- `test/whatsappStatus.test.ts` (new) — 36 tests.
- `src/supabaseOutboundStatus.ts` (new) — `recordWhatsAppOutboundStatus`, the
  native-fetch RPC client.
- `test/supabaseOutboundStatus.test.ts` (new) — 22 tests.
- `src/index.ts` (edited) — the signed POST handler now extracts statuses and
  inbound text before any mutation, rejects the whole request with 400 if
  either extraction fails, persists each status item via
  `recordWhatsAppOutboundStatus` (client `failed` -> 503, everything else
  acknowledged), logs only aggregate counts, then runs the unchanged inbound
  text/Queue path. A status-only callback never enqueues intake work.
- `test/index.test.ts` (edited) — 6 new tests: malformed mixed callback (400,
  zero fetch/queue calls); valid status-only callback (persists via RPC,
  never touches inbound/Queue, 200); `not_found`/`duplicate`/`stale` -> 200;
  client `failed` -> 503 with zero queue calls; valid mixed callback (persists
  status AND retains inbound/Queue behavior); mixed callback where the status
  RPC fails but inbound text still processes and enqueues -> 503.
- `docs/outbound-status.md` (new) — accepted-vs-status distinction, exact
  routing, rank/timestamp rules, additive-field tolerance, PII boundary,
  idempotency/out-of-order limitation, "not built here" list, migration/test
  marked NOT APPLIED, three Meta Postman references.
- `docs/database-schema.md` (edited) — one sentence on the
  `outbound_message_outbox` bullet forward-referencing the new columns/RPC,
  plus a new "Outbound WhatsApp status callbacks" section marked NOT YET
  APPLIED.
- `docs/outbound-delivery.md` (edited) — the "Sending" section's outdated
  "this task does not process outbound status webhooks" sentence now points
  to `docs/outbound-status.md`.
- `CURRENT_TASK.md` (edited) — this section only.

### Verification results

- `pnpm install --frozen-lockfile` — ran clean earlier in this delivery (no
  dependency changes made).
- `pnpm typecheck` — **PASS**, zero errors.
- `pnpm test` — **PASS**, 630/630 tests across 21 files (36 new in
  `whatsappStatus.test.ts`, 22 new in `supabaseOutboundStatus.test.ts`, 6 new
  in `index.test.ts`; all pre-existing tests remain green). Every fetch is
  mocked; no real Meta/Supabase call was made.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — **PASS**,
  builds and reports bindings only (`INTAKE_QUEUE`, `APP_TIMEZONE`,
  `WHATSAPP_GRAPH_API_VERSION`); no deploy performed.
- `git diff --check` — **PASS** (exit 0); only pre-existing LF/CRLF
  line-ending advisories on Windows, no whitespace errors introduced.
- Migration apply — **NOT RUN** (forbidden to Sonnet by contract and by the
  user's explicit instruction; Codex applies it to disposable `vetai-test`
  only).
- `supabase/tests/019_outbound_status_tracking.sql` — **NOT RUN** against any
  database, for the same reason.

### Known limitations

- The SQL fixture runs inside one PostgreSQL session/transaction and
  therefore cannot prove true concurrent lock contention across two
  connections or genuine out-of-order delivery from Meta's real
  infrastructure; both `supabase/tests/019_outbound_status_tracking.sql`'s
  header comment and `docs/outbound-status.md` document this rather than
  claim to have tested it.
- The "non-accepted row -> not_found" fixture case necessarily uses a still-
  `pending` row rather than a fabricated inconsistent one, because Task 018's
  own CHECK constraint makes a non-null `provider_message_id` on a
  non-`accepted` row impossible to construct in the first place; this is
  noted inline in the fixture.

### Risks for Codex to review

1. **SQL fixture is unverified against a real server.** It was designed
   directly from a full read of `20260809000200_outbound_delivery.sql`'s
   exact column/CHECK/RPC shapes and modeled closely on
   `018_outbound_delivery.sql`, but has never been executed. Please run it
   against disposable `vetai-test` first and check especially: the
   `pg_temp.make_pending_outbox_row` / `make_accepted_outbox_row` helper
   signatures against `ingest_whatsapp_text_message`,
   `claim_intake_queue_job`, and `finalize_intake_queue_job`'s real current
   signatures; and that `insufficient_privilege` is in fact the exception
   Postgres raises for a revoked-EXECUTE RPC call under `anon`/`authenticated`
   (matching 018's own fixture 9 assumption).
2. **Rank precedence is a hardcoded literal in the migration**, not derived
   from a table — please confirm the `sent=1, failed=2, delivered=3, read=4`
   mapping in the `CASE`/rank logic exactly matches the contract's stated
   order (`sent < failed < delivered < read`) with no off-by-one.
3. **The CHECK constraint's exact null-coherence wording** ("both null, OR
   `delivery_status='accepted'` AND status in the closed set AND timestamp
   non-null") should be re-checked against the literal migration SQL for any
   gap that would let a `pending`/`processing`/`failed` row carry a non-null
   status summary, which would break the Task 018 backfill invariant.
4. **`src/index.ts`'s status-then-text ordering inside the signed POST
   route** — please confirm persisting all status items before running the
   existing inbound-text/Queue loop, and returning 503 whenever either
   `statusFailed > 0` or the existing `failed > 0`, matches the intended
   "acknowledge everything except a client RPC failure" contract, especially
   for a mixed callback where text processing succeeds but the status RPC
   fails (current behavior: 503 despite the text message being enqueued —
   verified by test, but worth an explicit sign-off since it means Meta will
   retry a callback whose text side already fully succeeded).
5. **No new dependency, Env binding, or Wrangler config was touched** — please
   confirm the wrangler dry-run output above (bindings unchanged) matches
   your own expectation before applying anything.

## Codex review record — 2026-08-09

Decision: `PASS`. No Claude Opus review was required because the bounded
extension left no unresolved critical architecture, RLS, PII, or external-
side-effect ambiguity.

Targeted fixes made during review:

- Closed a PostgreSQL three-valued-logic gap in the named CHECK by requiring
  `provider_delivery_status is not null` in the populated branch. Without
  it, an accepted row with null status and non-null timestamp evaluated to
  unknown and passed a CHECK. Added the inverse null-coherence regression.
- Replaced six non-hex payload-hash fixture characters before the real
  database run.
- Deleted the deliberately pending non-accepted probe after its assertions so
  it cannot be claimed ahead of later accepted-row fixtures.
- Corrected the implementation-start record: `0f75a41` is the Task 019
  contract HEAD; `26f1b25` is the preceding product-code baseline.

Local verification after fixes:

- `pnpm install --frozen-lockfile` — pass, already up to date.
- `pnpm typecheck` — pass, no errors.
- `pnpm test` — pass, 630/630 across 21 files.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — pass;
  67.02 KiB / gzip 15.07 KiB, bindings unchanged, no deployment.
- `git diff --check` — pass; only existing LF/CRLF notices.

Disposable database validation (`vetai-test` only):

- Applied `20260809000300_outbound_status_tracking.sql`: success, no rows
  returned.
- Ran `019_outbound_status_tracking.sql`: `PASS`; remaining test clinics,
  accounts, outbox rows, messages, conversations, and owners were all zero.
- Read-only catalog verification returned: two status columns, one named
  status CHECK, RLS enabled, zero policies, RPC and lookup index present,
  `service_role` execution true, `anon`/`authenticated` execution false, and
  zero outbox rows.

Not run: real Meta callbacks, production migration workflow, deployment,
resource creation, push, or true two-session lock contention.
