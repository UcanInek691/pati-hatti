# Selective WhatsApp automation and strict AI allowlist

Last verified: 2026-08-22. **Codex applied Task 033 and the strict-allowlist
follow-up migration to disposable `vetai-test`; the 033 and 034 rollback
fixtures and the closed catalog audit passed with zero fixture residue. The
strict migration was then applied to `vetai-staging` through the managed CLI
transaction; its six-check catalog audit and 18/18 migration-history comparison
passed. It is not applied to production.**

## Why this exists

A single WhatsApp Business number can carry both automated clinic intake
traffic and a clinic staff member's personal conversations. VetAI never
guesses which is which from message text, contact names, prompt output, or
conversation history — that would misroute a real emergency or a private
message on a false inference. Instead, routing is a closed, explicit
per-account default plus an optional per-contact override that a clinic
operator sets from `/staff`.

## The three closed modes

- **`ai`** — preserves the existing reviewed intake/appointment/reply
  pipeline unchanged (see
  [`docs/inbound-queue.md`](inbound-queue.md) and
  [`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md)).
- **`manual`** — the inbound message is persisted (event, owner,
  conversation, message) exactly as `ai` traffic is, but the intake event is
  marked terminally completed immediately: no Queue send, no OpenAI call, no
  intake/appointment mutation, and no bot reply.
- **`personal`** — the signed webhook is acknowledged and the envelope's
  routing lookup runs, but nothing else happens: no owner, conversation,
  message, or webhook event row is created, and no Queue job is enqueued.
  An explicit `personal` override retains the contact's E.164 number as its
  routing key; an unlisted contact under the strict default has no route row.

An exact contact override belongs to one WhatsApp account. After
`20260822000100_strict_ai_allowlist.sql`, every existing and newly created
account has the only permitted default, `personal`. Therefore an unlisted
contact is ignored at the envelope boundary and only an exact `ai` override
enters automation. `manual` and explicit `personal` remain available as
per-contact overrides. Selecting `inherit` deletes the override and returns
that contact to the strict `personal` default.

## Envelope-first routing

Before this per-contact routing begins, recognizable group messages are
discarded at the same parser boundary. Their participant number is never
treated as a direct-chat contact, and their contacts/content never reaches a
route lookup, Supabase, Queue, OpenAI, or an outbound reply. This group guard
is independent of `ai | manual | personal`; those modes apply only to direct
contact traffic.

After signature verification and JSON decoding, `src/whatsappIngest.ts`
first extracts only the fields needed to route — phone number ID, sender
E.164, provider message ID, timestamp, declared type — before it reads any
nested text/media/contact/location/document field. Every recognized
candidate is resolved through `resolveWhatsAppContactAutomation`
(`src/contactAutomation.ts`, a native-fetch, service-role-only client for
`public.resolve_whatsapp_contact_automation`) **before** any non-personal
message is materialized. A failed route lookup (missing Supabase
configuration, network failure, malformed RPC response) fails the whole
webhook closed with retryable HTTP 503. A malformed inbound envelope/content
still receives HTTP 400.

The route RPC itself has a 10-second request timeout. Timeout/network failure
is the same fail-closed 503 outcome; content is not read after that failure.

For an effective `personal` result, resolution stops at the envelope: no
nested content is read, no payload hash is computed, no ingest RPC call is
made. Tests prove this with a throwing nested-content getter/proxy on the
`personal` fixture, so a bug that reads content on that path fails loudly
rather than silently.

An in-payload duplicate (the same provider message ID appearing twice in one
webhook delivery) is resolved twice — once per raw candidate — even though
it always collapses to a single ingest RPC call downstream; see
[`docs/inbound-queue.md`](inbound-queue.md) for the resulting Queue/HTTP
behavior.

### Honest privacy boundary

Meta's webhook subscription is WABA/phone-number scoped, not
contact-scoped: the signed raw payload for every covered inbound event
necessarily reaches the Worker in transient memory, including `personal`
traffic. After routing, VetAI does not inspect, log, hash, forward to
Supabase/OpenAI, or persist that content. This is a true statement about
what VetAI's software does with the bytes it already received — it is not a
claim that the infrastructure never receives them. A separate WhatsApp
number/account is the only way to guarantee personal messages never reach
VetAI infrastructure at all.

`whatsapp_contact_routes` rows contain a phone number and are personal data
under this boundary. They are never logged, sent to OpenAI, or placed in
browser storage/notifications, and are never described as anonymous.
Every authenticated staff member of the same clinic can see those route rows
through the documented RLS SELECT policy; they are not private to the staff
member who created them.

Deleting an `owners` row does not delete an independent contact-route row.
For a routing-number erasure request, an authorized operator must select
`Numara varsayılanı` (`inherit`), which deletes that exact override row, in
addition to the existing owner-data erasure procedure. Removing the override
now always returns future traffic to the `personal` default; exclusion no
longer requires retaining a contact-route row. The external KVKK review
package does not yet inventory `whatsapp_contact_routes` and must be updated
before the production legal review.

## Database objects (`supabase/migrations/20260814000300_selective_automation.sql`)

- Task 033 introduced `automation_default`; the forward-only strict-allowlist
  migration now sets/defaults every row to `personal` and constrains the
  account-level value to `personal`. Only contact overrides can enable `ai`.
- `public.whatsapp_contact_routes(whatsapp_account_id, clinic_id,
  contact_e164, mode, created_at, updated_at)` — primary key
  `(whatsapp_account_id, contact_e164)`; `contact_e164` constrained to
  canonical E.164 (`^\+[1-9]\d{1,14}$`); `mode` constrained to
  `ai | manual | personal`; `(whatsapp_account_id, clinic_id)` references
  `whatsapp_accounts (id, clinic_id) on delete cascade`, so clinic/account
  erasure cascades. RLS enabled; `authenticated` gets same-clinic `SELECT`
  only via `is_clinic_staff(clinic_id)`; only `service_role` can write. No
  audit/history table — the current row is the whole model.
- `vetai_private.effective_contact_automation_mode(whatsapp_account_id,
  contact_e164)` — private, `STABLE`, `SECURITY INVOKER`: returns the
  contact's override if one exists, else the account's
  `automation_default`. No lock; used by the read-only resolve RPC and by
  ingest, which first locks the exact account row.
- `vetai_private.lock_owner_and_resolve_automation(clinic_id,
  whatsapp_account_id, owner_id)` — private, `VOLATILE`, `SECURITY
  INVOKER`: locks the owner row `FOR UPDATE`, then resolves its effective
  mode. Shared by `claim_intake_queue_job` and all three finalizers so route
  changes and finalization serialize on the same lock.
- `public.resolve_whatsapp_contact_automation(phone_number_id,
  contact_e164)` — `SECURITY INVOKER`, `STABLE`, `SET search_path=''`,
  executable only by `service_role`. Returns exactly one closed
  `ai | manual | personal | unknown_account` result; exposes no
  identifier or PII.
- `public.set_whatsapp_contact_route(whatsapp_account_id, contact_e164,
  mode)` — `SECURITY DEFINER`, `VOLATILE`, `SET search_path=''`, executable
  only by `authenticated`. `mode` accepts `ai | manual | personal |
  inherit` (`inherit` deletes the override). Locks the target account row,
  authorizes its clinic through `vetai_private.is_clinic_staff`, and
  returns the same `not_found` for an absent or cross-tenant account so the
  two cases are indistinguishable to the caller. Returns only
  `updated | unchanged | not_found` — never an account, clinic, contact, or
  owner identifier. When the account row already has a matching owner, that
  owner row is locked before the route changes; when the resulting mode is
  `manual` or `personal`, still-`pending` automated outbox rows for that
  account/owner's conversations are deleted in the same transaction. Task 048
  (`supabase/migrations/20260903000100_staff_reply_composer.sql`, implemented
  and verified only on disposable `vetai-test`, not staging/production) scopes this
  delete to `message_origin = 'automation'` rows only, so a staff-queued
  reply already `pending` for that contact survives an operator route change
  instead of being deleted — see
  [`docs/outbound-delivery.md`](outbound-delivery.md#staff-originated-rows-task-048).
  `processing`, `accepted`, and `failed` rows are never touched. A
  `processing` row may not yet have reached Meta; if its lease expires it
  can still be reclaimed/retried within the existing three-attempt ceiling.
  A request already handed to Meta cannot be recalled. `/staff` states both
  limits explicitly.
- When the strict-allowlist migration activates, it removes `pending` and
  `processing` outbox rows whose exact `(account, recipient)` route is not
  `ai`. Removing `processing` prevents lease-expiry reclaim/retry, but cannot
  recall the single network request if a sender already handed it to Meta.
  Terminal `accepted`/`failed` history is preserved; normal finalizers
  continue to recheck the effective route before creating new work.
- `ingest_whatsapp_text_message` is replaced (same signature) to recheck
  the account and `(account, sender E.164)` override inside the ingest
  transaction, before any event/owner/conversation/message write. It holds
  a key-share lock on the exact account row, while route mutation takes an
  update lock on that row, so the route decision and a concurrent operator
  change serialize:
  `personal` returns `ignored` with a null conversation ID and makes zero
  writes; `manual` persists the same sanitized record `ai` traffic does but
  marks the event's intake state terminally completed and returns `manual`
  with its conversation ID; `ai` is unchanged. Unknown accounts remain
  `unknown_account` with zero writes.
- `claim_intake_queue_job` now also returns the claimed job's current
  automation mode. For `manual | personal`, `message_text` is strictly
  null; the TypeScript client requires exact null/value coherence with the
  mode. See [`docs/inbound-queue.md`](inbound-queue.md) for
  `src/intakeConsumer.ts`'s immediate-completion short-circuit on a
  non-`ai` claim.
- `finalize_intake_queue_job`, `finalize_appointment_offer_queue_job`, and
  `finalize_appointment_decision_queue_job` are replaced (same signatures)
  to lock/recheck the effective route via
  `lock_owner_and_resolve_automation` after validating and locking the
  current event/claim, but before any conversation, slot, or outbox
  mutation. If the route is no longer `ai`, the finalizer atomically
  completes the current intake lease via the existing
  `complete_intake_queue_job` and returns a new closed `suppressed` result
  with null stage/version — zero conversation-state change, appointment
  hold/confirmation/release, or outbox insert happens on that branch. Every
  other result and failure behavior is unchanged.

## Two race windows and how they close

- **Ingest → claim**: a route can change between a message being persisted
  as `ai` and a worker claiming its Queue job. `claim_intake_queue_job`'s
  returned mode lets `src/intakeConsumer.ts` complete the lease immediately
  — before context lookup, hashing, OpenAI, planning, appointment calls,
  clinic-hours lookup, or reply creation — whenever the claimed mode is no
  longer `ai`.
- **Claim → finalize**: a route can change again after a worker has already
  done paid work for a claimed `ai` job. Each finalizer's own
  route recheck (above) catches this by returning `suppressed` instead of
  writing any state, so a same-account route flip mid-turn can't leave a
  reply in the outbox or advance conversation state for a contact who was
  switched to `manual`/`personal` in between.

At ingest, the account-row lock serializes persistence with an operator route
change. After persistence, claim/finalizer checks reuse the same
`lock_owner_and_resolve_automation` owner lock that
`set_whatsapp_contact_route` uses for pending-outbox cleanup, so an
uncommitted finalizer can't insert a new pending reply after a route change's
cleanup already ran.

## `/staff` controls

A dependency-free "WhatsApp otomasyonu" section:

- lists the caller's RLS-scoped WhatsApp accounts (`id, display_name,
  automation_default`);
- lists at most 100 configured routes for the selected account
  (`contact_e164, mode, updated_at`, newest first);
- accepts one exact canonical E.164 number and one of four fixed actions —
  `AI açık`, `Sadece insan`, `Kişisel / yok say`, `Numara varsayılanı` —
  each calling `set_whatsapp_contact_route` and accepting only its closed
  one-row result;
- refreshes only this section after a successful change;
- uses `textContent`/native DOM only, and never stores account/contact/route
  data in `sessionStorage`, local storage, notifications, URLs, or logs.

Displayed fixed Turkish explanations:

- `AI açık`: future messages may enter the automated intake flow.
- `Sadece insan`: messages are retained for the clinic, but VetAI does not
  answer or call OpenAI.
- `Kişisel / yok say`: future message content and owner/conversation
  records are not persisted by VetAI; an explicit personal override retains
  its routing phone number, while an unlisted contact has no route row.
- `Numara varsayılanı`: deletes the override, returning future messages to
  the strict personal default.
- Changing to manual/personal does not erase earlier stored records.
- A reply already in provider delivery may still arrive.

`/staff` never implies a human was notified or will answer — this task adds
no human message composer, no staff notification, no response-time promise,
no free-text sender, no echo import, no contact sync, and no account-default
admin UI. (Task 048 later adds a narrowly-scoped staff reply composer — see
below; it does not add notification, echo import, contact sync, or an
account-default admin UI.)

## Same-number manual messaging ceiling

Route controls only silence VetAI's own automation; they do not give staff
a way to send a WhatsApp reply from the same number today. A human reply on
the same number requires either:

1. Meta-supported WhatsApp Business App/Cloud API **Coexistence** on the
   chosen account ([Meta Cloud API
   docs](https://developers.facebook.com/docs/whatsapp/cloud-api),
   [Business App/Cloud API Coexistence
   docs](https://developers.facebook.com/docs/whatsapp/embedded-signup/direct-onboarding-existing-users/existing-whatsapp-business-app-users)); or
2. a later reviewed staff free-text sender built on Cloud API — this is what
   Task 048's composer implements; see below.

Task 034 owns verifying the chosen Turkish pilot account's actual
Coexistence eligibility, onboarding behavior, and outbound message-echo/
webhook behavior in real staging. Until that staging evidence exists,
Coexistence must not be described as available in Türkiye or for this
account, and manual compose/send remains a pilot blocker if it turns out to
be unavailable.

## Staff reply composer (Task 048)

Option 2 above is now implemented, locally verified and proven only on
disposable `vetai-test` — not staging-verified and not committed. Mandatory
The first Opus review's corrections await a narrow read-only re-check. It does not
depend on or interact with Coexistence: it is a narrowly-scoped RPC
(`queue_staff_reply_v1`) that queues one human-authored reply, for the exact
assigned human-handoff work item, inside the WhatsApp 24-hour
customer-service window, onto the account's existing Cloud API sender
credentials — the same credentials and pipeline automation already uses. It
does not change route selection, does not add a general free-text sender for
arbitrary contacts, and does not touch `whatsapp_contact_routes`. See
[`docs/staff-workflow.md`](staff-workflow.md#staff-reply-composer-task-048)
for the UI and [`docs/database-schema.md`](database-schema.md#staff-authored-whatsapp-reply-composer-task-048)
for the schema/RPC contract.

## What this task does not do

No content-based routing, no AI classification of "friend vs. customer", no
CRM, no second inbox, no staff free-text sender, no contact import/sync, no
address-book access, no WhatsApp message-echo parsing, no push/e-mail/SMS
alerts, no new dependency, and no framework.
