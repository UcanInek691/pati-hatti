# Current task — 033 Selective WhatsApp automation and manual takeover

Status: `COMPLETE`

Owner: Codex

## Goal

Let one WhatsApp Business number serve both automated clinic contacts and
human-only/personal contacts without asking AI to guess which is which.

The closed routing modes are:

- `ai`: preserve the reviewed intake/appointment/reply pipeline;
- `manual`: persist the inbound clinic conversation, but perform no Queue send,
  OpenAI call, intake/appointment mutation, or bot reply; and
- `personal`: acknowledge the signed webhook without creating/updating an
  owner, message, conversation, webhook event, or Queue job. The preconfigured
  routing row necessarily retains the contact's E.164 number.

An exact contact override belongs to one WhatsApp account. When no override
exists, the account default applies. Every existing and newly created account
defaults to `manual`; a dedicated automation-only staging/production number may
be explicitly configured as `ai` by an authorized operational setup outside
this task.

This task also adds a minimal authenticated control to `/staff` so a clinic
operator can set an exact E.164 contact to `ai`, `manual`, `personal`, or back
to the account default. It does not infer friendship/customer status from text,
prompt output, contact names, or previous conversation content.

## Scope

Allowed changes:

- `supabase/migrations/20260814000300_selective_automation.sql` (new)
- `supabase/tests/033_selective_automation.sql` (new, rollback-only)
- `src/supabaseIngest.ts`
- `src/contactAutomation.ts` (new)
- `src/whatsappIngest.ts`
- `src/intakeJobLease.ts`
- `src/intakeConsumer.ts`
- `src/appointmentFlow.ts`
- `src/index.ts`
- `src/staffPage.ts`
- `test/supabaseIngest.test.ts`
- `test/contactAutomation.test.ts` (new)
- `test/whatsappIngest.test.ts`
- `test/intakeJobLease.test.ts`
- `test/intakeConsumer.test.ts`
- `test/appointmentFlow.test.ts`
- `test/index.test.ts`
- `test/staffPage.test.ts`
- `docs/selective-automation.md` (new)
- `docs/database-schema.md`
- `docs/inbound-queue.md`
- `docs/staff-workflow.md`
- `docs/product-roadmap.md` — Task 033 status paragraph only
- `CURRENT_TASK.md` — implementer fills only **Observed context** and
  **Delivery record**

Do not change:

- prompt text/version, OpenAI model/configuration, extraction schema, safety
  decision, clinical copy, clinic-hours copy, appointment copy, or media copy;
- webhook signature/size/content-type validation or outbound Meta request
  format;
- existing migration files, core RLS policies, staff work-item creation/status
  rules, appointment rules, Queue retry/DLQ limits, dependencies, lockfile,
  Wrangler bindings, or production resources;
- current staff authentication/session design or staff claim/resolve behavior.

Do not add content-based routing, AI classification of personal contacts, a
CRM, a second inbox, a staff free-text sender, contact import/sync, address-book
access, WhatsApp message-echo parsing, push/e-mail/SMS alerts, a framework, or a
new dependency.

## Verified starting evidence

- Task 032 is complete and committed at `9e45f1c`; the worktree was clean
  before this contract.
- Every supported inbound message currently persists first, then every
  `processed | duplicate` outcome is enqueued. No contact/account automation
  route exists.
- The Queue consumer claims the event before reading context or calling
  OpenAI. Generic and appointment finalizers lock the exact event before
  mutating conversation/appointment/outbox state.
- `/staff` already has RLS-scoped Supabase Auth and can render same-clinic
  operational data safely, but it cannot configure contact routing or send a
  human WhatsApp message.
- Meta's official Cloud API documentation supports systems connecting users
  with agents or bots. Same-number WhatsApp Business App/Cloud API coexistence
  eligibility and message-echo behavior have not been verified for the chosen
  Turkish pilot account and remain a real-staging gate.
- Meta webhook subscription is WABA/phone-number scoped rather than
  contact-scoped. Therefore the signed raw webhook necessarily reaches the
  Worker for every covered inbound event; absolute non-receipt of personal
  message bytes requires a separate number/account boundary.

## Required behavior

### 1. Closed account/contact routing data

The migration must:

- add `automation_default text not null default 'manual'` to
  `public.whatsapp_accounts`, constrained to `ai | manual`;
