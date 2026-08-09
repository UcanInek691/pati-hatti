# Current task — 021 minimal staff work surface

Status: `READY`

Primary implementer: Claude Sonnet

Reviewers: Codex, then one read-only Claude Opus architecture/RLS/privacy
review. Opus is required once because this task exposes authenticated clinical
conversation data in a browser and adds a callable `SECURITY DEFINER` mutation.
Do not repeat the review unless Codex makes a material security design change.

## Goal

Deliver one minimal, usable staff workflow:

```text
staff signs in -> sees own clinic's open work, urgent first
               -> opens owner/pet/recent-message detail
               -> explicitly marks the work resolved
```

Use the existing Cloudflare Worker, Supabase Auth, PostgREST, table RLS, and
native browser APIs. Add no UI framework, SDK, dependency, backend proxy, new
Queue, or speculative admin abstraction.

This task does not notify or assign staff, create users, reset passwords,
manage roles/clinics/accounts, add notes, send messages, change conversation
state, reopen work manually, implement appointments, add analytics/realtime,
deploy, or configure real credentials.

## Starting context

- Starting HEAD: `89f3596` on `main`; worktree was clean.
- Task 020 is committed and passed Codex plus Claude Opus review. Its
  `staff_work_items` table contains no phone/message content, grants
  authenticated users SELECT only, and exposes rows only through
  `vetai_private.is_clinic_staff(clinic_id)`.
- Same-clinic authenticated staff already have RLS-protected SELECT access to
  `conversations`, `owners`, `pets`, and `messages`. The staff browser can
  read those tables with its own Supabase access token; the Worker service-role
  credential must never enter a staff response or browser script.
- Task 020 intentionally provides no direct authenticated UPDATE. Resolution
  needs one predefined operation that authorizes the caller's clinic and
  performs the closed state transition.
- Text priority ordering is `normal < urgent`; the open work query must use
  `priority.desc`, then oldest first.
- Work-item erasure follows its source conversation/outbox. This is an
  operational queue, not a tamper-evident clinical audit log.
- The project has no runtime dependency beyond platform APIs and no frontend
  build pipeline. Preserve that property.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify every fact from source, migrations, callers, tests, scripts, Git
status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration `supabase/migrations/20260809000500_staff_workflow.sql`.
- New rollback SQL test `supabase/tests/021_staff_workflow.sql`.
- New `src/staffPage.ts` and `test/staffPage.test.ts`.
- `src/index.ts` and `test/index.test.ts`, limited to the new staff GET routes.
- `src/env.ts`, `.dev.vars.example`, and existing test Env fixtures, limited
  to one required `SUPABASE_ANON_KEY` string binding.
- New `docs/staff-workflow.md` plus narrowly relevant updates to
  `docs/staff-work-items.md` and `docs/database-schema.md`.
- Fill only the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, `wrangler.toml`, existing migrations or
SQL fixtures, webhook/Queue/Cron paths, service-role clients, intake/safety/
reply behavior, prompts, appointment tables, `AGENTS.md`, or
`PROJECT_CONTEXT.md`.

## Database contract

### Resolution RPC

Create exactly one operation:

```text
public.resolve_staff_work_item(p_work_item_id uuid)
returns table(result text)
```

It must be `SECURITY DEFINER`, `VOLATILE`, `SET search_path = ''`, revoked
from `PUBLIC`, `anon`, and `service_role`, and executable only by
`authenticated`.

Behavior:

- reject a null identifier before lookup;
- lock the exact work-item row;
- authorize with the caller's Supabase identity and the existing
  `vetai_private.is_clinic_staff(row.clinic_id)` helper;
- return `not_found` for an absent item or an item outside the caller's
  clinics, without revealing which case occurred;
- return `already_resolved` only for an authorized already-resolved row;
- otherwise atomically set `status = 'resolved'` and
  `resolved_at = pg_catalog.now()`, then return `resolved`;
