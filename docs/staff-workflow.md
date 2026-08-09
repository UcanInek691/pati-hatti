# Minimal staff workflow (Task 021)

Last verified: 2026-08-09.

## What this step does

Delivers one minimal, usable staff workflow on top of Task 020's durable
`staff_work_items` queue:

```text
staff signs in -> sees own clinic's open work, urgent first
               -> opens owner/pet/recent-message detail
               -> explicitly marks the work resolved
```

It uses only the existing Cloudflare Worker, Supabase Auth, PostgREST, table
RLS, and native browser APIs. It adds one new `SECURITY DEFINER` PostgreSQL
RPC and a small dependency-free staff browser page served from the same
Worker. No UI framework, SDK, dependency, backend proxy, new Queue, or
speculative admin abstraction is added.

This task does not notify or assign staff, create users, reset passwords,
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

## Open-work list

Using the staff member's own access token and the publishable anon key
(never the service-role key), the browser reads directly from
`public.staff_work_items` through PostgREST, RLS-scoped to that user's
clinic(s) by the existing `vetai_private.is_clinic_staff(clinic_id)`
membership check:

```text
GET /rest/v1/staff_work_items
    ?select=id,kind,priority,reason,created_at,conversation_id
    &status=eq.open
    &order=priority.desc,created_at.asc,id.asc
    &limit=100
```

Urgent items sort first and are marked with a `[ACIL]` text prefix (not
color alone). Kind/priority/reason are shown as fixed Turkish labels.
Refresh is a manual button; there is no polling and no Realtime subscription.

## Detail

Selecting an item reads, with the same caller token, only that item's
RLS-visible `conversations` row, its `owners` row, an optional `pets` row,
and at most the latest 20 `messages` rows (fetched newest-first at the API
boundary via `order=created_at.desc&limit=20`, then displayed
chronologically). Displayed fields: owner name and phone, pet name/species
when present, conversation status/intake stage, and each message's
direction, timestamp, and content. If any linked record is unavailable, the
UI shows a generic Turkish error rather than falling back to a broader query.

The page never fetches `intake_data`, webhook events, outbox rows, provider
message IDs, payload hashes, or secrets, and never more than 20 message
bodies. Every dynamic value from Supabase is assigned only through
`textContent` on DOM nodes built with `document.createElement` — never
`innerHTML`/`outerHTML`/`insertAdjacentHTML`, a script/style sink, or an
unsafe URL. The script never calls `console.*` and never logs owner, phone,
pet, message content, tokens, or response bodies.

## Resolve action

The detail view has one explicit "Çözüldü olarak işaretle" action guarded by
a fixed `window.confirm` step. It is disabled while the request is in
flight, and calls:

```text
POST {SUPABASE_URL}/rest/v1/rpc/resolve_staff_work_item
body: { "p_work_item_id": "<work item id>" }
```

Only an exact one-row response with `result` in
`resolved | already_resolved | not_found` is accepted. On `resolved` or
`already_resolved` the item disappears from the list on the next refresh. On
`not_found`, an unauthorized response, a network/HTTP failure, or a
malformed body, the UI shows one generic error without leaking the raw
response or any identifier.

### `public.resolve_staff_work_item`

`SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`, revoked from
`PUBLIC`, `anon`, and `service_role`, executable only by `authenticated`
(defined in `supabase/migrations/20260809000500_staff_workflow.sql`). It
rejects a null work-item id before lookup, locks the exact row, authorizes
with the caller's Supabase identity through the same
`vetai_private.is_clinic_staff(row.clinic_id)` helper used elsewhere, and:

- returns `not_found` for an absent item or one outside the caller's
  clinics, without revealing which case occurred;
- returns `already_resolved` only for an authorized, already-resolved row;
- otherwise sets `status = 'resolved'` and `resolved_at = pg_catalog.now()`
  atomically and returns `resolved`.

It returns exactly one row, never any identifier, PII, message content, or
raw database detail. It fully qualifies every relation/helper, uses no
dynamic SQL, does not accept a clinic id, and does not touch conversation or
outbox state. Direct authenticated table `UPDATE` remains denied. Concurrent
resolve calls on the same row serialize on the row lock and yield one
`resolved`, then `already_resolved` for any replay. No column, policy, table
grant, assignment/audit/note field, or general-purpose mutation endpoint is
added.

## Known limitations

- Session storage only: closing the tab, or letting the access token expire,
  requires signing in again (no refresh-token lifecycle).
- No notification, assignment, or escalation — staff must open `/staff` and
  refresh manually to see new or updated work.
- No reopen, note, or message-sending capability.
- No appointment, analytics, or realtime behavior.
- Not deployed; no real credentials were used or entered.

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
