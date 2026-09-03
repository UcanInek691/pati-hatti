# Outbound WhatsApp delivery (Task 018)

Last verified: 2026-08-09.

## What this step does

Delivers the reply already persisted into `outbound_message_outbox` by Task
017 (`finalize_intake_queue_job`, see `docs/database-schema.md`'s "Atomic
intake finalization" section) through the exact WhatsApp Business account the
inbound message arrived on, then atomically records Meta's acceptance and one
outbound `messages` row. It does not decide what to send, change reply copy,
add templates or media, process outbound status webhooks, notify staff, or
implement triage/appointments.

Runtime path: `Cloudflare Cron -> claim (database) -> send (Meta) -> accept or
retry (database)`, run every minute by `src/index.ts`'s `scheduled()` handler
via `drainOutboundMessages` (`src/outboundSender.ts`), which `ctx.waitUntil`s
so the trigger returns immediately.

## Four-state outbox lifecycle

`supabase/migrations/20260809000200_outbound_delivery.sql` adds
`delivery_status` (`pending | processing | accepted | failed`) plus lease,
attempt, and outcome columns to `outbound_message_outbox`, enforced by a
single table `CHECK` so each status only ever coexists with the exact set of
non-null fields it implies (see that migration for the precise per-status
shape). Fixed bounds, all database-owned:

- **Lease**: 5 minutes per claim (`delivery_lease_until`).
- **Attempts**: at most 3 (`delivery_attempt_count`), after which a row is
  terminally `failed` with `failure_reason = 'attempts_exhausted'`.
- **Retry delay**: 2 minutes after a failed send (`next_attempt_at`).
- **Per-run cap**: at most 10 rows claimed per Cron invocation
  (`MAX_OUTBOUND_ROWS_PER_RUN` in `src/outboundSender.ts`).

Transitions: `pending -> processing` (claim) `-> accepted` (Meta accepted and
recorded) or `-> pending` (retry, attempt < 3) or `-> failed` (attempts
exhausted). `claim_outbound_message()` also self-heals a `processing` row
whose lease expired at attempt 3 — the worker that held it crashed or was
killed mid-send — moving it straight to `failed` instead of leaving it as
unreachable poison work.

## RPCs

`SECURITY INVOKER`, `VOLATILE`, empty-`search_path` functions, granted
to `service_role` only (revoked from `PUBLIC`, `anon`, `authenticated`),
wrapped by `src/outboundDelivery.ts`:

- `claim_outbound_message()` — no arguments; locks the oldest due row
  (`FOR UPDATE OF ... SKIP LOCKED`, so concurrent Cron runs never block on
  each other) and returns `claimed` (with account/recipient/content and the
  new claim token), `exhausted` (a poison row was just terminated — the
  caller should keep looping), or `empty`. Preserved byte-for-byte as a
  rollback target only; the Worker no longer calls it (Task 040).
- `claim_outbound_message_v2()` — same body and result contract as
  `claim_outbound_message()`, plus the claimed row's own
  `whatsapp_account_id`, which the Worker uses to resolve that exact
  account's Meta credential (see "Exact-account routing and PII boundary"
  below). This is the RPC the Worker actually calls (Task 040).
- `release_outbound_message(p_outbox_id, p_claim_token)` — called after a
  failed Meta send; returns `retry_scheduled`, terminal `failed`, or `stale`
  (token no longer matches the current lease holder).
- `accept_outbound_message(p_outbox_id, p_claim_token, p_provider_message_id)`
  — called after a successful Meta send; atomically inserts one outbound
  `messages` row and marks the outbox `accepted`. Returns `accepted`,
  `already_accepted` (exact provider-ID replay, no duplicate insert), or
  `stale`. A replay reporting a *different* provider ID than what's already
  recorded raises instead of silently overwriting history.

`src/outboundDelivery.ts` validates every RPC response as an exact one-row
shape with a closed result before trusting any field, following the same
transport rules (HTTPS or loopback-HTTP only, non-blank Supabase config
required, no logging, 10-second request timeout) as `src/intakeJobLease.ts`.
Its private Data API helpers are intentionally duplicated rather than shared,
per the task contract.

## Exact-account routing and PII boundary