- create `public.whatsapp_contact_routes` with exactly the routing identity,
  mode, and timestamps needed for this feature:
  `clinic_id`, `whatsapp_account_id`, `contact_e164`, `mode`, `created_at`,
  `updated_at`;
- make `(whatsapp_account_id, contact_e164)` the primary/unique identity;
- constrain `contact_e164` to canonical E.164 and `mode` to
  `ai | manual | personal`;
- bind `(whatsapp_account_id, clinic_id)` to the existing composite WhatsApp
  account key with `ON DELETE CASCADE`, and cascade clinic/account erasure;
- enable RLS, revoke default access, grant same-clinic authenticated `SELECT`
  only through one `is_clinic_staff(clinic_id)` policy, and grant backend
  access only to `service_role`;
- reuse the existing updated-at trigger function; add no audit/history table.

An override is account-specific. Removing it restores that exact account's
default. Route rows contain a phone number and are therefore personal data;
they must never be logged, sent to OpenAI, placed in browser notifications, or
claimed to be anonymous.

### 2. Closed authenticated route mutation

Create one RPC:

```text
public.set_whatsapp_contact_route(
  p_whatsapp_account_id uuid,
  p_contact_e164 text,
  p_mode text
)
```

`p_mode` accepts only `ai | manual | personal | inherit`; `inherit` deletes the
override. The function must be `SECURITY DEFINER`, `VOLATILE`,
`SET search_path=''`, executable only by `authenticated`, and revoked from
`PUBLIC`, `anon`, and `service_role`.

It must validate inputs before mutation, lock/resolve the exact WhatsApp
account, authorize its clinic through `vetai_private.is_clinic_staff`, and
return the same `not_found` result for an absent/cross-tenant account. It may
return only the closed one-column results `updated | unchanged | not_found`.
It must not return an account, clinic, contact, owner, or actor identifier.

When an owner with the exact clinic/phone already exists, lock that owner row
before changing the route. When the resulting route is `manual` or `personal`,
delete only still-`pending` automated outbox rows for that exact account and
owner's conversations in the same transaction. Never delete or rewrite
`processing`, `accepted`, or `failed` rows. This lock order must serialize the
route change with intake finalization so an uncommitted finalizer cannot insert
a new pending reply after the cleanup.

The UI and docs must truthfully warn that an outbound row already claimed as
`processing` may already be leaving the system and cannot be recalled.

### 3. Route before persistence and paid work

Implement a two-phase inbound boundary. After signature verification and JSON
decoding, `src/whatsappIngest.ts` must first extract/validate only the envelope
fields required for routing: exact phone-number ID, sender E.164, provider
message ID, timestamp, and declared message type. It must not access nested
text/media/contact/location/document fields during this phase.

Add a native-fetch, service-role-only client and a matching fixed RPC:

```text
public.resolve_whatsapp_contact_automation(
  p_phone_number_id text,
  p_contact_e164 text
)
```

The RPC returns exactly one closed `ai | manual | personal | unknown_account`
result, derives the clinic/account internally, exposes no identifier or PII,
is `SECURITY INVOKER`, `STABLE`, `SET search_path=''`, and is executable only
by `service_role`. The client must use the repository's HTTPS/loopback and
strict fail-closed response rules and must never log inputs or bodies.

Resolve every validated candidate before materializing any non-personal
message. A failed route lookup fails the webhook closed. For effective
`personal`, stop at the envelope: do not access or validate nested message
content, construct a content-bearing ingest item, compute a payload hash, call
the ingest RPC, persist data, enqueue work, or invoke OpenAI. Tests must use a
throwing nested-content getter/proxy to prove the personal path never reads it.

The Worker still necessarily receives and JSON-decodes Meta's signed webhook
payload in transient memory. The product/docs must say “content is not
inspected, logged, hashed, forwarded, or persisted by VetAI after routing,” not
claim that the infrastructure never receives the bytes. A separate WhatsApp
number is the only supported option when absolute non-receipt is required.

After all route lookups succeed, materialize and fully validate only `ai` and
`manual` items before performing any persistence, preserving the existing
whole-webhook malformed-item rejection for those routes. Keep text/media
canonical hashing byte-for-byte unchanged.

Replace `ingest_whatsapp_text_message` only in the new migration, preserving
its signature and existing validation/idempotency/tenant behavior for AI
traffic.

Recheck the exact account and `(account, sender E.164)` override inside the
ingest transaction before any event/owner/conversation/message write, so a
route change between the pre-route read and mutation cannot persist content or
enqueue automation:

