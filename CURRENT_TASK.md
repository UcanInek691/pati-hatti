# Current task — 021 minimal staff work surface

Status: `COMPLETE`

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

- Read `AGENTS.md`, `PROJECT_CONTEXT.md`, and this file in full before editing.
  Starting `HEAD` was `89f3596` on `main`; `git status` showed a clean
  worktree, matching the "Starting context" claim above.
- Confirmed `supabase/migrations/20260809000400_staff_work_items.sql` (Task
  020): `staff_work_items` has RLS enabled with exactly one authenticated
  `SELECT` policy gated by `vetai_private.is_clinic_staff(clinic_id)`; no
  authenticated `INSERT`/`UPDATE`/`DELETE` grant exists, which is why an
  RPC — not a PostgREST `PATCH` — is required to resolve an item.
- Confirmed `supabase/migrations/20260808000200_finalize_intake_queue_job.sql`
  as the codebase's existing style reference for a `SECURITY DEFINER`
  function: parameter null-checks before lookup, `FOR UPDATE` row locking,
  `RETURNS TABLE(result text)`, `SET search_path = ''`, fully-qualified
  relations, and explicit `revoke`/`grant execute` statements.
- Confirmed `conversations`/`owners`/`pets`/`messages` already grant
  authenticated RLS-scoped `SELECT` via the same `is_clinic_staff` helper
  (`supabase/migrations/20260806000000_core_tenant_schema.sql`), so the
  staff browser can read detail data directly with the caller's own access
  token and the publishable anon key — no new table grant is needed.
- Confirmed `package.json` has no DOM/UI/testing-library dependency beyond
  `vitest`, `wrangler`, `typescript`, `@cloudflare/workers-types` — the staff
  page had to stay dependency-free and source-testable, not DOM-tested.
- Confirmed `src/env.ts` had no `SUPABASE_ANON_KEY` binding yet, and that no
  existing code path used the Supabase anon (publishable) key — only the
  service-role key, which must never reach a staff response or script.
- Confirmed `supabase/tests/020_staff_work_items.sql` as the rollback-fixture
  style reference (`BEGIN`/`ROLLBACK`, deterministic fixture UUIDs,
  `set local role` + `request.jwt.claim.sub` to simulate an authenticated
  identity, zero-residue verification after rollback).

## Delivery record — Sonnet fills after coding

### Changed files

- `supabase/migrations/20260809000500_staff_workflow.sql` (new) —
  `public.resolve_staff_work_item(p_work_item_id uuid) returns
  table(result text)`. **NOT APPLIED.**
- `supabase/tests/021_staff_workflow.sql` (new) — rollback-only SQL proof
  fixture for the RPC. **NOT APPLIED / NOT RUN** by Sonnet.
- `src/staffPage.ts` (new) — `StaffConfig`, `readStaffConfig`, `STAFF_HTML`,
  `STAFF_APP_JS`, `handleStaffShell`, `handleStaffScript`,
  `handleStaffConfig`.
- `src/index.ts` — added the staff routing block only (GET `/staff`,
  `/staff/`, `/staff/app.js`, `/staff/config.json`; 405 with `Allow: GET`
  for other methods; 404 for unknown `/staff/*` subpaths). Existing
  `/health`, `/webhooks/whatsapp`, `queue`, and `scheduled` handlers are
  unchanged.
- `src/env.ts`, `.dev.vars.example` — added the `SUPABASE_ANON_KEY` binding.
- `test/staffPage.test.ts` (new) — 32 tests covering `readStaffConfig`,
  `handleStaffShell`, `handleStaffScript`, `handleStaffConfig`, and
  source-level assertions on `STAFF_HTML`/`STAFF_APP_JS`.
- `test/index.test.ts` — added a `SUPABASE_ANON_KEY` field to the shared
  `Env` fixture and one new `describe("worker staff routes", ...)` block
  covering `/staff` routing (200/503/405/404); existing webhook/Queue/
  scheduled/health/unknown-route tests are untouched and still pass.
