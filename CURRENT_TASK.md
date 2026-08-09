# Current task — 018 send pending WhatsApp replies from the outbox

Status: `READY`

Primary implementer: Claude Sonnet

Reviewer: Codex, then Claude Opus for one read-only architecture/RLS/external-side-effect review

## Goal

Deliver the deterministic reply already persisted in
`public.outbound_message_outbox` through the exact inbound WhatsApp account,
then atomically record Meta acceptance and one outbound conversation-history
row.

The bounded runtime path becomes:

`Cloudflare Cron -> database claim -> Meta text send -> database accept or retry`

This task enables the first real outbound WhatsApp call in code, but the
implementer must use mocked HTTP only. Codex will validate the migration on the
disposable `vetai-test` database. Nobody deploys or calls real Meta during this
task.

Meta's messages endpoint does not provide this project a caller-supplied
idempotency key. Database claim and completion are idempotent, but an accepted
Meta response can be lost before it is persisted. The safe and honest MVP
policy is therefore **at-least-once external delivery**: ordinary concurrent
sends are prevented, retries are bounded, and a rare duplicate WhatsApp reply
remains possible after an ambiguous network/worker failure. Never claim
exactly-once WhatsApp delivery.

Meta HTTP success means only that Meta accepted the message request. It is not
proof that the phone received or read it. Delivery/read/failed status webhooks
remain a later task.

This task does not change reply copy, intake/safety/pet behavior, add templates
or media, process outbound status webhooks, notify staff, implement triage or
appointments, create Cloudflare resources, deploy, or configure real secrets.

## Starting context

- Starting HEAD: `0d4624b` on `main`; worktree is clean.
- Task 017 is committed and passed Codex plus Opus review. One backend-only
  outbox row is atomically persisted per tenant-scoped inbound event.
- Each row already contains the exact `whatsapp_account_id`, tenant-safe
  conversation/source links, recipient E.164 number, fixed reply category, and
  fixed reply content.
- `whatsapp_accounts.phone_number_id` is the Meta sender identifier. A clinic
  may have multiple accounts; the sender must join through the exact outbox
  account and must never choose an account from `clinic_id` alone.
- `messages` has tenant/conversation fields, direction, content, optional
  `whatsapp_message_id`, and a clinic-scoped partial unique index on non-null
  provider IDs.
- The Worker currently has `fetch` and intake-Queue handlers, but no scheduled
  handler, Meta access-token binding, outbox client, or sender.
- Wrangler has no Cron trigger. The only runtime dependency remains the
  platform and native `fetch`.
- Cloudflare Cron invokes a Worker's `scheduled()` handler and Cron expressions
  run in UTC. A one-minute trigger is sufficient because no clinic-local clock
  calculation is involved.
- Cloudflare and provider delivery are at-least-once boundaries; deduplication
  must live in durable state rather than process memory.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New migration
  `supabase/migrations/20260809000200_outbound_delivery.sql`.
- New rollback test `supabase/tests/018_outbound_delivery.sql`.
- New `src/outboundDelivery.ts` and `test/outboundDelivery.test.ts`.
- New `src/whatsappSend.ts` and `test/whatsappSend.test.ts`.
- New `src/outboundSender.ts` and `test/outboundSender.test.ts`.
- `src/index.ts` and `test/index.test.ts`, limited to the scheduled handler.
- `src/env.ts`, `.dev.vars.example`, and existing Env fixtures, limited to the
  two sender configuration fields below.
- `wrangler.toml`, limited to the Graph version variable and one Cron trigger.
- New `docs/outbound-delivery.md` plus narrowly relevant updates to
  `docs/database-schema.md`, `docs/intake-replies.md`, and README environment/
  local-scheduled-test instructions if necessary.
- Fill only the Observed context and Delivery record sections of this file.

Do not change dependencies or lockfiles, inbound webhook behavior, intake Queue
producer/consumer behavior or bindings, reply copy/precedence, extraction,
planning, safety, pet selection, existing migrations/SQL fixtures, `AGENTS.md`,
or `PROJECT_CONTEXT.md`.

## Database contract

### Delivery state

Extend `public.outbound_message_outbox` with exactly these fields:

