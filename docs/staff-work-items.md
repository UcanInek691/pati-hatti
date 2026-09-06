# Durable staff work queue (Task 020)

Last verified: 2026-08-14.

## What this step does

Adds `public.staff_work_items`, a minimal, tenant-safe, durable record of
work that needs a human: conversations that entered `human_handoff`, and
outbound WhatsApp replies that reached a terminal delivery failure. Two
private, `SECURITY DEFINER` row triggers populate it from existing write
paths (`conversations` updates, `outbound_message_outbox` updates) so every
current or future caller of those paths — Worker code, an RPC, a manual
fix — produces the same durable record without any new Worker wiring or
dependency. This task adds no notification, no admin panel, no assignment,
no resolution workflow, and no appointment logic.

## Two work kinds, four closed reasons, one urgent rule

- `kind = 'human_handoff'`, `source_outbox_id` null, `reason` in
  `emergency_handoff | human_handoff`.
- `kind = 'delivery_failure'`, `source_outbox_id` set, `reason` in
  `send_attempts_exhausted | provider_failed`.
- `priority = 'urgent'` only for `reason = 'emergency_handoff'`; every other
  reason is `normal`. Urgency is a routing hint from a literal `true` safety
  signal, not a clinical judgment — the absence of a `true` value is never
  described as safe.

## Human-handoff trigger

`vetai_private.sync_human_handoff_work_item()` fires `after update on
public.conversations` when the resulting `NEW.intake_stage =
'human_handoff'`. It derives clinic and conversation only from `NEW`, and
inspects only JSON boolean values under
`NEW.intake_data.reported_safety_signals` — generically, by iterating
whatever keys are present with `jsonb_each`, never by naming a specific
signal — so a future new signal name is caught for free. Absent or
non-object safety data is tolerated and treated as no true signal, not as an
error. A single `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE` upserts
against the partial unique index on `(clinic_id, conversation_id)` for
non-resolved handoff items: a repeated handoff-stage update while an item is
`open`, `seen`, or `in_progress` leaves it unchanged (or upgrades it from
`normal` to `urgent` if a later message carries a true signal), and never
downgrades or duplicates.
Once staff resolve an item, the next handoff-stage update opens a new one.

The migration backfills one coherent item for every conversation already at
`intake_stage = 'human_handoff'`, using the identical priority/reason rule.

## Delivery-failure trigger

`vetai_private.sync_delivery_failure_work_item()` fires `after update on
public.outbound_message_outbox` only for the three transitions it cares
about: `delivery_status` newly `failed` (bounded send attempts exhausted),
`provider_delivery_status` newly `failed` (a previously accepted message now
has failure evidence from Meta), and a prior `provider_delivery_status =
'failed'` superseded by `delivered` or `read`. The first two each open one
`delivery_failure` item with the matching reason, deduplicated by the
partial unique index on `(clinic_id, source_outbox_id)` for current delivery
items. Task 032 widens that uniqueness domain from `open` to every
non-resolved status.
The third resolves the current non-resolved `provider_failed` item — it never
touches a `send_attempts_exhausted` item, because a send-attempt exhaustion
is a durable fact about what this system did, not something a later provider
callback can retroactively undo. Unrelated, `accepted`, `sent`, `delivered`,
or `read` transitions with no prior failure create nothing. The function
derives every identifier from `NEW` and copies no PII — no recipient phone
number, no message content, no failure-reason text.

The migration backfills one item per current `delivery_status = 'failed'`
row and one item per current `provider_delivery_status = 'failed'` row,
using the identical rules.

## Tenant isolation, RLS, and the no-PII-copy rule

`clinic_id` is a structural `references public.clinics (id) on delete
cascade`; `conversation_id` and `source_outbox_id` are composite
`(id, clinic_id)` foreign keys into `conversations` and
`outbound_message_outbox` respectively (the migration adds the supporting
`unique (id, clinic_id)` to `outbound_message_outbox`), so a row can never
reference another tenant's conversation or outbox row. RLS is enabled; the
only policy is an authenticated `SELECT` gated by the existing
`vetai_private.is_clinic_staff(clinic_id)` helper, so staff at clinic A can
never see clinic B's rows. `PUBLIC`, `anon`, and `authenticated` have no
table privilege beyond that one `SELECT` grant — `authenticated` cannot
insert, update, or delete. `service_role` has full access for future backend
use. The table itself carries no phone number and no message content; both
triggers are `SECURITY DEFINER` with `search_path = ''`, fully-qualified
references, no dynamic SQL, and revoked direct-execute from every role, so
they only ever run as the table owner in response to a real row update —
never as a caller-invoked function, and never weakening the existing
`conversations`/`outbound_message_outbox` policies.

## Erasure cascades