`claim_outbound_message_v2()` joins `outbound_message_outbox` to
`whatsapp_accounts` on the same composite tenant-safe key set at insert time
(Task 017), so a reply always sends from the exact clinic account the
inbound message arrived on — never a caller-supplied account. The recipient
phone number and message content never leave the backend: they exist only in
the outbox row, the Meta API request, and the resulting `messages` row, all
of which are `service_role`-only with no client-facing RLS policy.

The Worker uses that claimed `whatsapp_account_id` to look up the one
matching entry in `WHATSAPP_ACCOUNT_CREDENTIALS_JSON` (Task 040) — the
registry is never trusted to name its own account, only the claimed row is.
A claimed row whose account has no matching registry entry is released
without ever calling Meta.

## Sending

`src/whatsappSend.ts` takes the resolved access token as a parameter — it
never reads a token from `Env` itself (Task 040) — and validates that
token, Graph API version (`v<integer>.0`), numeric phone-number ID, E.164
recipient, and content length locally, then sends exactly one text message
via native `fetch` with a 30-second request timeout:

```
POST https://graph.facebook.com/{WHATSAPP_GRAPH_API_VERSION}/{phone_number_id}/messages
Authorization: Bearer {resolved per-account access token}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+905...",
  "type": "text",
  "text": { "preview_url": false, "body": "..." }
}
```

An HTTP success with exactly one `messages[0].id` string (1-512 characters)
is the only `accepted` outcome. Additive enumerable fields in that message
object are tolerated for Meta response-schema evolution; hidden/symbol fields
and non-plain objects still fail closed. Everything else — timeout, network
failure, non-2xx, malformed body, missing or multiple message IDs — is a
generic `failed` with no response body logged or returned. **Meta HTTP success only means Meta
accepted the request for delivery, not that the message was delivered or
read** — see [`docs/outbound-status.md`](outbound-status.md) for how a later
Meta status callback records sent/delivered/read/failed against this same
row (Task 019).

## At-least-once delivery, not exactly-once

