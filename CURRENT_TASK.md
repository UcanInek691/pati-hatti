# Current task — 032 Pilot staff ownership, status, and browser alerts

Status: `READY`

Owner: Claude Sonnet

## Goal

Turn the existing minimal `/staff` queue into a usable pilot operation without
adding a framework or an external notification provider:

1. move each manual staff item through the closed workflow
   `open -> seen -> in_progress -> resolved`;
2. record the authenticated staff identity and database time for first view,
   ownership, and manual resolution; and
3. refresh the queue automatically and show a PII-free native browser alert
   for newly visible work while the staff page is open.

This task does not change clinical decisions, customer-facing WhatsApp copy,
AI behavior, or the creation rules for staff work items.

## Scope

Allowed changes:

- `supabase/migrations/20260814000200_staff_assignment_and_alerts.sql` (new)
- `supabase/tests/032_staff_assignment_and_alerts.sql` (new, rollback-only)
- `src/staffPage.ts`
- `test/staffPage.test.ts`
- `docs/staff-workflow.md`
- `docs/staff-work-items.md`
- `docs/database-schema.md`
- `docs/product-roadmap.md` — Task 032 status paragraph only
- `CURRENT_TASK.md` — implementer fills only **Observed context** and
  **Delivery record**

Do not change:

- staff-work-item creation, deduplication, urgency, reason, tenant FK,
  erasure cascade, or automatic provider-failure resolution behavior;
- conversation, intake, safety, appointment, webhook, Queue, outbox, clinic
  hours, OpenAI prompt/model/eval, or WhatsApp behavior;
- Worker routes, environment bindings, Wrangler configuration, dependencies,
  package-manager files, lockfile, or existing migrations;
- Supabase Auth user/role management or clinic membership management;
- production resources, secrets, deployments, or external service state.

Do not add a UI framework, Supabase SDK, Realtime subscription, service
worker, Push API backend, custom audio asset, e-mail/SMS/Slack/CRM integration,
notes, staff messaging, supervisor console, reassignment/history table,
analytics service, SLA engine, or generic workflow abstraction.

## Verified starting evidence

- Task 031 is complete and committed at `7f8277c`; the worktree was clean
  before this contract.
- `public.staff_work_items` currently has only `open | resolved` status,
  `created_at`, and `resolved_at`. Authenticated staff have same-clinic SELECT
  only; all direct INSERT/UPDATE/DELETE operations remain denied.
- `public.resolve_staff_work_item(uuid)` is an authenticated-only,
  tenant-checking `SECURITY DEFINER` RPC. It locks the exact row and currently
  lets any same-clinic staff member resolve an open item.
- `/staff` uses native browser APIs and direct Supabase Auth/PostgREST calls.
  It stores only the access token in `sessionStorage`, lists only `status=open`
  rows, refreshes manually, and has no ownership or notification behavior.
- The staff list already sorts `priority.desc, created_at.asc, id.asc`, so
  urgent work appears first without a schema/index redesign.
- Automatic `provider_failed` closure is performed by the existing database
  trigger and must remain a valid system resolution with no human resolver.

## Required behavior

### 1. Minimal status and audit columns

The migration must extend `public.staff_work_items` with exactly these nullable
columns:

- `first_seen_at timestamptz`
- `first_seen_by uuid references auth.users(id) on delete set null`
- `assigned_at timestamptz`
- `assigned_to uuid references auth.users(id) on delete set null`
- `resolved_by uuid references auth.users(id) on delete set null`

Replace the existing status check so the only allowed values are:

`open | seen | in_progress | resolved`.

Add named checks that enforce:

- `open`: no seen/assignment/resolution timestamps and no actor IDs;
- `seen`: `first_seen_at` is present, assignment/resolution fields are null;
- `in_progress`: `first_seen_at` and `assigned_at` are present,
  `resolved_at/resolved_by` are null;
- `resolved`: `resolved_at` is present; human audit fields may be null because
  existing rows and the existing provider-status trigger can resolve work
  automatically;