- `test/conversationState.test.ts`, `test/intakeConsumer.test.ts`,
  `test/intakeJobLease.test.ts`, `test/openaiIntake.test.ts`,
  `test/outboundDelivery.test.ts`, `test/outboundSender.test.ts`,
  `test/supabaseIngest.test.ts`, `test/supabaseOutboundStatus.test.ts`,
  `test/whatsappSend.test.ts` — added only the `SUPABASE_ANON_KEY: "test-anon-key"`
  field their existing `Env` fixtures needed once the binding became
  required (these files were previously omitted from the "Allowed changes"
  list's explicit examples but fall under "existing test Env fixtures,
  limited to one required `SUPABASE_ANON_KEY` string binding"; without this
  addition `pnpm typecheck` fails with `TS2741` in each).
- `docs/staff-workflow.md` (new); `docs/staff-work-items.md`,
  `docs/database-schema.md` — narrow additions cross-referencing the new
  RPC and marking it **NOT APPLIED**.
- `CURRENT_TASK.md` — this section only.

### Acceptance criteria

- Database contract: `resolve_staff_work_item` is `SECURITY DEFINER`,
  `VOLATILE`, `SET search_path = ''`, revoked from `PUBLIC`/`anon`/
  `service_role`, granted only to `authenticated`; rejects a null id before
  lookup; locks the row with `FOR UPDATE`; authorizes via
  `vetai_private.is_clinic_staff(row.clinic_id)`; returns indistinguishable
  `not_found` for an absent row or one outside the caller's clinics;
  returns `already_resolved` only for an authorized already-resolved row;
  otherwise sets `status = 'resolved'`, `resolved_at =
  pg_catalog.now()` and returns `resolved`; returns exactly one row; fully
  qualifies every relation; accepts no clinic id; touches no
  conversation/outbox state. Verified by source review against the
  contract text; **not verified by running SQL**, per the instruction that
  Sonnet must not apply the migration.
- Staff browser surface: routes, media types, security headers, CSP,
  405/404 behavior, auth flow, list query shape, detail scope, resolve
  action, and every "must not contain" bullet (service-role reference,
  console call, dynamic HTML sink, eval/Function, refresh-token
  persistence, webhook/outbox/intake-data reference, unrestricted select)
  are all asserted directly in `test/staffPage.test.ts` and pass.
- Out-of-scope items (notification, user creation, password reset, role/
  clinic/account management, notes, messaging, conversation-state changes,
  reopen, appointments, analytics/realtime, deployment, real credentials)
  were not built.

### Checks run

```text
pnpm install --frozen-lockfile   → up to date, exit 0
pnpm typecheck                   → exit 0, no errors
pnpm test                        → 672 passed, 0 failed (includes all new
                                    staffPage.test.ts and staff-route tests
                                    in index.test.ts)
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  → exit 0, "--dry-run: exiting now."
git diff --check                 → exit 0 (only benign CRLF-conversion
                                    notices, no whitespace errors)
```

### Checks not run, and why