- effective `personal` -> return `ignored` with null conversation ID and make
  zero database writes;
- effective `manual` -> persist the existing sanitized inbound/event/owner/
  conversation/message record atomically, but make the event intake state
  terminally completed and return `manual` with its conversation ID;
- effective `ai` -> preserve current `processed | duplicate` behavior and
  pending intake state.

Unknown accounts remain `unknown_account` with zero writes. Exact duplicate
delivery under a currently manual/personal route must not create/enqueue new AI
work. Do not read or classify message text to choose a route.

Update the strict native-fetch result parser and webhook route so only
`processed | duplicate` enqueue. `manual | ignored` are successful HTTP-200
outcomes with no Queue send; malformed/unknown Data API results remain failed.
Operational logs may contain fixed aggregate counts only, never account/contact
identifiers, message content, route-table values, or provider bodies.

This route lookup adds no model tokens. It adds at most one bounded Supabase
read per recognized inbound candidate; `manual` and `personal` routes make zero
OpenAI calls, so they reduce paid model usage relative to the current behavior.

### 4. Pending-job and finalization race closure

Extend `claim_intake_queue_job` in the new migration so a valid claim returns
the current closed automation mode in addition to its existing data. For
`manual | personal`, do not return `message_text`; the TypeScript parser must
require exact null/value coherence. The consumer must complete the claimed
lease immediately and acknowledge it before context lookup, safety hashing,
OpenAI, planning, appointment calls, clinic-hours lookup, or reply creation.

Create/reuse one narrowly scoped private helper that locks the conversation's
owner and resolves the effective route from the exact event account. Revoke
direct execution except where the reviewed service-role finalizers need it.

In the new migration, replace the current bodies of:

- `finalize_intake_queue_job`;
- `finalize_appointment_offer_queue_job`; and
- `finalize_appointment_decision_queue_job`.

After each finalizer validates and locks the current event/claim, but before
any conversation, slot, or outbox mutation, it must lock/recheck the effective
route. If the route is no longer `ai`, atomically complete the current intake
lease and return a new closed `suppressed` result with null stage/version.
There must be zero conversation-state change, appointment hold/confirmation/
release, or outbox insert in that branch.

Update all three strict TypeScript clients and consumer dispositions so
`suppressed` is accepted only with the exact null shape and is acknowledged.
Every other result and failure behavior remains unchanged.

### 5. Minimal staff routing controls

Keep `/staff` dependency-free. Add a separate fixed “WhatsApp otomasyonu”
section that:

- loads the caller's RLS-scoped WhatsApp accounts with only
  `id,display_name,automation_default`;
- loads at most 100 configured routes for the selected account with only
  `contact_e164,mode,updated_at`, ordered newest first;
- accepts one exact canonical E.164 input and fixed actions for
  `AI açık`, `Sadece insan`, `Kişisel / yok say`, and `Numara varsayılanı`;
- calls only `set_whatsapp_contact_route` and accepts only its exact one-row
  closed result;
- refreshes only this bounded routing section after a successful change.

Use `textContent`/native DOM only. Never store account/contact/route data in
`sessionStorage`, local storage, notifications, URLs, or logs. Existing login,
queue/detail, ownership, polling, and browser-alert behavior must not change.

Display fixed Turkish explanations:

- `AI açık`: future messages may enter the automated intake flow;
- `Sadece insan`: messages are retained for the clinic, but VetAI does not
  answer or call OpenAI;
- `Kişisel / yok say`: future message content and owner/conversation records
  are not persisted by VetAI, while the routing phone remains stored, and the
  bot does not answer;
- `Numara varsayılanı`: removes the override;
- changing to manual/personal does not erase earlier stored records; and
- a reply already in provider delivery may still arrive.

Do not imply that a human was notified or will answer. This task adds no human
message composer.

### 6. Same-number manual messaging ceiling

Document that route controls only silence VetAI. Human same-number replies
require either:

1. Meta-supported WhatsApp Business App/Cloud API coexistence on the chosen
   account; or
2. a later reviewed staff free-text sender through Cloud API.

Task 034 must verify the chosen account's current Coexistence eligibility,
onboarding behavior, and outbound message-echo/webhook behavior in real
staging. If it is unavailable, manual compose/send becomes a pilot blocker.
Do not claim coexistence is available in Türkiye or for this account until
that staging evidence exists.

