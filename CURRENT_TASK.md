# Current task — 040 Per-account Meta credential isolation

Status: `READY`

Opened by Codex on 2026-08-30 after Task 039 completed every local,
disposable-database, Claude Opus, paid Luna-eval and real staging WhatsApp
gate. The shared SaaS direction is recorded in
`docs/saas-urunlestirme-yol-haritasi.md`.

The current outbound sender still reads one global Worker secret,
`WHATSAPP_ACCESS_TOKEN`. That is safe only while the platform has one active
WhatsApp account. A second clinic would either use the first account's token
or fail to send. This task removes that single-account assumption without
adding an admin panel, billing engine or provisioning workflow.

## Goal

1. Select the Meta access token from the exact tenant-bound WhatsApp account
   claimed with each outbound row.
2. Keep every token outside source code, Git, Supabase tables, logs, error
   bodies and test artefacts.
3. Prove with two synthetic clinics/accounts that neither account can use the
   other's credential, including malformed/missing/mismatched configuration.
4. Preserve the existing at-least-once outbox lease, retry, acceptance,
   delivery-status and staff-work-item semantics.
5. Provide a safe expand-first rollout and rollback path for a later,
   separately authorized staging activation. Production remains untouched.

## Fixed architecture decisions

### A. Pilot credential container

1. Replace runtime use of the single `WHATSAPP_ACCESS_TOKEN` with one encrypted
   Worker secret named `WHATSAPP_ACCOUNT_CREDENTIALS_JSON`.
2. The secret is a JSON array. Each element has exactly these three keys:
   - `whatsapp_account_id`: canonical lowercase UUID;
   - `phone_number_id`: Meta's 1–64 digit phone-number ID;
   - `access_token`: opaque, trimmed secret text of 1–1,024 code points.