- `delivery_status text not null default 'pending'`;
- `delivery_claim_token uuid`;
- `delivery_lease_until timestamptz`;
- `delivery_attempt_count integer not null default 0`;
- `next_attempt_at timestamptz` initialized for existing/new pending rows;
- `provider_message_id text`;
- `accepted_at timestamptz`;
- `failed_at timestamptz`;
- `failure_reason text`.

Use a table CHECK to allow only these coherent states:

- `pending`: no claim/lease/provider/terminal fields, `next_attempt_at` non-null,
  attempts `0..2`;
- `processing`: claim and lease non-null, `next_attempt_at` and terminal fields
  null, attempts `1..3`;
- `accepted`: provider ID and `accepted_at` non-null, all claim/retry/failure
  fields null, attempts `1..3`;
- `failed`: `failed_at` non-null and `failure_reason = 'attempts_exhausted'`, all
  claim/retry/provider/acceptance fields null, attempts exactly `3`.

Provider message IDs have length `1..512`. Attempt count must never exceed
three. Do not store Meta response bodies, provider error text, access tokens,
request IDs, or exception text. Keep the existing tenant-safe FKs, erasure
cascades, RLS/no-policy boundary, grants, source uniqueness, and reply fields.

Replace the old `(created_at, id)` index with a claimant-oriented index that
supports status/due-time then `(created_at, id)` ordering. Do not add a generic
polling table or new Queue.

### Claim RPC

Create `public.claim_outbound_message()` as `SECURITY INVOKER`, `VOLATILE`,
empty `search_path`, fully qualified, service-role-only. It takes no input and
returns exactly:

```text
result, outbox_id, claim_token, phone_number_id,
recipient_e164, content, attempt_count
```

Closed results:

- `claimed`: atomically selects the oldest due `pending` row or expired
  `processing` row with fewer than three attempts, using
  `FOR UPDATE OF ... SKIP LOCKED`; sets status `processing`, a fresh
  `gen_random_uuid()` token, a fixed five-minute lease, clears
  `next_attempt_at`, increments attempt count, and returns the exact joined
  account `phone_number_id` plus recipient/content.
- `exhausted`: selects at most one expired `processing` row already at attempt
  three, marks it `failed/attempts_exhausted`, clears claim/lease, and returns
  all data columns null. This prevents a worker crash on the last attempt from
  leaving a poison row forever.
- `empty`: no eligible row exists; all data columns are null.

An outbox row whose exact account no longer exists cannot survive because of
Task 017's cascade. Still join on both account ID and clinic ID. Never accept a
tenant/account/recipient as caller input. Return no clinic, conversation, reply
category, or source-event field because the sender does not need them.

Process at most one row per RPC call. Ordinary concurrent Cron invocations may
run; the database lock/token is the authority.

### Retry RPC

Create
`public.release_outbound_message(p_outbox_id uuid, p_claim_token uuid)` with a
one-column closed result:

- `retry_scheduled`: only for the current processing token with attempts below
  three; return to `pending`, clear claim/lease, and set a fixed two-minute
  `next_attempt_at`;
- `failed`: only for the current token at attempt three; mark terminal
  `failed/attempts_exhausted`, clear claim/lease/retry time;
- `stale`: missing row, non-processing row, or wrong token; mutate nothing.

Lock before deciding. Validate non-null UUID inputs before mutation.

### Acceptance RPC

Create
`public.accept_outbound_message(p_outbox_id uuid, p_claim_token uuid,
p_provider_message_id text)` with a one-column closed result:

- `accepted`: only for the current processing token; in the same transaction,
  insert one `messages` row using the outbox's tenant/conversation/content,
  direction `outbound`, and exact provider ID, then mark the outbox accepted,
  clear claim/lease, and persist the provider ID and acceptance time;
- `already_accepted`: the row is already accepted with the exact same provider
  ID; create no duplicate history row;
- `stale`: missing/non-processing/wrong-token/non-accepted state; mutate
  nothing.

If an already-accepted row has a different provider ID, raise rather than hide
corruption. Validate provider ID length before mutation. Use a plain history
insert so an unexpected unique collision raises and rolls the whole RPC back.
Do not call this state or history row `delivered`; it records Meta acceptance.