- return exactly one row and no identifiers, PII, message content, clinic
  existence, or raw database detail.

Fully qualify every relation/helper, use no dynamic SQL, do not accept a
clinic ID, and do not change conversation/outbox state. Preserve direct table
UPDATE denial for authenticated users. Concurrent resolve calls must serialize
on the row and yield one `resolved`, then `already_resolved`.

Do not add columns, policies, table grants, assignment/audit/note fields, or a
general-purpose mutation endpoint in this task.

## Staff browser surface

### Routes and assets

Add only these GET routes:

- `/staff` and `/staff/` — fixed HTML shell;
- `/staff/app.js` — fixed browser JavaScript;
- `/staff/config.json` — JSON containing only normalized `supabaseUrl` and
  `supabaseAnonKey`.

Any non-GET request below `/staff` returns 405 with `Allow: GET`; any unknown
staff subpath returns 404. Existing routes and handlers remain unchanged.

`SUPABASE_ANON_KEY` is a publishable browser credential, never the
service-role key. Require non-blank `SUPABASE_URL` and `SUPABASE_ANON_KEY`;
allow HTTPS or loopback HTTP only. Missing/unsafe configuration returns a
generic 503 for `/staff` and `/staff/config.json`. Never include or compare
against `SUPABASE_SERVICE_ROLE_KEY` in staff assets.

All staff responses use `Cache-Control: no-store`,
`X-Content-Type-Options: nosniff`, and `Referrer-Policy: no-referrer`. The HTML
uses a restrictive CSP: default deny, scripts from self only, no frames/base
objects, and `connect-src` limited to the configured Supabase origin. Keep
JavaScript in `/staff/app.js`; do not enable inline script execution.

### Authentication

The browser JavaScript uses native `fetch` directly against:

```text
POST {SUPABASE_URL}/auth/v1/token?grant_type=password
```

It sends email/password only from the user's browser to Supabase with the
publishable key. It stores only the returned access token in `sessionStorage`,
ignores the refresh token, never logs credentials/tokens, and provides a
logout action that clears the token. On 401/403 it clears the session and
returns to the login form. No signup, password reset, refresh-token lifecycle,
cookie, or Worker credential proxy is added.

### Open-work list

Using the authenticated user's access token and publishable key, request only
the necessary columns from `public.staff_work_items`, filtered to `status =
open`, capped at 100, and ordered exactly:

```text
priority.desc,created_at.asc,id.asc
```

Display fixed Turkish labels for kind/priority/reason, creation time, and a
detail action. Urgent work must be visibly first and marked without relying on
color alone. Provide manual refresh; do not poll or use Realtime.

### Detail

On explicit selection, use the item's `conversation_id` and the same caller
token to read only that RLS-visible conversation, its owner, optional pet, and
at most the latest 20 messages. Display:

- owner name and phone;
- pet name/species when present;
- conversation status/intake stage;
- message direction, timestamp, and content.

Order the fetched messages newest-first at the API boundary, then display them
chronologically. If any linked record is unavailable, show a generic Turkish
error rather than falling back to an unscoped query.

Never fetch `intake_data`, webhook events, outbox rows, provider IDs, payload
hashes, secrets, or more than 20 message bodies. Never put remote data into
`innerHTML`, `outerHTML`, `insertAdjacentHTML`, script, style, or an unsafe URL;
construct dynamic nodes and assign remote text only through `textContent`.
Never log owner, phone, pet, content, token, or response bodies.

### Resolve action

The detail view provides one explicit “Çözüldü olarak işaretle” action with a
fixed confirmation step. It calls:

```text
POST {SUPABASE_URL}/rest/v1/rpc/resolve_staff_work_item
body: { "p_work_item_id": "..." }
```

Accept only an exact one-row response with result `resolved |
already_resolved | not_found`. On `resolved` or `already_resolved`, remove the
item from the open list after refresh. On `not_found`, unauthorized, network,
HTTP, or malformed response, show a generic error without leaking raw body or
identifiers. Disable the action while the request is in flight.