## Required tests

### SQL rollback fixture

Prove at minimum:

- default/manual/AI/contact-override resolution and exact account isolation;
- personal mode writes no webhook event, owner, conversation, or message;
- manual mode persists exactly one inbound conversation/message but completes
  intake and cannot be claimed;
- AI mode preserves processed/duplicate behavior;
- route mutation same-clinic success, idempotency, inherit deletion,
  cross-tenant/absent indistinguishability, invalid-input rejection, RLS,
  grants, account/clinic erasure, and zero fixture residue;
- changing to manual/personal deletes only exact pending outbox rows and leaves
  processing/accepted/failed rows unchanged;
- claim returns mode with strict null text for non-AI;
- generic/appointment-offer/appointment-decision finalizers return
  `suppressed`, complete the lease, and cause zero state/slot/outbox mutation
  after a route change;
- function security/search-path/grant shape and the common owner-lock route
  check.

The rollback fixture may prove sequential state outcomes, but must not claim a
real two-session race. Codex reviews lock order and may run a separate
two-session check on disposable `vetai-test` if practical.

### TypeScript/browser-source tests

Cover strict accept/reject shapes for all new ingest/claim/finalizer results;
strict route-client outcomes; envelope-first routing; a personal candidate
whose nested content throws on access; whole-webhook validation before writes
for AI/manual candidates; zero Queue send for `manual | ignored`; zero
context/OpenAI/planner/appointment/clinic lookup for a non-AI claim;
acknowledgment of `suppressed` on every finalizer path; unchanged AI behavior;
exact account/route projections and bounds; exact E.164 input handling; all
route actions/results; fixed Turkish explanations; and absence of
console/unsafe HTML/storage/notification leaks.

## Documentation

Create `docs/selective-automation.md` and narrowly update existing docs to
explain:

- account default versus exact contact override;
- why the system never guesses friend/customer status;
- persistence and AI behavior of each mode;
- the honest webhook privacy boundary: Meta still delivers the signed payload
  to the Worker, but personal nested content is not inspected, hashed, logged,
  forwarded to Supabase/OpenAI, or persisted after envelope routing;
- a separate number/account is required if the owner needs personal messages
  never to reach VetAI infrastructure at all;
- the bounded Supabase routing read versus zero OpenAI-token usage for manual
  and personal messages;
- pending-reply cleanup, finalizer recheck, and the irreducible already-in-
  flight send caveat;
- same-number Coexistence is an unverified staging dependency, not a shipped
  capability;
- `personal` route phone numbers are still personal data, and earlier stored
  records are not automatically erased;
- operator procedure for pre-marking friends, enabling AI for selected
  customers, taking a customer back to manual, and restoring the default;
- no staff notification, response-time promise, free-text sender, echo import,
  contact sync, or account-default admin UI exists in this task.

Include links to Meta's official Cloud API documentation and official
Business-App-user onboarding/Coexistence documentation, while stating that
actual account eligibility is verified only in Task 034 staging.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Migration apply and `supabase/tests/033_selective_automation.sql` are `NOT RUN`
for Sonnet. Codex applies/tests them only on disposable `vetai-test` after
review.

Do not run paid OpenAI evals: this task changes no prompt, model, extraction
contract, model context, safety decision, or customer copy.

No commit, push, deploy, database mutation, real Meta/WhatsApp call, contact
import, plugin installation, or external resource change is authorized for the
implementer.

## Review gates

1. Codex reviews the ingest/claim/finalizer/outbox race, all result parsers,
   UI privacy, and local checks; then applies/tests SQL only on disposable
   `vetai-test`.
2. Claude Opus performs one read-only review because this task changes
   persistence suppression, tenant-visible phone routing, `SECURITY DEFINER`
   mutation, and human/AI control boundaries.
3. Codex applies only verified targeted fixes, updates `PROJECT_CONTEXT.md`,
   and commits after all gates pass.
4. Turkish legal/KVKK review of routing-number retention and same-number
   personal/business use remains an external production gate.

## Observed context

Confirmed by reading `AGENTS.md`, `PROJECT_CONTEXT.md`, and this file in
order, then the repository itself, before any edit:

- Worktree was clean at commit `9e45f1c` (Task 032, "feat: add pilot staff
  ownership and alerts") before this task's edits began.
- `public.whatsapp_accounts` had no `automation_default` column and no
  per-contact routing table existed; every inbound message persisted first
  and every `processed | duplicate` outcome was unconditionally enqueued
  (`src/index.ts`, `src/supabaseIngest.ts`).
- `src/whatsappIngest.ts`'s `extractInboundMessages` validated full message
  content with no route-lookup phase; no `resolve_whatsapp_contact_automation`
  or `set_whatsapp_contact_route` RPC existed.
- `claim_intake_queue_job` (`supabase/migrations/20260808000100_intake_job_lease.sql`)
  returned only `result | claim_token | message_text`, no automation mode;
  `complete_intake_queue_job` was already defined there and reused unchanged
  by this task's consumer short-circuit — Task 033 does not redefine it.
- `finalize_intake_queue_job`, `finalize_appointment_offer_queue_job`, and
  `finalize_appointment_decision_queue_job` had no route recheck and no
  `suppressed` result kind (defined across
  `20260808000200_finalize_intake_queue_job.sql`,
  `20260809000100_intake_reply_outbox.sql`, and
  `20260810000200_whatsapp_appointment_flow.sql`).
- `/staff` (`src/staffPage.ts`) already had RLS-scoped Supabase Auth and a
  non-resolved work list, browser alerts, and claim/detail UI, but no
  contact-routing controls and no `set_whatsapp_contact_route` caller.
- `docs/selective-automation.md` did not exist; `docs/database-schema.md`,
  `docs/inbound-queue.md`, and `docs/staff-workflow.md` had no Task 033
  content; `docs/product-roadmap.md`'s Task 033 paragraph was written in
  future/planned tense.

## Delivery record

Implemented strictly within the allowed-changes list; `git status
--porcelain` after implementation shows exactly the allowed new/modified
files and nothing else:

- New: `supabase/migrations/20260814000300_selective_automation.sql`,
  `supabase/tests/033_selective_automation.sql`, `src/contactAutomation.ts`,
  `test/contactAutomation.test.ts`, `docs/selective-automation.md`.
- Modified: `src/supabaseIngest.ts`, `src/whatsappIngest.ts`,
  `src/intakeJobLease.ts`, `src/intakeConsumer.ts`, `src/appointmentFlow.ts`,
  `src/index.ts`, `src/staffPage.ts`, `test/whatsappIngest.test.ts`,
  `test/intakeJobLease.test.ts`, `test/intakeConsumer.test.ts`,
  `test/appointmentFlow.test.ts`, `test/index.test.ts`,
  `test/staffPage.test.ts`, `docs/database-schema.md`,
  `docs/inbound-queue.md`, `docs/staff-workflow.md`, `docs/product-roadmap.md`
  (Task 033 status paragraph only).
- No file outside this list was touched. `CURRENT_TASK.md` was edited only
  in this "Observed context" and "Delivery record" section.

**Local verification run (all commands from "Required verification"):**

```text
pnpm install --frozen-lockfile   -> already up to date, exit 0
pnpm typecheck                   -> tsc --noEmit, exit 0 (see fix below)
pnpm test                        -> 32 test files passed, 1328 tests passed,
                                     2 skipped (test/liveOpenAiEval.test.ts,
                                     test/liveOpenAiMultiTurnEval.test.ts —
                                     paid OpenAI evals, correctly not run)
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> succeeded, "--dry-run: exiting now."
git diff --check                 -> exit 0 (only benign LF/CRLF
                                     autocrlf warnings, no whitespace errors)
```

`pnpm typecheck` initially failed with 3 `TS2322` errors in
`test/intakeConsumer.test.ts` (the `claimRow` test helper's `message_text`
override was typed `string | undefined` but three non-`ai` claim fixtures
correctly pass `message_text: null`, matching the real RPC shape). Fixed by
widening the helper's type to `string | null | undefined`; no behavior
change. All five commands above pass cleanly after that fix.

**Explicitly not run, per contract:**

- The migration was not applied to any database (local, `vetai-test`, or
  production) and `supabase/tests/033_selective_automation.sql` was not
  executed. Both are reserved for Codex on disposable `vetai-test` after
  review.
- No real Meta/WhatsApp API call and no real (paid) OpenAI call were made.
- No `git commit`, `git push`, or deploy was performed.

**Test coverage added/changed this task:** `test/contactAutomation.test.ts`
(new, 20 tests) for the route-resolution client; targeted additions/updates
across `test/whatsappIngest.test.ts`, `test/intakeJobLease.test.ts`,
`test/intakeConsumer.test.ts`, `test/staffPage.test.ts`, and
`test/index.test.ts` (including new coverage for `manual`/`ignored` ingest
outcomes and the envelope-first routing call sequence).

**Codex review correction:** route lookup is still envelope-first, but a
missing Supabase configuration, network failure, or malformed route-RPC
response is an operational failure and returns retryable HTTP 503. Only a
malformed inbound envelope/content returns HTTP 400. This prevents a
transient routing outage from being acknowledged as a permanent bad request.

## Codex review record

Codex reviewed the full Task 033 diff and call paths, applied targeted fixes,
and reran every required local check.

Targeted fixes:

- deferred WhatsApp `contacts/profile` inspection until after a candidate has
  resolved non-`personal`; a throwing `contacts` getter now proves the personal
  path touches envelope fields only;
- distinguished malformed inbound data (HTTP 400) from route-service/config
  failures (retryable HTTP 503);
- removed unreachable early returns from
  `set_whatsapp_contact_route` so pending outbox cleanup actually executes;
- serialized ingest against route mutation on the exact account row with
  `FOR KEY SHARE`, while the setter holds `FOR UPDATE`;
- kept an exact duplicate under a currently manual route terminally `manual`
  so it cannot enqueue fresh AI work;
- added strict bounded account/route response validation and honest personal
  webhook wording to `/staff`;
- added strict TypeScript parser coverage and rollback-SQL suppression proof
  for both appointment finalizers;
- fixed the rollback fixture's second-message optimistic version assumption
  by reading the conversation's current `state_version`.

Local verification after fixes:

```text
pnpm install --frozen-lockfile   -> PASS
pnpm typecheck                   -> PASS
pnpm test                        -> PASS; 32 files, 1335 passed, 2 paid eval gates skipped
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> PASS; no deploy
git diff --check                 -> PASS; only benign autocrlf notices
```

Disposable database validation:

- applied `20260814000300_selective_automation.sql` to `vetai-test`;
- ran `033_selective_automation.sql` after fixing its stale expected-version
  assumption: `PASS` with all reported fixture residue counts at zero;
- independently verified `automation_default='manual'`, RLS enabled, exactly
  one authenticated SELECT policy, authenticated read-only table access,
  anon denial, setter/resolver execute ACLs, and aggregate fixture residue:
  all `true`.

No production database, deploy, real Meta/WhatsApp call, or paid OpenAI eval
was used. Model/prompt/extraction/safety/reply copy did not change, so a paid
eval is not required for this task.

Decision: `PASS_FOR_OPUS`. The remaining mandatory gate is Claude Opus's
read-only architecture/RLS/KVKK review.

Opus returned `CHANGES_REQUIRED` on the first read-only pass. The narrow
follow-up fixes now:

- state directly in `/staff` that manual-mode messages remain stored for the
  clinic and make no OpenAI call;
- state directly that personal-mode content is not persisted but the routing
  phone number remains stored;
- document that owner erasure does not delete the independent route row,
  `inherit` is the route-row deletion operation, and an `ai` account default
  will apply again to future messages after deletion;
- disclose same-clinic staff visibility of route rows;
- record the required pre-production follow-up to add
  `whatsapp_contact_routes` to `docs/kvkk-inceleme-paketi.md`;
- reject malformed status callbacks before performing any contact-route RPC.

Decision after targeted fixes: `READY_FOR_OPUS_RECHECK`.

Verification after the Opus follow-up fixes:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
pnpm exec vitest run test/staffPage.test.ts test/index.test.ts
                                  -> PASS; 131/131 targeted tests
pnpm test                        -> PASS; 32 files, 1336 passed,
                                     2 paid eval gates skipped
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> PASS; no deploy
git diff --check                 -> PASS; only benign autocrlf notices
```

The migration and database fixture were not rerun because this follow-up
changed only fixed staff copy, documentation, webhook validation ordering,
and regression tests; the previously validated SQL is unchanged. No real
Meta/OpenAI call, production mutation, commit, push, or deploy was performed.

Claude Opus completed the requested narrow read-only recheck and returned
`PASS`. It verified the exact `/staff` retention copy, the owner-erasure /
`inherit` / account-default / same-clinic-visibility / KVKK documentation, and
the malformed-status-callback ordering. No remaining Task 033 code, RLS, or
KVKK review blocker was identified. Final Codex decision: `PASS`.