- an actor UUID, when non-null, always has its matching timestamp.

`ON DELETE SET NULL` may erase an actor UUID while retaining the event time.
Therefore checks must not require an actor UUID whenever its timestamp exists.
An `in_progress` row whose assignee was erased remains recoverable by a later
claim.

Existing `open` and `resolved` rows must satisfy the new checks without an
invented backfill identity or timestamp. Do not add an event/audit table or a
new list index unless an actual new query requires it.

The existing RLS policy and grants must remain unchanged: same-clinic
authenticated users can SELECT these columns but still cannot mutate the table
directly. Actor IDs are opaque operational identifiers and must never be
interpolated into the page, logs, alerts, or customer messages.

### 2. Closed authenticated RPCs

Create these functions:

```text
public.mark_staff_work_item_seen(p_work_item_id uuid)
public.claim_staff_work_item(p_work_item_id uuid)
```

Replace `public.resolve_staff_work_item(uuid)` without changing its signature.

All three functions must be `SECURITY DEFINER`, `VOLATILE`,
`SET search_path = ''`, executable only by `authenticated`, and revoked from
`PUBLIC`, `anon`, and `service_role`. Each must:

- reject a null ID before reading data;
- obtain `auth.uid()`, lock the exact work-item row, and authorize the locked
  row through `vetai_private.is_clinic_staff(row.clinic_id)`;
- return the same `not_found` result for absent and cross-clinic rows;
- derive every actor from `auth.uid()`; callers never provide a clinic or user
  ID;
- return exactly one row with one `result text` field;
- use no dynamic SQL and reveal no identifier, PII, message, or database error
  detail in a success result.

#### `mark_staff_work_item_seen`

- `open` -> atomically set `status='seen'`, `first_seen_at=now()`, and
  `first_seen_by=auth.uid()`; return `seen`.
- `seen | in_progress` -> no mutation; return `already_seen`.
- `resolved` -> no mutation; return `already_resolved`.
- Closed result set: `seen | already_seen | already_resolved | not_found`.

#### `claim_staff_work_item`

- `open | seen` -> atomically set `status='in_progress'`, fill missing first-
  seen fields with `now()/auth.uid()`, and set `assigned_at/assigned_to` to
  `now()/auth.uid()`; return `claimed`.
- `in_progress` with the same assignee -> no mutation; return
  `already_claimed`.
- `in_progress` with a different non-null assignee -> no mutation; return
  `busy`.
- `in_progress` with a null assignee left by Auth-user erasure -> assign the
  current user, refresh `assigned_at`, and return `claimed`.
- `resolved` -> no mutation; return `already_resolved`.
- Closed result set:
  `claimed | already_claimed | busy | already_resolved | not_found`.

#### `resolve_staff_work_item`

- Preserve `already_resolved | not_found` behavior.
- `open | seen`, or an `in_progress` row with a null assignee -> no mutation;
  return `not_claimed`.
- `in_progress` assigned to another user -> no mutation; return `not_owner`.
- Only the current assignee may set `status='resolved'`,
  `resolved_at=now()`, and `resolved_by=auth.uid()`; return `resolved`.
- Closed result set:
  `resolved | already_resolved | not_claimed | not_owner | not_found`.

The existing database trigger may still resolve `provider_failed` items
without calling this RPC; such rows legitimately have `resolved_by = null`.
True two-session lock contention is a Codex validation concern, not something
the rollback-only fixture may claim to have executed.

### 3. Staff identity and queue query

Keep the existing direct Supabase Auth architecture and access-token storage.
After login and on session restoration, obtain the current authenticated user
from the fixed `/auth/v1/user` endpoint using the existing token. Accept only
a valid non-empty UUID `id`, hold it in memory, and never store email, user ID,
or any additional auth response in `sessionStorage`.

The list query must:

- select only `id,kind,priority,reason,status,created_at,conversation_id,
  first_seen_at,assigned_at,assigned_to`;