3. The array is a deliberately small pilot-scale registry, not a general
   secret database. It must reject:
   - non-array roots, arrays outside 1–10 entries, or raw UTF-8 JSON over
     5,000 bytes (Cloudflare's current per-Worker variable limit is 5 KB);
   - non-plain entries, missing/extra keys and invalid values;
   - duplicate `whatsapp_account_id` values;
   - duplicate `phone_number_id` values;
   - a token containing control characters or surrounding whitespace.
4. Any malformed registry invalidates the whole registry. The runtime must not
   partially accept a prefix and must not fall back to another account or to
   the legacy global token.
5. The parser/resolver is pure, deterministic, bounded and has no logging. It
   never returns the full registry to application call sites; it resolves one
   exact account-ID/phone-ID pair to one token or a closed failure.
6. The token stays an opaque string. Do not encode assumptions about a current
   Meta token prefix, because Meta may change its format.
7. Cloudflare Secrets Store is not used as a dynamic lookup table in this
   task. Its Worker integration binds named secrets statically at deploy time;
   a database `credential_ref` cannot select an arbitrary binding at runtime.
   A future migration to static per-secret bindings or a dedicated broker
   requires a separately reviewed task and measured operational need. The
   registry is therefore capped at ten WhatsApp accounts; clinic eleven is a
   mandatory architecture-migration gate, not an invitation to raise the cap.

### B. Tenant-bound database claim

1. Add an expand-only RPC named `claim_outbound_message_v2`; do not replace or
   drop the existing `claim_outbound_message` in this task.
2. V2 reuses the reviewed SQL body and lock semantics unchanged, but returns
   one additional `whatsapp_account_id` column from the same composite join:
   `outbound_message_outbox (whatsapp_account_id, clinic_id)` to
   `whatsapp_accounts (id, clinic_id)`.
3. The returned account UUID and phone-number ID must come from that locked,
   tenant-safe claim path, never from a Worker request, recipient, route row,
   model output or caller parameter.
4. `src/outboundDelivery.ts` must call only V2 and strictly validate the new
   eight-field response. Empty/exhausted rows require every nullable output,
   including the account ID, to be exactly null.
5. Keep the old RPC solely so the previously deployed Worker remains a valid
   rollback target. New Worker code must not call it.

### C. Send and failure behavior

1. `drainOutboundMessages` validates the credential registry before claiming
   any row. A globally malformed/missing registry causes zero claims and zero
   Meta calls.
2. After a valid claim, resolve credentials using the exact pair
   `(whatsappAccountId, phoneNumberId)`. A missing or mismatched mapping causes
   zero Meta calls and releases that exact claim through the existing retry
   RPC. Existing database attempt exhaustion and delivery-failure staff work
   item behavior remains the terminal path.
3. `sendWhatsAppTextMessage` receives only the one resolved token needed for
   that call. It must not receive or parse the full registry.
4. Authorization must be `Bearer <that exact account token>`. Tests prove two
   different claims produce their own headers and endpoints. Tests must use
   obviously synthetic tokens and IDs.
5. Accepted, already-accepted, stale, retry-scheduled and exhausted behavior is
   unchanged. This task does not claim exactly-once delivery.
6. No code path may log or return a token, registry, Authorization header,
   recipient, message body or Meta response body. Existing fixed aggregate
   logs may remain.
7. `/ready` validates presence and full shape of the new registry and reports
   only the existing generic `ready`/`unavailable` result. It must not expose
   which account is missing, the registry count or any identifier.

### D. Configuration, rotation and rollback

1. `Env` and `.dev.vars.example` use
   `WHATSAPP_ACCOUNT_CREDENTIALS_JSON`; production/staging Wrangler TOML files
   contain no plaintext registry or token.
2. Remove runtime references to `WHATSAPP_ACCESS_TOKEN`. Existing test fixtures
   may be mechanically renamed, but no real or production-like token enters
   the repository.
3. Document this future rollout order:
   1. apply the expand-only V2 RPC migration;
   2. upload the new encrypted registry secret;
   3. verify `/ready` on an unpublished/canary version;
   4. deploy the new Worker;
   5. run one account at a time through a synthetic outbound/status smoke;
   6. retain the old global secret only during the bounded rollback window;
   7. after the gate passes, delete/rotate the old global token.
4. Rollback is Worker-first: redeploy the Task 039 Worker, which can still call
   the retained V1 RPC and legacy secret during the rollback window. The V2
   RPC may remain unused; no destructive down migration is needed.
5. Changing one clinic's token initially requires atomically replacing the
   encrypted JSON secret. The complete registry is validated before deploy;
   no partial registry activation is permitted. This operational limitation is
   documented and measured before choosing a more complex secret backend.
6. The implementing agent performs no secret upload, staging/production
   migration, Meta call, deploy, resource creation, commit or push.

### E. Scope boundaries

This task does **not** add or change:

- clinic provisioning/offboarding UI or Embedded Signup;
- platform-admin roles, break-glass access or an `/admin` page;
- usage metering, tariff, campaign, quota, invoice or payment behavior;
- `/staff` visual design, composer, notification or appointment UI;
- inbound extraction, prompts, model choice, safety rules or Turkish copy;
- Meta application settings, WABA ownership or real account tokens;
- production resources or configuration.

No paid OpenAI eval is required: prompt, extraction schema, model and safety
behavior are untouched.

## Required implementation

### Part 1 — Database expansion

1. Add
   `supabase/migrations/20260830000100_per_account_whatsapp_credentials.sql`
   with `public.claim_outbound_message_v2()`.
2. Preserve V1 byte-for-byte. V2 uses `SECURITY INVOKER`, empty `search_path`,
   service-role-only execute grants, the same `FOR UPDATE OF o SKIP LOCKED`,
   oldest-due ordering, retry/exhaustion limits and five-minute lease.
3. Add `supabase/tests/040_per_account_whatsapp_credentials.sql`, wrapped in
   `BEGIN`/`ROLLBACK`, proving:
   - two clinics and two WhatsApp accounts return the matching account ID and
     phone-number ID;
   - composite tenant joins cannot cross accounts;
   - empty, exhausted and reclaimed states preserve the existing contract;
   - anon/authenticated/public cannot call V2;
   - service_role can call it;
   - fixture residue is zero.
4. A one-session SQL fixture may document that it cannot prove real lock
   blocking. Source lock-order semantics and any structural regression
   assertion must be stated honestly.

### Part 2 — Strict registry boundary

1. Add `src/whatsappCredentials.ts` with the bounded parser and exact resolver.
2. Add `test/whatsappCredentials.test.ts` covering every malformed shape,
   duplicate, trust-boundary and exact-pair case, including two-clinic
   positive/negative mappings.
3. Avoid dependencies, schema libraries, crypto, caching layers or a generic
   secret abstraction. Standard `JSON.parse`, existing validation patterns and
   a short linear scan are sufficient at pilot scale.

### Part 3 — Outbound wiring

1. Update `src/outboundDelivery.ts`, `src/outboundSender.ts`,
   `src/whatsappSend.ts`, `src/env.ts` and `src/readiness.ts` as fixed above.
2. Update focused tests for V2 response parsing, credential selection, missing
   mapping release, exact Authorization header, zero-call fail-closed paths,
   generic readiness and no sensitive logging.
3. Existing Env fixtures may receive only the mechanical binding replacement
   needed to compile; their behavior must not otherwise change.

### Part 4 — Documentation

Narrowly update:

- `.dev.vars.example` with a clearly synthetic JSON example;
- `docs/outbound-delivery.md` with credential selection and failure semantics;
- `docs/production-readiness.md` with the rollout/rollback gate;
- `docs/staging-runbook.md` with the future staging secret-rotation procedure
  and removal of stale global-token language;
- `docs/saas-urunlestirme-yol-haritasi.md` only to mark Task 040 implemented,
  not to redesign later phases;
- `CURRENT_TASK.md` only in **Observed context** and **Delivery record**.

## Allowed changes

- `supabase/migrations/20260830000100_per_account_whatsapp_credentials.sql`
  (new)
- `supabase/tests/040_per_account_whatsapp_credentials.sql` (new)
- `src/whatsappCredentials.ts` (new)
- `src/env.ts`
- `src/outboundDelivery.ts`
- `src/outboundSender.ts`
- `src/whatsappSend.ts`
- `src/readiness.ts`
- `test/whatsappCredentials.test.ts` (new)
- `test/outboundDelivery.test.ts`
- `test/outboundSender.test.ts`
- `test/whatsappSend.test.ts`
- `test/readiness.test.ts`
- existing `test/*.test.ts` files only for a mechanical Env-fixture binding
  rename; no assertion or behavior change outside the focused five files
- `.dev.vars.example`
- `docs/outbound-delivery.md`
- `docs/production-readiness.md`
- `docs/staging-runbook.md`
- `docs/saas-urunlestirme-yol-haritasi.md`
- `CURRENT_TASK.md` only in **Observed context** and **Delivery record**

Anything else is out of scope. The pre-existing `.gitignore` working-tree
change is user-owned and must remain untouched/uncommitted.

## Acceptance criteria

1. No new Worker runtime path reads `WHATSAPP_ACCESS_TOKEN`; outbound delivery
   requires `WHATSAPP_ACCOUNT_CREDENTIALS_JSON`.
2. No token or registry value is stored in SQL, source, docs, Git diff, logs,
   returned errors or generated build artefacts.
3. V2 returns the exact internal WhatsApp account ID from the same tenant-safe
   composite join as the phone-number ID and outbox row.
4. A claim for clinic/account A can select only A's exact credential; B's token
   is never used for A under missing, reordered, duplicated or mismatched
   configuration.
5. Globally malformed configuration claims nothing. A valid registry missing
   one claimed account sends nothing and safely releases only that row.
6. Meta send acceptance and database acceptance still use the same claim token
   and retain the existing at-least-once limitation.
7. `/ready` is unavailable for a malformed/missing registry and reveals no
   account-level detail.
8. The old claim RPC remains callable by the old Worker for rollback, while the
   new Worker statically calls only V2.
9. All new SQL objects are RLS/grant-compatible and service-role-only as
   specified; the disposable fixture passes with zero residue.
10. Existing inbound, AI, appointment, staff, selective-automation and status
    behavior remains unchanged.

## Required verification and review gates

The implementer runs:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --dry-run --config wrangler.staging.toml --outdir .wrangler/dry-run-staging
git diff --check
```

The implementer does not apply migrations or run SQL fixtures against any
database. Codex must then:

1. review the complete diff and outbound call path;
2. rerun the required commands;
3. apply the migration and run the Task 040 rollback fixture only on disposable
   `vetai-test`;
4. request a mandatory read-only Claude Opus security/tenant/secret review;
5. close findings, update `PROJECT_CONTEXT.md`, and commit only after PASS.

Staging secret upload, staging migration/deploy and any real Meta send are a
separate explicit user-approval gate after the repository task is committed.
Production remains untouched throughout Task 040.

## Observed context

To be filled by the implementing agent from repository evidence only.

## Delivery record

To be filled by the implementing agent. Do not change Status.

---

# Previous task — 039 Per-pet appointment lifecycle and burst-safe messaging

Status: `COMPLETE` (closed 2026-08-30 after local, disposable-database,
mandatory Claude Opus, paid Luna-eval, and real staging WhatsApp gates passed;
production remains untouched)

Opened by Codex on 2026-08-28 after Task 038 passed its local, mandatory
Claude Opus, paid-eval and real staging WhatsApp gates. Maya explicitly chose
one combined task for two related product gaps: a pet can currently obtain a
second future appointment through a different conversation, and rapid
back-to-back WhatsApp messages are currently separate Queue/model turns.

This is one review/deploy unit with two independently testable parts. It must
not blur their trust boundaries: appointment mutation remains database-owned
and exact-confirmation-only; burst assembly only changes the bounded text sent
to the existing structured extractor.

## Goal

1. Enforce at most one **upcoming active appointment per pet per clinic**
   across every conversation, and truthfully return its date/time instead of
   holding a second slot.
2. Let an owner request cancellation in natural Turkish, but cancel only
   after the exact current appointment is repeated back and a separate exact
   `EVET` confirmation is received.
3. Atomically return a cancelled slot to availability while retaining a
   minimal, tenant-safe cancellation audit record.
4. Treat a short burst such as `Merhaba` followed by `Pamuk kusuyor` as one
   ordered user turn, producing at most one OpenAI call and one automated
   reply for that burst.
5. Produce two new Turkish human-review artifacts after implementation: a
   veterinarian scenario/wording package with example conversations, and a
   legal/KVKK data/retention package.

## Fixed product and safety decisions

### A. Per-pet appointment integrity

1. An upcoming active appointment is:
   - a `confirmed` slot whose `starts_at` is later than database `now()`; or
   - an unexpired `held` slot for the same pet while confirmation is pending.
   Past confirmed slots and expired holds do not block a new booking.
2. The guard is clinic- and pet-scoped, not merely conversation-scoped. Every
   booking/hold/cancel RPC locks the tenant-scoped pet row before checking or
   changing an appointment so two conversations cannot win concurrently.
   Lock order must be identical across all touched RPCs and documented.
3. If a future confirmed appointment already exists, a new appointment request
   creates no hold and returns a fixed truthful Turkish reply containing only
   the selected pet's name and the existing Europe/Istanbul date/time. It must
   not claim a new booking or staff notification.
4. An unexpired hold owned by a different conversation is not described as a
   confirmed appointment. It returns a fixed truthful `appointment in
   progress`/phone-contact outcome and creates no second hold.
5. A database invariant or locked-RPC proof must cover concurrency. A unique
   index that permanently blocks a pet after a past appointment is forbidden;
   PostgreSQL partial-index predicates cannot depend on volatile `now()`.

### B. Cancellation

1. Add a closed extraction intent `appointment_cancel_request`; bump the
   prompt version once. Natural variants such as `randevumu iptal etmek
   istiyorum`, `Pamuk'un randevusunu iptal edelim` and elliptical replies to a
   cancellation question may map to it. It never authorizes a mutation.
2. Emergency, explicit-human and medical-advice decisions retain their current
   deterministic precedence over cancellation.
3. The pet must resolve through the existing tenant-scoped pet boundary. With
   zero/multiple/ambiguous pets the system asks for identity or hands off; it
   never guesses from a model-generated ID.
4. Add one closed stage `appointment_cancel_confirmation`. Entering it looks up
   exactly one future confirmed appointment for the resolved pet, writes no
   cancellation, and sends fixed Turkish copy with that appointment's
   Europe/Istanbul date/time followed by exact `EVET`/`HAYIR` instructions.
5. In that stage only, the existing strict raw-text confirmation discipline
   applies:
   - exact normalized `EVET` atomically cancels that exact still-current
     appointment, records the audit row, returns the slot to `available`,
     completes the Queue lease/conversation and writes the cancelled reply;
   - exact normalized `HAYIR` leaves the appointment untouched, completes the
     attempt and writes the unchanged reply;
   - any other text repeats the fixed confirmation question without mutation.
6. If the appointment disappeared, changed pet/tenant, started, or was already
   cancelled before `EVET`, fail closed with a truthful stale/no-appointment
   result; never cancel a replacement appointment.
7. Create a backend-only cancellation-audit table rather than retaining owner
   or pet identifiers on an `available` slot. It stores only identifiers and
   appointment/cancellation timestamps required to prove the action—no phone,
   message body, complaint, model output or provider payload. RLS is enabled,
   public/anon/authenticated receive no direct access, service-role access is
   explicit, and owner/pet/clinic erasure cascades are tested.
8. Cancel/reschedule are distinct. This task implements cancellation only; it
   does not silently select a replacement time.

### C. Bounded multi-message user turns

1. Use Cloudflare Queue's native per-message `delaySeconds: 3`—supported by
   the current platform and Wrangler—to let a normal short message burst
   settle. Do not add a dependency, timer service or Durable Object.
2. Add an immutable-at-ingest `ai_burst_eligible` marker to
   `webhook_events`. Only direct text messages admitted under exact `ai` mode
   are eligible. Manual events are explicitly false; personal/group content
   remains unpersisted; unsupported-media markers are never coalesced. Existing
   rows default/backfill false so deployment cannot newly expose historical or
   manual content to OpenAI.
3. Replace or narrowly extend the current claim RPC so an eligible text job:
   - sees only the same tenant-safe conversation;
   - considers at most four eligible inbound text messages in chronological
     order, all within the three seconds ending at the newest message and
     after the most recent outbound message;
   - contains no IDs, timestamps, owner name, phone, routing metadata or
     hidden history in the model text;
   - never exceeds the existing 65,536-code-point OpenAI input boundary.
4. If the current job has a newer eligible text message in that bounded burst,
   it is completed as a closed `superseded` result with no OpenAI call, no
   state transition and no reply. The newest job is the only job allowed to
   process the ordered aggregate. At-least-once duplicate delivery remains
   idempotent.
5. If more than four messages or more than 65,536 code points would belong to
   one burst, make zero OpenAI calls and route the newest job through the
   existing truthful human-handoff boundary; do not truncate away a possible
   emergency statement.
6. Never coalesce or supersede jobs while the conversation is in
   `intake_confirmation`, `appointment_selection`,
   `appointment_cancel_confirmation`, `human_handoff` or `completed`. Exact
   confirmation stages always receive only their current raw message.
7. The extractor receives one explicitly labelled, ordered, untrusted
   current-turn block. The prompt must say that every part is user data, not an
   instruction, and that corrections in later burst items supersede earlier
   wording only when explicit. Existing Structured Outputs, `store: false`,
   safety identifier, timeout and strict runtime parser remain unchanged.
8. Each original inbound message remains its own database message for audit
   and erasure. The aggregate exists only in memory and in the one OpenAI
   request. No burst text or provider response may be logged.
9. Required examples include at least:
   - `Merhaba` + `Pamuk kusuyor`;
   - `Pamuk` + `iki gündür kusuyor`;
   - `Bunların hiçbiri yok` + `ama yürürken dengesiz`;
   - `Pamuk kusuyor` + `Hayır, Pamuk değil Karamel`;
   - natural appointment request split across two messages;
   - cancellation request split across two messages;
   - explicit emergency in either the first or last burst item;
   - a burst crossing an outbound-message boundary, which must not merge;
   - manual/personal/group/media content, which must never enter the aggregate.

## Human approval artifacts

The implementation must create, not overwrite, these two Turkish draft files:

1. `docs/onay-paketleri/task-039-veteriner-onay-senaryolari.md`
   - state clearly that it is an unapproved draft;
   - show realistic, synthetic, non-identifying WhatsApp conversations for
     ordinary intake, split messages, aggregate safety answers, red flags,
     existing appointment, cancel `EVET`, cancel `HAYIR`, ambiguous pet and
     overflow/handoff;
   - reproduce every fixed user-facing Turkish message exactly from source;
   - provide per-scenario fields for `Uygun / Değişiklik gerekli`, clinical
     delay risk, wording notes, approver name/registration/date/signature;
   - never ask the veterinarian to review SQL, code or model internals.
2. `docs/onay-paketleri/task-039-kvkk-inceleme-paketi.md`
   - state clearly that it is an unapproved draft;
   - inventory individual inbound storage, transient burst aggregation,
     OpenAI transfer, cancellation-audit fields, tenant visibility, processors,
     purposes, erasure cascades and every undecided retention period;
   - distinguish Meta delivery to the Worker, Supabase persistence and OpenAI
     processing; never claim whitelist-excluded content reaches OpenAI;
   - include concrete legal-review decisions and approver/date/signature fields.

The existing general veterinarian and KVKK packages receive links only; they
must not be rewritten as though approval occurred.

## Acceptance criteria

1. Two concurrent conversations for the same clinic/pet cannot create two
   upcoming active appointments. The loser receives the correct existing-time
   or in-progress result with zero second hold.
2. Another clinic or another owner's pet can never be queried, blocked,
   cancelled or disclosed. All relationships are structurally tenant-safe.
3. A past appointment does not block a new one.
4. A natural cancellation request never mutates by itself. Exact confirmation
   is mandatory; stale tokens/state/appointment identity leave zero partial
   mutation.
5. Successful cancellation audit insert, slot release, state/lease completion
   and outbound reply are one transaction; any error rolls back all of them.
6. A cancelled slot is available to a later eligible conversation, while the
   minimal cancellation audit remains until its reviewed erasure/retention
   rule removes it.
7. Rapid eligible text messages generate exactly one model call and one reply;
   superseded jobs are acknowledged. Single messages retain existing behavior.
8. Burst ordering and late corrections are deterministic; any explicit red
   signal still wins, aggregate negatives never erase a separately stated
   symptom, and an omitted signal is never converted to false.
9. Manual/personal/group/media and pre-migration historical content is not
   added to an OpenAI burst.
10. The two new Turkish human-review files contain exact source copy, synthetic
    scenario evidence and unsigned approval fields. They are not labelled
    approved by an AI.
11. No arbitrary date/time preference, rescheduling, reminders, calendar UI,
    external-calendar sync, diagnosis, treatment, medication or staff
    notification claim is added.

## Required automated evidence

- A forward migration and rollback-only SQL fixture for appointment guard,
  cancellation/audit, grants/RLS, lock/order semantics, cross-tenant denial,
  stale replay, erasure and zero residue.
- A separate forward migration and rollback-only SQL fixture for burst
  eligibility, supersession, ordering, boundaries, manual exclusion,
  overflow, grants and zero residue.
- TypeScript unit/integration tests for every new closed result, exact reply,
  malformed Data API shape, no-log behavior, no-model paths, Queue delay, one
  call/one reply, corrections and safety precedence.
- Existing regression suite remains green.

## Prompt/eval gate

Because the extraction intent and bounded-current-turn format change, bump the
prompt version once and extend both synthetic corpora. The implementer must not
make a real OpenAI call. After Codex/Opus review and Maya's separate approval,
Codex runs the full single- and multi-turn corpora against the already-selected
`gpt-5.6-luna` only. Terra is not re-run because Task 038 already selected Luna
with equal mandatory quality at roughly one-tenth the cost. Keep `store:
false`, strict Structured Outputs, no raw-text logs, a hard maximum of 160
calls and an operational estimate cap of USD 0.15. Required new gates:

- cancellation intent positive and negative/ambiguous precision;
- split-message fact merge and explicit correction;
- red signal in every burst position;
- aggregate safety negative plus separately reported symptom;
- no unexpected explicit-red signal;
- no appointment/cancellation mutation authority in model output.

Official OpenAI documentation continues to support the current Responses API
boundary: structured JSON belongs in `text.format`, input is explicit request
content, `store` controls response storage, and usage is returned separately.
The model remains `gpt-5.6-luna`; this task is not a model-selection exercise.

## Allowed changes

New:

- `supabase/migrations/20260829000100_pet_appointment_guard_and_cancellation.sql`
- `supabase/tests/039_pet_appointment_guard_and_cancellation.sql`
- `supabase/migrations/20260829000200_inbound_message_bursts.sql`
- `supabase/tests/039_inbound_message_bursts.sql`
- `docs/onay-paketleri/task-039-veteriner-onay-senaryolari.md`
- `docs/onay-paketleri/task-039-kvkk-inceleme-paketi.md`

Narrow edits only:

- `prompts/intake-extraction-prompt.ts`
- `src/intakeExtraction.ts`, `src/openaiIntake.ts`, `src/intakeTurn.ts`
- `src/conversationState.ts`, `src/intakeQueue.ts`, `src/intakeJobLease.ts`
- `src/appointmentEngine.ts`, `src/appointmentFlow.ts`
- `src/intakeReply.ts`, `src/intakeConsumer.ts`, `src/index.ts`
- `src/liveAiDemo.ts` only to keep its persisted-snapshot parser aligned with
  the new closed `pending_cancel_slot_id` field; this Codex scope amendment
  fixes the Task-039-caused demo regression without duplicating the parser
- the corresponding existing test files under `test/`
- `evals/intake-live-cases.json`, `evals/intake-multiturn-live-cases.json`
- `docs/database-schema.md`, `docs/appointment-booking-engine.md`
- `docs/whatsapp-appointment-flow.md`, `docs/inbound-queue.md`
- `docs/ai-behavior-and-safety.md`, `docs/product-roadmap.md`
- link-only edits in `docs/veteriner-hekim-onay-paketi.md` and
  `docs/kvkk-inceleme-paketi.md`
- `CURRENT_TASK.md`: implementer fills only `Observed context` and `Delivery
  record`; Codex owns status/contract/review records.
- `PROJECT_CONTEXT.md`: Codex only after final verification.

No dependency, lockfile, Env binding, Wrangler queue resource, production
configuration, secret, staff UI or unrelated migration may change. The user's
pre-existing `.gitignore` modification remains untouched.

## Required local verification

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

SQL fixtures are `NOT RUN` by Sonnet unless a disposable database is explicitly
available and Codex authorizes it. No implementer commit, push, deploy, live
OpenAI call, Supabase mutation, Meta call or Cloudflare resource mutation.

## Review and live gates

1. Sonnet implements the exact allowed scope and records evidence without
   commit/push/deploy.
2. Codex reviews the full call path, runs both SQL fixtures on disposable
   `vetai-test`, applies only targeted fixes, reruns all checks and controls the
   task status.
3. Claude Opus performs one mandatory read-only review covering per-pet
   concurrency, cancellation atomicity/audit/erasure, tenant/RLS boundaries,
   burst privacy, safety precedence and Turkish copy.
4. Only after PASS and Maya's separate approval may Codex run the Luna-only
   paid eval, apply migrations to staging in order, deploy the Worker and run
   two real WhatsApp smokes: second-booking rejection/cancellation/rebooking,
   and a two-message burst producing one reply. Production remains forbidden.
5. Veterinarian and Turkish legal/KVKK humans review the two new packages only
   after the final implementation copy/data inventory is stable. Their signed
   approval remains an external production gate and cannot be replaced by
   Codex, Sonnet or Opus.

## Observed context

- Repository was clean at task start on top of commit
  `8ccf976 docs: define appointment lifecycle and burst task` (the commit
  that defines this task's contract); the only other pending change
  (`M .gitignore`) predates this task and was left untouched throughout.
- `supabase/migrations/` ended at `20260827000100_second_pet_registration_atomicity.sql`
  (Task 037) and `supabase/tests/` ended at `037_second_pet_registration_atomicity.sql`;
  there is no Task 038 migration or fixture — Task 038 ("post-confirmation
  appointment invitation") only added `POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT`
  in `src/petRegistration.ts` plus prompt/eval/doc changes, confirmed by
  directory listing before writing the new Task 039 files.
- Pre-Task-039, `hold_appointment_slot` (in `20260810000200_whatsapp_appointment_flow.sql`)
  handled collisions only at the slot-row level; it had no concept of "this
  pet already has a future confirmed appointment" or "this pet's slot is
  being held by a different conversation right now" — confirmed by reading
  that migration before writing the Part A guard.
- Pre-Task-039, `claim_intake_queue_job` claimed exactly one unclaimed
  message per invocation with no aggregation window and no message-count or
  length ceiling; `webhook_events` had no `ai_burst_eligible` column —
  confirmed by reading the prior ingest/claim migration before writing Part C.
- All pre-existing fixed Turkish appointment-offer/confirm/decline copy lives
  as SQL string concatenation inside `20260810000200_whatsapp_appointment_flow.sql`,
  not as TS constants; this precedent was followed for every new Part A/B
  string rather than adding new `src/intakeReply.ts` constants.
- Mid-task defect found and fixed (not a pre-existing production bug — the
  SQL branches it affects are new in this same task): `existing_confirmed`
  and `in_progress`, `hold_appointment_slot`'s two new Part A result kinds,
  were wired into the SQL migration's `return query select 'existing_confirmed'::text, ...`
  / `'in_progress'::text, ...` branches but never into
  `src/appointmentFlow.ts`'s `FinalizeAppointmentOfferResult` union/parsing
  or `src/intakeConsumer.ts`'s disposition check — grepping `src/` and
  `test/` for both identifiers returned zero matches before the fix. A
  message reaching either branch would have completed its SQL transaction
  (lease completed, outbox reply written, stage advanced) while the consumer
  still classified it as `{ kind: "failed" }` and retried indefinitely.
- Mid-task gap found and fixed in the eval corpus (self-introduced earlier in
  this same task, not pre-existing): 9 cases in `evals/intake-live-cases.json`
  (`T028-078`…`T028-086`) were missing the `expected.reported_safety_signals`
  object required by `test/liveOpenAiEval.test.ts`.

## Delivery record

### Changed files

- New, **NOT RUN against any database**:
  `supabase/migrations/20260829000100_pet_appointment_guard_and_cancellation.sql`
  (Part A guard + Part B cancellation table/RPCs),
  `supabase/migrations/20260829000200_inbound_message_bursts.sql` (Part C),
  `supabase/tests/039_pet_appointment_guard_and_cancellation.sql`,
  `supabase/tests/039_inbound_message_bursts.sql` (both rollback-only
  fixtures).
- New human-approval drafts (both explicitly marked unapproved), plus
  link-only additions in the two existing general packages pointing to them
  (no rewrite, no implied approval):
  `docs/onay-paketleri/task-039-veteriner-onay-senaryolari.md`,
  `docs/onay-paketleri/task-039-kvkk-inceleme-paketi.md`,
  `docs/veteriner-hekim-onay-paketi.md` (+5 lines),
  `docs/kvkk-inceleme-paketi.md` (+5 lines).
- TS narrow edits: `src/appointmentFlow.ts` (+183/-lines — new
  `existing_confirmed`/`in_progress` result kinds plus the pre-existing
  cancel-offer/cancel-decision parsing), `src/intakeConsumer.ts` (+96 —
  disposition wiring for both new offer kinds, cancel dispatch, overflow
  handling), `src/intakeExtraction.ts`, `src/intakeTurn.ts`,
  `src/conversationState.ts`, `src/intakeQueue.ts` (`delaySeconds: 3` burst
  window), `src/intakeJobLease.ts`, `src/openaiIntake.ts`, and the
  corresponding test files (`test/appointmentFlow.test.ts`,
  `test/intakeConsumer.test.ts`, `test/intakeExtractionPrompt.test.ts`,
  `test/intakeJobLease.test.ts`, `test/intakeQueue.test.ts`,
  `test/intakeTurn.test.ts`, `test/intakeReply.test.ts`,
  `test/openaiIntake.test.ts`, `test/petRegistration.test.ts`,
  `test/index.test.ts`). At implementer delivery, `src/appointmentEngine.ts`,
  `src/intakeReply.ts` and `src/index.ts` needed no changes. Codex later made
  the allowed narrow `src/intakeReply.ts` terminal-safety correction described
  in its review record below; the other two remain unmodified.
- `prompts/intake-extraction-prompt.ts` bumped to version `2026-08-28.2`
  (new `## Appointment cancellations` / `## Burst messages` sections);
  `evals/intake-live-cases.json` and `evals/intake-multiturn-live-cases.json`
  extended with cancellation/burst/existing-appointment cases, plus the
  9-case `reported_safety_signals` gap fix described above. No paid eval run.
- Docs (narrow additions/insertions, not rewrites): `docs/database-schema.md`,
  `docs/appointment-booking-engine.md`, `docs/whatsapp-appointment-flow.md`,
  `docs/inbound-queue.md`, `docs/ai-behavior-and-safety.md`,
  `docs/product-roadmap.md` — each cross-linked, each explicitly noting the
  SQL fixtures are `NOT RUN`.
- At implementer delivery, `PROJECT_CONTEXT.md`, the user's pre-existing
  `.gitignore` change, `src/localDemo.ts` and `src/liveAiDemo.ts` were
  untouched. Codex later amended scope narrowly for `src/liveAiDemo.ts` as
  recorded below; the other three remain untouched.

### Verification run this session

- `pnpm install --frozen-lockfile` → `Already up to date`.
- `pnpm typecheck` → clean, no errors.
- Implementer-time `pnpm test` → **1466 passed, 1 failed, 2 skipped** (1469
  total). The one failure appeared in
  `test/liveAiDemo.test.ts` ("second turn: carries the returned state
  forward and increments callCount to 2", expected 400 to be 200) in
  `src/liveAiDemo.ts`. Codex established that Task 039's new closed snapshot
  field caused it, amended scope, fixed it by reusing the canonical parser,
  and reran the fully green gate below.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
  succeeded; bindings unchanged (`env.INTAKE_QUEUE` Queue,
  `env.APP_TIMEZONE`, `env.WHATSAPP_GRAPH_API_VERSION`).
- `pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run` →
  succeeded, same shape.
- `git diff --check` → exit 0, no whitespace errors (only benign
  LF→CRLF autocrlf notices on Windows).
- No real Supabase, Cloudflare, Meta or OpenAI call was made. No commit, push
  or deploy was performed. Both new SQL fixtures remain `NOT RUN`.

### Codex review record — 2026-08-29

Codex reviewed the complete Task 039 diff and the appointment, cancellation,
claim/burst, extraction and reply call paths. The task remains `IN_REVIEW`
pending its mandatory Claude Opus gate; no paid eval, staging migration,
staging deploy, Meta call, commit or push has been performed.

Targeted corrections made during review:

- serialized all per-pet hold/confirm/cancel decisions behind the same
  tenant-scoped pet lock, added a legacy-data guard, and ensured the public
  cancellation decision wrapper locks event → owner → conversation → pet
  before entering its private mutation body;
- made stale cancellation `HAYIR` truthful, preserved emergency/human
  precedence from completed conversations, and added only the two narrow
  database stage edges needed by those reviewed outcomes;
- replaced the transitive sliding burst with disjoint first-message-anchored
  windows, chronological claim ordering and an outbound boundary; a later
  window cannot overtake an earlier one, and only its representative completes
  eligible siblings;
- kept exact cancellation `EVET | HAYIR` on a zero-model deterministic path
  while routing every non-exact answer through extraction so a newly stated
  emergency can still win;
- wired the SQL-terminal `existing_confirmed` and `in_progress` results into
  the TypeScript client/consumer instead of retrying already-completed work;
- fixed the demo parser by reusing `readCanonicalPersistedSnapshot`; the
  delivery-time demo failure was introduced by Task 039's new closed snapshot
  key, not a pre-existing failure, so `src/liveAiDemo.ts` was added above as a
  narrow Codex-owned scope amendment;
- fixed the real PostgreSQL fixtures where tied timestamps, stale conversation
  selection, missing strict-AI routes and an impossible manual-claim setup had
  made the written proof diverge from runtime behavior;
- fixed a final integration defect found after the SQL gate: burst claims label
  even one eligible message as `Mesaj 1: ...`, so previous-question context and
  repeated-no-progress detection now match the aggregate only when it ends in
  the newest raw inbound. Tests cover labelled one-message and multi-message
  turns plus stale/mismatched history.

Disposable database evidence:

- Both source fixtures were executed successfully against disposable
  `vetai-test` (`cyjpiapxvalqltcsywam`) on the schema containing the reviewed
  Task 039 migrations. The temporary remote harness changed only fixture
  runner-role restoration (`RESET ROLE` → `SET LOCAL ROLE postgres`) because
  the Supabase CLI session restores to restricted `cli_login_postgres`; source
  fixtures remain rollback-only and unchanged in that respect.
- `039_pet_appointment_guard_and_cancellation.sql` → PASS with rollback and no
  fixture residue.
- `039_inbound_message_bursts.sql` → PASS with rollback and no fixture residue.
- A second full remote reset was not used after the disposable schema's first
  reset; the current `advance_conversation_intake` replacement was applied as
  a narrow temporary verification patch on that disposable project only.
  Staging and production were not mutated.

Final local gate after all corrections:

- `pnpm install --frozen-lockfile` → PASS (`Already up to date`).
- TypeScript no-emit check → PASS, zero errors.
- `pnpm exec vitest run` → PASS: **33 files, 1,522 passed, 2 opt-in
  paid-eval tests skipped, 0 failed**.
- production Wrangler dry-run → PASS, 170.45 KiB / gzip 35.82 KiB; bindings
  unchanged.
- staging Wrangler dry-run → PASS, same bundle shape with
  `vetai-intake-staging`; no deployment.
- `git diff --check` → PASS; only Windows LF/CRLF notices.

Review focus carried to Opus: identical per-pet lock ordering and
cancel/audit erasure, the two narrow terminal stage edges, fixed-window burst
privacy/order/idempotency, the labelled-aggregate context matcher, emergency
precedence, and the exact Turkish appointment/cancellation copy. The paid
Luna eval and both real staging WhatsApp smokes remain separately approval
gated after Opus PASS.

### Claude Opus mandatory read-only review — 2026-08-29

Claude Opus reviewed the complete Task 039 architecture/RLS/KVKK/clinical
safety surface and returned **PASS** with no blocking or change-required
finding. It independently confirmed the pet-scoped lock order, cancellation
atomicity and stale/replay behavior, audit-table RLS/erasure, narrow stage
edges, emergency precedence, burst ordering/privacy/overflow behavior,
labelled aggregate matching, zero-model exact cancellation path, terminal
offer results and the two unapproved human-review packages.

Three non-blocking observations were recorded: real two-session lock
contention remains logically rather than empirically proven; cancellation
audit rows intentionally cascade when their slot is erased; and the aggregate
suffix matcher was examined for forged `Mesaj N:` text without finding an
escape. The second point is already explicit in the KVKK package's data table,
so no duplicate prose was added.

After Opus PASS, Codex found one operational mismatch in the eval gate itself:
the contract authorizes Luna-only evidence while both existing harnesses
always ran Luna and Terra together. Codex added a closed, test-only
`LIVE_OPENAI_EVAL_MODEL` selector to both harnesses. It accepts only
`gpt-5.6-luna | gpt-5.6-terra`, rejects any other value before a network call,
and leaves the default historical two-model comparison unchanged. Targeted
tests PASS: 2 files, 13 passed, 2 paid gates skipped; typecheck remains clean.
Production code and model selection are untouched.

The active corpora contain 88 single-turn plus 47 multi-turn cases, therefore
the separately approval-gated Luna run is exactly **135 OpenAI calls**. The
official GPT-5.6 Luna price rechecked on 2026-08-29 is $0.20 per million input
tokens and $1.20 per million output tokens. Historical per-case evidence puts
the likely run near **$0.06–$0.07**. A deliberately conservative ceiling using
one token per source character and the full 1,200-output-token request cap is
below **$0.50**; actual usage is reported from provider token counts.

### Paid Luna eval evidence — 2026-08-29

Maya explicitly approved 135 corpus calls plus three synthetic output samples,
bounded by $0.50. Codex ran Luna only; Terra was not called. No real owner,
patient, WhatsApp or provider data was used.

- Single-turn corpus: **88/88** runtime-valid schemas, zero provider failures,
  1,081/1,249 expected leaf fields (86.55%), 13/13 explicit-red recall, 9/9
  explicit-false accuracy, 682/682 unspecified signals preserved as not-false,
  5/5 human intent, 5/5 medical-advice intent and 9/9 appointment intent.
  Tokens: 171,922 input + 13,369 output; measured cost **$0.0504272**.
- Multi-turn corpus: **47/47** runtime-valid schemas, zero provider failures,
  98/102 expected leaf fields (96.08%), 15/15 explicit-red recall, 50/50
  explicit-false accuracy, 311/311 unspecified signals preserved as not-false,
  zero unexpected explicit-red signals, 6/6 positive appointment invitations,
  4/4 negative/ambiguous appointment rejections, and the original mixed
  safety-negative/other-symptom case preserved. Tokens: 94,484 input + 6,736
  output; measured cost **$0.02698**.
- Exact whole-case differences remained in `T029-027`, `T029-045` and
  `T029-047`; the binding clinical/product metrics above all passed. The
  report initially counted only the non-burst mixed-symptom category. Codex
  expanded the test-only metric to both labelled mixed categories and added a
  closed single-case selector.
- Maya separately approved one diagnostic rerun of only `T029-047`. It
  produced 1/1 valid schema, 8/8 explicit false safety facts, zero unexpected
  red signals and 1/1 preservation of the other symptom/complaint. Its 2,137
  input + 151 output tokens cost **$0.0006086**. The remaining exact-field
  difference is wording normalization, not fact loss or a safety failure.
- Three separately approved synthetic demonstration calls also behaved as
  intended: named-pet cancellation mapped to `appointment_cancel_request`;
  `Merhaba` + `Pamuk kusuyor` preserved pet and vomiting; hours question +
  `kedim nefes alamıyor` produced `breathing_difficulty: true`. Their local
  demo response was displayed without secrets or provider bodies.

Measured corpus and diagnostic cost was **$0.0780158**; the three samples kept
the overall run far below the approved $0.50 ceiling. These are engineering
evals, not veterinarian approval. The prompt/model eval gate is PASS; staging
migration/deploy and WhatsApp smokes still require Maya's separate approval.

Final post-eval local rerun: frozen install PASS; typecheck PASS; **33 test
files, 1,525 passed, 2 opt-in live gates skipped, 0 failed**; production and
staging Wrangler dry-runs PASS at 170.45 KiB / gzip 35.82 KiB with unchanged
bindings; `git diff --check` PASS with only Windows line-ending notices.

Staging rollout record (2026-08-29): Maya explicitly authorized changes only
to `vetai-staging`; production remained untouched. The first migration push
failed atomically on the new legacy-data guard because one synthetic staging
pet had two future confirmed slots (10:00 and 10:30 Europe/Istanbul on
2026-08-31); neither Task 039 migration was recorded. After a read-only audit
and Maya's explicit approval, Codex returned only the later 10:30 test slot to
`available`, clearing its booking links/token while preserving the 10:00
appointment and all conversation/owner/pet rows. The retry then applied
`20260829000100` and `20260829000200`; `supabase migration list` showed local
and remote history aligned through both versions. The first Cloudflare deploy
request timed out before creating a version. A deployment-history check proved
that no new version existed, so Codex retried the same approved staging-only
deploy. Worker version `b25c1b9b-d55d-4621-988e-cb8c693c5e62` is now active at
`https://vetai-staging.mehmetsait7072.workers.dev`; `/ready` returned HTTP 200
with `{\"status\":\"ready\"}`. The two real WhatsApp smoke journeys remain in
progress; no production deploy or mutation occurred.

The first real WhatsApp lifecycle smoke proved the per-pet guard: after the
normal safety/intake confirmations, a second booking request for Pamuk returned
the existing `31.08.2026 10:00` confirmed appointment instead of holding a new
slot. The subsequent natural cancellation smoke exposed one integration bug,
not an OpenAI-credit failure: live logs showed three successful Luna calls
(the observed attempt used 1,960 input + 142 output tokens), followed each time
by `finalize_intake_queue_job: invalid next_stage`. An unbound conversation
whose extracted pet name did not exactly match one of two registered pets was
still allowed to plan `appointment_cancel_confirmation`; because its
`PetResolution` was not `matched`, the special cancellation finalizer was not
called and the generic finalizer correctly rejected that stage. The message
then exhausted its bounded retries and entered the existing DLQ handoff path;
no appointment was cancelled.

Codex fixed the fail-closed routing in `src/intakeTurn.ts`: an unbound,
unmatched cancellation request is now reduced to `needs_clarification` and
held at `pet_identification`; only an exact tenant-scoped pet match can enter
the cancellation stage. Two live-shape regression tests cover the pure planner
and full consumer disposition. Targeted tests passed 221/221; typecheck passed;
the full suite passed **1,527 with 2 opt-in paid evals skipped**; staging
dry-run passed at 170.69 KiB / gzip 35.85 KiB; `git diff --check` passed with
only line-ending notices. The narrow Worker-only correction was deployed to
staging as version `4a4fc5f4-922c-4221-a16f-fd60b4e4a8aa`, and `/ready`
returned HTTP 200. The exhausted synthetic conversation is now intentionally
in `human_handoff`; a fresh cancellation smoke requires Maya's explicit
approval to close only that staging conversation operationally. Production
remains untouched.

Maya approved closing only that failed staging conversation. Codex advanced
conversation `522627a5-74f3-4a0e-8cae-92dbf848586e` from
`handoff/human_handoff` version 2 to `completed/completed` version 3 without
deleting its owner, messages, pets, or the confirmed 10:00 appointment. A
second root cause was then found before asking for another live message:
first-message cancellation correctly produces unknown clinical safety fields,
but `planAppointmentAction` rejected every non-`continue_intake` plan after
`planIntakeTurn` had already selected `appointment_cancel_confirmation`. The
consumer therefore fell through to the generic finalizer and would reproduce
the same invalid-stage retry. The router now treats cancellation as an
administrative exception for `needs_safety_check` only; explicit emergency and
human-handoff decisions still win, while ordinary appointment booking remains
safety-gated. Exact cancellation `EVET/HAYIR` is likewise deterministic with
unknown safety fields. An ambiguous multi-pet cancellation now asks which pet
before clinical safety questions; an exact named match or the only existing pet
reaches the cancel lookup. Targeted appointment/reply/planner/consumer tests
and typecheck passed; full local verification and the replacement staging
deploy followed: frozen install PASS, typecheck PASS, **1,536 tests passed / 2
opt-in paid evals skipped**, production and staging dry-runs PASS at 170.95 KiB
/ gzip 35.87 KiB, and `git diff --check` PASS with line-ending notices only.
The fix was deployed only to staging as Worker version
`9b0f6db9-57ae-45de-8703-bcbcf5b3b679`; `/ready` returned HTTP 200 with
`{"status":"ready"}`. Production remained untouched. The next gate is a fresh
real WhatsApp cancellation smoke from the first message.

That fresh live smoke passed end to end. Maya sent a natural direct
cancellation request, received the exact pinned-appointment confirmation for
Pamuk at `31.08.2026 10:00`, replied `evet`, and received the fixed cancelled
copy. A read-only staging query then proved the same slot
`a4aaa5ba-95c5-4114-9677-7eec28fb2dbe` was `available` with booking links
cleared, and a durable `appointment_cancellations` audit row
`3652cced-8993-453c-8cf8-3785be1c3715` existed for Pamuk and the exact
31.08.2026 10:00 slot. The next live gate is rebooking that now-available slot,
followed by a fresh two-message burst.

Before that next live gate, Maya requested the external approval material.
Codex corrected the Task 039 veterinarian/KVKK draft headers to reflect the
completed disposable-DB and staging-only validation (production remains
untouched), added the direct-first-message cancellation boundary, and produced
four Turkish reviewer PDFs under `output/pdf`: the two general packages and
their two Task 039 supplements. Maya then asked for the veterinarian supplement
to show complete example conversations rather than isolated copy fragments.
Codex expanded that supplement to 13 synthetic, start-to-finish WhatsApp
scenarios covering ordinary intake, aggregate safety answers, split-message
bursts, emergency precedence, second-booking guards, cancellation variants,
correction, no-slot and overflow handoff. Each scenario now includes the bot's
user-visible replies and a veterinarian decision/risk field. Maya then asked
for the supplement to stand alone without requiring the older general package.
Codex added the system boundaries, 25 individually reviewable user-facing
texts, the 10-minute hold and Europe/Istanbul rules, staff-notification and
configured-hours limitations, the full clinical checklist, and the expanded
signature/storage record. The regenerated comprehensive veterinarian package
is 14 pages. Codex also rebuilt the Task 039 KVKK supplement as a standalone,
18-page Turkish legal-review workbook. It now contains an executive decision
list, plain-language data flows, controller/processor and data-subject roles, a
complete technical inventory, legal-basis and cross-border-transfer decision
tables, notice/consent separation, retention/destruction, data-subject request
handling, AI/human-intervention boundaries, minors/third-party health data,
groups/commercial messages, incident response, provider/clinic contracts and a
production go/no-go checklist. Its official-source section was refreshed on
2026-08-30. All 50 rendered pages across the four PDFs were visually inspected;
`pypdf` reopened every PDF, extracted the expected Turkish headings/status
text, confirmed all 25 copy headings, 13 scenario headings and 17 KVKK sections,
and found no raw Markdown emphasis markers or stale deployment claim. The documents remain explicitly
**unapproved drafts** until the
named external reviewers complete and sign them.

### Task 039 closure record — 2026-08-30

Maya completed the final combined staging journey from the dedicated pilot
number. She sent `Merhaba` and then `Pamuk kusuyor` within the configured burst
window and received exactly one automated reply: the existing safety-question
block. `Bunların hiçbiri yok.` then produced one correct pet/complaint summary
for Pamuk and vomiting. Exact `EVET` preserved that intake, produced the
truthful appointment invitation, and a second exact `EVET` held the previously
cancelled `31.08.2026 10:00` slot. The hold copy correctly said that the slot
was only temporary; the final exact `EVET` returned the fixed confirmed reply.
This closes both remaining live gates: one reply for the two-message burst and
successful rebooking of the slot released by the earlier cancellation smoke.

Codex reran the final repository gate after review corrections and before
commit: frozen install PASS; TypeScript typecheck PASS; **33 test files, 1,536
tests passed, 2 opt-in paid evals skipped, 0 failed**; production and staging
Wrangler dry-runs PASS at 170.95 KiB / gzip 35.87 KiB with unchanged bindings;
and `git diff --check` PASS with only benign Windows LF/CRLF notices. The two
Task 039 rollback fixtures had already passed with zero residue on disposable
`vetai-test`; both migrations are applied only to `vetai-staging`. No production
migration, production Worker deploy, push, or secret change occurred.

The veterinarian and Turkish legal/KVKK packages were regenerated and visually
verified, but remain expressly unsigned drafts. Their named human approvals,
production retention decisions, production credentials/resources, and a
production go/no-go remain outside this completed engineering task.

---

# Current task — 038 Natural Turkish interpretation and appointment invitation

Status: `COMPLETE` (closed 2026-08-28; local, Opus, paid-eval and live staging
WhatsApp gates passed. Production and external human approvals remain open.)

Opened by Codex on 2026-08-28 after Task 037 closed and Maya asked that the
product understand conversational Turkish rather than accumulate exact phrase
rules. This task changes the extraction prompt and therefore requires fresh
synthetic live evaluation before any staging deployment. It does **not** let
the model diagnose, invent availability, choose a database record, or confirm
an appointment.

## Goal

Make the existing AI boundary useful as an actual conversational interpreter:

1. understand varied, colloquial and elliptical Turkish from meaning and the
   immediately preceding clinic question, rather than from a growing list of
   literal phrases;
2. accept natural aggregate answers to the existing safety-question block
   while preserving any separately reported symptom;
3. after a safely confirmed intake, proactively ask whether the owner wants an
   appointment, so replies such as “olur”, “uygun saatlere bakalım” or
   “randevu ayarlayalım” can enter the existing appointment engine without the
   owner first having to type the exact sentence “randevu almak istiyorum”;
4. expose the exact OpenAI token usage of each successful production
   extraction without logging message content or identifiers, so real average
   model cost can be calculated from evidence.

This is the first of two deliberately bounded steps. Task 038 improves
understanding and adds the appointment invitation. A later Task 039 may add
controlled model-written wording only for low-risk intake questions, with the
current fixed copy as fallback. Task 039 must not generate emergency, medical,
handoff, slot, confirmation, privacy or consent text.

## Verified starting evidence

- Production already sends Luna the current inbound message plus at most the
  single immediately preceding eligible outbound question. Full history,
  owner/pet IDs and provider IDs are not sent.
- The Responses request already uses strict Structured Outputs and the result
  is revalidated by `parseIntakeExtraction`; the model cannot return a reply,
  database ID, stage, slot or action.
- `planAppointmentAction` already offers the earliest tenant-scoped slot when
  a safe matched-pet turn reaches `ready_for_triage | appointment_offer` with
  `intent === "appointment_request"`.
- After pet/intake confirmation, `planPostConfirmationReply` currently sends
  the generic “Bilgileri aldım...” copy. It does not invite the owner into the
  appointment flow even though the next inbound can already carry the prior
  question as bounded context.
- Appointment selection is a separate irreversible boundary: only exact
  normalized raw-text `EVET | HAYIR` controls the held slot. The model cannot
  supply the slot ID/token or confirm the mutation.
- `callOpenAiForIntake` already validates `usage.input_tokens`,
  `usage.output_tokens` and `usage.total_tokens` for evaluation, but the
  production wrapper discards those values.
- Prompt `2026-08-14.1` has live Luna/Terra evidence, but any text change makes
  that historical baseline non-authoritative for the new revision.
- Official OpenAI documentation recommends outcome-focused instructions,
  representative evals and Structured Outputs for stable machine-readable
  contracts. The implementation already uses Structured Outputs; this task
  must improve semantic guidance and evidence rather than add a phrase parser.

## Product and safety decisions — binding

1. **Meaning, not a phrase table.** Do not add a runtime list/regex of Turkish
   appointment or safety phrases. The prompt must instruct the model to
   interpret ordinary spelling errors, colloquial wording, inflection,
   negation and short answers from meaning. Examples may clarify classes but
   must not be described as an exhaustive vocabulary.
2. **One bounded context item.** Keep the current privacy boundary: current
   message plus at most one prior clinic question. Do not send full history,
   persisted intake data, owner/pet IDs, timestamps or provider metadata.
3. **Facts remain explicit.** Context may disambiguate what a short current
   answer refers to; it is never itself evidence. The model may output only
   facts justified by the resolved current answer. Unclear values stay null.
4. **Aggregate safety answers are supported.** When the previous question is
   the fixed safety list:
   - a clear aggregate negative such as “hiçbiri yok” may set every listed
     signal false;
   - naming only one or more listed conditions may set only those justified
     values true and leave unaddressed values null;
   - “bunlar yok ama yürüyüşü dengesiz” may set the listed signals false while
     preserving “yürüyüşte dengesizlik” as complaint/symptom;
   - ambiguity must never be converted to false and explicit true signals must
     keep deterministic emergency precedence.
5. **Appointment invitation.** A successful `create | confirmed` intake turn
   that is already safety-clear, or the later `safety_check →
   ready_for_triage` turn that resolves the remaining safety questions, sends
   exactly one fixed, reviewable Turkish invitation ending in `?`, rather than
   the generic closing sentence. The copy is:

   `Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?`

   This asks a question; it does not claim a booking, available time, staff
   action or response deadline.
6. **Contextual appointment intent.** If the prior clinic question is the
   appointment invitation, a clear affirmative or request to see/book suitable
   times maps to `appointment_request` even without the word “randevu”. A
   clear negative, postponement or refusal must not map to
   `appointment_request`. A direct appointment request continues to work
   without prior context. Mixed symptom + appointment messages preserve both
   the explicit symptom facts and appointment intent; safety still wins.
7. **Database owns availability.** The model never invents a day/time and
   never chooses a slot. `planAppointmentAction` and the existing database RPC
   remain the only route to the earliest real tenant-scoped future slot,
   rendered in `Europe/Istanbul`.
8. **Final mutation stays explicit.** Keep exact normalized raw-text
   `EVET | HAYIR` for the already shown and temporarily held slot in this
   task. Natural conversation may reach the offer, but only the deterministic
   confirmation grammar may confirm/release the specific hold. Changing that
   authority requires a separate reviewed contract.
9. **Critical copy stays deterministic.** The model still cannot write any
   owner-facing text. Emergency, safety-question, human-handoff, privacy,
   intake-confirmation, appointment-offer and appointment-confirmation copy
   remains fixed. Task 039 is not pre-authorized by this record.
10. **Usage telemetry is content-free.** A successful production extraction
    may emit one fixed structured log containing only the model name and
    validated non-negative input/output/total token counts. It must contain no
    message text, previous question, owner/conversation/provider/pet ID,
    safety identifier, API key or provider response body. Missing/malformed
    usage remains `null` and must not turn a valid extraction into failure.
11. **No hardcoded monetary claim in runtime.** Log exact token counts, not a
    fixed USD/TL amount. Prices and exchange rates change; cost is calculated
    in the eval/report using the then-current official OpenAI rates.
12. No database migration, new dependency, production deploy, staging deploy,
    real WhatsApp send, paid eval, commit or push is authorized for the
    implementing agent.

## Required behavior and tests

### Prompt and extraction

- Bump the prompt version once and align both live-eval corpus metadata files.
- Keep the exact existing JSON schema and strict runtime parser unchanged
  unless Codex first amends this contract. No new intent is needed.
- Add prompt-contract tests proving the semantic/non-exhaustive rule,
  appointment-invitation context, aggregate safety rules, explicit-facts-only
  boundary, and unchanged diagnosis/medication/action prohibitions.
- Extend the synthetic corpora with representative Turkish, including at
  least:
  - invitation replies: `olur`, `evet lütfen`, `uygun saatlere bakalım`,
    `müsait olduğunuz zamana yazalım`, `randevu ayarlayabilir miyiz`, common
    typo/spacing variants;
  - negatives: `şimdilik istemiyorum`, `hayır teşekkürler`, `sonra bakarız`;
  - direct appointment requests without prior context;
  - mixed symptom + appointment requests;
  - full and partial aggregate safety negatives, one/multiple listed true
    signals, and “listed conditions absent + another symptom present”;
  - ambiguous replies that must preserve null rather than fail open.
- Do not use a hardcoded production phrase classifier to make these tests
  pass. Mocked tests verify request shape and deterministic consumers; live
  eval is the evidence for model semantics.

### Appointment invitation and routing

- `planPostConfirmationReply` returns the fixed appointment invitation for a
  successful, safety-clear confirmed intake.
- If confirmation first requires safety questions, the later safe transition
  from `safety_check` to `ready_for_triage` returns the same fixed invitation;
  this is the ordinary path and must not fall back to the generic closing copy.
- The invitation is eligible for the existing one-question context selector.
- A natural affirmative extracted as `appointment_request` reaches the
  existing offer RPC only when all current safety, pet-match and stage guards
  pass.
- A negative/ambiguous answer, an emergency, human request, malformed state,
  unresolved pet, unavailable slot or stale hold cannot create/confirm an
  appointment and preserves the existing fail-closed outcome.
- Direct `randevu almak istiyorum` behavior and exact held-slot `EVET | HAYIR`
  behavior remain covered by regression tests.

### Usage evidence

- The production OpenAI success result includes validated usage or null,
  without weakening extraction validation.
- The consumer emits at most one usage log for a successful model call and no
  usage log when no model call occurs or the call fails.
- Tests inspect every logged value and prove raw current/previous messages,
  IDs, safety identifier, secrets and provider bodies are absent.
- Evaluation reports continue to show total tokens, latency and cost. No live
  call is made during the ordinary test suite.

## Allowed changes

- `prompts/intake-extraction-prompt.ts`
- `src/openaiIntake.ts`
- `src/intakeConsumer.ts`
- `src/petRegistration.ts`
- `test/intakeExtractionPrompt.test.ts`
- `test/openaiIntake.test.ts`
- `test/intakeConsumer.test.ts`
- `test/petRegistration.test.ts`
- `test/liveOpenAiEval.test.ts` only for metadata/metric assertions required
  by the revised corpus
- `test/liveOpenAiMultiTurnEval.test.ts` only for metadata/metric assertions
  required by the revised corpus
- `evals/intake-live-cases.json`
- `evals/intake-multiturn-live-cases.json`
- `docs/ai-behavior-and-safety.md`
- `docs/inbound-queue.md`
- `docs/whatsapp-appointment-flow.md`
- `docs/veteriner-hekim-onay-paketi.md` only to add the new invitation as
  pending human-review copy
- `docs/kvkk-inceleme-paketi.md` only for Codex's post-review inventory note
  about the bounded previous-question context and stable pseudonymous safety
  identifier disclosed to OpenAI
- `docs/product-roadmap.md` only for the Task 038 result and the bounded Task
  039 follow-up described above
- `CURRENT_TASK.md`, but the implementing agent may fill only this task's
  **Observed context** and **Delivery record** sections

Anything else requires Codex to amend this contract before implementation.
Do not edit `PROJECT_CONTEXT.md`; Codex owns it after verification. Preserve
the user's pre-existing `.gitignore` change byte-for-byte.

## Required local verification

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

The normal suite must skip both opt-in paid eval gates. No database check is
required because schema/RPC/RLS do not change.

## Review, eval and staging gates

1. Sonnet implements within the exact allowed list, records evidence, and
   makes no commit/push/deploy/live call.
2. Codex reviews the full prompt/input/call/routing/logging diff and reruns the
   local gate. Any phrase-table workaround is rejected.
3. Claude Opus performs a mandatory read-only safety/privacy review of
   aggregate safety interpretation, appointment precedence, bounded context
   and telemetry contents.
4. Because the prompt changes, Codex presents the exact synthetic call count
   and estimated maximum cost, then obtains Maya's separate approval before
   running Luna/Terra live evals. Evals are required after prompt/model/schema
   changes, not after unrelated tasks.
5. Mandatory live gates for both models on the new prompt revision:
   - 100% runtime-valid schema and zero provider failures;
   - 100% explicit-red recall;
   - 100% explicit-false accuracy for labelled safety facts;
   - 100% unspecified safety values preserved as not-false;
   - zero unexpected explicit-red signals;
   - every labelled positive appointment-invitation reply maps to
     `appointment_request`, and no labelled negative/ambiguous reply does;
   - every labelled mixed “listed conditions absent + other symptom” case
     preserves that other symptom/complaint.
6. Passing evals do not automatically change the production model. Luna stays
   selected unless a separately reviewed cost/quality decision changes it.
7. Only after the local, Opus and live-eval gates pass and Maya separately
   approves may Codex deploy staging and run a fresh WhatsApp smoke:
   confirmed intake → appointment invitation → natural affirmative → real
   earliest-slot offer. The final slot confirmation remains exact `EVET`.
8. Production remains out of scope. Veterinarian review of the new Turkish
   invitation and all existing external legal/KVKK gates remain open.

## Observed context

Implementation began from `d89eb2d` (`docs: define natural Turkish
appointment task`). The working tree contained only the user's pre-existing
`.gitignore` addition (`tmp/`); it was not edited by this task. `rtk` is not
installed in this shell, so native commands were used.

Repository inspection confirmed the contract's starting boundaries:

- `src/openaiIntake.ts` already sends the current message plus at most one
  labelled prior clinic question, uses strict Structured Outputs, reparses via
  `parseIntakeExtraction`, and already validates optional provider usage for
  the evaluation entry point. The production wrapper discarded that usage.
- `src/intakeConsumer.ts` performs one extraction before pure intake,
  registration, safety and appointment planning. Existing media, non-AI,
  terminal/handoff and poison paths return before the model call.
- `src/petRegistration.ts` is the only caller-owned post-confirmation reply
  boundary. The successful `create | confirmed` branches pass through
  `planPostConfirmationReply`; the exact held-slot `EVET | HAYIR` parser and
  appointment finalizers are separate and unchanged.
- `src/appointmentFlow.ts` already admits `appointment_request` only after
  safety/stage/pet guards and delegates real availability/holding to the
  existing tenant-scoped database RPC. No new runtime phrase classifier or
  slot-selection path was needed.
- Both opt-in eval harnesses already report provider-validity, usage, latency
  and estimated cost while ordinary `pnpm test` skips paid calls. Their corpus
  metadata needed a prompt-version bump and Task 038 semantic cases.
- Official OpenAI guidance was checked for outcome-focused instructions,
  representative evals and Structured Outputs. The existing schema/parser
  boundary was therefore retained; the prompt was revised without adding a
  dependency or runtime phrase table.

## Delivery record

Implemented Task 038 within the exact allowed-change list. The user's
pre-existing `.gitignore` change remains byte-for-byte outside this delivery.

Changed files:

- `prompts/intake-extraction-prompt.ts`: bumped to `2026-08-28.1` and added
  meaning-based Turkish, aggregate safety-list and contextual appointment
  guidance while preserving the exact schema and all diagnosis/action bans.
- `src/openaiIntake.ts`, `src/intakeConsumer.ts`: returned validated usage (or
  `null`) to production and emitted one content-free structured usage log per
  successful model call when usage exists. Codex review also added a narrow
  system-context guard so an `unknown` reply to the exact appointment
  invitation cannot resurrect an older persisted `appointment_request`.
- `src/petRegistration.ts`: added the fixed post-confirmation invitation and
  preserved deterministic safety-copy precedence.
- `test/intakeExtractionPrompt.test.ts`, `test/openaiIntake.test.ts`,
  `test/intakeConsumer.test.ts`, `test/petRegistration.test.ts`: covered the
  new prompt contract, usage/null behavior, no-content telemetry, no-model
  silence, one-question invitation routing into the existing offer RPC, exact
  post-confirmation copy and safety precedence.
- `evals/intake-live-cases.json`: prompt/eval version `2026-08-28.1`, 77 total
  cases, including direct/typo/mixed symptom-and-appointment requests.
- `evals/intake-multiturn-live-cases.json`: prompt/eval version
  `2026-08-28.1`, 46 total cases, including six positive, three negative and
  one ambiguous invitation reply plus aggregate-negative, partial,
  true-signal, uncertain and other-symptom safety answers.
- `test/liveOpenAiEval.test.ts`, `test/liveOpenAiMultiTurnEval.test.ts`:
  aligned metadata/pricing-review date and added separate appointment and
  mixed-symptom evidence metrics/assertions. The bounded two-model multi-turn
  plan is 92 calls, below its hard maximum of 100.
- `docs/ai-behavior-and-safety.md`, `docs/inbound-queue.md`,
  `docs/whatsapp-appointment-flow.md`: documented the unchanged bounded input,
  deterministic safety/booking authority, invitation flow and content-free
  token telemetry.
- `docs/veteriner-hekim-onay-paketi.md`: added the exact invitation as pending
  veterinary-review item V-12.
- `docs/product-roadmap.md`: recorded the Task 038 result/gates and kept Task
  039 narrowly limited to low-risk wording with fixed fallback.

Acceptance evidence:

- No phrase table, regular-expression classifier, new intent, new schema
  field, parser weakening, dependency, migration or database operation was
  added.
- The model still receives only current text plus at most one untrusted prior
  question and cannot write replies, choose a pet/slot, or confirm a hold.
- Natural invitation intent reaches only the existing guarded appointment
  offer route; exact raw-text `EVET | HAYIR` remains the final held-slot
  mutation authority. A refusal, postponement or ambiguous invitation reply
  cannot inherit an older appointment intent from persisted intake state.
- Usage values must be validated non-negative safe integers. Missing/malformed
  usage does not fail a valid extraction and produces no usage log. Tests
  inspect the complete log arguments and exclude message/context, ids, safety
  identifier, key, complaint and provider-body content.

Checks run:

- `pnpm install --frozen-lockfile` — PASS (`Already up to date`).
- `pnpm typecheck` — PASS, zero errors. The first sandboxed attempt hit the
  host's known `EPERM lstat C:\\Users\\mehme`; the same command passed when
  run with the required local permission.
- `pnpm test` — PASS after Codex's stale-intent and Opus-review corrections:
  33 files, 1,449 passed, 2 opt-in paid evals skipped, 0 failed (1,451 total).
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — PASS,
  production bundle 157.37 KiB / gzip 33.53 KiB, no deploy.
- `pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir
  .wrangler/staging-dry-run` — PASS, staging bundle 157.37 KiB / gzip 33.53
  KiB, no deploy.
- `git diff --check` — PASS; only expected LF/CRLF notices.

Explicitly NOT RUN: any real Meta/Supabase call, database/migration check (no
database change), production deploy, WhatsApp send, commit and push. The first
Task 038 staging Worker version was deployed and readiness-checked as recorded
below, but no WhatsApp smoke was sent.

Known limitations and review risks for Codex/Opus:

- All corpus expectations and live results are engineering-labelled synthetic
  evidence, not veterinary approval.
- Aggregate safety semantics depend on model behavior and therefore require
  the mandatory explicit-red/false/null/unexpected-red live gates; the
  deterministic post-extraction safety gate itself is unchanged.
- Usage telemetry exists only when OpenAI supplies all three valid counts and
  is per successful extraction attempt, so a Queue retry may legitimately
  produce another content-free record. It deliberately makes no runtime USD/TL
  claim.
- `appointment_request` is deliberately treated as a non-sticky action intent:
  a later `unknown` extraction clears it instead of replaying it. A direct
  request is guaranteed on the turn where it is stated; after intake the fixed
  invitation lets the owner express the request again. This is fail-closed and
  prevents stale slot holds.
- The new Turkish invitation is fixed and truthful but remains pending the
  clinical veterinarian review recorded as V-12. Existing legal/KVKK gates
  also remain open.
- Task 039 is not implemented or authorized here; all critical copy remains
  deterministic and unchanged.

## Codex review record — 2026-08-28

Codex reviewed the complete prompt, bounded-input, parser, routing, telemetry,
eval and documentation diff. The implementation keeps Structured Outputs and
the strict runtime parser unchanged, sends at most one prior system question,
adds no runtime Turkish phrase table, leaves database availability and exact
held-slot `EVET | HAYIR` authority unchanged, and logs only validated token
counts plus the fixed model name.

One material routing defect was found and fixed during review. Persisted intake
normally keeps a previous non-`unknown` intent, so a correctly extracted
negative or ambiguous answer (`intent: unknown`) to the appointment invitation
could have resurrected an older `appointment_request`. The consumer now resets
only that exact system-owned invitation context to neutral `routine_request`
before merging. A new end-to-end regression proves that no offer RPC runs and
the stale intent is removed; positive replies still require model semantic
classification and all existing guards.

The full required local gate then passed: frozen install, clean typecheck,
1,449 tests passed with the two paid eval gates skipped, production and staging
dry-run bundles passed, and `git diff --check` passed. Scope matches the allowed
list except for the user's pre-existing untouched `.gitignore` change.

Claude Opus's first read-only pass found one batched-message hole in that
correction: tying it to the bounded previous-question selector still allowed a
persisted appointment action to survive when a later inbound message made the
selector return `null`. Codex replaced that condition with the stronger action
semantics: whenever persisted intent is `appointment_request` and the current
validated extraction is `unknown`, the turn becomes neutral
`routine_request`. The regression now includes the trailing second inbound
message and proves both a two-item model input and zero appointment-offer RPC.

The same review identified three cheap completeness fixes, all applied before
live evaluation: the fixed invitation again includes the immediate
worsening-case off-bot contact path; the partial/true/uncertain safety cases now
use the exact production bullet-list question; and the KVKK inventory now
records that the single previous question can contain pet/intake summary data
and that the stable hashed safety identifier is pseudonymous/linkable. The
stale source comment was corrected. The full local gate above was rerun after
all changes.

Claude Opus then performed the required narrow read-only re-check and returned
`PASS`: the batched-message regression, off-bot contact copy, corrected source
comment, production-format safety cases and KVKK inventory were all confirmed
closed. Its process note N1 was already satisfied by Codex's explicit contract
amendment adding the KVKK document to the allowed list and updating the binding
invitation copy. Its non-blocking N2 is recorded above; N3 is an optional extra
test hardening note because the two already-correct production-format cases are
outside the four-case regression loop.

The user then approved the bounded live gate. Codex ran 77 single-turn and 46
multi-turn cases against both Luna and Terra sequentially: exactly 246
synthetic API calls. Both models returned valid schemas for every call with
zero provider failures and no missing usage. Mandatory gates all passed:
single-turn explicit red 11/11, explicit false 9/9, unspecified-not-false
596/596 and appointment intent 9/9; multi-turn explicit red 15/15, explicit
false 42/42, explicit null 16/16, unspecified-not-false 311/311, zero
unexpected explicit red, appointment positives 6/6, negative/ambiguous
rejections 4/4, and aggregate-negative-plus-other-symptom preservation 1/1.

Luna matched 985/1,144 single-turn expected leaves and 90/92 multi-turn leaves;
Terra matched 968/1,144 and 91/92 respectively. Both multi-turn reports listed
only `T029-045` as non-exact, while its mandatory symptom-preservation gate
still passed. Token-derived estimated costs were $0.0628416 for Luna and
$0.627384 for Terra, $0.6902256 total—within the approved $1 operational cap.
Luna remains production-selected because every mandatory gate passed and
Terra cost roughly ten times more without a gate-level advantage.

After user approval, Codex deployed staging Worker version
`48698e61-3203-4893-acf1-8f2d8dfa8bff`; `/health` and `/ready` both returned
HTTP 200. Before asking the user to send the smoke message, Codex traced the
ordinary flow and found that the invitation was emitted only when safety was
already clear on the confirmation turn. In the common path—confirmation asks
the safety block, then the owner clears it—the later `safety_check →
ready_for_triage` turn still emitted the old generic closing copy.

Codex amended the contract and consumer minimally: that exact safe transition
now reuses the same fixed appointment invitation, while unresolved/emergency/
handoff decisions retain their existing precedence. Targeted tests are 176/176,
the full suite is again 1,449 passed plus 2 paid gates skipped, typecheck and
staging dry-run pass. The prompt/schema/model did not change, so the completed
246-call semantic eval remains applicable. The currently deployed staging
version does not yet contain this post-deploy correction and must not be used
for the smoke.

Claude Opus completed the requested narrow read-only routing re-check and
returned `PASS`. It confirmed that only the resolved `safety_check →
ready_for_triage` ordinary path can receive the invitation; emergency,
handoff, unresolved, malformed and terminal paths cannot. Appointment-offer
RPC precedence, off-bot worsening guidance and the completed 246-call eval
remain valid. Codex also added Opus's recommended isolated regression test:
an already-`ready_for_triage` conversation with all safety signals false does
not receive the invitation again. The targeted consumer suite is 125/125 and
the full suite is 1,450 passed plus 2 paid gates skipped; frozen install,
typecheck, staging dry-run and `git diff --check` pass.

Codex replaced staging with Worker version
`47b745ae-db7b-4627-886d-939117aed8e2`; `/health` and `/ready` both returned
HTTP 200. Maya then completed the fresh real-WhatsApp smoke through the
corrected flow: ordinary intake reached the proactive appointment invitation,
a natural affirmative reached a real database-owned available-slot offer, and
the exact final `EVET` produced the confirmed-appointment reply. Worker tail
showed each inbound persisted and each Queue turn completed without an error;
content-free OpenAI telemetry identified `gpt-5.6-luna` and token counts only.

Decision: `COMPLETE`. Production, veterinarian approval, and legal/KVKK
approval remain out of scope and open. The existing appointment engine still
limits one active slot per conversation—not per pet—and has no cancellation or
reschedule-after-confirmation flow; those are follow-up product tasks, not
claims made by Task 038.

---

# Current task — 037 Second-pet registration and atomic pet finalization

Status: `COMPLETE` (closed 2026-08-28; Codex engineering/database gate and
mandatory Claude Opus read-only review passed. Staging and production remain
unchanged.)

Opened by Codex on 2026-08-27 after Task 036 closed and the fresh zero-pet
staging smoke passed. This task intentionally does **not** change the model
prompt, safety-question language, appointment behavior, production resources,
or the one-open-conversation-per-owner rule.

## Goal

Close two related defects with one minimal, reviewed change:

1. An owner who already has one or more registered pets must be able to register
   a distinctly named second pet when the current conversation has no selected
   `pet_id`. The existing `intake_confirmation` + exact `EVET` gate remains the
   only creation authority.
2. A stale optimistic version must never commit a newly inserted pet while the
   conversation advance fails. Pet insert, conversation link/stage advance,
   reply outbox insert, and lease completion remain one atomic operation.

## Verified starting evidence

- `PetResolution` currently has only `matched | needs_clarification`.
- `resolvePet()` returns `needs_clarification` both for “no matching registered
  pet” and “more than one normalized match”; those cases cannot safely share a
  creation decision.
- `isPetIdentityKnown()` accepts an unmatched candidate only when
  `context.pets.length === 0`, so an existing owner naming a second animal is
  held in `pet_identification`. Task 036 only bounded that loop with handoff.
- `finalize_intake_queue_job` inserts the pet before
  `advance_conversation_intake`. A normal `stale_state` return after the insert
  commits the pet, leaves `conversations.pet_id` unchanged, and leaves the
  intake lease processing until expiry.
- The active conversation model is one open conversation per owner. A
  conversation already linked to one pet may contain old clinical context;
  silently switching it to another animal is therefore outside this task and
  must fail closed to the existing human-handoff path.

## Product and safety decisions — binding

1. Extend the closed `PetResolution` union with exactly one candidate case for
   an explicit pet name that has **zero** normalized matches among the
   tenant-scoped `context.pets`. Do not add fuzzy matching or accept an ID from
   the model.
2. An explicit name with exactly one normalized match stays `matched`; more
   than one match stays `needs_clarification`; no explicit name keeps the
   existing single-pet fallback.
3. A `new_candidate` is identity-known only when `context.petId === null`.
   Whether the owner already has other pets is irrelevant. It may progress
   through complaint collection into the existing `intake_confirmation` flow.
4. `planPetRegistrationAction` may return `create` only for `new_candidate`
   after the exact confirmation grammar accepts `EVET`. A matched pet is never
   recreated; `needs_clarification` is never treated as a new pet.
5. If `context.petId` is non-null and the current turn explicitly names a
   different/unmatched pet, never silently relink the active conversation and
   never persist the new animal's identity or clinical facts as if they
   belonged to the selected pet. Route to the existing truthful human-handoff
   path. Preserve newly reported deterministic safety signals so an emergency
   still receives emergency copy and the staff work item can still become
   urgent. Do not diagnose or add new user-facing copy.
6. The Task 036 bounded-handoff fallback remains as defense in depth, but the
   valid unbound second-pet path must no longer reach it.
7. Before any pet insert, the finalizer must lock the exact tenant-scoped
   conversation row and verify `state_version = p_expected_version`. A mismatch
   returns the existing closed `stale_state` result with zero pet/outbox/state
   mutation and leaves the current lease available for the existing retry
   policy.
8. Once that row lock/version check succeeds, a later zero-row result from
   `advance_conversation_intake` is an invariant violation and must raise so
   the whole transaction rolls back. Do not turn database errors into success.
9. Keep the accepted pilot ceiling: the AI duplicate-name guard remains an
   application-level normalized-name check, not a table-wide unique index.
   Staff pet inserts remain unchanged.
10. No production migration, deploy, real WhatsApp/OpenAI call, commit, or push
    is authorized for the implementing agent.

## Required behavior

### Pure planning

- Zero registered pets + explicit “Minnoş” → `new_candidate`, identity known.
- Existing Karamel + unbound conversation + explicit “Minnoş” →
  `new_candidate`, progresses normally.
- Existing Karamel + unbound conversation + explicit “Karamel” → `matched`.
- Two normalized Karamel rows + explicit “Karamel” → `needs_clarification`.
- No explicit name + exactly one registered pet keeps the current automatic
  exact pet selection.
- Selected Karamel + explicit Minnoş/new unmatched name → human handoff,
  Karamel remains selected, Minnoş identity/complaint/symptoms are not merged
  into Karamel's persisted snapshot, and any true/null safety information from
  the new turn is still evaluated fail-closed.

### Confirmation and persistence

- An unbound owner with existing pets receives the same combined
  name/species/complaint confirmation already used for a first pet.
- No row is created before exact `EVET`.
- Exact `EVET` calls the existing finalizer creation parameters once; one new
  pet is created under the server-resolved clinic/owner, the conversation is
  linked to it, and the stage advances to `safety_check` atomically.
- `HAYIR`, correction, repeat, safety, human request, malformed snapshot,
  non-AI routing, stale claim, and completed conversation cannot create a pet.
- A normalized duplicate can never create another AI pet. The existing
  retry/self-heal behavior may remain, but must be explicitly tested.
- A stale expected version with creation parameters returns `stale_state` and
  proves: zero matching pet rows, unchanged conversation link/stage/version,
  zero reply outbox rows, and unchanged current lease token/status.
- Retrying the same logical turn with the current version creates exactly one
  pet and completes normally.

## Database requirements

- Add one forward-only migration after
  `20260826000100_intake_confirmation_stage.sql`; do not edit an applied
  migration.
- Replace only the current `finalize_intake_queue_job` signature/body and keep
  its result shape, grants, `SECURITY INVOKER`, volatility, empty search path,
  selective-automation suppression, reply validation, tenant derivation,
  duplicate guard, outbox behavior, and lease completion semantics unchanged
  except for the explicit atomically safe version check above.
- Add a rollback-only SQL proof. It must exercise the real RPC as
  `service_role`, cover an existing owner registering a distinct second pet,
  duplicate refusal, stale-version zero-mutation + successful retry, tenant
  isolation, and zero fixture residue. A single-session fixture may not claim
  to prove real concurrent blocking.
- Sonnet must mark both migration and fixture `NOT APPLIED` / `NOT RUN`.
  Codex will validate them on disposable `vetai-test` after review.

## Allowed changes

- `supabase/migrations/20260827000100_second_pet_registration_atomicity.sql`
- `supabase/tests/037_second_pet_registration_atomicity.sql`
- `src/intakeExtraction.ts`
- `src/intakeTurn.ts`
- `src/petRegistration.ts`
- `src/intakeConsumer.ts`
- `src/localDemo.ts` only if the closed resolution-label map requires it
- `test/intakeExtraction.test.ts`
- `test/intakeTurn.test.ts`
- `test/petRegistration.test.ts`
- `test/intakeConsumer.test.ts`
- `test/localDemo.test.ts` only if an existing scenario changes
- `docs/ai-behavior-and-safety.md`
- `docs/database-schema.md`
- `docs/inbound-queue.md`
- `docs/kvkk-inceleme-paketi.md`
- `CURRENT_TASK.md`, but the implementing agent may fill only this task's
  **Observed context** and **Delivery record** sections

Anything else requires Codex to amend this contract before implementation.
Do not edit `PROJECT_CONTEXT.md`; Codex owns it after verification.

## Required tests and checks

- Add focused unit/integration tests for every behavior listed above, including
  no repeated OpenAI call after the selected-pet conflict has persisted the
  handoff stage, and no create parameters before exact confirmation. Detecting
  the conflict on its first turn still requires the one normal extraction call.
- Preserve all existing safety, first-pet, appointment, routing, and outbound
  tests.
- Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

- Do not run a paid model eval: no prompt/model/extraction schema changes are
  authorized. Do not apply the migration or SQL fixture to any database.

## Review and staging gates

1. Sonnet implements and records evidence without commit/push/deploy.
2. Codex reviews the entire diff/call path, runs the required checks, applies
   the migration plus rollback fixture only to disposable `vetai-test`, and
   makes minimum corrections.
3. Claude Opus performs a mandatory read-only review of transaction atomicity,
   tenant/pet isolation, selected-pet conflict handling, RLS/grants, and KVKK
   retention semantics.
4. Only after PASS and Maya's separate approval may Codex migrate/deploy
   staging and run one live WhatsApp second-pet smoke. Production remains out
   of scope.

## Observed context

- Repository was clean at task start on top of commit
  `096b26c docs: define Task 037 second-pet integrity contract`; the only
  other pending change (`M .gitignore`) predates this task and was left
  untouched.
- `supabase/migrations/` ended at `20260826000100_intake_confirmation_stage.sql`
  (Task 036); `supabase/tests/` ended at `035_pet_registration.sql` — used as
  the exact byte-for-byte base for the new migration and as the structural
  template (`run_pet_turn` helper, multi-turn stage progression) for the new
  fixture.
- `finalize_intake_queue_job` (as of `20260826000100`) already validated
  `p_expected_version` against `advance_conversation_intake`'s own
  `WHERE state_version = p_expected_version` guard, but only *after* an
  unconditional `p_create_pet_name` insert into `pets` when that parameter
  was supplied — a stale-version retry on the create path could therefore
  insert a real pet row and then return `stale_state` with that row already
  committed. This is exactly the defect Goal item 2 and decisions 7–8
  describe; confirmed by reading the migration directly before editing.
- `src/intakeExtraction.ts`'s `resolvePet` already normalized names via
  NFKC/whitespace/Turkish-lowercase and never fuzzy-matched, but collapsed
  both the zero-match and multiple-match cases into `needs_clarification`
  (`PetResolution` had no third case) — so an owner with an existing pet who
  named a genuinely new second animal could never be distinguished, in the
  type system, from an owner whose input was ambiguous.
- `src/petRegistration.ts`'s `planPetRegistrationAction` authorized `create`
  on exact `"evet"` for any resolution kind, not only an unmatched name —
  the confirmation-text/duplicate-name guards were the only things standing
  between an ambiguous resolution and a created row.
- `src/intakeConsumer.ts` needed no code change: `preserveHumanHandledPetBoundary`
  and `isHandoffConsistent` operate on `plan.nextStage`/`plan.safetyDecision`
  and are agnostic to *why* a plan chose `human_handoff`, and the existing
  `context.intakeStage === "human_handoff" || "completed"` short-circuit
  (line 45) already skips the OpenAI call on every turn after a conflict has
  forced the stage there — confirmed by tracing both functions and by the
  new end-to-end test added under "selected-pet conflict handoff" below.
- Two existing tests in `test/intakeConsumer.test.ts` (previously titled
  around "naming a different animal is handed off after the identical
  question repeats" / "...after only one prior question") asserted the
  pre-Task-037 defect itself — an owner with a registered pet naming a
  distinct second pet got stuck at `pet_identification` — as correct
  behavior. Renamed and re-asserted per Goal item 1; this is a behavior fix,
  not a preserved regression.

## Delivery record

### Changed files

- `supabase/migrations/20260827000100_second_pet_registration_atomicity.sql`
  (new) — byte-for-byte copy of `20260826000100_intake_confirmation_stage.sql`
  except: (1) locks the conversation row and checks `state_version` before
  the `p_create_pet_name` insert, returning `stale_state` immediately on a
  mismatch instead of inserting; (2) the post-`advance_conversation_intake`
  zero-row branch (which previously returned `stale_state` after the pet was
  already inserted) is now `raise exception` — a zero-row result after the
  pre-insert version check already succeeded is an invariant violation, not
  a retryable outcome. **NOT APPLIED to any database.**
- `supabase/tests/037_second_pet_registration_atomicity.sql` (new) —
  rollback-only (`begin ... rollback`) fixture: two-clinic setup, a
  `pg_temp.run_second_pet_turn` helper mirroring `035`'s `run_pet_turn` with
  an added expected-version override, and five `do $$ ... $$` blocks
  covering (1) second-pet registration for an owner with an existing pet via
  proper one-hop-per-call stage progression, (2) the core atomicity proof —
  a stale-version create attempt mutates zero rows, (3) a same-turn retry
  with the corrected version succeeds, (4) duplicate-name refusal, (5)
  cross-tenant isolation. **NOT RUN against any database.**
- `src/intakeExtraction.ts` — `PetResolution` gains `{ kind: "new_candidate" }`;
  `resolvePet`'s explicit-name branch returns it on zero normalized matches
  (decision 1); multiple matches still return `needs_clarification`
  (decision 2).
- `src/intakeTurn.ts` — added `detectSelectedPetConflict` (true when
  `context.petId` is non-null and the turn's resolved name doesn't match
  that pet), `mergeSnapshotPreservingIdentity` (keeps the stored pet's
  identity/clinical fields exactly, merges only `intent`,
  `reported_safety_signals`, `user_requested_human` — decision 5), and a
  `petConflict` parameter on `decideNextStage` that forces `human_handoff`.
  `resolvePetForContext` was read but not modified: it already returns
  `context.petId` unchanged whenever one is selected, which structurally
  guarantees decision 3 (`new_candidate` is reachable only when
  `context.petId === null`) without an extra guard.
- `src/petRegistration.ts` — `planPetRegistrationAction`'s `confirm` branch
  now requires `resolution.kind === "new_candidate"` before returning
  `create`; every other resolution kind returns `none` (decision 4).
- `src/localDemo.ts` — added the required `new_candidate` entry to
  `PET_RESOLUTION_LABELS` (TS strict indexing over the widened union).
- `test/intakeExtraction.test.ts` — updated the two zero-match
  `resolvePet` expectations from `needs_clarification` to `new_candidate`;
  added a zero-registered-pets case; left the duplicate-match
  (`needs_clarification`) test unchanged.
- `test/intakeTurn.test.ts` — split one combined test into an ambiguous-
  duplicate case (`needs_clarification`, unchanged outcome) and a new
  no-match-with-other-pets-present case (`new_candidate`); added a
  zero-pets `new_candidate` case; added three new tests proving a
  selected-pet conflict routes to `human_handoff` without merging the
  conflicting animal's identity/clinical fields, for both an unmatched
  explicit name and a brand-new name, and that a true safety signal still
  merges through during a conflict turn.
- `test/petRegistration.test.ts` — changed the shared `planned()` helper's
  default `petResolution` from `{ kind: "needs_clarification" }` to
  `{ kind: "new_candidate" }` (traced every call site first; several
  existing `create`-expecting tests relied on the old default and would
  otherwise have silently broken under the tightened production guard);
  added an explicit test overriding `petResolution: { kind:
  "needs_clarification" }` and asserting `{ kind: "none" }` on exact
  `"evet"`, proving decision 4 directly.
- `test/intakeConsumer.test.ts` — audited every `pet_name:`/`pets:`
  occurrence in the file against the new resolution/conflict logic.
  Renamed and re-asserted the two tests described in Observed context
  above (now expect `complaint_collection`, not `human_handoff`/stall).
  Added a new `describe("processIntakeQueueMessage: selected-pet conflict
  handoff (Task 037)")` block with three end-to-end tests: a conflict
  reaches `human_handoff` through the real pipeline with the selected pet's
  identity/clinical facts unchanged, no relink, and no `p_create_pet_name`;
  a true safety signal reported on a conflict turn still merges into
  `p_intake_data.reported_safety_signals`; and a turn after the conflict
  has already forced `human_handoff` makes no OpenAI call. Every other
  occurrence (Task 029 no-progress-fallback tests, the Task 036
  `intake_confirmation` block, the recording-notice tests) uses `pet_id:
  null` with either no name or an exact match and is unaffected by this
  task's changes.
- `docs/ai-behavior-and-safety.md` — corrected the "What the pet resolver
  guarantees" section, which stated zero *or* multiple matches both fell
  back to `needs_clarification`; now describes the `new_candidate` case and
  cross-references the conflict behavior in `docs/inbound-queue.md`.
- `docs/kvkk-inceleme-paketi.md` — added a dated note correcting the Task
  035 pet-creation description, which stated pet creation only occurs when
  "the owner has no registered pet at all"; that condition is no longer
  accurate; what actually gates creation is whether the conversation has a
  selected pet (`context.pet_id is null`), independent of how many pets the
  owner already has. The final Codex/Opus correction also records the exact
  conflict-turn fields that are and are not persisted, including the accepted
  attribution ceiling for another animal's `false | null` safety values.
- `test/localDemo.test.ts` — reviewed, no scenario exercises the new
  `PET_RESOLUTION_LABELS` entry; **not changed**.
- `docs/database-schema.md`, `docs/inbound-queue.md` — the implementer left
  these unchanged at delivery. Codex review then documented the current
  finalizer signature and pre-mutation atomicity boundary, plus the selected-
  pet conflict/no-relink behavior and its one-model-call detection boundary.
- `CURRENT_TASK.md` — this Observed context and Delivery record only.

No production migration was applied, no SQL fixture was run against any
database, and no commit, push, deploy, or real API/model call was made.

### Acceptance criteria satisfied

- An owner with a registered pet and no selected `pet_id` can register a
  distinctly named second pet (Goal item 1) — proved by the two corrected
  `test/intakeConsumer.test.ts` cases and the `037_...sql` fixture's first
  block, which Codex later ran successfully on disposable `vetai-test`.
- A stale optimistic version can never commit a newly inserted pet while
  the conversation advance fails (Goal item 2) — proved by the migration's
  pre-insert lock-and-version-check and the fixture's stale-version block,
  later run successfully by Codex; pet insert, conversation advance, outbox insert, and lease
  completion remain inside one `finalize_intake_queue_job` transaction,
  unchanged from `20260826000100`.
- All 10 binding decisions are implemented as described in Changed files
  above; each has at least one direct unit or end-to-end test.
- The app-level duplicate-name guard is unchanged (decision 9); no unique
  index was added to the migration.
- No production migration, deploy, real API call, commit, or push occurred
  (decision 10).

### Exact checks and results

```text
pnpm install --frozen-lockfile   → "Already up to date", exit 0
pnpm typecheck                   → tsc --noEmit, no output, exit 0
pnpm test                        → 33 test files passed, 1433 passed / 2 skipped (1435 total), exit 0
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  → Worker "vetai", vetai-intake Queue binding, exit 0
git diff --check                 → only LF/CRLF line-ending notices, no whitespace errors, exit 0
```

### Checks not run by the implementing agent

- The new migration and `supabase/tests/037_second_pet_registration_atomicity.sql`
  fixture were not applied/run against `vetai-test`, staging, or production
  — explicitly out of scope for this task; both are marked NOT APPLIED /
  NOT RUN in their delivery-time headers. Codex subsequently ran both on
  disposable `vetai-test`; see the review record below.
- No real OpenAI call, WhatsApp send, or paid eval was made; all tests run
  against `vi.stubGlobal("fetch", ...)` mocks.

### Known limitations / risks for Codex/Opus to inspect

- At implementer delivery time the migration and fixture were unvalidated
  against real Postgres. Codex subsequently closed this item on disposable
  `vetai-test`; see the review record below.
- The implementer's initial `docs/database-schema.md` gap was closed during
  Codex review: the current finalizer signature and unconditional pre-mutation
  conversation lock/version check are now documented.
- `detectSelectedPetConflict` compares only the current turn's extracted
  name against the currently selected pet; it does not re-run duplicate-
  name detection against the owner's other pets, since decision 5 forbids
  persisting anything from the conflicting turn in the first place — Codex
  should confirm this is the intended boundary and not a gap.

### Codex review record — 2026-08-27

Verdict: **PASS for engineering and disposable-database validation; awaiting
the mandatory Claude Opus read-only gate.**

Codex reviewed the complete diff and call path and made four minimum
corrections:

1. Selected-pet conflict safety merging now keeps sticky prior `true` values
   but otherwise uses the conflicting turn's current `true | false | null`.
   An old pet's `false` can no longer turn the other animal's unknown signal
   into a false assurance. A focused regression test was added.
2. The SQL fixture now proves `stale_state` preserves stage, link, version,
   claim token, lease timestamp, processing status, pet count and outbox count,
   then retries the **same provider event and same claim token** with the real
   version. The earlier substitute-new-message retry was not sufficient proof.
3. A Worker integration test now directly covers exact `EVET` creation of a
   distinct second pet for an unbound owner who already has another pet.
4. The feasible model-call boundary and the database/inbound documentation
   were corrected. Detecting the first selected-pet conflict requires the one
   normal extraction call; later `human_handoff` turns make no model call.

Local verification after these corrections:

```text
pnpm install --frozen-lockfile   → already up to date, PASS
pnpm typecheck                   → PASS, 0 errors
pnpm test                        → 33 files, 1435 passed / 2 opt-in paid evals skipped, PASS
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  → PASS, no deploy
git diff --check                 → PASS; line-ending notices only
```

Disposable database evidence:

- Target was visibly verified as `vetai-test`
  (`cyjpiapxvalqltcsywam`), not the CLI-linked `vetai-staging` project.
- `20260827000100_second_pet_registration_atomicity.sql` was applied through
  the SQL Editor: `Success. No rows returned`.
- The updated rollback-only
  `supabase/tests/037_second_pet_registration_atomicity.sql` ran completely:
  `Success. No rows returned`.
- A separate post-rollback query returned `fixture_clinics = 0`.
- Because the migration was applied through the SQL Editor, this disposable
  validation did not add a `supabase_migrations.schema_migrations` row.
- Staging and production were not migrated or deployed. No real WhatsApp,
  OpenAI, or outbound-send call was made. The pre-existing `.gitignore` user
  change remained untouched.

### Claude Opus read-only review and closure — 2026-08-28

Verdict: **PASS.** Opus independently reviewed the resolution contract,
selected-pet conflict path, safety merge, finalizer lock/transaction order,
rollback fixture, RLS/grants and KVKK erasure boundary. All eight requested
technical checks passed; no code or database correction was required.

Codex closed the three non-blocking documentation findings before commit:

1. The KVKK package now states the exact conflict-turn data retained in
   `intake_data`, instead of implying that only positive safety signals remain.
2. It records the accepted attribution ceiling: another animal's explicit
   `false | null` safety values can appear in the selected conversation's
   snapshot, but old `true` values remain sticky and the same turn terminates
   in human handoff, so normal automation cannot reuse them as a downgrade.
3. The database document now says the conversation lock/version check runs on
   every AI finalization, before any optional pet insert or other mutation.

Task 037 is complete at the repository and disposable-database gates. The
next gate is deliberately separate: only Maya's new approval may apply the
migration and deploy the Worker to `vetai-staging`, followed by one live
second-pet WhatsApp smoke. Production and the external veterinarian/KVKK
approvals remain out of scope.

---

# Current task — 035 Pet onboarding (first-time owner pet registration)

Status: `COMPLETE` (closed 2026-08-26 — see "Task 035 closure record" below,
directly above the Task 034 record). **This stamp covers engineering only.** Criterion 5's KVKK
questions were moved out of this task unanswered, to the human gate in
`docs/production-readiness.md` §1; nothing here is a legal sign-off, and the
production release gate is unchanged by this closure.

Contract opened by: Claude Opus, standing in for Codex under Maya's explicit
delegation of 2026-08-25. Reverts to Codex ownership when Codex returns.

Depends on: Task 034 `COMPLETE` and committed (`0bcdd86`, 2026-08-25). Met.

## Problem

`resolvePet` (`src/intakeExtraction.ts:236`) only matches pets that already
exist for the owner, and no runtime path ever creates one. An owner with zero
registered pets therefore loops in `pet_identification` forever. Task 034
reproduced this on real staging and recorded it as
`PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED` (defect 6). This task adds the
one missing path: creating a pet, gated on the owner's explicit confirmation.

## Product decision — already taken, do not reopen without Maya

1. **Only an explicit owner confirmation turn may create a pet.** The bot reads
   the extracted name (and species, if extracted) back verbatim and creates the
   row only if the owner replies exactly `EVET`, using the same grammar the
   appointment confirmation already uses. An LLM extraction alone never writes
   a row.
2. **Duplicate names are refused on the AI write path only** (Maya, 2026-08-25,
   option (b)). See "Decision 2, as amended" below — this replaced an earlier
   table-wide unique index.
3. **Species is stored at creation** when the same confirmed turn supplied it,
   and left null otherwise.
4. **Bounded attempts.** A repeated or unparseable answer re-asks at most
   `MAX_PET_IDENTIFICATION_ATTEMPTS` (3) times, derived at read time from the
   already-loaded recent messages — no new column, no `schema_version` bump —
   and then hands off to a human. This is stricter and earlier than the
   existing 12-turn `NO_MODEL_STATE_VERSION_CEILING`.

### Decision 2, as amended (Maya, 2026-08-25 — option (b))

The duplicate-name rule is **not** a table-wide constraint. The first draft of
the migration created

```sql
create unique index pets_owner_normalized_name_key
  on public.pets (owner_id, (lower(btrim(name))));
```

which would also have bound clinic staff inserting directly through the
existing `pets_all` RLS policy, turning a legitimate registration — one owner
really does have two pets whose names collide under this normalization — into
a bare `23505` in a code path that never asked for the rule. The rule exists to
stop the AI from silently creating a second row for a pet the owner already
registered, so it now lives inside `finalize_intake_queue_job` as a conditional
`insert ... select ... where not exists (...)`, and staff writes are untouched.

Recorded ceiling, deliberately accepted for the pilot: `where not exists` is a
read-then-write check, not a constraint. Two finalize calls for the same owner
running concurrently in two different conversations can both pass it. The
per-conversation intake lease serializes the ordinary case. If duplicates are
ever observed, the upgrade path is a **partial** unique index covering only
AI-created rows — which first needs a provenance column on `public.pets` — and
never a table-wide one.

## What is already in the repository

The implementation landed on 2026-08-25 in the same session that opened this
contract, reviewed against the real migration history (the code was originally
drafted in a sandboxed working copy that could see only 3 migrations; every
inference it carried has now been checked against the real files):

- `supabase/migrations/20260825000100_pet_registration.sql` — forward-only
  replacement of `finalize_intake_queue_job` adding `p_create_pet_name` /
  `p_create_pet_species` (both `default null`, so an older Worker still calls
  it unchanged) and the new `duplicate_pet_name` result. Verified: the body is
  `20260814000300_selective_automation.sql`'s body plus the pet additions and
  nothing else, and nothing after that migration — including
  `20260822000100_strict_ai_allowlist.sql` — redefines the function.
- `src/petRegistration.ts` — the confirmation-turn planner.
- `src/intakeConsumer.ts`, `src/intakeJobLease.ts`, `src/intakeReply.ts` —
  additive wiring only.
- `test/petRegistration.test.ts` plus new blocks in
  `test/intakeConsumer.test.ts` and `test/intakeJobLease.test.ts`.
- `supabase/tests/035_pet_registration.sql` — rollback-only fixture in
  `033_selective_automation.sql`'s real shape. It replaces the draft
  `20260825000100_pet_registration_test.sql` that shipped in the handoff
  package; that draft was never installed, and must not be — it tested the
  unique index that decision (b) removed.
- `docs/kvkk-inceleme-paketi.md` — §3, §4, §5 and §8 updated in place. The
  separate `EK` annex from the handoff package was merged and not kept; a
  second KVKK source of truth must not exist.
- `docs/staging-runbook.md` §12.1 — migration-then-Worker deploy order.

## Acceptance criteria — what still has to happen

1. **Run `supabase/tests/035_pet_registration.sql` against the disposable
   `vetai-test` project and see it green.** `PASSED` — 2026-08-25, executed by
   Maya together with Claude Sonnet through the Supabase **dashboard SQL
   Editor** on `vetai-test` (ref `cyjpiapxvalqltcsywam`). Not run by Codex and
   not by Opus: the repository session still has no database access at all (no
   DB password, no `psql`, no Docker daemon for a local stack), so the
   dashboard was the only available route and remains so.
   A pre-check first showed
   `supabase/migrations/20260825000100_pet_registration.sql` was already
   applied on that project — `finalize_intake_queue_job` was already live in
   its 11-parameter form. The fixture then ran end to end with no error and
   reached its `rollback`: the last visible result row was fixture 3's
   `set_config`, everything after it being silent `do` blocks and the
   rollback itself. All six fixtures passed: the AI path creating the pet
   atomically; the case- and whitespace-insensitive duplicate refusal writing
   nothing and advancing no state; **a staff insert of the same name through
   `pets_all` succeeding** (decision (b)); the AI path still refusing
   afterwards; a distinct name created with a trimmed name and a null species;
   and `create_pet_species` without `create_pet_name` raising.
2. **Run the duplicate-name pre-check on staging and record the result.**
   `RUN` — 2026-08-25, same route (Maya + Claude Sonnet, dashboard SQL Editor)
   against `vetai-staging`. Result: **0 rows** —
   no existing owner has same-normalized-name pets, so nothing already in
   staging falls in the population that the AI path would answer
   `duplicate_pet_name` for. Under decision (b) this was already **not a
   blocker** — nothing in this migration constrains existing rows, so no
   pre-existing duplicate could make it fail to apply; it is informational
   only. The query that was run:

   ```sql
   select p.clinic_id, p.owner_id, lower(btrim(p.name)) as normalized_name,
          count(*) as n, array_agg(p.id order by p.created_at) as pet_ids
   from public.pets p
   group by p.clinic_id, p.owner_id, lower(btrim(p.name))
   having count(*) > 1
   order by n desc;
   ```

   If it returns rows, do **not** treat merging them as part of this task:
   `conversations.pet_id` is `on delete no action` and
   `advance_conversation_intake` can never set it back to null
   (`coalesce(p_pet_id, c.pet_id)`), so consolidation needs manual `update`s
   and belongs in its own data-reconciliation task.
3. **Apply the migration to staging, then deploy the Worker — in that order.**
   `DONE` — 2026-08-25, in the runbook order, each step on Maya's separate
   explicit approval. `docs/staging-runbook.md` §12.1 is binding: migration
   first (the new parameters default to null, so the old Worker keeps
   working), Worker second. On rollback, the reverse.
   - **Migration.** Pushed through the managed CLI flow, not the SQL Editor,
     so it lands in migration history. Maya ran `supabase link` herself so the
     database password never entered the session. `supabase migration list`
     beforehand showed every earlier file matched local/remote through
     `20260822000100_strict_ai_allowlist` and `20260825000100` remote-empty;
     `supabase db push --dry-run` offered exactly one file. The real
     `supabase db push` applied `20260825000100_pet_registration.sql` with no
     error, and `supabase migration list` afterwards shows
     `20260825000100 | 20260825000100`. Staging's last migration is now
     `pet_registration`.
   - **Worker.** `pnpm exec wrangler deploy --config wrangler.staging.toml`
     (wrangler 4.118.0): 150.16 KiB upload / 31.51 KiB gzip, uploaded in
     11.00 s, triggers deployed in 15.23 s, version id
     `2ea1d3b7-5e5c-4cd6-9dcd-4dfc008d11ad`. Bindings as expected — the
     `INTAKE_QUEUE` producer, consumers on the intake queue and its DLQ, the
     `* * * * *` cron, `APP_TIMEZONE=Europe/Istanbul`,
     `WHATSAPP_GRAPH_API_VERSION=v25.0`.
   - **Post-deploy health.** `GET /health` → `200`
     `{"status":"ok","version":"0.1.0",...}`; `GET /ready` → `200`
     `{"status":"ready"}`.
   - Between the two steps staging ran the new schema against the old Worker,
     which is the safe direction of the §12.1 asymmetry; the window was a few
     minutes and no inbound traffic was driven through it deliberately.
4. **Prove the loop is closed on staging**: a first-time owner sends a message,
   confirms with `EVET`, the pet row appears, and the conversation advances to
   `complaint_collection` instead of looping.
   `DONE` — 2026-08-26, on `vetai-staging`, driven from Maya's whitelisted
   number. Closed **by derivation from the run's own recorded state**, not by a
   literal `complaint_collection` snapshot; Maya reviewed the derivation,
   accepted it, and declined a second run.
   - **The run.** Four inbound turns in one new conversation
     (`1aa4d07a-012b-45b0-b663-c7213ba9fd45`, `state_version` 5): the pet name,
     an answer to the safety questionnaire, `evet`, and one follow-up question.
     It deviated from the written plan — the first message was conversational
     ("merhaba köpeğimin adı karamel") and the safety answer carried a symptom
     with it ("bunlardan birisi yok sarhoş gibi yürüyor 15 dakikadır") — which
     is exactly what carried the conversation one stage past the point this
     criterion's wording anticipated observing.
   - **The pet row.** One row, `c0e06f64-3239-4289-85fd-c889ce7b4296`,
     `karamel`/`köpek`, correct `clinic_id`, and `conversations.pet_id` points
     at it. Both writes happen inside the same `finalize_intake_queue_job`
     call, so the row and the stage advance are atomic by construction — the
     property this criterion exists to prove.
   - **Why `complaint_collection` is proven even though the snapshot reads
     `safety_check`.** `advance_conversation_intake`
     (`20260806000200_conversation_intake_state.sql`) accepts exactly one
     forward step and raises on anything else. `pet_identification →
     safety_check` is two steps and therefore cannot have happened. The
     conversation being in `safety_check` today *requires* that it passed
     through `complaint_collection`. This is a database guarantee, not an
     inference.
   - **Corroboration.** `state_version` 5 is the default 1 plus exactly four
     advances, one per inbound turn — no room for a failed, repeated, or extra
     turn. And the reply sent on the `EVET` turn was the `intake_received`
     copy, which on a zero-pet `pet_identification` turn can only come from the
     creation branch: the ordinary path would have resolved
     `needs_clarification` and sent `PET_IDENTITY_TEXT`. That branch passes the
     literal `nextStage: "complaint_collection"` (`src/intakeConsumer.ts`).
   - **The safety detour was not a deviation from the design.** No "clean"
     re-run could have avoided it: on a first turn all eight safety signals are
     `null`, so `evaluateSafetyDecision` returns `needs_safety_check` and
     `planPetRegistrationAction` returns `none` on safety precedence
     (`src/petRegistration.ts:138`). The questionnaire always precedes the pet
     confirmation, and the shortest possible path to a created pet is three
     inbound turns.
5. **KVKK.** `MOVED OUT` — 2026-08-26, on Maya's decision. The engineering half
   was done: `docs/kvkk-inceleme-paketi.md` §3/§4/§5/§8 carry the verified
   technical facts of pet onboarding. The legal half was never this task's to
   answer, and closing this task does **not** answer it. Both open questions —
   whether the confirmation prompt is itself an adequate disclosure moment, and
   whether pet records need provenance for export — now live as named,
   individually visible bullets under the KVKK human gate in
   `docs/production-readiness.md` §1, alongside the third question Maya raised
   the same day about an opening recording notice. They block production
   release exactly as they did before; only their home changed. Do not treat
   this task's `COMPLETE` as covering them.

## Out of scope

- Any provenance column on `public.pets`.
- Merging or deleting existing duplicate pets.
- The staff Cloud API composer (Task 034's Coexistence `UNAVAILABLE`
  consequence) — still a separate controlled-pilot blocker.
- Retention periods and the lawyer review of `/privacy` — human gates, tracked
  in `docs/pilot-oncesi-plan.md` and `docs/production-readiness.md`.

## Checks at contract time — 2026-08-25

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean |
| Full suite | `npx vitest run` | 1,411 passed, 2 skipped, 33 files |
| Worker build | `npx wrangler deploy --dry-run` | built, 150.16 KiB |
| SQL fixture | `supabase/tests/035_pet_registration.sql` | **PASSED** on `vetai-test` — 2026-08-25, Maya + Claude Sonnet via dashboard SQL Editor; all 6 fixtures, rolled back (criterion 1) |
| Staging pre-check | duplicate-name query | **RUN** on `vetai-staging` — 2026-08-25, same route; **0 rows** (criterion 2) |

No staging or production migration was applied, no Worker was deployed, no
secret was created or rotated, and no Meta configuration was changed while
opening this contract. The 2026-08-25 dashboard runs above touched only
`vetai-test` (inside a transaction that was rolled back) and a read-only
`select` on `vetai-staging`.

That held only until criterion 3 was approved. **Later the same day**, on
Maya's separate explicit approvals, `20260825000100_pet_registration.sql` was
pushed to staging and the staging Worker was redeployed — see criterion 3 for
the outputs. Staging's last migration is no longer `strict_ai_allowlist`. No
production change and no secret rotation at any point.

---

## Task 035 closure record — 2026-08-26

Closed by Claude Opus in Codex's role under Maya's standing delegation of
2026-08-25, on Maya's explicit instruction of 2026-08-26.

### What `COMPLETE` means here, and what it does not

Criteria 1-4 are met and recorded above with their evidence. Criterion 5 was
**moved out unanswered**, not met: its two KVKK questions are now named bullets
under the human gate in `docs/production-readiness.md` §1, together with the
third question Maya raised the same day. They block production release exactly
as before.

The move was Maya's call and it had a concrete reason: `AGENTS.md:23` forbids
starting a second task while the current one is `READY` or `IN_REVIEW`. Holding
035 open for a legal sign-off that no engineer can produce would have blocked
all further work indefinitely. `COMPLETE` here therefore means *the engineering
is done and proven on staging*, and nothing more. It is not a compliance
statement, it does not shorten the production gate, and it must not be cited as
evidence that any KVKK question was resolved.

### State at closure

- Pet onboarding for first-time owners is live on `vetai-staging` and on no
  production surface. `20260825000100_pet_registration.sql` is in staging's
  migration history; the staging Worker carrying `src/petRegistration.ts` is
  deployed.
- The duplicate-name rule binds the AI write path only; staff writes through
  the `pets_all` RLS policy are deliberately unconstrained (Maya, 2026-08-25).
- One defect found during closure is recorded but not fixed: on `stale_state`,
  `finalize_intake_queue_job` returns without rolling back an already-committed
  pet insert, leaving an orphan row and a lease stuck in `processing`. Full
  description in `PROJECT_CONTEXT.md` under "Not implemented". The Worker's
  retry self-heals it, so it is not a release blocker; it is a candidate task.

---

# Current task — 036 Conversation flow, latency, and recording notice

Status: `COMPLETE` (closed 2026-08-27; implementation, database proof,
staging migration/deploy, bounded second-pet handoff, and the fresh zero-pet
live WhatsApp smoke all passed. Production remains unchanged.)

**Approved by Maya on 2026-08-26**, with two decisions recorded at approval
time:

1. **The stage model is to be redesigned properly, not patched.** The complaint
   must not be collected inside `pet_identification` to avoid a migration. A
   new stage, a changed rank map, and a new migration are explicitly in scope,
   and stage names must describe what the stage actually does. The full design
   had to be written into this contract before implementation started; it is
   the "Stage model redesign" section below.
2. Everything else in the drafted scope is approved as written: the correction
   action, the "şimdi ne yapacağım" mechanism (mechanism only — copy choice
   stays a veterinary-approval item), the recording-notice mechanism (text
   excluded, it belongs to the KVKK gate), inline outbound send, and lowering
   `max_batch_timeout`.

Drafted 2026-08-26 from Maya's four requests after that day's live staging
test, plus a source audit.

## Where this came from

Maya's words after the live run: conversations should move **"daha hızlı, daha
insancıl ve daha net."** Her concrete complaint from that run: she asked
*"şimdi ne yapacam peki"* and the bot replied with a byte-identical repeat of
its previous "Bilgileri aldım..." message — it answered nothing and read like a
machine.

That specific symptom is now explained from source, and it is not a bug in the
repeat detector. `intakeConsumer.ts`'s `hasRepeatedNoProgressQuestion` only
counts an outbound as repeatable if `isEligibleClinicQuestion` is true, which
requires the text to contain `?`. `INTAKE_RECEIVED_TEXT` has no question mark,
so the no-progress handoff can never fire on it, and an owner can be shown that
same closing line indefinitely. Whether the fix is to widen the eligibility
rule, to answer "what happens now" with real copy, or both, is part of this
task's scope.

## Current behavior, established from source

### 1. Confirmation timing

`planPetRegistrationAction` (`src/petRegistration.ts:129`) asks for confirmation
the moment it has a name: zero registered pets, safety clear, and a non-null
`plan.intakeData.pet_name` is enough. It does not wait for species and does not
wait for a complaint. The ask pins the conversation to `pet_identification`
(`src/intakeConsumer.ts`, ask branch) so the stage cannot advance while a
confirmation is outstanding.

### 2. What `HAYIR` does today

Maya's guess was right, and it is worse than she described:

- `parseYesNoReply` (`src/petRegistration.ts`) accepts **only** the exact
  strings `evet`, `hayır`, `hayir` after NFKC normalization, Turkish-locale
  lowercasing, and whitespace collapse. Everything else returns `"repeat"`.
- A `decline` produces `{ kind: "declined" }`, and `src/intakeConsumer.ts` then
  writes `{ ...intakeData, pet_name: null, species: null }` — both fields
  erased — and replies with the generic `PET_IDENTITY_TEXT`, *"Hangi evcil
  hayvanınız için yazıyorsunuz? Lütfen adını belirtin."* The owner starts over.
- A natural correction such as *"hayır, adı Karabaş"* is **not** a decline and
  **not** a correction: it is `"repeat"`, so the same confirmation is re-asked
  verbatim and the attempt counter advances toward `bounded_handoff`. The
  owner's actual correction is discarded even though the extractor already
  parsed the new name out of that same message.

### 3. Recording notice

There is none. No reply category, no prefix, nothing at conversation start. The
only privacy surface is the static `/privacy` page (`src/privacyPage.ts`).

### 4. The ~1 minute delay — found, and it is not a retry

The path, end to end:

| Step | Cost |
|---|---|
| Meta webhook → `enqueueIntakeJob` (`src/index.ts:130`) | immediate, in-request |
| Queue batching (`max_batch_timeout = 5`, `wrangler.staging.toml`) | 0-5 s |
| `extractIntakeViaOpenAi` — `gpt-5.6-luna`, `reasoning: { effort: "none" }`, `max_output_tokens: 1200`, 30 s ceiling | typically low single-digit seconds |
| `finalize_intake_queue_job` writes the reply into `outbound_message_outbox` — **it does not send it** | immediate |
| `drainOutboundMessages`, reachable **only** from the `scheduled` handler (`src/index.ts:239`) on cron `* * * * *` | **0-60 s** |

The delay is the last row. The reply is composed within seconds and then sits in
the outbox waiting for the next cron tick — ~30 s on average, ~60 s worst case,
every turn. It is structural, not a retry and not the model.

`retry_delay = 120` is a real setting but a different signature: it applies only
to genuine retries (`stale_state`, `duplicate_pet_name`, transient failures) and
would present as ~2 minutes on *some* turns, not ~1 minute on nearly all of
them. `wrangler tail` distinguishes the two cleanly — a retry logs a second
consumer invocation for the same message; the cron case logs exactly one.

**The cron cannot be made faster.** `* * * * *` is already Cloudflare's finest
cron granularity. Any real improvement has to stop waiting for cron at all.

Options, in the order I would put them to Maya:

1. **Send inline after finalize, keep cron as the safety net.** Call the
   existing claim/send/accept path from the queue consumer once the outbox row
   is written, and leave the cron drain untouched for anything the inline send
   misses. `drainOutboundMessages` already claims with a token before sending
   and accepts or releases afterwards, so reusing that path — never bypassing
   it — is what keeps double-send impossible. Removes essentially the whole
   delay. No new infrastructure, no new schedule, no extra Worker invocation
   beyond the one already running.
2. **Drop `max_batch_timeout` to 0-1 s.** Saves up to 5 s. One line, safe,
   trivially reversible, and worth doing regardless of option 1.
3. **Leave it.** Legitimate only if a delay is wanted; nothing in the record
   suggests it is.

**Plan verified 2026-08-26, before approval.** `wrangler whoami` reports the
account `Mehmetsait7072@gmail.com's Account`
(`1ac987ec7ff5add2ab333de15e8cff9f`), OAuth token, `queues (write)` in scope.
`wrangler queues list` returns the provisioned intake queues and their DLQs.
Cloudflare Queues cannot be provisioned on the Free plan at all, so this
account is on **Workers Paid**. The "Free tier limits" framing in the draft was
wrong and is withdrawn: neither option below is constrained by Free-plan
limits, and the inline send adds no billable invocation, because it runs inside
the queue-consumer invocation that already exists.

Two related facts found the same way, worth having on record:

- The stored OAuth token is **missing the `workers_tail:read` scope**, so
  `wrangler tail` will fail until someone runs `wrangler login` again. The
  draft above proposes `wrangler tail` for telling a cron wait apart from a
  retry; that will need the re-login first.
- The local wrangler is 4.118.0 while 4.126.0 is available. Not upgraded as
  part of this task — the deployed staging Worker was built with 4.118.0 and
  changing the toolchain mid-task would muddy any comparison.

## Hard constraints any design here must respect

These came out of the audit and each one rules out an otherwise obvious
approach:

- **One outbound reply per inbound message.** `outbound_message_outbox` carries
  `unique (clinic_id, source_provider_message_id)`
  (`20260809000100_intake_reply_outbox.sql:200`). A standalone recording notice
  as its *own* message on turn 1 is impossible without a schema change; a
  prefix on the existing first reply is not.
- **The reply-category set is closed in SQL.** `finalize_intake_queue_job`
  accepts exactly `emergency_handoff`, `human_handoff`, `safety_questions`,
  `pet_identity`, `complaint`, `intake_received`. A new category means a new
  migration.
- **Stages advance exactly one step.** `advance_conversation_intake` raises on
  anything else. Any reordering of the flow has to be expressible as
  single-step transitions.
- **Safety precedence is not negotiable.** On the first turn all eight safety
  signals are `null`, so `evaluateSafetyDecision` returns `needs_safety_check`
  and `planPetRegistrationAction` returns `none`
  (`src/petRegistration.ts:138`). The questionnaire always precedes the pet
  confirmation. "Fewer turns" cannot be bought here.

## Stage model redesign

Maya's decision 1. The problem being fixed: since Task 035,
`pet_identification` does two different jobs — work out *which* pet, and
confirm-and-create it. Deferring the confirmation until the complaint is known
would, under the old model, mean collecting complaints inside a stage called
`pet_identification`. Maya rejected that. So the second job gets its own stage
and its own name.

### The new stage

`intake_confirmation`, inserted between `complaint_collection` and
`safety_check`. It is the stage in which everything collected so far is put to
the owner in one message, and in which an `EVET` writes the `public.pets` row.
The name matches the existing `appointment_confirmation`, which already names a
stage the same way.

### Rank map, before and after

| Stage | Old rank | New rank |
|---|---|---|
| `pet_identification` | 0 | 0 |
| `complaint_collection` | 1 | 1 |
| **`intake_confirmation`** | — | **2** |
| `safety_check` | 2 | 3 |
| `ready_for_triage` | 3 | 4 |
| `appointment_offer` | 4 | 5 |
| `appointment_selection` | 5 | 6 |
| `appointment_confirmation` | 6 | 7 |
| `completed` | 7 | 8 |

`human_handoff` stays outside the rank map, reachable from any non-terminal
stage, exactly as today.

### How this satisfies the single-step rule

`advance_conversation_intake` allows a transition only when
`rank(next) = rank(current) + 1` (`20260806000200_conversation_intake_state.sql:172`).
The insertion keeps every rank consecutive, so every transition in the new
graph is still exactly one step:

```
pet_identification → complaint_collection → intake_confirmation → safety_check
  → ready_for_triage → appointment_offer → appointment_selection
  → appointment_confirmation → completed
```

Ranks are computed inside the function from a `constant jsonb` local, never
stored on the row, so renumbering costs nothing for conversations already in
flight: a conversation sitting in `safety_check` simply reads as rank 3 after
the migration instead of rank 2, and its remaining path is unchanged. **No
backfill, no data migration.** The one behavioral consequence is intended: a
conversation parked in `complaint_collection` when the migration lands will go
to `intake_confirmation` next, not to `safety_check`.

### Transition rules that change

`decideNextStage` (`src/intakeTurn.ts:188`) gets two edits:

- **Leaving `pet_identification` no longer requires a persisted pet.** Today it
  advances only on `petResolution.kind === "matched"`, which a first-time owner
  cannot satisfy before the row exists. It will advance when the pet identity
  is *known*: a matched existing pet, **or** a captured candidate name for an
  owner with no pets. The stage name stays honest — identification means we
  know which animal, not that we have written it down.
- **`complaint_collection` → `intake_confirmation`** on the same condition that
  today sends it to `safety_check` (`complaint !== null || symptoms.length >
  0`), and **`intake_confirmation` → `safety_check`** once the confirmation is
  settled.

### Where the pet row is written

Unchanged mechanically, moved in time: still the `p_create_pet_name` path of
`finalize_intake_queue_job`, still atomic with the stage advance and the outbox
insert, still guarded by the AI-path-only duplicate rule. It now fires from
`intake_confirmation` instead of `pet_identification`, and
`planPetRegistrationAction`'s stage gate moves with it.

### Everyone goes through `intake_confirmation`

A returning owner whose pet already matches has nothing to create, but still
gets the combined confirmation. This costs that owner one extra round trip, and
that is deliberate: the turn it replaces is the one that produced Maya's
complaint, where the bot had nothing left to ask and repeated *"Bilgileri
aldım..."* at her. Replacing a dead-end filler turn with a real question is the
"daha net" half of the request. One stage, one code path, one honest name — no
conditional skip, which the single-step rule would reject anyway.

### Migration surface

One new forward-only migration, following the technique already used twice in
this repository (`20260814000300`, `20260825000100`):

1. `conversations.intake_stage` CHECK constraint — drop and re-add with
   `intake_confirmation`.
2. `advance_conversation_intake` — redefine with the new rank map.
3. `finalize_intake_queue_job` — redefine (from its current 11-argument Task
   035 body) with `intake_confirmation` in the `p_next_stage` allowlist and a
   new `intake_confirmation` value in the `p_reply_category` allowlist.
4. `outbound_message_outbox.reply_category` CHECK — drop and re-add with
   `intake_confirmation`, following the precedent at
   `20260810000200_whatsapp_appointment_flow.sql:20`.

The appointment RPCs need no change: they accept only `ready_for_triage` and
`appointment_offer` as planned stages (`20260814000300:810`), and both keep
their meaning and their consecutive ranks.

TypeScript surface: the `IntakeStage` union and its runtime array
(`src/conversationState.ts`), the parallel arrays in `src/intakeJobLease.ts` and
`src/liveAiDemo.ts`, `decideNextStage`, `planPetRegistrationAction`'s stage
gate, the consumer branches, and the reply-category union.

## Proposed scope

1. **Defer the confirmation and combine it.** Hold the ask until name, species,
   and complaint (when the owner offers one) are collected, then confirm once,
   in the new `intake_confirmation` stage designed above.
2. **Make correction a first-class outcome.** Add a `correction` action beside
   `confirm`/`decline`/`repeat`: when the owner's reply carries a new name or
   species, keep the fields they did not contradict, apply the ones they did,
   and re-confirm with the updated values. Stop erasing both fields on decline.
   A correction is progress and must not count against
   `MAX_PET_IDENTIFICATION_ATTEMPTS`; only genuinely unparseable repeats should.
3. **Answer "şimdi ne yapacam peki" instead of repeating.** Either widen
   `isEligibleClinicQuestion` so a repeated non-question closing line can still
   trigger the no-progress path, or give that state real copy. Copy choice is a
   veterinary-review item (below), not an engineering one.
4. **Recording notice — draft only, do not finalize.** Given the one-reply-per-
   inbound constraint, the cheapest shape is a one-line prefix on the
   conversation's first outbound reply rather than a new message or new
   category. Candidate Turkish text, **explicitly a draft**:

   > *Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki
   > mesajlar kayıt altına alınmaktadır.*

   This wording must not ship on an engineer's or the AI's say-so. It is the
   same notice-timing question already open under the KVKK gate, and it is
   filed there (`docs/production-readiness.md` §1, third bullet). Implementing
   the *mechanism* can proceed on Maya's approval; the *text* ships only after
   KVKK sign-off.
5. **Latency.** Options 1 and 2 above, presented to Maya with the plan question
   answered first.

## Approvals this task will need, separately

| Item | Whose approval |
|---|---|
| Recording-notice wording | KVKK sign-off — already filed under the production-readiness gate |
| Any change to the confirmation, complaint, or closing copy | Reviewing veterinarian (`docs/veteriner-hekim-onay-paketi.md`) |
| Stage-model change implied by deferring confirmation | Maya, as a contract decision |
| Inline outbound send | Maya, plus a staging deploy under the `docs/staging-runbook.md` §12.1 order |

## Explicitly out of scope

- The `stale_state` orphan-pet defect recorded in `PROJECT_CONTEXT.md`. Related
  file, unrelated fix; it deserves its own task.
- Anything in production. This task, like 035, ends at staging.


## Implementation record — 2026-08-26

Every scope item above is implemented, verified locally, proven against a live
Postgres on vetai-test, and applied to vetai-staging with the Worker deployed
back to back on Maya's approval. Production stays out of scope. The one item
still open is the live smoke test, recorded at the end of this section.

### Changed files

| File | Change |
|---|---|
| `supabase/migrations/20260826000100_intake_confirmation_stage.sql` | New. The four-part migration surface designed above: the `conversations_intake_stage_check` list, the rank map inside `advance_conversation_intake`, the `outbound_message_outbox_reply_category_check` list, and the two allowlists inside `finalize_intake_queue_job`. Not applied anywhere yet. |
| `src/conversationState.ts`, `src/intakeJobLease.ts`, `src/liveAiDemo.ts` | `intake_confirmation` inserted after `complaint_collection` in the `IntakeStage` union and in all three `INTAKE_STAGES` sets. |
| `src/intakeTurn.ts` | `decideNextStage` rewritten around the new stage; new `isPetIdentityKnown` helper. |
| `src/intakeReply.ts` | New `intake_confirmation` reply category. The identity ask is now keyed on `nextStage === "pet_identification"` instead of on pet resolution — see the note below. |
| `src/petRegistration.ts` | `correction` and `confirmed` actions; `buildIntakeConfirmationText` replaces `buildPetConfirmationText`; `planPostCreationReply` renamed `planPostConfirmationReply`; decline no longer erases collected fields. |
| `src/intakeConsumer.ts` | `prepareOutboundReply` (the single outbound choke point) now also attaches the recording notice; `hasRepeatedNoProgressQuestion` widened; the confirmation branch finalizes into `intake_confirmation` and passes `intakeData` through unchanged. |
| `src/index.ts` | The queue handler drains the outbound outbox via `ctx.waitUntil` as soon as the turn is written; cron kept as the safety net. |
| `src/localDemo.ts` | Stage and reply-category labels for the new values. |
| `wrangler.toml`, `wrangler.staging.toml` | Both consumers' `max_batch_timeout` 5 → 1. |
| `docs/database-schema.md`, `docs/intake-turn-planning.md` | Stage chain and transition rules updated. |

### One design consequence found during implementation

Deferring pet creation means a first-time owner's pet resolution stays
`needs_clarification` for the whole conversation, because there is no `pets`
row to match against until they confirm. `planIntakeReply` used to key the
"hangi hayvanınız" question on exactly that, so it would have re-asked for the
pet on every turn after the deferral. The question is now keyed on the planned
stage instead, which is the fact it was really asking about. Two tests in
`test/intakeReply.test.ts` pin both halves of this.

### Verification actually run

| Check | Result |
|---|---|
| `npx vitest run` | 1421 passed, 2 skipped, 0 failed (33 files) |
| `npx tsc --noEmit` | clean |
| `npx wrangler deploy --dry-run` | ok, 152.54 KiB |
| `npx wrangler deploy --dry-run --config wrangler.staging.toml` | ok, 152.54 KiB |

### SQL fixtures — run on vetai-test (`cyjpiapxvalqltcsywam`) 2026-08-26

The SQL fixtures in `supabase/tests/` were updated for the new stage —
`006` (the stale-version case had to stay a legal one-step transition, and the
service-role block now walks `complaint_collection -> intake_confirmation ->
safety_check`), `024` (the full-chain walk array and the two state_version
assertions that follow from it), and `035` (a new Fixture 7 that creates the
pet on the real `intake_confirmation -> safety_check` edge and proves nothing
is written to `pets` before the owner confirms).

All three were run against vetai-test after this migration was applied there,
and all three passed: `006` and `024` returned their `PASS` row, `035`
returned no rows as designed. That run found one fixture bug, fixed here.
`006`'s last service-role block passed `p_intake_data => '{}'::jsonb` to a
call it expected to fail on `illegal transition`, but
`advance_conversation_intake` validates its arguments *before* the transition
check, so the call raised `invalid intake_data` and the block re-raised. The
payload is now `'{"test": true}'::jsonb`, matching the ten other
non-intake_data error tests in the same file. The two permission tests keep
`'{}'` deliberately: `EXECUTE` is checked before the body runs, so the payload
never reaches validation there.

Two earlier fixture failures were investigated and ruled out as unrelated to
this task. `013` and `017` have been broken since Task 033 (2026-08-22): they
call `ingest_whatsapp_text_message` without a `whatsapp_contact_routes` row,
which the strict AI allowlist now answers `'ignored'`. Both were withdrawn
from this task's runbook and left for a separate fix.

### Staging migration and deploy — 2026-08-26, on Maya's approval of the pair

Applied and deployed back to back in one session, deliberately, because the
new rank map inside `advance_conversation_intake` shifts
`complaint_collection -> safety_check` from +1 to +2. The Task 035 Worker and
the Task 036 schema are incompatible on exactly that one transition, and
`finalize_intake_queue_job` has no exception handler around that call, so a
turn on that edge inside the window would have surfaced as a queue retry.

| Step | Output |
|---|---|
| Exposure check, immediately before | one active conversation, at `safety_check`; zero at `complaint_collection`, so the only affected edge was empty |
| `supabase migration list` before | `20260826000100` local-only, Remote column empty |
| `supabase db push --linked` | `Applying migration 20260826000100_intake_confirmation_stage.sql` then `Finished`. 18:59:49Z to 18:59:52Z |
| `npx wrangler deploy --config wrangler.staging.toml` | `Uploaded vetai-staging`, version `12ae7efb-3f1e-4fe9-9df4-2c62f6cc9958`, producer and both consumers listed. Done 19:00:27Z |
| Window between the two | **38 seconds**, against a consumer `retry_delay` of 120s: anything caught in it would have retried after the new Worker was live |
| `supabase migration list` after | Local and Remote both `20260826000100`, applied `2026-08-26 00:01:00`. No history drift |
| Schema check on staging | all four objects carry `intake_confirmation`; `finalize_intake_queue_job` has exactly **1** overload, so the old 11-argument signature really was dropped |
| `GET /health` | `200` `{"status":"ok","version":"0.1.0"}` |
| `GET /ready` | `200` `{"status":"ready"}` |
| Failure check after the pair | no new failed outbox rows; the single `failed_at` row dates from 2026-08-23 and is unrelated. Zero handoffs |

The migration went through `supabase db push`, not the dashboard, so
`supabase_migrations.schema_migrations` recorded it. That distinction matters:
vetai-test received the same migration by dashboard paste, which applies the
DDL without writing the history row, so a later `db push` against that project
will try to apply it a second time and fail. Accepted on a disposable test
project, never acceptable here.

**There is no rollback out of this.** `wrangler rollback` would restore the
Task 035 code against the Task 036 schema, which is the broken combination the
back-to-back pair existed to avoid. Recovery is fix-forward only.

### Still open

The live smoke test from the allowlisted test number: one turn confirming the
conversation stops at `intake_confirmation` with nothing written to `pets`,
and that only `evet` creates the pet and moves it to `safety_check`. It needs
a real inbound WhatsApp message, so it is Maya's step, not a command this
session can run.

### Smoke test round 1 — 2026-08-27, and the loop it found

Round 1 first hit a stale conversation. Maya's message landed in
`1aa4d07a…`, created 2026-08-25, which already carried pet `karamel` and had
passed pet identity long before this task existed — so it answered
`intake_received` at `ready_for_triage` with no recording notice
(`withRecordingNotice` fires only at `state_version === 1`) and proved nothing
either way. It was the same single active conversation the pre-migration
exposure check had found at `safety_check`. Closed with `status='completed'`
on Maya's approval, which releases the
`(clinic_id, owner_id) where status in ('active','handoff')` partial unique
index so the next inbound opens a fresh conversation.

Round 1 proper then exposed a real defect, and it is a blocker for closing
this task. Conversation `7d006d0c…` opened clean, sent the recording notice on
turn 1 (so that half of Task 036 is proven), asked the safety questions, and
then locked at `pet_identification`, re-sending the identical
`PET_IDENTITY_TEXT` on every turn with no exit. Cause: `PetResolution` has no
"known owner, new animal" case and `isPetIdentityKnown` accepts a candidate
name only when the owner has no pets on file, so Maya's test account — which
still owns `karamel` from Task 035 — can never register a second pet. The
Task 029 net misses it because the owner re-sends the name each turn, keeping
`isNoActionableFact` false. Full analysis and the permanent-fix direction are
recorded in `PROJECT_CONTEXT.md`.

Mitigated here, not fixed: `stalledOnPetIdentity` in `src/intakeConsumer.ts`
adds `pet_identification` to the same bounded-handoff floor
`intake_confirmation` already had. Holding at `pet_identification` while the
identical question has already gone out twice now hands off to a human. Three
tests in `test/intakeConsumer.test.ts` pin it: the loop hands off, one prior
question does not, and a name that actually advances the stage is untouched.
The pre-existing fixture that asserted the opposite was rewritten — with
`pet_name: "Pamuk"` against an owner whose only pet is Fluffy it was pinning
this very loop as correct behaviour, and its `not.toBe` form would also have
passed on an undefined body.

`npx vitest run` 1423 passed, 2 skipped, 0 failed. `npx tsc --noEmit` clean.
`npx wrangler deploy --dry-run --config wrangler.staging.toml` ok. Worker-only
change, no migration.

#### Round 1 recovery and reviewed Worker deploy — 2026-08-27

Codex resumed the review and reran the complete local gate: frozen install,
typecheck, 1,423 tests with the two paid eval gates skipped, production and
staging Wrangler dry-runs, and `git diff --check` all passed. The accidental
`ponytail:` word in the new source comment was removed; runtime behavior did
not change. Supabase staging migration history matched all 20 local migrations.

On Maya's explicit approval, the Worker-only mitigation was deployed to
`vetai-staging` as version `82573d66-3907-4935-9749-54556793eb6e`. The real
staging URL then returned `200` from both `/health` and `/ready`. A read-only
Meta audit confirmed that the staging app is published, its registered number
is subscribed, its callback targets the staging Worker, and the `messages`
webhook field is subscribed. No production resource changed.

Maya separately approved deleting the synthetic `karamel` pet so Task 036 can
exercise its real zero-pet path. Read-only inspection established exactly one
pet row, exactly one referencing conversation (already `completed`), no
appointment row, and no pet link on the active `7d006d0c…` conversation. The
core composite FK is `ON DELETE NO ACTION`, so a guarded atomic staging block
first set the completed conversation's `pet_id` to null and then deleted only
that exact pet row. Postcondition query: zero matching pets, the completed
conversation unlinked, and `7d006d0c…` still `active`,
`pet_identification`, `state_version = 4`, `pet_id is null`.

One test-procedure correction is now explicit: a `handoff` conversation is
still reused by `ingest_whatsapp_text_message`, because the partial unique/open
conversation predicate covers both `active` and `handoff`. Handoff alone can
never open the next fresh conversation; the old row must first be closed.

The next real inbound exposed a second sequencing mistake in the original
test plan rather than a product failure. Because `karamel` had already been
deleted, the owner was genuinely zero-pet at context read. The old
`pet_identification` conversation therefore unlocked normally instead of
reaching `stalledOnPetIdentity`: the inbound persisted, an outbound reply was
accepted, and the conversation advanced to `complaint_collection`,
`state_version = 5`, still with `pet_id is null`. On Maya's separate approval,
Codex then changed only that staging conversation's operational `status` from
`active` to `completed`; message history, intake stage/data, owner data, and
outbox rows were retained. The open-conversation partial unique constraint is
now released, so the following inbound — not the one just processed — is the
first genuinely fresh zero-pet Task 036 smoke turn. The bounded second-pet
handoff remains covered by local regression tests and deployed code, but this
specific live run did not exercise it after the pet fixture was removed.

### Smoke test round 2 — fresh zero-pet path passed, 2026-08-27

Maya then sent a genuinely fresh complaint from the allowlisted staging
number. A new active conversation opened with `pet_id is null`; its first
outbound reply carried the recording-notice prefix and the deterministic
safety questions. `public.pets` still contained zero rows.

After Maya explicitly answered all eight safety questions negatively, the
conversation produced the combined `intake_confirmation` prompt for
`Minnoş` / `Kedi` / `2 gündür yemek yemiyor`. A second read of `public.pets`
still showed zero rows, proving that extraction and the confirmation prompt do
not create a pet.

Only after Maya sent the exact `EVET` confirmation did staging contain one
`public.pets` row (`Minnoş`, `Kedi`). The same active conversation's `pet_id`
then referenced that exact row, advanced to `safety_check` at
`state_version = 4`, and the Worker emitted its normal
post-confirmation reply. This closes the live acceptance criterion: pet
creation is deferred until explicit confirmation and the created row is linked
to the conversation in the same finalized turn. No production resource was
changed.

### Task 036 closure record

- Local gate: frozen install, typecheck, 1,423 tests passed with two paid eval
  gates skipped, production and staging dry-runs, and `git diff --check` all
  passed.
- Database gate: the Task 036 migration and affected rollback fixtures passed
  on `vetai-test`; migration history is aligned on `vetai-staging`.
- Live gate: recording notice, deterministic safety questions, deferred
  combined confirmation, zero rows before `EVET`, one linked pet after `EVET`,
  and inline outbound delivery were observed on staging.
- Known limitation: owners who already have a different pet on file still use
  the bounded human-handoff floor; the full second-pet registration flow is a
  separate task recorded in `PROJECT_CONTEXT.md`.
- Production deployment and the external veterinary/KVKK gates remain open.

---

# Completed task record — 034 Real staging and same-number WhatsApp evidence


Status: `COMPLETE` (closed 2026-08-25 — see "Task 034 closure record" at the end of this file)

Owner: Claude Sonnet (repository preparation), then Codex (review and live
execution); closed by Claude Opus standing in for Codex under Maya's explicit
delegation of 2026-08-25, Codex being unavailable.

## Goal

Prepare and then exercise one isolated, synthetic-data staging environment for
the already-reviewed VetAI Worker. The task must establish evidence for:

1. migration-history-based Supabase staging;
2. a separate Cloudflare Worker, three separate staging Queues, Cron, and
   secret bindings;
3. a real Meta webhook/inbound/outbound/status journey;
4. all three Task 033 modes (`ai | manual | personal`); and
5. whether the selected Turkish pilot number can actually use WhatsApp
   Business App / Cloud API Coexistence and how app-originated message echoes
   behave.

This remains one task. Repository preparation does not authorize external
resource creation. After Codex review, Codex must obtain explicit user approval
before any cost-bearing resource creation, remote migration, secret mutation,
Meta configuration, or deployment.

## Product decision

- Staging uses synthetic clinic/owner/pet/message data only.
- No production resource, identifier, secret, phone number, or patient data may
  enter Git, logs, screenshots, or evidence documents.
- Coexistence is an empirical gate, not an assumed feature. Record either:
  - `VERIFIED`: the chosen number can continue using the Business App while the
    Cloud API path works and message echoes do not create bot loops; or
  - `UNAVAILABLE`: exact sanitized Meta UI/API evidence identifies the blocker,
    and a reviewed staff Cloud API composer becomes a controlled-pilot blocker.
- Do not build that composer in this task.

## Sources and constraints

- Cloudflare Wrangler named environments create distinct Workers and require
  bindings to be declared per environment:
  <https://developers.cloudflare.com/workers/wrangler/environments/>.
- Cloudflare Queue resources are created separately from Worker bindings:
  <https://developers.cloudflare.com/queues/reference/wrangler-commands/>.
- Supabase staging must use a separate environment and migration history, not
  copied production data or ad-hoc SQL-editor schema application:
  <https://supabase.com/docs/guides/deployment/managing-environments> and
  <https://supabase.com/docs/guides/local-development/cli-workflows>.
- Meta's current Business App onboarding/Coexistence path must be verified in
  the authenticated Meta UI for the actual test account; repository docs must
  not promise regional/account eligibility:
  <https://developers.facebook.com/docs/whatsapp/embedded-signup/direct-onboarding-existing-users/existing-whatsapp-business-app-users>.

## Phase A — Sonnet repository preparation

### Allowed changes

- `wrangler.staging.toml` (new)
- `docs/staging-runbook.md` (new)
- `docs/production-readiness.md`
- `docs/product-roadmap.md` (Task 033/034 status text only)
- `README.md` (one link only)
- `CURRENT_TASK.md` (`Observed context` and `Delivery record` only)

No source, prompt, migration, SQL fixture, test, dependency, lockfile, existing
Wrangler config, environment type, Queue consumer, reply text, or KVKK/veterinary
approval package may change.

### Staging Wrangler contract

Create one standalone `wrangler.staging.toml` that reuses `src/index.ts` and:

- names the Worker `vetai-staging`;
- uses the production compatibility date and the same non-secret variables;
- binds producer `INTAKE_QUEUE` to `vetai-intake-staging`;
- declares consumers for `vetai-intake-staging` and
  `vetai-intake-dlq-staging` with the exact production retry/batch settings;
- routes their dead letters respectively to `vetai-intake-dlq-staging` and
  `vetai-intake-terminal-dlq-staging`;
- declares the same Cron trigger;
- contains no route/custom domain, real identifier, secret, placeholder secret,
  automatic provisioning flag, or production Queue name.

Do not add a wrapper script or dependency. Wrangler dry-run plus the runbook's
native commands are sufficient.

### Staging runbook contract

`docs/staging-runbook.md` must be an executable Turkish checklist with these
closed sections:

1. **Authority and cost gate** — list every remote mutation and state that
   Codex pauses for explicit user approval before executing it.
2. **Read-only preflight** — confirm authenticated Cloudflare/Supabase/Meta
   accounts, current project/portfolio, intended region, current Queues/Workers,
   and expected spending tier before mutation.
3. **Supabase** — create/select a dedicated staging project; link only after
   showing the exact project ref; run migration dry-run then migration-history
   push; compare migration list; never run rollback fixtures or production data.
4. **Cloudflare** — create the three exact staging Queues, set the seven secret
   bindings interactively, deploy only `vetai-staging`, and verify bindings,
   Cron, `/health`, and `/ready`.
5. **Synthetic prerequisites** — one fabricated clinic/account/staff user/pet,
   one future appointment slot, and one designated test sender. No real patient
   or friend conversation.
6. **Meta** — webhook challenge, `messages` subscription, real inbound text,
   outbound delivery/status callback, and sanitized evidence fields.
7. **Selective automation matrix** — sequentially verify the same designated
   sender in `personal`, `manual`, then `ai`; state exact expected persistence,
   Queue, OpenAI, outbox, and reply behavior for each.
8. **Manual-takeover race** — switch an AI contact to manual while work is
   pending and prove no new outbox reply is committed; acknowledge that a reply
   already submitted to Meta cannot be recalled.
9. **Appointment and safety smoke** — synthetic safety handoff, staff-item
   visibility, appointment offer → `EVET`, and separate offer → `HAYIR`.
10. **Coexistence evidence** — eligibility/onboarding result, Business App
    inbound visibility, API reply visibility in the app, app-originated
    `smb_message_echoes` behavior, and explicit no-loop/no-persistence result.
11. **Evidence template** — timestamps, closed PASS/FAIL/NOT RUN result, HTTP or
    closed RPC outcome, redacted resource alias, and screenshot filename only;
    never raw bodies, phone numbers, tokens, user text, provider IDs, or keys.
12. **Stop/rollback/cleanup** — unsubscribe webhook or disable Worker first,
    allow Queue disposition without purge, use forward-only migration repair,
    and list resource deletion only as an explicitly approved final action.
13. **Decision table** — define the exact `VERIFIED` vs `UNAVAILABLE`
    Coexistence outcomes and the resulting pilot decision.

The runbook must distinguish facts that Sonnet can validate locally from live
steps reserved for Codex. It must not mark a live checkbox complete.

### Documentation corrections

- Update `docs/production-readiness.md` so staging is performed before any
  production smoke journey and cross-link the new runbook.
- Update only the stale Task 033/034 status paragraphs in
  `docs/product-roadmap.md`: Task 033 is complete and validated on disposable
  `vetai-test`; Task 034 repository preparation is in progress, with live
  evidence still not run.
- Add one README link to the staging runbook.

## Phase B — Codex live execution (not Sonnet)

After Phase A delivery, Codex reviews the diff and reruns local checks. Then:

1. perform read-only account/resource discovery;
2. present the exact resource plan and any expected price to the user;
3. request explicit approval;
4. create/configure only the approved staging resources;
5. execute the runbook with synthetic data;
6. record sanitized evidence in the Codex review record or a new evidence file
   only if Codex first adds that file to this contract;
7. stop immediately on target ambiguity, secret exposure, real-person data, an
   unexpected charge, or any tenant/safety failure.

No production deployment is authorized by Task 034.

## Acceptance criteria

### Repository gate

- Staging config is syntactically valid and has only staging resource names.
- Production `wrangler.toml` and runtime behavior are unchanged.
- Runbook contains every section above and no live claim.
- No secret or real identifier appears in the diff.
- No new code, dependency, test framework, migration, or schema change.

### Live evidence gate

Task 034 becomes `COMPLETE` only if Codex records all of the following after
explicit approval:

- migration history and read-only RLS/grant catalog checks pass on staging;
- three staging Queues, Worker bindings, Cron, `/health`, and `/ready` pass;
- real Meta inbound → Queue → OpenAI → atomic finalize → outbound → status
  works using synthetic text;
- `personal`, `manual`, and `ai` behavior matches Task 033 exactly;
- safety handoff, staff visibility, `EVET`, and `HAYIR` smoke paths pass;
- Coexistence is honestly classified `VERIFIED` or `UNAVAILABLE` with sanitized
  evidence and a corresponding pilot decision;
- no production resource/data was touched and no secret was recorded.

If external access or eligibility is absent, do not fabricate completion. Keep
the task in review and record the exact blocker.

## Required local verification

Sonnet runs:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

No paid OpenAI eval is required because prompt/model/extraction/safety/reply
logic is out of scope.

## Review gate

- Mandatory: Codex config/runbook review and all live execution.
- Claude Opus is not required because no new RLS, clinical safety, KVKK data
  boundary, or runtime logic is allowed. If implementation crosses one of
  those boundaries, stop and revise the contract rather than silently adding
  an Opus gate.

## Observed context

- Repository was clean at start (`git status --short` empty); last commit
  `9ee9afc docs: define real staging evidence task`.
- Production `wrangler.toml`: Worker `vetai`, `main = "src/index.ts"`,
  `compatibility_date = "2025-01-01"`, `[vars]` = `APP_TIMEZONE`,
  `WHATSAPP_GRAPH_API_VERSION`; producer/consumer bindings for
  `vetai-intake` → `vetai-intake-dlq` → `vetai-intake-terminal-dlq` with
  `max_batch_size=1`, `max_batch_timeout=5`, `max_retries=3`,
  `retry_delay=120`/`300`; Cron `* * * * *`. `wrangler.staging.toml` mirrors
  this exactly with staging Worker/queue names, per the contract.
- `src/env.ts`, `src/readiness.ts`, and a complete `env.*` usage scan show
  exactly **seven** runtime-required
  non-`[vars]` values (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
  `OPENAI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`), matching
  `docs/production-readiness.md` §3 and `.dev.vars.example`. Codex corrected
  the Phase A contract from eight to seven during review; no eighth runtime
  value exists.
- `docs/product-roadmap.md`'s Task 033 status paragraph was stale relative to
  `PROJECT_CONTEXT.md` (Task 033 is recorded complete, validated on
  disposable `vetai-test`, 1,336/1,336 tests, Codex + Opus review passed);
  updated in place along with a new Task 034 in-progress paragraph.
- Confirmed routes in `src/index.ts`: `GET /health`, `GET /ready`,
  `GET|POST /webhooks/whatsapp`, `/staff*`.
- `supabase/migrations/` currently ends at
  `20260814000300_selective_automation.sql`; `supabase/tests/` currently
  ends at `033_selective_automation.sql` — used as the exact reference point
  in the runbook's Supabase migration-list comparison step.

## Delivery record

### Changed files

- `wrangler.staging.toml` (new) — standalone staging config, no source/route/
  secret/production Queue name.
- `docs/staging-runbook.md` (new) — Turkish executable checklist, all 13
  contract sections present, every live item unchecked (`[ ]`), no live
  claim.
- `docs/production-readiness.md` — one paragraph added to §5 requiring
  staging to pass first, cross-linking the new runbook.
- `docs/product-roadmap.md` — Task 033 status paragraph corrected to
  "complete/validated"; new Task 034 repository-preparation-in-progress
  paragraph added. No other text changed.
- `README.md` — one link added to `docs/staging-runbook.md`.
- `CURRENT_TASK.md` — this Observed context and Delivery record only.

No source, prompt, migration, SQL fixture, test, dependency, lockfile,
existing Wrangler config, environment type, Queue consumer, reply text, or
KVKK/veterinary approval package was touched.

### Acceptance criteria satisfied (repository gate)

- Staging config is syntactically valid and uses only staging resource
  names — confirmed by the staging Wrangler dry-run (see below).
- Production `wrangler.toml` and runtime behavior are unchanged (not
  edited; production dry-run output unchanged from baseline expectations).
- Runbook contains all 13 required sections and marks no live checkbox
  complete.
- No secret or real identifier appears in the diff (`git diff` for the four
  changed tracked files scanned for secret/token/key/password patterns:
  none found; new files contain only placeholder/redacted-alias examples).
- No new code, dependency, test framework, migration, or schema change.

### Exact checks and results

```text
pnpm install --frozen-lockfile   → "Already up to date", exit 0
pnpm typecheck                   → tsc --noEmit, no output, exit 0
pnpm test                        → 32 test files passed, 1336 passed / 2 skipped (1338 total), exit 0
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  → Worker "vetai", queue "vetai-intake" binding, exit 0
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
                                  → Worker "vetai-staging", queue "vetai-intake-staging" binding, exit 0
git diff --check                 → only LF/CRLF line-ending warnings, no whitespace errors, exit 0
```

### Live checks

All Meta/Cloudflare/Supabase live steps in `docs/staging-runbook.md`
(§§2–10, §12): `NOT RUN — reserved for Codex`. No Cloudflare, Supabase,
Meta, or OpenAI resource was created, modified, or called. No deploy,
remote migration, or secret mutation occurred.

### Known limitations / risks for Codex to inspect

- The runbook's §10 Coexistence steps (Business App inbox visibility,
  `smb_message_echoes` behavior, no-loop confirmation) are necessarily
  written from documentation and code reading, not from an authenticated
  Meta session — Codex must treat every expected behavior there as a
  hypothesis to empirically confirm, not a given.
- The runbook assumes the designated test sender and Meta test WABA number
  are already available to Codex; provisioning/selecting that number is a
  Phase B action outside this task's allowed file list.
- `wrangler queues create` for the three staging queues must run before
  `wrangler deploy --config wrangler.staging.toml` (queue bindings do not
  auto-provision the underlying resource); the runbook §4 sequences this
  correctly but Codex should confirm current Wrangler behavior has not
  changed.

## Codex review record

Phase A repository preparation reviewed with minimum corrections:

- corrected the task's mistaken secret count from eight to the seven values
  actually used by `Env`, `checkReadiness`, `.dev.vars.example`, and the full
  `env.*` usage scan;
- corrected the cost preflight: Cloudflare Queues is available on Workers
  Free with 10,000 operations/day and fixed 24-hour retention; Workers Paid
  remains an optional minimum-$5 tier with longer retention, not a staging
  prerequisite;
- removed the misleading notion of a Cloudflare deployment region and kept
  the real Supabase region plus Cloudflare account/plan checks;
- clarified the Task 033 test count in the roadmap.

Independent local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
pnpm test                        -> PASS; 32 files, 1336 passed,
                                     2 paid eval gates skipped
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> PASS; production config unchanged
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
                                  -> PASS; vetai-staging and staging producer binding
git diff --check                 -> PASS; only benign autocrlf notices
```

Read-only Phase B preflight, with identifiers suppressed from tool output:

- Cloudflare CLI authentication: missing; Queue discovery therefore not
  available and no Cloudflare mutation was attempted.
- Supabase CLI authentication: present; four projects were returned and the
  existing disposable `vetai-test` project is present. Project refs, account
  identifiers, and names other than the already-documented alias were not
  emitted.
- Meta authenticated preflight: not run yet.

Decision: `PHASE_A_PASS`. Task 034 remains `IN_REVIEW`; live execution cannot
start until Cloudflare/Meta read-only discovery is complete, the exact plan and
price are shown to the user, and the user explicitly approves the remote
mutations. No Opus review or paid model eval is required for Phase A.

### Codex Phase B live execution record — 2026-08-15

The user approved the isolated staging mutations after a zero-cost plan was
shown. Raw account/project/app/phone/provider identifiers and every secret were
suppressed from this record.

Completed evidence:

- Cloudflare authentication was granted with the minimum Worker/Queue scopes
  needed for this task. Three staging Queue resources were created, the
  `vetai-staging` Worker was deployed with the reviewed producer/consumer/
  DLQ/Cron bindings, and all seven runtime secrets were stored only through
  encrypted or interactive inputs.
- `GET /health` returned 200/`ok` and a cache-busted `GET /ready`
  returned 200/`ready`.
- A separate free Supabase staging project was created and linked. All 17
  migrations were applied through migration history; local/remote migration
  order matched.
- The Supabase CLI's linked database test command required unavailable local
  Docker. Codex instead ran the 17 rollback-only SQL proofs in the staging SQL
  Editor. All passed and left zero fixture residue. This was a deliberate
  deviation from the initial runbook's `do not run fixtures on staging` rule and
  is recorded rather than hidden; it will not be repeated.
- One clearly synthetic clinic and the exact Meta test-number account mapping
  were inserted into staging. One synthetic manual-routing override was added;
  no real owner, patient, pet, message, or recipient phone was stored.
- A free unpublished Meta app/test WABA/test number was created. The staging
  callback challenge passed, the `messages` field is subscribed, and the
  app secret, verify token, and refreshed temporary access token are present
  only in encrypted runtime storage.
- Meta's fixed test template was sent from the test number to a user-verified
  recipient and the user confirmed receipt. This proves only Meta test-number
  outbound delivery; it does not prove the VetAI outbox/sender path.
- Expected incremental cost for the executed Cloudflare, Supabase, and Meta
  steps was `$0`. No OpenAI request or paid evaluation was run.

Unresolved live gate:

- Meta explicitly states that an unpublished app receives dashboard-generated
  test webhooks only and receives no production inbound/status data. The
  dashboard showed test-number status events, but a bounded Worker tail
  observed no webhook invocation.
- The dashboard's webhook-field `Test` control produced no Worker request in
  either the new or classic Meta screen. It was not counted as a pass.
- The user has no WhatsApp Business App account or eligible pilot number;
  Coexistence is therefore honestly classified `UNAVAILABLE`. Only the
  free Cloud API test number exists.
- Consequently real inbound → Queue → OpenAI → atomic finalize → VetAI
  outbound → status, the selective-automation matrix, the takeover race,
  safety/staff smoke, and appointment `EVET`/`HAYIR` paths remain
  `NOT RUN`.
- Publishing is intentionally not authorized: veterinary copy approval,
  Turkish legal/KVKK approval, a production privacy-policy surface, durable
  Meta credentials, and an eligible business/pilot number are still absent.

Decision: `PHASE_B_PARTIAL_BLOCKED`. Task 034 remains `IN_REVIEW`.
No production resource or data was touched, no secret was recorded, and no
claim of full staging completion is made.

Post-record local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
pnpm test                        -> PASS; 32 files, 1336 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; production binding unchanged
staging Wrangler dry-run         -> PASS; staging Queue binding
git diff --check                 -> PASS; only benign autocrlf notices
sanitized diff scan              -> PASS; only a documented migration
                                     timestamp matched the long-number rule
```

## Phase C — pre-Business-number runtime hardening (user amendment)

The user explicitly requested one final code-safety pass before connecting an
eligible WhatsApp Business number. This is an amendment to Task 034 rather than
a second active task.

### Required outcome

1. Group-originated WhatsApp traffic must never enter automation. If Meta
   delivers a recognizable group event, acknowledge the signed webhook without
   reading, hashing, logging, persisting, queueing, sending to OpenAI, or
   replying to its nested message content.
2. Audit the adjacent inbound/routing/Queue/outbound/staff/appointment trust
   boundaries for similarly reachable correctness, privacy, tenant, loop, or
   unbounded-cost failures.
3. Fix only reproducible or source-proven defects. Do not add speculative
   abstractions, dependencies, schema, features, or production resources.
4. Preserve direct-chat behavior, the three selective-automation modes,
   signature verification, fail-closed parsing, deterministic safety
   precedence, and all existing tenant/RLS boundaries.

### Audit gate and scope control

- Codex first records evidence-backed findings and the exact affected files in
  this section. Source edits are forbidden until that finding list is closed.
- Allowed review surface: `src/index.ts`, `src/whatsappIngest.ts`,
  `src/contactAutomation.ts`, Queue consumers/finalizers, outbound sender/status,
  staff routes, appointment flow, their direct tests, and the matching docs.
- After the audit, Codex may amend the exact allowed-change list below once.
  Any database/RLS, clinical-copy, prompt/model, or new data-retention change
  requires a new explicit contract and the applicable Opus/human review gate.
- No remote mutation, deploy, paid OpenAI call, Meta publication, or real
  Business number is authorized.

### Required verification

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

### Closed audit findings

1. **BLOCKING — recognizable group messages can enter the direct-chat path.**
   Meta's current Groups webhook contract carries inbound group messages in
   the ordinary `messages` field with an additive message-level `group_id`.
   `extractInboundMessages` ignores that discriminator and currently treats
   the participant's numeric `from` as a direct-chat sender. The same parser
   must also recognize the documented/additive `recipient_type: "group"` and
   `context.group_id` shapes defensively. A recognized group candidate must be
   skipped before route resolution, contacts/profile access, nested content,
   hashing, persistence, Queue, OpenAI, or reply creation; other direct
   candidates in the same signed batch must continue normally.
2. **HIGH — internal RPC fetches are not locally bounded.** Most Supabase RPC
   clients used by webhook, Queue, appointment, dead-letter, and outbound
   paths have no AbortSignal. A stalled origin can therefore outlive the
   120-second intake lease, allowing a reclaimed second worker and duplicate
   paid model work even though only one finalize can win. Every affected
   native-fetch RPC call must fail closed after 10 seconds. Combined with the
   existing 30-second OpenAI/Meta bounds and 5-second clinic-hours bound, the
   normal intake path remains below the lease ceiling.
3. **No new source-proven defect** was found in the remaining reviewed
   boundaries. `smb_message_echoes`, history, lifecycle, reaction, system,
   and unknown fields are ignored because they are not supported inbound
   `messages` candidates; outbound sends force `recipient_type: "individual"`;
   selective-automation is rechecked at claim time; Queue retries and outbound
   attempts are finite; appointment mutations remain confirmation-gated; and
   staff rendering remains fixed-copy/escaped. Existing documented
   at-least-once, route-race, retention, and external-approval ceilings remain
   unchanged and are not silently relabeled as fixed.

### Exact Phase C allowed changes

- Group exclusion: `src/whatsappIngest.ts`,
  `test/whatsappIngest.test.ts`, `test/index.test.ts`.
- Ten-second internal-RPC bounds: `src/contactAutomation.ts`,
  `src/supabaseIngest.ts`, `src/supabaseOutboundStatus.ts`,
  `src/intakeJobLease.ts`, `src/conversationState.ts`,
  `src/intakeDeadLetter.ts`, `src/outboundDelivery.ts`,
  `src/appointmentFlow.ts`, `src/appointmentEngine.ts`, and their matching
  existing unit-test files.
- Narrow documentation/context: `docs/inbound-queue.md`,
  `docs/selective-automation.md`, `docs/outbound-delivery.md`,
  `docs/appointment-booking-engine.md`, `docs/production-readiness.md`,
  `PROJECT_CONTEXT.md`, and this file.

No migration, SQL fixture, prompt/model, reply copy, dependency, configuration,
secret, remote resource, or production identifier may change.

### Phase C Codex review and verification record — 2026-08-21

Implemented and independently reviewed the two closed findings with no schema,
prompt, copy, dependency, configuration, or remote-service change:

- `src/whatsappIngest.ts` now excludes value/message `group_id`, explicit
  `recipient_type: "group"`, and `context.group_id` before route lookup or
  nested content/profile access. Throwing-getter tests prove those fields are
  untouched; a mixed-batch test proves direct traffic still proceeds.
- A signed Worker-level group fixture returns HTTP 200 with zero fetch and
  Queue calls, proving no RPC, persistence, Queue, OpenAI, or reply path runs.
- The nine previously unbounded Supabase client fetch boundaries now use
  `AbortSignal.timeout(10_000)` and preserve their existing generic fail-closed
  results. Existing 5-second clinic-hours and 30-second OpenAI/Meta bounds are
  unchanged.
- Source tracing found no second group/echo reply path: only
  `extractInboundMessages` imports content into intake; `smb_message_echoes`,
  history, lifecycle, reaction, system, and unknown fields remain ignored;
  outbound Meta calls still force `recipient_type: "individual"`.

Verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 11 files, 636 tests
pnpm test                        -> PASS; 32 files, 1343 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; production bindings unchanged
staging Wrangler dry-run         -> PASS; staging bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
sanitized diff review            -> PASS; no real secret or identifier added
```

No migration/database check was required because no SQL changed. No live Meta,
OpenAI, Supabase, Cloudflare mutation, deploy, publication, or Business-number
connection occurred. The existing Task 034 Phase B live blockers remain.

Decision: `PHASE_C_PASS`. The code hardening is ready to commit; Task 034 as a
whole remains `IN_REVIEW` until the user supplies an eligible WhatsApp Business
pilot number and the external veterinary/legal production gates are closed.

## Phase D — strict AI allowlist before personal-number pilot (user amendment)

The user explicitly chose to test with a backed-up personal iPhone number and
requested a strict allowlist before any WhatsApp Business/Cloud API
registration. This remains part of Task 034 because it is a prerequisite for
the same live staging journey; no phone-number registration is authorized by
this repository phase.

### Required outcome

1. Every WhatsApp account defaults to `personal`: an unlisted direct sender's
   nested message content is not read, hashed, logged, persisted, queued, sent
   to OpenAI, or answered by VetAI.
2. Only an exact per-contact route explicitly set to `ai` enters automation.
   Existing `manual` and explicit `personal` overrides remain available.
3. Removing an override (`inherit`) returns that sender to the strict
   `personal` default.
4. The existing envelope-level routing lookup and honest Meta/Cloudflare
   transient-memory boundary remain unchanged. Group exclusion remains
   stronger and runs before contact routing.
5. No prompt, clinical copy, dependency, framework, new storage table, or
   production resource is added.

### Exact allowed changes

- New migration and rollback proof:
  `supabase/migrations/20260822000100_strict_ai_allowlist.sql`,
  `supabase/tests/034_strict_ai_allowlist.sql`; compatibility-only fixture
  update: `supabase/tests/033_selective_automation.sql` (the old proof must no
  longer insert now-forbidden account-level `ai/manual` defaults).
- Existing staff UI/parser tests: `src/staffPage.ts`,
  `test/staffPage.test.ts`.
- Narrow documentation/context: `docs/selective-automation.md`,
  `docs/staff-workflow.md`, `docs/database-schema.md`,
  `docs/staging-runbook.md`, `docs/product-roadmap.md`,
  `PROJECT_CONTEXT.md`, and this file.

No existing migration may be rewritten. No live database migration, Worker
deploy, Meta registration, secret mutation, paid OpenAI call, or production
change is authorized until local review passes and the user sees the exact
staging mutation plan.

### Review gate

- Codex: migration/call-path/UI review and all local verification.
- Claude Opus: mandatory narrow read-only review of the database constraint,
  pending-outbox cleanup, RLS/tenant behavior, and privacy wording before live
  staging apply.
- Human: iPhone backup is complete; normal WhatsApp/Business/Cloud API account
  changes remain a later explicit step.

### Phase D Codex local review record — 2026-08-22

Implemented the strict allowlist by reusing Task 033's existing route model:

- the forward migration sets every existing/new account default to the only
  permitted account-level value, `personal`;
- exact per-contact `ai | manual | personal` overrides and `inherit` remain
  unchanged; therefore only an explicit `ai` row enters automation;
- activation deletes still-`pending | processing` outbox rows without an
  exact AI route. Removing `processing` prevents lease-expiry reclaim/retry;
  one network request already handed to Meta still cannot be recalled.
  Terminal `accepted | failed` history remains;
- `/staff` accepts only a `personal` account default and otherwise fails the
  account-list parser closed, preventing a false "strict whitelist" claim;
- the existing Task 033 SQL proof was compatibility-updated to express its AI
  paths as explicit routes instead of obsolete account defaults.

Local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 3 files, 191 tests
pnpm test                        -> PASS; 32 files, 1344 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; bindings unchanged
staging Wrangler dry-run         -> PASS; bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
```

At this local-review stage, migration apply and SQL fixtures 033/034 were
`NOT RUN`; staging deploy, Meta number registration, WhatsApp account
conversion, and paid OpenAI eval were also untouched. The later records below
preserve the subsequent Opus and disposable-database results.

### Phase D Opus correction record — 2026-08-22

The first mandatory read-only Opus review returned `CHANGES_REQUIRED`.
Codex addressed the findings without adding a table, RPC, dependency, prompt,
clinical copy, or remote mutation:

- activation cleanup now deletes unauthorized `pending | processing` rows,
  preventing an expired processing lease from being reclaimed; documentation
  states that a network request already handed to Meta cannot be recalled;
- the 034 rollback proof now exercises the real unlisted ingest boundary and
  proves zero event/owner/conversation/message writes;
- the same fixture exercises the exact cleanup predicate across authorized
  pending, unauthorized pending/processing, terminal accepted/failed, and a
  same-recipient row in another account/tenant;
- the cross-tenant absence assertion now runs after `reset role`, outside
  authenticated RLS, and the resolver proof distinguishes identical contacts
  across two accounts;
- `/staff` keeps its “strict policy active” claim hidden until the account
  payload validates a `personal` default, and shows a fixed fail-closed
  warning otherwise; its retention and `inherit` copy now distinguishes an
  explicit route row from an unlisted number;
- migrations remain intentionally free of nested `begin/commit`, matching
  the reviewed Supabase CLI transaction invariant. The runbook now forbids
  statement-by-statement SQL Editor application and requires the managed
  file-atomic migration path.

At this correction stage, database execution remained `NOT RUN`; local
verification and a narrow Opus re-review were required before any staging
apply or phone registration. The later disposable-database record below is the
authoritative result after those gates.

Correction verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 3 files, 111 tests
pnpm test                        -> PASS; 32 files, 1,344 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; bindings unchanged
staging Wrangler dry-run         -> PASS; bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
```

### Phase D disposable database validation record — 2026-08-22

After explicit user approval, Codex validated Phase D only on the disposable
`vetai-test` project. The restored database already contained the first 17
migrations' schema but its CLI migration-history table was empty because the
older files had been applied through the dashboard. Codex recorded those 17
existing versions as applied, then reran `supabase db push --dry-run`; the only
remaining file was `20260822000100_strict_ai_allowlist.sql`.

Live disposable-database evidence:

```text
strict-allowlist migration apply -> PASS; vetai-test only
033 rollback fixture             -> PASS; zero visible fixture residue
034 rollback fixture             -> PASS 0/0/0
catalog/default/CHECK/RLS audit   -> PASS; 7/7 closed checks true
```

The final catalog audit proved the new migration-history record, the
`personal` column default, the named strict CHECK, all existing accounts on
`personal`, no unauthorized claimable `pending | processing` outbox row, RLS
enabled on all three affected tables, and zero 033/034 fixture residue.

Decision: `PHASE_D_DISPOSABLE_PASS`. The local Codex gate, mandatory Opus
read-only review, real migration apply, both rollback fixtures, and catalog
checks have passed. Task 034 remains `IN_REVIEW` because the strict migration
has not been applied to staging, no eligible pilot number is registered, and
the full real inbound/outbound chain is still unproved. No staging,
production, Meta, OpenAI, or iPhone mutation occurred in this validation.

### Phase D staging apply record — 2026-08-22

After separate user approval, Codex linked only to the existing
`vetai-staging` project. The remote migration history matched all first 17
local migrations, and `supabase db push --dry-run` offered only
`20260822000100_strict_ai_allowlist.sql`. Codex applied that single file
through the managed CLI transaction; no rollback fixture was run on staging.

Post-apply evidence:

```text
strict-allowlist migration apply -> PASS; vetai-staging only
catalog/default/CHECK/RLS audit   -> PASS; 6/6 closed checks true
migration history comparison     -> PASS; local/remote 18/18
post-apply migration dry-run      -> PASS; remote database up to date
```

The staging catalog audit proved the new migration record, the `personal`
default, the named strict CHECK, every existing account on `personal`, no
unauthorized claimable `pending | processing` outbox row, and RLS enabled on
the three affected tables. Task 034 remains `IN_REVIEW`: no eligible pilot
number exists, Coexistence is still `UNAVAILABLE`, and real inbound → Queue →
OpenAI → finalize → outbound/status evidence remains `NOT RUN`. No production,
Meta, OpenAI, or iPhone mutation occurred in this staging apply.

### Business App conversion and direct Coexistence probe — 2026-08-22

The user completed the reviewed iPhone backup, moved the same number from
WhatsApp Messenger to the WhatsApp Business App, and independently confirmed
that existing chats plus normal send/receive still work. Codex then opened the
existing Meta staging app's Production setup. The direct self-serve flow
offered only the standard `Add new number` wizard (`Business information → WA
Business Profile → Add number → Verify number`); it exposed no Coexistence,
existing-Business-App, or QR path. Codex closed the wizard before entering or
submitting any business information.

Decision: `COEXISTENCE_UNAVAILABLE_DIRECT_SELF_SERVE`. Do not use the standard
wizard for this personal-number pilot because it can move the number to
Cloud-API-only operation and remove the Business App inbox relied on for human
and personal replies. No phone number was registered with Cloud API, no
payment was added, and the Business App remained operational. The safe next
options are a separate API test number or a separately approved Embedded
Signup/Tech Provider/BSP Coexistence route; neither is authorized here.

## Phase E — dedicated Cloud API pilot number and staging publication (user amendment)

The user registered a separate, non-Coexistence pilot number in the existing
staging WABA and explicitly authorized completing the staging-only setup. This
amendment does not authorize production deployment, production data, a claim
of legal/KVKK approval, or use by unlisted senders.

### Required outcome

1. Serve a public Turkish staging privacy notice at `GET /privacy` without
   tracking, remote assets, secrets, phone numbers, patient data, or a false
   compliance/approval claim.
2. Keep all non-GET methods closed and preserve existing Worker routes.
3. Deploy only `vetai-staging`, enter that URL in the staging Meta app, and
   publish only after a separate action-time user confirmation.
4. Bind the newly registered phone-number ID to the existing synthetic staging
   WhatsApp account, keep the account default `personal`, and add only the one
   user-designated test sender as an exact `ai` route before real inbound.
5. Record only sanitized PASS/FAIL/NOT RUN evidence. Never record the pilot or
   sender number, token, message body, provider ID, or secret.

### Exact Phase E allowed changes

- `src/privacyPage.ts` (new), `src/index.ts`, `test/index.test.ts`.
- Narrow staging evidence/context only: `docs/staging-runbook.md`,
  `docs/production-readiness.md`, `PROJECT_CONTEXT.md`, and this file.

No migration, schema, prompt/model, clinical reply, dependency, production
configuration, or production resource may change. The public notice is a
truthful staging disclosure, not the missing lawyer-approved production
privacy package.

### Phase E observed context — 2026-08-23

Recorded by Claude (implementer) from repository evidence only. No Cloudflare,
Supabase, Meta, or OpenAI resource was created, called, or mutated.

- The privacy-notice half of Phase E was already present on disk and unrecorded
  when this session started: `src/privacyPage.ts`, the `/privacy` route in
  `src/index.ts`, and three `test/index.test.ts` cases (`GET /privacy`,
  `GET /privacy/`, `POST /privacy` → 405). Baseline run before any edit in this
  session: 32 files, 1,347 passed, 2 paid eval gates skipped — exactly the Phase
  D count of 1,344 plus those three. No Phase E delivery record existed.
- **BLOCKING defect found — the staging Worker's Queue consumer is inert.**
  `src/index.ts`'s `queue()` handler selected its processor by exact production
  resource name (`batch.queue === "vetai-intake"` /
  `"vetai-intake-dlq"`). `batch.queue` carries the real Cloudflare resource
  name, and `wrangler.staging.toml` declares consumers for
  `vetai-intake-staging` and `vetai-intake-dlq-staging`. On `vetai-staging`
  every batch therefore fell to the `null` processor and retried: intake
  exhausted its three attempts into `vetai-intake-dlq-staging`, that queue
  exhausted its three attempts into `vetai-intake-terminal-dlq-staging`, and no
  dead-letter staff handoff was ever created. The exact Phase E / Task 034 live
  gate — real inbound → Queue → OpenAI → atomic finalize → outbound → status —
  could not have passed on staging, and the failure would have looked like a
  Meta or Supabase problem rather than a routing one.
- The existing queue-routing tests only ever asserted production names
  (`vetai-intake`, `vetai-intake-dlq`, `vetai-intake-terminal-dlq`), so the
  suite could not detect the gap. `wrangler deploy --dry-run` cannot detect it
  either: it validates bindings, not the handler's name matching.
- Both affected files (`src/index.ts`, `test/index.test.ts`) are already inside
  the Exact Phase E allowed-change list, so no amendment to that list was
  needed. No other file was touched.

### Phase E delivery record (partial) — 2026-08-23

#### Changed files

- `src/index.ts` — queue routing now resolves through two explicit named sets,
  `INTAKE_QUEUE_NAMES` (`vetai-intake`, `vetai-intake-staging`) and
  `INTAKE_DEAD_LETTER_QUEUE_NAMES` (`vetai-intake-dlq`,
  `vetai-intake-dlq-staging`). Terminal dead-letter names are deliberately in
  neither set: they have no declared consumer and must keep failing closed to
  `retry`. No other behavior, route, header, or handler changed; production
  routing is byte-for-byte equivalent to the previous exact-match branch.
- `test/index.test.ts` — four added cases: staging intake routes only to the
  primary processor; staging DLQ routes only to the dead-letter processor;
  every line-anchored `queue = "..."` name declared in `wrangler.toml` and
  `wrangler.staging.toml` resolves to exactly one processor and acks; both
  terminal dead-letter names still retry with no processor called. The third
  case reads the two Wrangler configs so future config drift fails the suite
  rather than staging.
- `docs/staging-runbook.md` — new §14 (Faz E) execution section and a
  corrected header date. Every §14 item is `[ ]`; no live checkbox was marked
  and no live claim was added. §14.0 records the redeploy prerequisite created
  by the queue-routing defect above, §14.2 records that the Phase B temporary
  Meta token has expired, §14.4 restates the exact `whatsapp_accounts` /
  `whatsapp_contact_routes` / `clinic_staff` shapes the binding and allowlist
  steps depend on, and §14.6 restates the external gates Phase E does not
  close.
- `CURRENT_TASK.md` — this Observed context and Delivery record only.

No source outside `src/index.ts`, no migration, SQL fixture, prompt, model,
clinical copy, dependency, lockfile, Wrangler config, or secret was touched.

#### Regression proof

The three name-dependent new cases were run against the previous exact-match
branch and failed (3 failed / 77 passed); against the fix they pass (80/80).
The suite therefore reproduces the defect rather than merely accompanying it.

#### Exact checks and results

Run in an isolated Linux sandbox holding a faithful copy of the worktree, not
on the developer machine.

```text
pnpm install --frozen-lockfile   -> PASS; lockfile honored, 80 packages
pnpm typecheck                   -> PASS; zero errors
targeted Vitest (index.test.ts)  -> PASS; 80 tests (was 76)
pnpm test                        -> PASS; 32 files, 1,351 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; Worker "vetai",
                                     env.INTAKE_QUEUE (vetai-intake)
staging Wrangler dry-run         -> PASS; Worker "vetai-staging",
                                     env.INTAKE_QUEUE (vetai-intake-staging)
```

Sandbox caveat, recorded rather than hidden: `@types/node` is an uninstalled
optional peer under `--frozen-lockfile`, so the sandbox needed it added locally
before `tsc` could resolve the `node:fs` / `node:path` imports that several
existing test files already use. That install was local to the sandbox only;
`package.json` and `pnpm-lock.yaml` are unchanged in the repository. Codex
should rerun `pnpm typecheck` on the developer machine to confirm.

#### Checks not run and why

- `git status`, `git diff --check`, and any commit: this session had no shell
  on the developer machine, only file read/write. Line-ending and worktree
  cleanliness must be confirmed by Codex or the user before commit.
- Every live Cloudflare, Supabase, Meta, and OpenAI step of Phase E
  (deploy, privacy URL entry, app publication, phone-number-ID binding,
  designated-sender `ai` route, real inbound/outbound/status journey):
  `NOT RUN`. Phase E items 2-5 remain entirely open.
- No paid OpenAI call or eval was made.

#### Known limitations / risks to inspect

- The staging Worker currently deployed at the time of this record predates
  this fix. Any staging Queue evidence gathered before a redeploy is invalid,
  and any message already sitting in `vetai-intake-terminal-dlq-staging` got
  there through the defect, not through a real failure.
- The fix hardcodes four resource names. A third environment, or a rename of
  any queue, must update `src/index.ts` together with its Wrangler config; the
  added config-drift test is what surfaces that, so it must not be weakened.
- The `/privacy` notice is a truthful staging disclosure written by an AI and
  is still not the lawyer-approved KVKK package required before production.

### Phase E live execution record — 2026-08-23

Executed with the user present, each remote mutation separately approved by
them at the time. Raw identifiers, phone numbers, and secrets are suppressed.

#### What was executed

- `vetai-staging` redeployed with the queue-routing fix. Deploy output listed
  `Consumer for vetai-intake-staging` and `Consumer for vetai-intake-dlq-staging`.
- Meta app: privacy policy URL set to the staging Worker's `/privacy`; the app
  was then **published** on the user's explicit approval.
- Staging database: the `whatsapp_accounts` row was rebound from the old Meta
  **test** number to the pilot number (it would otherwise have resolved
  `unknown_account` for every real inbound); the synthetic staff Auth user's
  `clinic_staff` membership was inserted; and one exact `ai` contact route was
  added for the single designated test sender.
- The `ai` route was set by calling the real `set_whatsapp_contact_route` RPC
  from a database session assuming the staff user's identity
  (`set local role authenticated` + real `auth.uid()`, the pattern the repo's
  own SQL fixtures use). Recorded deviation: this is not the `/staff` browser
  path the runbook prescribes. No table was written directly, and
  `is_clinic_staff` genuinely authorized the call — but the `/staff` UI itself
  remains untested.
- `WHATSAPP_ACCESS_TOKEN` was replaced with a permanent Meta token after the
  expired one was proven invalid by three failed delivery attempts.

#### Live evidence — the full chain now passes

Real inbound → signed webhook → signature verified → persisted → `ai` route →
Queue → OpenAI → atomic finalize → outbox → real outbound → Meta delivery
status callback. Worker tail showed `processed: 1` and
`Queue vetai-intake-staging (1 message) - Ok`; the conversation advanced to
`pet_identification`; two outbox rows reached `accepted` on their first
attempt with `provider_status_at` populated.

**The queue-routing fix is what made this possible.** Before it, `batch.queue`
never matched a processor on staging and the message would have retried into
the terminal dead-letter queue with no reply and no visible error.

#### Diagnosis worth preserving

After publishing, real messages still produced no webhook for roughly an hour.
Meta's own `messages` field `Test` control was the discriminating experiment:
that request **did** reach the Worker, proving the callback registration,
signature layer, and Worker were all sound, and isolating the fault to how the
real message was being targeted. The chain fired on the first attempt once the
message was started from Meta's "Customer replies" **QR flow**. Future real
inbound tests should always start from that QR.

#### Open defects found and deliberately not fixed here

1. `src/index.ts` returns `503` for `unknown_account`. Meta can throttle an
   endpoint that repeatedly returns `5xx`, so this can become self-inflicted.
   It should return `200` and ignore the event. Outside the Phase E allowed
   change list; needs its own contract.
2. Three duplicate "weosa" WABAs exist in the portfolio; only one holds the
   number. This materially slowed diagnosis.
3. Business-initiated (template) sending is blocked — Meta's "Add payment"
   step is incomplete. User-initiated 24-hour-window replies are unaffected.
4. The permanent access token was pasted into a chat transcript during this
   session and must be regenerated to invalidate it.
5. `/staff` was never opened; §7 matrix, §8 takeover race, and §9 safety and
   appointment smoke remain `NOT RUN`, and §9's clinic-hours and slot
   prerequisites are still absent.
6. **BLOCKING product gap — an owner with no registered pet loops forever.**
   Observed in the real conversation, not inferred: after the safety gate
   cleared, the system asked for the pet's name, the user answered with the
   name, and the identical fixed question was sent again. The model was not
   at fault — `conversations.intake_data` held the correctly extracted
   `pet_name` and `species` for that reply. `resolvePet`
   (`src/intakeExtraction.ts:236`) only ever matches against pets **already
   stored** for the owner; with none stored it returns `needs_clarification`,
   and `src/intakeReply.ts:92` re-sends the fixed pet-identity copy. No
   runtime path creates a pet anywhere in `src/` — there is no
   `insert into public.pets`. Every first-time owner therefore dead-ends.
   The user chose to record this rather than paper over it with a seeded pet
   row, so the loop is still reproducible on staging for whoever fixes it.
   Any fix must decide who a pet record is created for, on whose consent, and
   under which KVKK basis, so it needs its own contract and the applicable
   review gates rather than a quick patch.

#### Changed files in this phase

`docs/staging-runbook.md` (§6, §11, §14 evidence and the new §14.5b defect
list) and this record. No source, migration, or configuration changed after
the queue fix.

### Phase F — `unknown_account` acknowledgement (executed 2026-08-23)

Defect 1 above was fixed, because it is bounded, needs no schema, prompt,
clinical copy, or retention change, and it actively risks Meta throttling
webhook delivery for the whole account while it stands.

- `src/index.ts` now counts `unknown_account` under its own counter and
  acknowledges with HTTP 200 instead of folding it into `failed` and returning
  503. `failed` still returns 503; `manual` and `ignored` are unchanged. The
  new counter appears in the persistence log line so a stale or misconfigured
  `phone_number_id` stays visible rather than silently swallowed.
- `test/index.test.ts`: `unknown_account` added to the 200-outcome table, a
  test pinning the separate counter, and a test proving a genuinely
  unrecognized RPC result still returns 503. Two pre-existing tests asserted
  the old 503 and were updated in place with a comment recording the date and
  reason, so the change is not silently rewritten history.
- `docs/inbound-queue.md`: the outcome list now states the behavior and why.

Verification: `pnpm typecheck` PASS; `pnpm test` PASS (32 files, 1,354 passed,
2 paid eval gates skipped). Not deployed — the live staging Worker still runs
the previous build.

### Proposed next task — pet onboarding (defect 6)

Written here for Codex to lift into its own contract; **not** authorized or
implemented by Task 034.

Problem: `resolvePet` only matches pets already stored for the owner, and no
runtime path creates one, so a first-time owner cannot pass
`pet_identification`. Reproducible on staging right now.

Why it is gated rather than patched: creating a pet record from message
content is a new data-retention path. It decides what personal data VetAI
originates about an identifiable owner, on what consent, and with what
erasure behavior. Under `AGENTS.md` and the Phase C/D precedent that requires
a new contract plus the applicable Opus/KVKK review gate, and
`docs/kvkk-inceleme-paketi.md` must be updated in the same change.

Design questions the contract must close before code:

1. Who may create a pet — only an explicit owner confirmation turn, or the
   extraction alone? An LLM-extracted name silently becoming a stored record
   is the weaker option and should be justified if chosen.
2. What identifies a duplicate: exact normalized name per owner, or does the
   owner get asked when two pets are similar? Today's resolver already fails
   closed on multiple matches, and that behavior should survive.
3. Species is optional in the schema but the extractor often supplies it;
   decide whether it is stored at creation or left null pending confirmation.
4. Erasure: pets cascade from owners today. Confirm that an owner-erasure
   request still removes auto-created pets, and that a pet created in error
   can be removed without breaking `conversations.pet_id`'s `no action` FK.
5. The loop itself is a defect independent of pet creation: even with
   onboarding built, an owner who never supplies a usable name must reach a
   bounded outcome — human handoff — rather than repeating one fixed line
   forever. A bounded-attempt counter needs storage, and
   `PersistedIntakeData` currently fails closed on any unexpected key, so it
   implies a `schema_version` bump and its own migration.

Suggested review gates: Codex for the RPC, call path, and RLS; Claude Opus
read-only for the retention, consent wording, and erasure cascade; human for
the KVKK package text.

Decision: `PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED`. Task 034 remains
`IN_REVIEW`: the transport chain is proven end to end, but defect 6 blocks
every first-time owner, the §7-§9 behavioral gates are unproven, the other
defects above are open, and the external veterinary/legal/KVKK production
gates are untouched. Defect 6 should be triaged before any further live
behavioral testing, because §7's `ai` path and §9's appointment smoke both
run through the pet-identification stage that currently dead-ends.

---

## Task 034 closure record — 2026-08-25

Closed by Claude Opus acting in Codex's role (review, checks, `PROJECT_CONTEXT.md`,
commit) under Maya's explicit delegation, Codex being unavailable. Codex's normal
authority is unchanged; this is a stand-in, not a redefinition of the role.

### What was reviewed

The Phase F working tree, uncommitted at review time:

- `src/index.ts` — `INTAKE_QUEUE_NAMES` / `INTAKE_DEAD_LETTER_QUEUE_NAMES` sets
  replacing the two hardcoded production queue names (the Phase E staging
  defect), the `/privacy` route, and the `unknown_account` outcome now
  answering `503` instead of `200`.
- `src/privacyPage.ts` (new) — static Turkish staging privacy notice, no
  inline script, `default-src 'none'` CSP, `nosniff`, `no-referrer`,
  `GET`-only with a `405 + Allow: GET` for anything else.
- `test/index.test.ts` — pins the `unknown_account` `503`, the `/privacy`
  headers/method handling, and the queue-name sets.
- `docs/inbound-queue.md`, `docs/staging-runbook.md`, `docs/pilot-oncesi-plan.md`.

Review verdict: accepted as written. Two points recorded rather than changed:

1. The `/privacy` page is truthful about the staging pilot but is still **not
   lawyer-approved**, and it states no concrete retention period because none
   has been decided. That is honest disclosure of an open gap, not a defect of
   this task — it stays a controlled-pilot blocker, tracked in
   `docs/pilot-oncesi-plan.md`.
2. `unknown_account` returning `503` deliberately asks Meta to redeliver rather
   than silently dropping a message for an account the staging database does
   not know. It is the correct failure direction for a pilot, and it is pinned
   by test so a future refactor cannot quietly turn it back into a `200`.

### Checks actually run — 2026-08-25

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean, no output |
| Entrypoint tests | `npx vitest run test/index.test.ts` | 83 passed / 1 file |
| Full suite | `npx vitest run` | 1,411 passed, 2 skipped, 33 files |
| Worker build | `npx wrangler deploy --dry-run --outdir <tmp>` | built, 150.16 KiB / 31.51 KiB gzip |

Honest scoping note on the full-suite number: that run happened on a working
tree that **also** contained the Task 035 pet-onboarding preparation (landed in
the same session, committed separately). Task 034 alone was at 1,354 passing at
the end of Phase E; the pet-onboarding files account for the rest. The 83-test
entrypoint run above is the Task-034-only figure.

No staging or production migration was applied, no Worker was deployed, no
secret was created or rotated, and no Meta configuration was changed in the
course of closing this task.

### What Task 034 did and did not establish

Established: migration-history staging, a separate staging Worker with its own
queues/cron/secrets, a real signed Meta webhook → inbound → outbound → status
journey, and all three Task 033 modes (`ai | manual | personal`).

Not established, carried forward rather than quietly dropped:

- **Coexistence is `UNAVAILABLE`**, with sanitized Meta evidence recorded in
  the Phase D/E records. A reviewed staff Cloud API composer therefore remains
  a controlled-pilot blocker, and was correctly not built here.
- **Pet onboarding is blocked** (`PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED`):
  a first-time owner still cannot pass `pet_identification`, because
  `resolvePet` (`src/intakeExtraction.ts:236`) only matches pets that already
  exist and no runtime path creates one. This is defect 6 and is now Task 035
  below.
- The retention period, the lawyer review of `/privacy`, and the KVKK §7–§9
  boxes remain open and belong to humans, not to this task.