If the Worker crashes or the Cron invocation is killed after Meta accepts the
message but before `accept_outbound_message` records it, the row's lease
expires and a later claim resends it — a real WhatsApp message can reach the
owner twice in this narrow window. This is deliberate: closing it would
require a synchronous, blocking check against Meta before every send (or an
idempotency key Meta doesn't offer for this endpoint), which is out of scope
here. The delivery pipeline is explicitly **at-least-once**, matching
Cloudflare Queues' own at-least-once guidance (see references below); no code
in this task claims or relies on exactly-once delivery.

## Cron cadence and config

`wrangler.toml` adds one UTC Cron trigger, `* * * * *` (every minute), calling
`src/index.ts`'s `scheduled()` handler, which runs `drainOutboundMessages`
inside `ctx.waitUntil`. Each invocation claims and processes at most 10 rows
(`MAX_OUTBOUND_ROWS_PER_RUN`), so backlog beyond that drains over multiple
minutes rather than blocking on one over-long run.

Two `Env` fields: `WHATSAPP_ACCOUNT_CREDENTIALS_JSON` (secret; a JSON array
of up to 10 `{whatsapp_account_id, phone_number_id, access_token}` entries,
one per pilot clinic's WhatsApp Business account — placeholder only in
`.dev.vars.example`, real value never committed; see
[`src/whatsappCredentials.ts`](../src/whatsappCredentials.ts) for the exact
validation rules, Task 040) and `WHATSAPP_GRAPH_API_VERSION` (non-secret,
`[vars]` in `wrangler.toml`, set to `v25.0`). Before claiming anything,
`drainOutboundMessages` validates both are present and well-formed; on
invalid config it makes zero database or Meta calls. A row claimed for an
account with no matching registry entry is released and retried like any
other failed send, never reaching Meta. All Meta calls in tests are mocked —
no real Meta or Supabase call has been made by this task.

## Failed rows have no operational owner yet

A row that exhausts all 3 attempts becomes terminally `failed` with no retry
and no panel to view it — this task does not build one. Task 020's
`public.staff_work_items` (see [`docs/staff-work-items.md`](staff-work-items.md))
durably records a `send_attempts_exhausted` work item for it so clinic staff
can see it in their own tenant's data; that is visibility, not notification —
no email, push, or WhatsApp alert is sent, and no one is paged.

## Staff-originated rows (Task 048)

Not every `outbound_message_outbox` row is automation-produced. Task 048
(`supabase/migrations/20260903000100_staff_reply_composer.sql` — implemented
and locally verified; migration plus rollback fixture passed only on disposable
`vetai-test`, with zero fixture residue; not applied to staging/production; see
[`docs/database-schema.md`](database-schema.md#staff-authored-whatsapp-reply-composer-task-048)
and [`docs/staff-workflow.md`](staff-workflow.md#staff-reply-composer-task-048))
adds a `queue_staff_reply_v1` RPC that a signed-in clinic staff member can
call to queue one human-authored reply for their assigned human-handoff work
item, inside the WhatsApp 24-hour customer-service window computed from the
database clock and capped by the trusted webhook receipt time when the
provider/client timestamp is future-skewed. It inserts a row into this same `outbound_message_outbox`
table with `message_origin = 'staff'` (instead of `'automation'`) — from that
point on it is claimed, sent, and accepted through the exact same pipeline
described above, with no separate code path. Two narrow additions to that
existing pipeline, forward-only recreated in the same migration:

- `claim_outbound_message_v2()` now terminalizes to `failed` (with
  `failure_reason = 'staff_window_expired'`) any staff-origin row whose
  service window has since expired, instead of attempting a send Meta would
  reject anyway. That no-send expiry does not create a misleading
  `send_attempts_exhausted` staff work item; the automation
  claim/lease/exhaustion and real provider-failure paths are unchanged. A
  provider request already handed to Meta before the expiry transition cannot
  be recalled.
- `accept_outbound_message()` now copies the accepted row's origin and
  queuing staff member into the durable `messages` row, so accepted history
  can distinguish a staff reply from an automated one. VetAI's first-party
  `/staff` query deliberately omits the actor UUID; the existing tenant-scoped
  `messages` table grant is not a column-level secrecy boundary.

A staff-queued reply follows the same **at-least-once, not exactly-once**
guarantee described above, and the same Meta-acceptance-vs-delivered-vs-read
distinction in [`docs/outbound-status.md`](outbound-status.md) — queuing a
staff reply never itself claims delivery or read receipt.

## Disposable validation passed

`supabase/migrations/20260809000200_outbound_delivery.sql` and
`supabase/tests/018_outbound_delivery.sql` were validated against disposable
`vetai-test` on 2026-08-09. The migration applied successfully; the rollback
fixture returned `PASS` with zero surviving test clinics, accounts, outbox
rows, messages, conversations, or owners. Read-only catalog verification
confirmed nine delivery columns, RLS enabled with zero policies, all three
service-role-only RPCs, the claimant index, `SKIP LOCKED`, and zero outbox
rows. Production still requires the managed migration workflow.

The rollback-only SQL fixture runs inside a single session and therefore
cannot prove true concurrent lock contention across two connections, a
mid-send Worker crash, or real Meta behavior — it documents this limitation
rather than claiming to have tested it.

## Out of scope

No Cloudflare resource (Cron, Queue, DLQ) is created by this task — the Cron
trigger is declared in `wrangler.toml` only and takes effect on the next real
`wrangler deploy`, which this task does not run. No plugin is installed, no
dependency is added, no real Meta/LLM endpoint is called, and no staging or
production Supabase project is changed. The only Supabase mutation was the
authorized disposable `vetai-test` migration/rollback proof. No
existing migration, inbound webhook behavior, intake Queue behavior, reply
copy, or extraction/planning/safety/pet-selection logic changes.

## References

- [WhatsApp Cloud API — Postman collection docs](https://developers.facebook.com/docs/whatsapp/cloud-api/postman)
- [Cloudflare Workers — Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Cloudflare Workers — `scheduled()` handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- [Cloudflare Queues — guarantees (at-least-once delivery)](https://developers.cloudflare.com/queues/reference/delivery-guarantees/)
- [PostgreSQL — explicit row locking (`FOR UPDATE`, `SKIP LOCKED`)](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)