- include every non-resolved status and exclude resolved rows;
- preserve urgent-first, then oldest-first ordering and the 100-row bound;
- remain RLS-scoped by the caller token.

The rendered list must show fixed Turkish labels for `open`, `seen`, and
`in_progress`, plus one of `Sahipsiz`, `Sizde`, or `Başka personelde` by
comparing `assigned_to` with the in-memory current-user ID. Never display an
actor UUID.

### 4. View, claim, and resolve UI

Opening a detail must call `mark_staff_work_item_seen` before loading owner,
pet, conversation, or messages. Accept only its exact one-row closed result.
On `already_resolved | not_found`, return to the refreshed list without
loading detail. Network/HTTP/malformed failures show a generic error and do
not broaden data access.

Add a fixed `İşi üstlen` action:

- it calls only `claim_staff_work_item` with the current work-item ID;
- it is available for `open | seen`, for a recoverable null-assignee
  `in_progress` row, and idempotently for the current assignee;
- `busy` displays a fixed Turkish “başka personel üstlendi” status without an
  identity;
- success refreshes the selected item's state.

The existing resolve action must be enabled only when the item is
`in_progress` and assigned to the current user. Keep its fixed confirmation.
Accept the expanded closed resolve result set; `not_claimed | not_owner` must
show generic fixed Turkish guidance and refresh state rather than leaking any
actor or raw response.

All dynamic database values continue to use `textContent` and native DOM
construction only. Do not add `innerHTML`, log calls, unrestricted selects,
raw provider bodies, or secret/service-role references.

### 5. Automatic refresh and PII-free browser alerts

Use only native browser APIs:

- while authenticated and the page remains open, fetch the bounded work list
  every 30 seconds;
- prevent overlapping refresh requests;
- stop the interval on logout/session failure and do not create multiple
  intervals after repeated login/navigation;
- continue polling while the detail view is open, but do not replace its DOM;
- the first successful list load establishes a baseline and emits no alert;
- on later successful loads, alert only for work-item IDs not in the previous
  successful open-set baseline; status/ownership changes of an existing ID do
  not alert;
- a failed refresh does not erase the last successful baseline and does not
  generate a notification.

Add a fixed `Bildirimleri aç` button. Request `Notification` permission only
from that explicit user action—never at page load/login. Unsupported, denied,
or default permission states must remain non-fatal and show fixed Turkish
status text.

When permission is already `granted`, a later newly visible item may create
one native notification with only:

- title: `VetAI personel kuyruğu`
- body `Yeni acil personel işi var.` when at least one new item is urgent;
- otherwise body: `Yeni personel işi var.`

Do not place work-item IDs, clinic/owner/pet names, phone numbers, reasons,
message content, counts, URLs, tokens, or other data in the notification.
Do not set `silent: true`; actual sound remains controlled by the browser and
operating system and is not guaranteed by this application.

The visible page status region must still report the current open-work count.
Manual refresh remains available.

### 6. Explicit product ceiling

This task's notification is only an active-page pilot aid. It does not prove a
person saw the work, and it does not operate reliably after the page/browser
is closed. General sale still requires a separate, PII-free external
notification path plus measured staging/pilot evidence.

No customer-facing text may claim that staff were notified, assigned, or will
respond within a time window.

## Required tests

### SQL rollback fixture

The rollback-only SQL test must prove:

- the new status and audit checks, including existing open/resolved row
  compatibility and Auth-user `ON DELETE SET NULL` behavior;
- same-clinic authenticated `open -> seen -> in_progress -> resolved` with
  exact first-seen/assignment/resolver identity and timestamps;
- idempotent seen/claim/resolve results;
- claim directly from `open` fills first-seen fields;
- a second same-clinic user receives `busy`/`not_owner` and cannot mutate the
  current owner's row;
- an erased assignee can be reclaimed by another same-clinic user;
- absent and cross-tenant IDs are indistinguishable as `not_found` with zero
  mutation;
