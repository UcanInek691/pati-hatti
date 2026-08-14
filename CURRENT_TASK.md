# Current task — 033 Selective WhatsApp automation and manual takeover

Status: `READY`

Owner: Claude Sonnet

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
- `src/intakeJobLease.ts`
- `src/intakeConsumer.ts`
- `src/appointmentFlow.ts`
- `src/index.ts`
- `src/staffPage.ts`
- `test/supabaseIngest.test.ts`
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

Replace `ingest_whatsapp_text_message` only in the new migration, preserving
its signature and existing validation/idempotency/tenant behavior for AI
traffic.

Resolve the exact account and `(account, sender E.164)` override before any
event/owner/conversation/message write:

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
zero Queue send for `manual | ignored`; zero context/OpenAI/planner/appointment/
clinic lookup for a non-AI claim; acknowledgment of `suppressed` on every
finalizer path; unchanged AI behavior; exact account/route projections and
bounds; exact E.164 input handling; all route actions/results; fixed Turkish
explanations; and absence of console/unsafe HTML/storage/notification leaks.

## Documentation

Create `docs/selective-automation.md` and narrowly update existing docs to
explain:

- account default versus exact contact override;
- why the system never guesses friend/customer status;
- persistence and AI behavior of each mode;
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

To be filled by the implementer from repository evidence before editing.

## Delivery record

To be filled by the implementer after implementation and verification.

## Codex review record

Reserved for Codex.
