# Minimal staff workflow (Tasks 021, 032)

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

- title: `VetAI personel kuyruğu`
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
notes or staff-to-staff messaging, no staff reply to the customer, no
supervisor/admin console, no SLA timer or response-time metric, and no
customer-facing claim about staff awareness or response time. Creation,
deduplication, urgency, reason derivation, and the automatic
delivery-failure resolution trigger from Task 020 are unchanged.

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

### `public.resolve_staff_work_item` (replaced; signature unchanged)

Replaced in the same migration — same `p_work_item_id uuid` signature and
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
lock.

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