## Required tests

### TypeScript

Prove at least:

- exact `/staff`, `/staff/`, `/staff/app.js`, and `/staff/config.json` GET
  behavior, media types, no-store/security headers, CSP connect origin, 404,
  and staff-subpath 405;
- blank/unsafe URL or blank anon key fails closed with 503;
- config returns only the two public fields and never includes the service-role
  value/name;
- HTML has semantic login, queue, detail, refresh, logout, and status/error
  regions, references only the self-hosted script, and has no inline script;
- browser source uses native fetch/sessionStorage, password-grant auth,
  `priority.desc,created_at.asc,id.asc`, `status=eq.open`, `limit=100`, latest
  20 messages, closed resolve RPC/result set, fixed confirmation, logout, and
  401/403 session clearing;
- browser source contains no service-role reference, console call, dynamic
  HTML sink, eval/function constructor, refresh-token persistence, webhook,
  outbox, intake-data, or unrestricted select;
- all dynamic provider/user values are routed to `textContent` only;
- existing webhook, Queue, scheduled, health, and unknown-route behavior stays
  green.

Do not call real Supabase or add a DOM/test dependency. Source-level assertions
are acceptable for this fixed, dependency-free asset; mock any Worker fetch.

### Rollback SQL fixture

`supabase/tests/021_staff_workflow.sql` runs inside `BEGIN`/`ROLLBACK` and
proves at least:

- same-clinic authenticated staff resolves one open item and receives exactly
  `resolved`, with coherent `resolved_at`;
- replay by the same authorized staff returns `already_resolved` with no
  timestamp rewrite;
- another clinic's item and an unknown UUID both return `not_found` with zero
  mutation;
- authenticated user without clinic membership receives `not_found`;
- `anon`, `PUBLIC`, and `service_role` cannot execute the RPC;
- authenticated direct table UPDATE remains denied;
- null input fails before mutation;
- concurrent behavior is documented as not proven by the single-session test,
  while the row lock is verified from the stored function definition;
- a Task 020 urgent open handoff remains urgent/emergency after a later
  handoff update with no true signal;
- function security-definer/search-path/grant shape and the existing one-policy
  table RLS shape are unchanged;
- rollback leaves zero fixture residue.

Sonnet must not apply the migration or SQL fixture. Codex alone validates them
on disposable `vetai-test`.

## Documentation

Create `docs/staff-workflow.md` describing the exact login/list/detail/resolve
flow, direct RLS reads, controlled resolution RPC, data displayed, public anon
key versus forbidden service-role key, sessionStorage/no-refresh limitation,
security headers/CSP, manual refresh/no notification, and all omitted admin/
appointment/deployment behavior.

Update `docs/staff-work-items.md` and `docs/database-schema.md` narrowly. Mark
the migration/SQL test `NOT APPLIED` until Codex validates them. Do not claim a
person was notified, assigned, or responded.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Also start Wrangler locally with placeholder public configuration and manually
verify the fixed `/staff` shell, app asset, config shape, 405, and 404. Do not
enter a real staff credential or call real Supabase.

Do not commit, push, deploy, apply SQL, call real Meta/OpenAI/Supabase, create a
resource/user, install a plugin/dependency, or mutate an external service.

## Review gate

After Sonnet delivers, Codex reviews the complete browser-auth/RLS/RPC/data-
display path, runs all checks, applies the migration and rollback fixture only
to disposable `vetai-test`, performs a local page smoke test, makes minimum
fixes, updates `PROJECT_CONTEXT.md`, and records the result.

Then Claude Opus performs one read-only review focused on callable
`SECURITY DEFINER`, tenant isolation, browser credential separation, PII/XSS,
resolution authorization, urgent-first ordering, and truthful operational
claims. PASS closes the task; only a material blocking fix requires a narrow
re-check.

## Observed context — Sonnet fills before coding

Pending.

## Delivery record — Sonnet fills after coding

Pending.