- null IDs fail before lookup;
- automatic `provider_failed` resolution remains valid with
  `resolved_by is null`;
- authenticated direct table INSERT/UPDATE/DELETE remains denied, SELECT
  remains same-clinic only, and `anon`/`service_role` cannot execute the three
  staff RPCs;
- function security/search-path/grant shape and zero fixture residue after
  rollback.

The sequential fixture may verify row-state outcomes but must state that it
does not execute real two-session lock contention.

### TypeScript/browser-source tests

Extend the existing dependency-free tests to cover:

- the exact non-resolved list projection/order/limit;
- current-user loading, UUID rejection, access-token-only session storage,
  and session clearing on 401/403;
- all three RPC paths and every accepted/rejected closed result;
- exact list ownership/status labels without rendering actor UUIDs;
- mark-seen-before-detail ordering, claim/busy behavior, and owner-only
  resolve enablement;
- one 30-second interval, overlap prevention, logout/session cleanup, manual
  refresh preservation, and polling during detail view without replacing it;
- baseline/no-initial-alert, new-ID alert, no alert for existing-ID status
  changes, urgent precedence, and baseline retention after failure;
- explicit permission request only, unsupported/denied behavior, and exact
  PII-free notification title/body;
- no `console`, dynamic HTML sink, service-role key, refresh-token storage,
  unrestricted select, arbitrary URL, or notification interpolation.

Do not add a DOM/test framework dependency merely to test this fixed page.
Reuse the existing source-level page test style and extract a tiny pure helper
only if it materially improves behavioral proof without widening runtime
surface.

## Documentation

Update the staff docs to explain:

- the four statuses and which RPC performs each manual transition;
- first-seen, current-owner, assignment, resolver, and timestamp semantics;
- actor UUIDs are same-clinic operational/audit data, not display names, and
  are nulled when the Auth user is erased while timestamps remain;
- automatic provider resolution has no human resolver;
- urgent-first ordering and current `Sahipsiz | Sizde | Başka personelde`
  display;
- automatic 30-second refresh and the exact PII-free alert boundary;
- notification permission is explicit, OS/browser sound is not guaranteed,
  and the page must remain open;
- the pilot procedure: one named staff operator keeps the page open during
  clinic hours, enables notifications, claims before working, resolves after
  action, and hands page-monitoring duty to another authenticated staff member
  at shift change; an already claimed item remains with its recorded owner
  because this MVP has no release/reassignment flow;
- no response-time promise is made to customers; `first_seen_at`,
  `assigned_at`, and `resolved_at` only enable later measurement;
- no external/background notification, full immutable event history,
  reassignment UI, notes, staff reply, or admin/user-management UI exists.

State that staff actor IDs and operational timestamps are personal/audit data
whose retention and access must be covered by the Turkish legal/KVKK review
before production.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Migration apply and `supabase/tests/032_staff_assignment_and_alerts.sql` are
`NOT RUN` for Sonnet. Codex applies/tests them only on disposable `vetai-test`
after review.

Do not run paid OpenAI evals: this task changes no prompt, model, extraction
contract, model context, safety decision, or customer reply.

No commit, push, deploy, database mutation, real notification, real service
call, plugin installation, or external resource change is authorized for the
implementer.

## Review gates

1. Codex reviews the full schema/RLS/RPC/browser path, reruns local checks,
   and validates the migration plus rollback fixture on disposable
   `vetai-test`.
2. Claude Opus performs one read-only review because this task changes
   authenticated `SECURITY DEFINER` mutations, tenant-visible actor IDs, and
   notification/privacy behavior.
3. Codex applies only verified targeted fixes, updates `PROJECT_CONTEXT.md`,
   and commits after all gates pass.
4. Turkish legal/KVKK review remains an external production gate.

## Observed context

_Implementer: fill from repository evidence before editing._

## Delivery record

_Implementer: fill after verification. Do not commit, push, deploy, mutate a
database, send a real notification, or call an external service._