All three RPCs remain unavailable to `PUBLIC`, `anon`, and `authenticated`, and
executable only by `service_role`. Add no `BEGIN`/`COMMIT`, exception-swallowing
block, dynamic SQL, RLS policy, general table RPC, or arbitrary SQL path.

## Worker contract

### Configuration

Add required Env strings:

- `WHATSAPP_ACCESS_TOKEN` — secret; placeholder only in `.dev.vars.example`;
- `WHATSAPP_GRAPH_API_VERSION` — non-secret; set Wrangler `[vars]` to `v25.0`.

Update all existing Env fixtures with inert test values. Never log either
value. Do not put the access token in `wrangler.toml`, source, docs, URL query,
or test snapshots.

### Data API client

`src/outboundDelivery.ts` exposes typed claim/release/accept helpers using
native `fetch` and the existing Supabase transport policy:

- require non-blank Supabase configuration;
- allow HTTPS and loopback HTTP only;
- use service-role headers;
- validate every untrusted response as an exact one-row Data API shape and
  closed result;
- for `claimed`, require UUIDs, numeric `phone_number_id` length `1..64`, exact
  E.164 recipient, content length `1..4096` by Unicode code points, and attempt
  `1..3`;
- require all non-applicable return fields to be null;
- catch network/HTTP/JSON/prototype/getter/shape failures and return generic
  `failed` without logging bodies, identifiers, content, recipient, or secrets.

Do not refactor the existing private Data API helpers solely to share code.

### Meta adapter

`src/whatsappSend.ts` exposes a native-fetch text sender. Before any request,
validate the non-blank token, exact Graph version pattern `v<integer>.0`,
numeric phone-number ID, E.164 recipient, and content length. POST only to:

```text
https://graph.facebook.com/{version}/{phone-number-id}/messages
```