Every `staff_work_items` foreign key is `on delete cascade`. Deleting an owner
cascades through its conversation to any open or resolved staff work item;
an allowed WhatsApp-account deletion cascades through its outbox rows to any
delivery-failure item; deleting a clinic cascades everything. The pre-existing
webhook-event account FK remains `NO ACTION`, so it may intentionally block a
standalone account deletion while event history still carries that link. No
successful erasure path can leave a dangling `staff_work_items` row.

## Staff read-only in this task

Staff can only `SELECT` their own clinic's rows. There is no acknowledge,
assign, or resolve endpoint, RPC, or UI in this task — `resolved_at` is set
only by the delivery-failure supersession trigger described above. Building
a resolution workflow is explicitly out of scope here.

Task 021 (see [`docs/staff-workflow.md`](staff-workflow.md)) later adds the
one explicit resolution path: `public.resolve_staff_work_item`, a
`SECURITY DEFINER` RPC callable only by `authenticated`. It does not change
anything described in this document — the table grants, RLS policy, and both
triggers above are unchanged; `authenticated` still has no direct table
`UPDATE`.

Task 032 (see [`docs/staff-workflow.md`](staff-workflow.md)) later adds a
`seen` and `in_progress` status between `open` and `resolved`, five nullable
audit columns (`first_seen_at`/`first_seen_by`, `assigned_at`/`assigned_to`,
`resolved_by`), and two more closed `authenticated`-only RPCs
(`mark_staff_work_item_seen`, `claim_staff_work_item`) alongside a replaced
`resolve_staff_work_item`. It adds no backfill for existing rows (they keep
the new columns null) and does not change the table grants or RLS policy —
`authenticated` still has no direct table `INSERT`/`UPDATE`/`DELETE`. It
replaces the two partial unique indexes and trigger predicates so `seen` and
`in_progress` stay in the same non-resolved deduplication and automatic
provider-failure resolution domain as `open`; creation, urgency, reason, and
resolution semantics are otherwise unchanged. The three actor columns follow
the existing `on delete cascade` conventions used elsewhere in this table for
`on delete set null` instead: deleting the `auth.users` row that performed an
action erases only the actor id, not the timestamp, so audit history survives
staff account deletion. See [`docs/staff-workflow.md`](staff-workflow.md) for
the full status machine, identity semantics, and browser-alert boundary.

## Durable visibility is not notification

This task makes handoff and failure work durably queryable by staff who
already look at their clinic's data. It does not send an email, push, or
WhatsApp alert; it does not page anyone; it does not claim a person saw or
will act on a row. A `human_handoff` reply still only tells the customer the
bot cannot answer and to contact the clinic directly — it never claims staff
were notified, and this task does not change that copy.

## Not built here

Task 020 itself added no notification/alert, UI, assignment, resolution API,
appointment flow, retention/pruning job, deployment, or real-provider or
real-clinic operations test. Task 021 later adds only the minimal internal
read/detail/resolve surface described above; it still adds no notification,
assignment, appointment, or deployment behavior.

## Disposable validation passed

`supabase/migrations/20260809000400_staff_work_items.sql` and
`supabase/tests/020_staff_work_items.sql` were validated on disposable
`vetai-test` on 2026-08-09. Codex seeded one pre-migration row for each
backfill case; applying the migration produced one urgent human-handoff, one
send-attempts-exhausted, and one provider-failed item. The rollback fixture
then returned `PASS` with zero remaining test clinics, users, work items, or
outbox rows. Catalog checks confirmed ten table columns, RLS enabled, one
policy, two triggers, two `SECURITY DEFINER` trigger functions, authenticated
SELECT only, no anon access, no authenticated trigger execution, and zero
remaining work rows. The migration has not been applied to production.

A mandatory read-only Claude Opus review of the `SECURITY DEFINER` boundary,
tenant/RLS isolation, emergency escalation, failure auto-resolution,
PII/KVKK, and erasure behavior follows Codex's review before this task can
close.

## Provenance column (Task 053)

`supabase/migrations/20260905000100_operational_alerting.sql` adds
`provenance text not null default 'workflow'` (check: `'workflow'` or
`'intake_dead_letter'`). It does not add or change a `reason` value — it
distinguishes, orthogonally to `kind`/`reason`, a normal `human_handoff`
trigger-populated row from one `finalize_intake_dead_letter` creates when the
intake consumer gives up on a conversation. The migration backfills existing
rows whose `conversations.intake_data = '{"dead_letter_handoff": true}'`
marker proves that origin; every other existing row defaults to `'workflow'`.
The implementer did not run this migration. Codex later applied it only to
disposable `vetai-test` by direct query on 2026-09-06; the corrected rollback
fixture and independent zero-residue/catalog checks passed. Migration history,
staging, production, and alert activation remain unchanged. See
[`docs/inbound-queue.md`](inbound-queue.md) for the consumer-side behavior
this discriminates, and [`docs/operational-alerting.md`](operational-alerting.md)
for the alert-mail system that reads it.
