# Minimal staff workflow (Tasks 021, 032, 033)

Last verified: 2026-08-14.

## What this step does

Delivers one minimal, usable staff workflow on top of Task 020's durable
`staff_work_items` queue:

```text
staff signs in -> sees own clinic's non-resolved work, urgent first
               -> opens an item (marked seen automatically)
               -> claims it ("İşi üstlen"), works it
               -> explicitly marks the work resolved
```

Task 032 turns this into a usable pilot operation: manual items now move
through the closed workflow `open -> seen -> in_progress -> resolved`, each
transition records the authenticated staff identity and database time, and
the page polls automatically every 30 seconds with an optional, explicitly
opted-in, PII-free native browser alert for newly visible work. See
[`docs/staff-work-items.md`](staff-work-items.md) for the underlying table,
triggers, and tenant/RLS boundaries. Task 032 keeps their behavior but widens
the deduplication and provider-failure auto-resolution predicates from only
`open` to every non-resolved state.

It uses only the existing Cloudflare Worker, Supabase Auth, PostgREST, table
RLS, and native browser APIs. It adds three `SECURITY DEFINER` PostgreSQL
RPCs and a small dependency-free staff browser page served from the same
Worker. No UI framework, SDK, dependency, backend proxy, new Queue, or
speculative admin abstraction is added.

This task does not notify or assign staff through any channel other than the
active-page browser alert described below, create users, reset passwords,
manage roles/clinics/accounts, add notes, send messages, change conversation
state, reopen work, implement appointments, add analytics/realtime, deploy,
or configure real credentials.

## Routes

Served directly by the Worker (`src/staffPage.ts`, wired in `src/index.ts`):

- `GET /staff` and `GET /staff/` — the fixed HTML shell.
- `GET /staff/app.js` — the fixed browser JavaScript (`text/javascript`).
- `GET /staff/config.json` — `{ "supabaseUrl": "...", "supabaseAnonKey": "..." }`
  only. Any non-GET request under `/staff` returns 405 with `Allow: GET`; any
  unknown `/staff/*` subpath returns 404.

`SUPABASE_ANON_KEY` is the Supabase publishable (anon) key — safe for a
browser. The Worker's `SUPABASE_SERVICE_ROLE_KEY` is never read by, compared
against, or included in any staff response or script. Missing or unsafe
`SUPABASE_URL`/`SUPABASE_ANON_KEY` configuration (blank, unparsable,
non-HTTPS/non-loopback, or a URL containing credentials, a path, a query, or
a fragment) fails closed with a generic 503 for `/staff` and
`/staff/config.json`. A valid URL is normalized to its origin.

All staff responses set `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. The
HTML response additionally sets a restrictive
`Content-Security-Policy: default-src 'none'; script-src 'self';
connect-src 'self' <configured Supabase origin>; form-action 'none'; base-uri
'none'; frame-ancestors 'none'`. All JavaScript lives in `/staff/app.js`; no
inline script runs. Disabling JavaScript therefore cannot submit the login
form and place credentials in a URL.

## Authentication

The browser script calls Supabase Auth directly with native `fetch`:

```text
POST {SUPABASE_URL}/auth/v1/token?grant_type=password
```

Email and password go straight from the browser to Supabase using the
publishable anon key — the Worker never sees or proxies credentials. Only the
returned access token is kept, in `sessionStorage`; the refresh token is
ignored and never persisted. A logout action clears the stored token. Any
401/403 from a later Supabase call clears the session and returns to the
login form. There is no signup, password reset, refresh-token lifecycle,
cookie, or Worker credential proxy.

## Non-resolved work list

Using the staff member's own access token and the publishable anon key
(never the service-role key), the browser reads directly from
`public.staff_work_items` through PostgREST, RLS-scoped to that user's
clinic(s) by the existing `vetai_private.is_clinic_staff(clinic_id)`
membership check:

```text
GET /rest/v1/staff_work_items
    ?select=id,kind,priority,reason,status,created_at,conversation_id,
            first_seen_at,assigned_at,assigned_to
    &status=neq.resolved
    &order=priority.desc,created_at.asc,id.asc
    &limit=100