- **Local `/staff` smoke test (`wrangler dev` with placeholder config):
  attempted, could not complete.** A `.dev.vars` file with clearly
  placeholder, non-real values (`http://127.0.0.1:54321` Supabase URL,
  placeholder keys/tokens — never entered anywhere real) was created,
  gitignored, and removed again after the attempt. `pnpm exec wrangler dev`
  loaded the config and bindings correctly (confirmed by its own startup
  log, which listed all seven `Env` bindings including the new
  `SUPABASE_ANON_KEY`), but the underlying `workerd` runtime crashed before
  serving any request: `*** std::terminate() called with no exception` /
  `The Workers runtime failed to start. There was likely a problem with the
  workerd binary or your configuration.` This crash occurs during `workerd`
  process startup, before the Worker's `fetch` handler — and therefore
  before any of my routing code — ever runs, on both a Git Bash and a
  PowerShell/cmd launch. It is a local Windows `workerd`-binary/environment
  problem, not something introduced by this task's diff; `wrangler deploy
  --dry-run` (which builds and validates the same bundle without invoking
  `workerd`) succeeded. Recommend Codex or Opus attempt the local `wrangler
  dev` smoke test on their own environment as part of review; I could not
  complete it here.
- SQL migration and rollback fixture: intentionally not applied or run, per
  explicit instruction ("Sonnet must not apply the migration or SQL
  fixture... Codex alone validates them on disposable `vetai-test`").
- No real Meta/OpenAI/Supabase credentials were used, entered, or called at
  any point.

### Known limitations (see also `docs/staff-workflow.md`)

- sessionStorage-only auth: closing the tab or token expiry requires
  re-login; no refresh-token lifecycle.
- No notification/assignment; staff must open `/staff` and refresh
  manually.
- No reopen, note, or messaging capability; no appointment/analytics/
  realtime behavior.
- Not deployed.

### Risks Codex/Opus should inspect

- The RPC's authorization and result-shape correctness is asserted only by
  source review here; Codex's SQL-fixture run against disposable
  `vetai-test` is the actual proof and has not happened yet.
- The local Worker runtime smoke test did not complete (see above); Codex's
  own local run is the first real confirmation that `/staff`,
  `/staff/app.js`, and `/staff/config.json` serve correctly end to end.
- `isSafeSupabaseUrl` in `src/staffPage.ts` accepts `https:` unconditionally
  and `http:` only for `localhost`/`127.0.0.1`/`[::1]` (matching
  `URL.hostname`'s bracketed IPv6 form) — worth Opus double-checking this
  is the intended loopback allowlist and that no other bypass exists.

## Codex review record

Codex reviewed the complete diff and browser/RLS/RPC call path on 2026-08-09.
The allowed-change boundary is intact; no dependency, lockfile, Wrangler,
webhook, Queue, Cron, intake, prompt, or existing migration drift was found.

Minimum fixes made during review:

- normalized `SUPABASE_URL` to a root origin and rejected credentials, path,
  query, and fragment components;
- added the required no-store/nosniff/no-referrer headers to staff 404/405
  responses and `form-action 'none'` to prevent a no-JavaScript login form
  submission from placing credentials in a URL;
- made the resolve response parser reject additional row fields and corrected
  one Turkish error string;
- repaired the rollback fixture's null-input false positive, PostgreSQL 17
  empty-search-path representation, implicit function-owner privilege
  accounting, authenticated access to its temporary ID table, and
  transaction-timestamp expectation. These were test-proof defects, not RPC
  behavior changes.

Verification after the fixes:

```text
pnpm install --frozen-lockfile   -> PASS (unchanged lock)
pnpm typecheck                   -> PASS
pnpm test                        -> PASS (676/676, 22 files)
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> PASS (no deployment)
git diff --check                 -> PASS
```

Wrangler local smoke testing with placeholder-only values passed for the
fixed `/staff` shell, JavaScript, two-field config, 405, and 404 responses.
No real staff login or Supabase browser call was made.

Codex applied the migration only to disposable `vetai-test`. The corrected
rollback fixture returned `PASS` with `remaining_test_clinics = 0`,
`remaining_test_users = 0`, and `remaining_test_items = 0`. A separate
catalog query confirmed: function present; `SECURITY DEFINER`; `VOLATILE`;
empty search path; execute allowed for `authenticated` and denied for
`PUBLIC`, `anon`, and `service_role`; staff table RLS enabled with one policy;
zero fixture users/clinics. No production migration or migration-history
entry was created.

Codex decision: **PASS, pending the single mandatory read-only Claude Opus
review.** No commit is made until that review passes.

## Claude Opus review record

Claude Opus completed the mandatory read-only architecture/RLS/privacy review
on 2026-08-10 and returned **PASS** with no blocking finding. The review
independently reran all 676 tests and verified the caller-identity
`SECURITY DEFINER` boundary, indistinguishable absent/cross-tenant results,
closed grants, publishable-key/service-role separation, RLS-protected PII,
`textContent`-only rendering, CSP/URL controls, urgent-first ordering,
fail-closed resolution parsing, and truthful operational claims.

Accepted non-blocking notes: the trusted operator URL binding could receive
additional hostname-character hardening; the RPC locks the target row before
membership authorization, which can cause only a short statement-lifetime
lock for a guessed UUID; absent and cross-tenant paths are not timing-equal;
membership revocation currently means deleting the `clinic_staff` row. These
do not expose data or weaken the reviewed tenant boundary and do not justify
another implementation/review cycle for this MVP task.

Final decision: **PASS / COMPLETE**. No production deploy, production
migration, real staff login, or external provider call occurred.
