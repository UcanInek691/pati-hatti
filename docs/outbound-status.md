# Outbound WhatsApp status callbacks (Task 019)

Last verified: 2026-08-09.

## What this step does

Persists Meta's signed outbound-message status callbacks (`sent`,
`delivered`, `read`, `failed`) against the exact tenant, WhatsApp account,
accepted outbox row, and recipient that Task 018's send pipeline already
recorded. It does not send messages, change intake/reply/safety behavior,
store raw provider errors, notify staff, build a monitoring UI, prune PII,
implement appointments, deploy, or create resources.

Runtime path: `signed Meta webhook -> strict status extraction ->
tenant-safe status RPC -> acknowledged callback`, added to the existing
signed POST route in `src/index.ts` alongside inbound text ingestion.

## Accepted is not sent, delivered, or read

`outbound_message_outbox.delivery_status = 'accepted'` (Task 018) only means
Meta's send API accepted the request. `provider_delivery_status` and
`provider_status_at` — the two nullable columns this task adds to that same
table — record the *later*, separate confirmation that Meta actually queued
(`sent`), handed off to the recipient's device (`delivered`), or the
recipient opened (`read`) the message, or that Meta could not do so
(`failed`). A row can be `accepted` with a null status summary indefinitely
if Meta never calls back, or if the callback is still in flight.

## Exact-account and recipient routing

`public.record_whatsapp_outbound_status(...)` never selects an outbox row
from a caller-supplied clinic or outbox UUID, and never resolves an account
from `clinic_id` alone. It joins the accepted outbox row to its own
tenant-scoped `whatsapp_account_id` (the same composite, tenant-safe key set
by Task 017/018) and then matches all three provider-supplied facts —
`phone_number_id`, `provider_message_id`, `recipient_e164` — before locking
and mutating anything. A callback naming a real provider ID that belongs to
a different clinic's account, or the right ID with the wrong recipient,
returns `not_found` with zero mutation; it can never update another
tenant's row, even when two clinics happen to have been issued a
same-looking provider message ID.

## Non-regressing rank and timestamp rules

Meta's own documentation warns that notification arrival order does not
have to match event order, so a later HTTP callback can describe an earlier
provider event. The RPC uses a fixed precedence, `sent = 1, failed = 2,
delivered = 3, read = 4`, so the stored summary always reflects the most
advanced known state regardless of network arrival order:

- a higher rank always replaces a lower rank, even if its `timestamp` is
  older than what's currently stored (`recorded`);
- a lower rank never replaces a higher rank, even if its `timestamp` is
  newer (`stale`);
- the same rank with a newer timestamp updates the stored time (`recorded`);
- the same rank with the identical timestamp changes nothing (`duplicate`);
- the same rank with an older timestamp changes nothing (`stale`).

This means `delivered` or `read` can supersede an earlier `failed` (Meta
sometimes reports a transient failure before a later success), but `failed`
can never regress an already-recorded `delivered` or `read`. This is a
bounded operational summary — one current status and one timestamp per
outbox row — not a full event ledger of every callback ever received.

## Additive-field tolerance

Meta's status objects and their parent `entry`/`changes`/`value` levels
carry other fields this task does not use (`conversation`, `pricing`,
`errors`, `gs_id`, etc.). `src/whatsappStatus.ts` tolerates unrelated
enumerable JSON fields at every provider-owned level so a future additive
Meta field does not break extraction, while still rejecting hidden
(non-enumerable), symbol-keyed, or non-plain-prototype status objects, which
have no legitimate reason to appear in a real webhook body and are treated
as malformed. A status name outside the four supported values is ignored,
not rejected, so a future Meta status addition does not make an otherwise
valid webhook retry forever.

## PII boundary and no raw error storage

The two new columns store only a status word and a timestamp. No raw
webhook payload, provider error text, pricing, or conversation-billing
metadata is ever persisted — `src/whatsappStatus.ts` never returns those
fields, and the migration adds no column for them. The recipient phone
number and message content already exist on the protected, `service_role`-
only outbox row from Task 017/018; this task does not duplicate them.

## Idempotency and the out-of-order limitation

An exact replay of the same status and timestamp is a no-op (`duplicate`),
so redelivering the same webhook is always safe. The rank/timestamp rule
above makes result correctness independent of arrival order for a single
outbox row within one RPC call. What this task cannot prove is true
concurrent lock contention across two simultaneous callback deliveries for
the same row, or genuine out-of-order delivery from Meta's real
infrastructure — `supabase/tests/019_outbound_status_tracking.sql` runs
inside one PostgreSQL session and documents this limitation rather than
claiming to have tested it.

## Not built here

No dashboard, alert, retention/pruning job, deployment, or real-provider
test is part of this task. A `provider_delivery_status = 'failed'` row is
durably recorded as a `provider_failed` staff work item by Task 020's
`public.staff_work_items` (see
[`docs/staff-work-items.md`](staff-work-items.md)), which a later
`delivered` or `read` callback resolves automatically. That is durable
visibility for clinic staff, not a dashboard, alert, or notification.

## Disposable validation passed

Codex applied
`supabase/migrations/20260809000300_outbound_status_tracking.sql` and ran
`supabase/tests/019_outbound_status_tracking.sql` against disposable
`vetai-test` on 2026-08-09. The rollback fixture returned `PASS` with zero
fixture residue. Catalog checks confirmed both columns, the named CHECK,
RLS enabled with zero policies, the lookup index, and service-role-only RPC
execution. Production still requires the managed migration workflow.

## References

- [Meta — Message Status Update Notifications](https://www.postman.com/meta/whatsapp-business-platform/request/rgtfq23/message-status-update-notifications)
- [Meta — Statuses Object](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object)
- [Meta — Webhook Payload Reference](https://www.postman.com/meta/whatsapp-business-platform/folder/vzaxn16/webhook-payload-reference)