Use `Authorization: Bearer ...`, JSON content type, and exactly this request
body:

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+905...",
  "type": "text",
  "text": { "preview_url": false, "body": "fixed reply" }
}
```

Accept only an HTTP-success JSON object containing exactly one
`messages[0].id` string of length `1..512`; unrelated top-level Meta fields may
exist. Return only `accepted` with that ID or generic `failed`. Never return or
log response/error bodies. Do not add an SDK, dependency, template, media,
typing indicator, read receipt, or real call.

### Bounded sender and Cron wiring

`src/outboundSender.ts` exports one scheduled-drain function and contains fixed
constants: maximum 10 claimed/cleaned rows per run, three database attempts,
five-minute lease (database-owned), and two-minute retry (database-owned).

Before the first claim, validate Meta token/version configuration. If invalid,
stop with zero database or Meta calls so a deployment mistake cannot consume
attempts.

For at most ten iterations:

1. claim one row;
2. stop on `empty` or client `failed`, continue on `exhausted`;
3. send a claimed row once through the Meta adapter;
4. on Meta `accepted`, call acceptance once; continue only after
   `accepted`/`already_accepted`; stop on acceptance transport `failed`; a
   `stale` result is safe to skip;
5. on Meta `failed`, call release once; continue on
   `retry_scheduled`/`failed`/`stale`, stop on release transport `failed`.

If Meta accepted but its response was lost, or the Worker stopped before the
acceptance RPC committed, the lease later permits a resend and the user may
receive a duplicate. This ambiguity is unavoidable with the available API and
must be documented and tested as a retry—not hidden as exactly-once.

Add one `scheduled()` handler to the default Worker export. Use
`ctx.waitUntil(...)` so Cloudflare tracks the drain promise; contain unexpected
throws without exposing data. Do not change `fetch()` or `queue()` behavior.

Add exactly one UTC Cron expression to Wrangler:

```toml
[triggers]
crons = ["* * * * *"]
```

No resource is created until a later authorized deployment.

## Required tests

### TypeScript

Mock every fetch and Cloudflare context. Prove at least:

- exact claim/release/accept RPC request bodies and authorization headers;
- every closed result and strict null/shape/prototype/length/UUID/E.164/attempt
  acceptance/rejection class;
- missing/invalid configuration makes no request and fails closed;
- Meta URL, bearer header, and exact text body for all six reply categories'
  possible fixed content (the adapter itself remains category-neutral);
- Meta network/non-2xx/bad JSON/missing-or-multiple-message/bad-ID responses fail
  closed and never expose/log bodies;
- config failure causes zero claims; empty stops; exhausted continues;
- success performs claim -> Meta -> accept in order;
- Meta failure performs claim -> release and no accept;
- acceptance/release transport failure stops the drain;
- a maximum of ten rows is processed even if more remain;
- ambiguous Meta/acceptance failures are not falsely marked successful;
- the scheduled handler registers the drain with `waitUntil` while existing
  fetch and intake Queue tests remain unchanged;
- no sensitive identifier, phone, reply content, provider body, token, or
  service-role key is logged.

Do not add dependency injection frameworks or real timers solely for tests.

### Rollback SQL test

`supabase/tests/018_outbound_delivery.sql` runs inside `BEGIN`/`ROLLBACK` and
proves at least:

- Task 017-style pending rows backfill into a coherent due state;
- oldest-due claim returns exact account/recipient/content, increments attempt,
  and sets a current token/lease;
- a second sequential claim cannot claim a live lease; expired lease reclaim
  gets a different token and increments the attempt;
- wrong/stale tokens cannot release or accept;
- release schedules a two-minute retry below attempt three and marks terminal
  failure at attempt three;
- an expired third-attempt processing row becomes `exhausted/failed` instead of
  remaining poison work;
- acceptance atomically inserts one exact outbound `messages` row and marks the
  outbox accepted; exact replay returns `already_accepted` without duplication;
- different-provider replay and history-provider collision raise with no
  partial outbox/history mutation;
- same-looking provider IDs across two clinics remain tenant-isolated;
- state CHECK violations fail; anon/authenticated have zero table privileges,
  no RLS policies, and cannot execute the RPCs; real service_role can execute a
  successful claim/accept path;
- parent erasure cascades remain intact and all fixtures roll back to zero.

The single-session fixture cannot prove true lock contention, Worker crash, or
Meta behavior. Document those limits instead of claiming them.

## Documentation and official references

Document:

- the four-state outbox lifecycle and fixed bounds;
- exact-account routing and backend-only PII boundary;
- Meta `accepted` versus delivered/read status;
- the rare at-least-once duplicate window and why no exactly-once claim is made;
- Cron UTC cadence and per-run cap;
- secret/config requirements and local mocked-only status;
- failed rows require an operational owner; no staff panel/alert exists yet;
- migration/test `NOT APPLIED` until Codex validates them;
- no resource creation, real Meta call, status-webhook handling, or deployment.

Use these primary references:

- Meta's official WhatsApp Cloud API collection and messages request:
  https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api
- Cloudflare Cron Triggers:
  https://developers.cloudflare.com/workers/configuration/cron-triggers/
- Cloudflare scheduled handler:
  https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Cloudflare at-least-once delivery guidance:
  https://developers.cloudflare.com/queues/reference/delivery-guarantees/
- PostgreSQL row locking:
  https://www.postgresql.org/docs/current/explicit-locking.html

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not apply the migration or SQL fixture to any database. Mark both
database checks `NOT RUN`; Codex alone will inspect and run them against
disposable `vetai-test` after delivery.

Do not commit, push, deploy, call a real Meta/LLM/Supabase endpoint, create a
Cron/Queue/DLQ/resource, install a plugin, or mutate any external service.

## Review gate

After Sonnet delivers, Codex reviews the full claim/send/accept/retry call path,
tenant/account routing, locking/token logic, attempt bounds, RLS/grants,
erasure behavior, request/response validation, secret handling, tests, and
docs. Codex applies the migration and rollback fixture only to disposable
`vetai-test`, makes targeted fixes, and reruns all checks.

This is a critical external side-effect plus tenant/PII boundary, so Claude
Opus performs one final read-only architecture/RLS review. Routine tasks after
this do not automatically require three-agent review.

## Observed context — Sonnet fills before coding

Pending.

## Delivery record — Sonnet fills after coding

Pending.