```

The list shows every non-resolved status (`open`, `seen`, `in_progress`),
not only `open` — a claimed item stays visible to the whole clinic so a
second person can see it is being worked. Urgent items sort first and are
marked with a `[ACIL]` text prefix (not color alone). Kind/priority/reason
and the current status use fixed Turkish labels (`Açık`, `Görüldü`,
`İşleniyor`). Each row also shows a fixed ownership label derived by
comparing `assigned_to` to the signed-in staff member's own id, read once
from `/auth/v1/user` at login and held only in memory: `Sahipsiz` (no
`assigned_to`), `Sizde` (`assigned_to` is the current user), or `Başka
personelde` (`assigned_to` is someone else) — the raw assignee UUID is never
shown. Refresh is available both as a manual button and, since Task 032, an
automatic 30-second poll (below); there is still no Realtime subscription.

## Detail, seen, and claim

Opening an item first calls `mark_staff_work_item_seen` (below) before
loading any owner/pet/conversation/message data, so the record identifies who
first attempted to open the item even if detail loading later fails or the
user never claims or resolves it. It is not proof that the detail content was
successfully rendered or read.
If that call returns `already_resolved` or `not_found`, the UI shows one
generic error, returns to the (refreshed) list, and never loads detail for
that item. Otherwise the detail view reads, with the same caller token, only
that item's RLS-visible `conversations` row, its `owners` row, an optional
`pets` row, and at most the latest 20 `messages` rows (fetched newest-first
at the API boundary via `order=created_at.desc&limit=20`, then displayed
chronologically). Displayed fields: owner name and phone, pet name/species
when present, conversation status/intake stage, and each message's
direction, timestamp, and content. If any linked record is unavailable, the
UI shows a generic Turkish error rather than falling back to a broader query.

A fixed "İşi üstlen" (claim) button calls `claim_staff_work_item` (below). It
is enabled for `open`, `seen`, an idempotent replay by the current assignee,
and an `in_progress` item whose assignee was erased (see identity and
erasure, below); a `busy` result shows one fixed, non-identifying message
("Bu iş şu anda başka bir personel tarafından işleniyor.") and never reveals
who holds it. The resolve button is enabled only when the item is
`in_progress` and assigned to the current user; `not_claimed`/`not_owner`
results show one fixed generic message and never leak the raw RPC response
or another user's identity.

The page never fetches `intake_data`, webhook events, outbox rows, provider
message IDs, payload hashes, or secrets, and never more than 20 message
bodies. Every dynamic value from Supabase — including status/ownership
labels — is assigned only through `textContent` on DOM nodes built with
`document.createElement` — never `innerHTML`/`outerHTML`/
`insertAdjacentHTML`, a script/style sink, or an unsafe URL. The script never
calls `console.*` and never logs owner, phone, pet, message content, tokens,
or response bodies.

## Identity, ownership, and erasure

`assigned_to`, `first_seen_by`, and `resolved_by` are operational/audit data,
not free text: each is the acting staff member's `auth.users` id, captured
only from `auth.uid()` inside the RPC that performs the transition, never
from client input. Each actor column is `references auth.users (id) on
delete set null` — if that Auth user is later deleted, the id is erased but
the matching timestamp (`first_seen_at`/`assigned_at`/`resolved_at`) is kept,
so the audit trail still shows *when* something happened even after it can
no longer show *who*. An `in_progress` item whose `assigned_to` was erased
this way is not stuck: any same-clinic staff member can claim (reclaim) it
through the same `claim_staff_work_item` path used for a fresh claim.
`resolved_by` is null whenever a resolution was automatic (the existing
delivery-failure-supersession trigger from Task 020, described in
[`docs/staff-work-items.md`](staff-work-items.md)) rather than a staff
action — there is no human resolver to record for that path, and this is
expected, not an error.

## Automatic refresh and browser alerts

The list poll runs on a single native `setInterval` every 30 seconds while a
staff member is signed in, with a shared in-flight guard so a manual refresh
click and an automatic tick never overlap, and no duplicate interval is ever
created. The interval stops on logout or on any 401/403 that clears the
session, and keeps running (without re-rendering the list) while a detail
view is open, so a poll tick during detail view cannot replace what the
staff member is looking at. Manual refresh remains available at all times.
The visible status region always reports the current non-resolved item
count. A failed refresh tick is silent and keeps the last known list state —
it never clears it and never fires an alert off incomplete data.

A fixed "Bildirimleri aç" button is the only place the page calls the native
`Notification.requestPermission()` — never automatically at page load or
login, only on that explicit click. Unsupported, denied, and default
permission states are all non-fatal and shown with fixed Turkish status
text; the page works fully without notification permission.

Once permission is `granted`, the first successful list load after sign-in
establishes a silent baseline (no alert) — only items that appear on a
*later* successful load, and were not part of any previously seen set of
ids, are "new." A status or ownership change on an already-known id (for
example another user claiming it) never triggers an alert. When one or more
genuinely new items appear, the page raises at most one native notification
for that tick:

- title: `Pati Hattı personel kuyruğu` (Task 059 markalama; kod
  `src/staffPage.ts` içinde bu dizeyi üretir)
- body: `Yeni acil personel işi var.` if any new item is urgent, otherwise
  `Yeni personel işi var.`

The notification never includes an item id, owner/pet name, phone number,
reason, message content, a count, or a URL, and is never created with
`silent: true`. This is deliberately a single generic alert, not a feed.

### Product ceiling — read before relying on this for anything urgent

This alert is an **active-page pilot aid only**. It proves nothing about
whether a person actually saw the work: it requires the `/staff` tab to
still be open in a browser that has been granted permission, does not
survive the tab or browser being closed, is not delivered in the
background, and the operating system is not guaranteed to play a sound or
surface it prominently. Nothing in this system may tell a customer, in
product copy or support messaging, that staff have been "notified,"
"assigned," or will respond within any particular time — that claim is not
true today and this task does not add it anywhere.

## WhatsApp automation controls (Task 033)

A separate, fixed "WhatsApp otomasyonu" section — independent of the
non-resolved work list and its polling/alerts above — lists the caller's
RLS-scoped WhatsApp accounts (`id, display_name, automation_default`) and,
for the selected account, its at most 100 configured contact overrides
(`contact_e164, mode, updated_at`, newest first). An operator enters one
exact canonical E.164 number and picks one of four fixed actions —
`AI açık`, `Sadece insan`, `Kişisel / yok say`, `Numara varsayılanı` — each
calling `set_whatsapp_contact_route` and accepting only its closed
`updated | unchanged | not_found` result; only this section refreshes after
a successful change. It uses `textContent`/native DOM only and never stores
account/contact/route data in `sessionStorage`, local storage,
notifications, URLs, or logs, matching the storage discipline the rest of
this page already follows. See
[`docs/selective-automation.md`](selective-automation.md) for the full
routing contract, the fixed Turkish explanations shown next to each action,
and the same-number manual-messaging ceiling — this section does not add a
staff reply composer, and switching a contact to manual/personal does not
notify anyone or erase earlier stored records.

The fixed copy also states that `manual` messages remain stored for the
clinic. `personal` content does not persist; an explicit personal override
retains its routing phone number, while an unlisted number has no route row.
Selecting `Numara varsayılanı` deletes the override row; see the
selective-automation document for the owner-erasure boundary. The Task 034
strict allowlist makes the account default permanently `personal`: only an
exact number shown as `AI açık` is automated, and removing that row returns
the number to the content-unread/unpersisted default. The UI claims the strict
policy is active only after the account response validates that default; a
missing migration or malformed response leaves route controls fail-closed
with an explicit warning.

## Staff reply composer (Task 048)

**Implemented, locally verified and proven only on disposable `vetai-test` —
not staging-verified and not committed.** The corrected rollback fixture
passed with zero residue; the first mandatory Opus review's corrections are
implemented and await a narrow read-only re-check. See
`supabase/migrations/20260903000100_staff_reply_composer.sql`,
`supabase/tests/048_staff_reply_composer.sql`, and
[`docs/database-schema.md`](database-schema.md#staff-authored-whatsapp-reply-composer-task-048)
for the schema/RPC contract this section describes.

This surface currently relies on Supabase-authenticated clinic membership.
Task 045's TOTP/`aal2` boundary applies only to `/admin`; staff MFA remains a
separate production-access decision and is not claimed by Task 048.

A fixed composer appears only inside the detail view of a work item that is,
at read time, `kind = 'human_handoff'`, `status = 'in_progress'`, and
assigned to the signed-in staff member — the same three conditions the
server-side RPC re-checks independently, so a stale or manipulated client
view can only ever fail closed, never queue on the caller's behalf. The
composer is absent for every other kind/status/assignee combination,
including the caller's own `open`/`seen`/resolved items and any item claimed
by someone else.

The RPC locks the clinic and exact membership row before the work item and
re-checks tenant membership after any lifecycle-lock wait. A concurrent
suspend, offboarding, or membership revocation therefore
cannot commit and then leave a newly queued staff reply behind; this ordering
also matches the clinic-to-child order used by lifecycle deletion.

The service-window anchor is the earlier of the inbound message's provider/
client timestamp and its trusted `webhook_events.received_at` server timestamp.
A device clock set in the future therefore cannot lengthen the 24-hour window.

Before sending, the operator sees a fixed Turkish `window.confirm()` warning
that this will queue one real WhatsApp message and that queuing alone does not
prove Meta acceptance or delivery; the operator must accept it. Declining
leaves the draft untouched and sends nothing. On confirm, the page calls
`queue_staff_reply_v1` (below) with a
`crypto.randomUUID()` request id generated once per draft and reused only for
that draft's own retries (a network timeout or transient failure retries the
exact same request id; composing a new message after send always gets a new
one) — so an accidental double-click or an automatic retry after a 10-second
client-side timeout can never queue a second WhatsApp message for the same
draft. The client also rejects an empty or whitespace-only draft and a draft
over 4096 Unicode code points before calling the RPC, purely as a UX
convenience; the RPC independently re-validates PostgreSQL character length
and content server-side and is the authoritative check.

The RPC's closed result set maps to fixed, truthful Turkish outcome copy —
queued (`"Yanıt gönderim kuyruğuna eklendi."`) is described only as *queued*,
never as *delivered* or *read*. Closed failures have a fixed, non-sensitive
mapping: `not_found` → `"İş bulunamadı."`, `not_allowed` →
`"Bu yanıtı şu anda gönderemezsiniz."`, `inactive` →
`"Klinik şu anda aktif değil."`, and `window_closed` →
`"24 saatlik müşteri yanıt penceresi kapandı."`. None exposes raw RPC details
or another user's identity. This composer never reports Meta acceptance or
delivery/read status itself — the existing sender Worker and
`claim_outbound_message_v2`/`accept_outbound_message`
(see [`docs/outbound-delivery.md`](outbound-delivery.md) and
[`docs/outbound-status.md`](outbound-status.md)) own that, unchanged, exactly
as they do for automation-produced replies.

A staff-queued reply is never a new AI/automation turn: `queue_staff_reply_v1`
only inserts a `pending` `outbound_message_outbox` row and never touches
`staff_work_items`, `conversations`, or `whatsapp_contact_routes`, so queuing
a reply does not itself resolve the work item, does not restart or bias
automation for that contact, and a later `set_whatsapp_contact_route` mode
change for that contact no longer deletes an already-queued staff reply (see
`docs/database-schema.md`).

## Clinic schedule (Task 044)

A fixed "Klinik takvimi" section — independent of the work queue and
WhatsApp-automation sections above — lets clinic staff see, and a
`clinic_staff.role = 'admin'` member edit, that clinic's weekly hours,
full-day closures, and future bookable slots, through the five RPCs
documented in [`docs/database-schema.md`](database-schema.md) and the
product rules in
[`docs/clinic-operations.md`](clinic-operations.md#task-044-self-service-hours-closures-and-slot-inventory-staff).
It is the same `/staff` page and Supabase Auth session as the rest of this
document; there is still no second panel and no clinic-schedule route.

- **Clinic selector.** A caller who belongs to more than one clinic (through
  RLS-visible `clinic_staff` rows) picks which clinic's schedule to view;
  the selected clinic is never inferred from a WhatsApp account, and every
  schedule read/write is scoped to that exact clinic ID.
- **Admin-only edits, fixed Turkish warnings.** `veterinarian` and
  `receptionist` staff see the same weekly-hours/closure/slot data rendered
  read-only, with fixed copy explaining only the clinic administrator can
  change it. An administrator of a suspended/offboarding clinic also sees a
  read-only schedule with an inactive-clinic explanation; the server-side RPC
  role/lifecycle check is authoritative regardless of what the page renders.
  Every mutation surface carries the same fixed
  warning: changing hours or closures does not cancel a held or confirmed
  appointment and does not notify its owner — a mutation's returned
  preserved-active-slot count is shown as that warning, never as a
  cancellation or contact claim. Any returned removed-available-slot count is
  also shown, including an idempotent schedule replay that cleans up a stale
  empty slot.
- Weekly hours use native `<input type="time" step="1800">` (half-hour
  aligned, matching the generation ceiling in `docs/clinic-operations.md`);
  `24:00` is not accepted and the latest supported closing input is `23:30`;
  closure dates and slot generation use native date controls; the upcoming
  slot list shows status labels and a delete control only on future
  `available` rows — a `held`/`confirmed` row has no delete action. All
  times render with `timeZone: "Europe/Istanbul"` regardless of the
  operator's browser timezone.

## Clinic alert preferences (Task 056)

A fixed "Uyarı tercihleri" section — independent of the queue, automation, and
schedule sections above — lists every clinic the caller belongs to, backed by
`get_my_clinic_alert_preferences`/`set_my_clinic_alert_preference`
([`docs/database-schema.md`](database-schema.md#clinic-alert-preferences-and-rollout-gate-task-056),
full behavior in
[`docs/operational-alerting.md`](operational-alerting.md#11-task-056--klinik-e-posta-uyarı-tercihleri-üç-bağımsız-katman-2026-09-07-aktivasyon-yok)
§11). This is a personal, self-service subscription toggle — distinct from
the clinic-wide rollout gate a platform admin controls (see
[`docs/platform-admin-overview.md`](platform-admin-overview.md)) and from the
global Worker alert activation described in `docs/operational-alerting.md`.

- Each row shows the clinic name, whether the platform admin's clinic gate is
  currently open, the caller's own checkbox, and the resulting effective
  state (`effective_enabled = clinic gate AND my preference`) — so a staff
  member can always tell whether their own subscription is actually live,
  not just switched on.
- Toggling calls `set_my_clinic_alert_preference` with only `clinic_id` and
  the new boolean; the caller's own confirmed Auth e-mail is resolved
  server-side, never entered or shown in the UI. `email_unconfirmed` is
  surfaced as a fixed message rather than silently no-op'ing.
- The toggle is guarded by a shared in-flight flag and always reloads
  authoritative state from the server afterward, so a failed or racing
  mutation can never leave the checkbox showing a state the server didn't
  actually apply.
- Disabling prevents unclaimed/expired-lease clinic alerts from being sent,
  but an e-mail whose provider send already started before the toggle cannot
  be recalled and may still arrive; the UI states this boundary explicitly.

## Pilot operating procedure

Because there is no reassignment, release, or shared "who's on call" UI yet,
this is meant to run with **one named operator watching the page at a
time**, handed off explicitly at shift change (the outgoing operator tells
the incoming operator to open `/staff` and grant notification permission;
there is no automated handoff signal). The expected per-item flow is claim
before working an item (so ownership is visible to the rest of the clinic)
and resolve immediately after finishing it — an item left `in_progress` and
unresolved is not distinguishable from one still being worked. There is
still no notes field, no staff-to-staff handoff message, and no admin
console; coordination beyond the ownership label is a manual, out-of-band
process for the clinic to run themselves.

## Not built here (Task 032)

No background or closed-tab notification (Push API, service worker), no
full event/audit history view, no reassignment or release-claim UI, no
notes or staff-to-staff messaging, no supervisor/admin console, no SLA timer
or response-time metric, and no customer-facing claim about staff awareness
or response time. Creation, deduplication, urgency, reason derivation, and
the automatic delivery-failure resolution trigger from Task 020 are
unchanged. (A staff reply to the customer was added later — see "Staff reply
composer (Task 048)" above; that addition does not change anything else
listed in this section.)

## Resolve, seen, and claim RPCs

All three RPCs below share the same shape: `SECURITY DEFINER`, `VOLATILE`,
`SET search_path = ''`, revoked from `PUBLIC`, `anon`, and `service_role`,
executable only by `authenticated`. Each rejects a null work-item id before
any lookup, locks the exact row with `for update`, authorizes with the
caller's Supabase identity through the same
`vetai_private.is_clinic_staff(row.clinic_id)` helper used elsewhere, returns
`not_found` for both an absent item and one outside the caller's clinics
without revealing which case occurred, derives the acting identity only from
`auth.uid()` (never a client-supplied user id), returns exactly one row with
one `result text` field from a fixed, closed set of literal strings, fully
qualifies every relation/helper, and uses no dynamic SQL. None of the three
accept a clinic id, and none touch conversation or outbox state. Direct
authenticated table `INSERT`/`UPDATE`/`DELETE` remains denied for all three.

### `public.mark_staff_work_item_seen`

Defined in
`supabase/migrations/20260814000200_staff_assignment_and_alerts.sql`. From
`open`, records `first_seen_at`/`first_seen_by` and moves the item to `seen`,
returning `seen`. From `seen` or `in_progress` (already viewed once, whether
or not it has since been claimed) it returns `already_seen` with no
mutation. From `resolved` it returns `already_resolved`.

### `public.claim_staff_work_item`

Defined in the same migration. From `open` or `seen`, fills any missing
first-seen fields, sets `assigned_at`/`assigned_to` to the caller, moves the
item to `in_progress`, and returns `claimed`. From `in_progress`: if the
current caller is already the assignee, returns `already_claimed` with no
mutation; if a *different* user is currently assigned, returns `busy` with
no mutation; if the assignee was erased (see identity and erasure, above),
the caller becomes the new assignee and the result is `claimed` (a reclaim).
From `resolved` it returns `already_resolved`.

### `public.resolve_staff_work_item` (replaced by Task 051; signature unchanged)

Replaced again in
`supabase/migrations/20260904000200_handoff_conversation_recovery.sql` — same
`p_work_item_id uuid` signature, public result set
(`resolved | already_resolved | not_claimed | not_owner | not_found`), and
grant shape as the version Task 021 added in
`supabase/migrations/20260809000500_staff_workflow.sql`. From `resolved` it
returns `already_resolved`. From any other status where the item is not
currently claimed by anyone with a live assignee — `open`, `seen`, or an
`in_progress` item whose assignee was erased — it returns `not_claimed` with
no mutation. From `in_progress` assigned to a *different* user it returns
`not_owner` with no mutation. Only when the caller is the current live
assignee of an `in_progress` item does it set `status = 'resolved'`,
`resolved_at = pg_catalog.now()`, and `resolved_by` to the caller, and return
`resolved`. Concurrent calls on the same row still serialize on the row
lock, locked in a fixed order (clinic, exact caller membership, then — for
`human_handoff` only — the conversation, then the work item) to avoid the
known inverted-order deadlock cycle against the intake trigger.

Since Task 051, resolving a `kind = 'human_handoff'` item also completes its
linked conversation in the same transaction: a conversation that is exactly
`status = 'handoff'` / `intake_stage = 'human_handoff'` moves to
`completed`/`completed` with `state_version` incremented once. A conversation
already exactly `completed`/`completed` (a resolve racing a second path to
the same terminal state) resolves the item without a second increment. Any
other status/stage pairing fails closed with an exception and no mutation at
all — this never happens through this migration's own code paths, and would
mean an unrelated bug elsewhere. Completing the conversation this way means a
later inbound message from the same contact starts a brand new conversation
at the default intake stage instead of being silently dropped by the
now-terminal one; see the ingest upsert behavior in
[inbound-queue.md](inbound-queue.md). Resolving a `kind = 'delivery_failure'`
item is unaffected — the linked conversation is never touched. A one-time
backfill in the same migration repairs conversations left stuck by the
pre-Task-051 behavior (exactly `handoff`/`human_handoff`, at least one linked
`human_handoff` item already resolved, and none still open); it never closes
a conversation with a non-resolved handoff item or one represented only by
delivery-failure work.

`/staff` asks for confirmation before calling this RPC, and the copy depends
on the claimed item's `reason`: a normal `human_handoff` item shows one
truthful Turkish confirmation stating the conversation will complete and that
a further message starts a new one; an `emergency_handoff` item requires two
separate confirmations (first, that staff actually handled the escalation;
second, the same closure/fresh-conversation warning) and calls no RPC if
either is cancelled — an added operator-safety guard on top of, not instead
of, the database's current-assignee authorization. A coherent
`delivery_failure` kind/reason pair keeps the original single generic
confirmation; every other kind/reason pairing shows no prompt and makes no
RPC call.

## Application shell and section navigation (Task 058)

`/staff` now shares one native CSS module (`src/panelStyles.ts`, plain
`:root` custom properties — no new package, font, or CDN) with `/admin`, and
exposes a single keyboard-accessible `<nav aria-label="Panel bölümleri">`
with four destinations: **İşler**, **WhatsApp otomasyonu**, **Takvim**, and
**E-posta uyarıları**. Each destination is a plain `<button aria-current>`
(native Tab/Enter/Space operation — no custom ARIA tablist needed);
switching destinations shows exactly one section at a time via `hidden`,
never issues a new network call, and never touches the reply composer's
draft state — the draft lives in the DOM `<textarea>` and simply persists
under `hidden`. Selecting an unknown or tampered destination is ignored
(fails closed to the current view) instead of blanking the shell. The
weekly-hours and alert-preference tables are each wrapped in a scrollable
`.table-wrap` div (not `display:block` on `<table>`, which would break
table semantics) for narrow screens. The shell also adds a `<main>`
landmark, `:focus-visible` outlines, `@media (prefers-reduced-motion:
reduce)`, and ~44px (`2.75rem`) touch targets. Covered by
`test/staffPage.test.ts` and `test/panelStyles.test.ts`, including a runtime
harness that drives the actual destination-switching functions against fake
DOM nodes. An open detail/composer is restored when the user returns to
**İşler**, so switching sections neither clears nor strands a reply draft.
The shared inline style is authorized by its exact SHA-256 CSP hash;
`unsafe-inline` is not enabled.

## Known limitations

- Session storage only: closing the tab, or letting the access token expire,
  requires signing in again (no refresh-token lifecycle).
- The 30-second poll and browser alert are an active-page pilot aid only —
  see the product-ceiling note above. There is still no background,
  closed-tab, email, SMS, or push notification.
- No reopen, note, or staff-to-staff messaging capability.
- No reassignment or release-claim UI — an erased assignee is the only way
  an `in_progress` item becomes reclaimable by someone else.
- No appointment, analytics, or realtime behavior.
- Not deployed; no real credentials were used or entered.

## Legal / KVKK note

`first_seen_by`, `assigned_to`, and `resolved_by` store a specific staff
member's Supabase Auth user id against a specific work item and timestamp —
this is personal, operational/audit data about clinic staff (who looked at
or handled which item, and when), not about the customer or patient. It is
readable only by staff of the same clinic under the existing RLS policy and
is never exposed to the customer-facing WhatsApp flow. Retention here
follows the existing `staff_work_items` table (no separate retention job was
added by this task); a Turkish-law (KVKK) review of appropriate retention
and staff-data handling for this actor/audit trail is still outstanding and
should happen before any production use.

## Disposable validation status

`supabase/migrations/20260809000500_staff_workflow.sql` was applied to
disposable `vetai-test` on 2026-08-09. The rollback fixture
`supabase/tests/021_staff_workflow.sql` returned `PASS` with zero remaining
test clinics, users, or work items. A separate catalog query confirmed the
function exists, is `SECURITY DEFINER`/`VOLATILE` with an empty search path,
is executable by `authenticated` but not `PUBLIC`, `anon`, or `service_role`,
and leaves the existing one-policy RLS shape intact. This validation is not a
production migration or a Supabase migration-history entry. The mandatory
read-only Claude Opus architecture/RLS/privacy review passed on 2026-08-10
with no blocking finding. No claim is made here that any person was notified,
assigned, or has responded to any item.

**Task 032 — disposable validation passed; not production.** Codex applied
`supabase/migrations/20260814000200_staff_assignment_and_alerts.sql` to
disposable PostgreSQL 17 `vetai-test` on 2026-08-14. Its rollback fixture
`supabase/tests/032_staff_assignment_and_alerts.sql` returned
`PASS 0/0/0/0`, proving zero remaining test clinics, users, work items, or
outbox rows. Final typecheck, all 1,283 normal tests, Worker dry-run, and
`git diff --check` also passed; the two opt-in paid evals were skipped because
this task changes no AI behavior. This was not a production migration or a
Supabase migration-history entry. No claim is made that any person has been
notified, assigned to, or has responded to any item.

**Task 056 — disposable validation passed; not staging/production.** The implementer
(Claude Sonnet) wrote `supabase/migrations/20260907000200_clinic_alert_preferences.sql`
and its rollback fixture `supabase/tests/056_clinic_alert_preferences.sql` but,
per a binding instruction, did not run either against any database. Codex
later applied the reviewed migration only by direct query on disposable
`vetai-test`; the rollback fixture and independent catalog/grant/zero-residue
query passed. No migration-history record was created. The `/staff`
alert-preferences section above and the underlying client code passed local
typecheck and the full test suite. No
claim is made that any e-mail was sent, that the mandatory Claude Opus review
ran, or that staging/production were touched.

**Task 058 — shell/navigation refactor, no database change.** No migration
was written or applied. Local typecheck, the targeted
`staffPage.test.ts`/`adminPage.test.ts`/`index.test.ts`/`panelStyles.test.ts`
run, and the full test suite all passed, as did `wrangler deploy --dry-run`
for both the production and staging (`wrangler.staging.toml`) configs and
`git diff --check`. The implementing session could not perform visual
inspection, but Codex closed that gap by rendering both login surfaces
locally in headless Chrome at 1440px, 768px, and 375px. The initial render
found and the final render confirmed fixes for pre-login nav visibility,
mobile overflow and admin first-viewport density. No deploy or change to any
real service, database, or domain was made.
