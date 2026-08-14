# Current task — 031 Clinic profile, hours, and after-hours handoff

Status: `COMPLETE`

Owner: Codex

## Goal

Make clinic contact/hours behavior tenant-scoped, deterministic, and changeable
without modifying the AI prompt:

1. store a clinic's public phone/address plus one weekly opening interval per
   day and optional full-day closure dates;
2. resolve `open | closed | unconfigured` for the conversation's own clinic
   in `Europe/Istanbul`; and
3. personalize only the existing non-emergency `human_handoff` reply with the
   configured clinic name/phone and truthful open/closed wording.

The AI still only extracts facts and intent. It must not choose operating
policy, claim a clinic is open, create a pet, or book an appointment.

## Scope

Allowed changes:

- `supabase/migrations/20260814000100_clinic_operations.sql` (new)
- `supabase/tests/031_clinic_operations.sql` (new, rollback-only)
- `src/clinicOperations.ts` (new)
- `src/intakeReply.ts`
- `src/intakeConsumer.ts`
- `test/clinicOperations.test.ts` (new)
- `test/intakeReply.test.ts`
- `test/intakeConsumer.test.ts`
- `docs/clinic-operations.md` (new)
- `docs/database-schema.md`
- `docs/ai-behavior-and-safety.md`
- `docs/inbound-queue.md`
- `docs/product-roadmap.md` — Task 031 status only
- `CURRENT_TASK.md` — implementer fills only **Observed context** and
  **Delivery record**

Do not change:

- the OpenAI prompt/version, model, extraction schema/parser, eval corpora,
  safety-signal set, deterministic safety precedence, or Luna selection;
- pet creation, pet association, appointment tables/RPCs/behavior/copy,
  staff-work-item behavior, outbound delivery, Queue message shape/bindings,
  Cron, webhook verification/limits, environment bindings, dependencies, or
  lockfile;
- the existing emergency, safety-question, unsupported-media, appointment, or
  generic fallback copy;
- production resources, secrets, deployments, or external service state.

Do not add a generic policy framework, JSON settings bag, dormant
`appointment_offer` option, notification, map/geocoding integration,
split-shift editor, overnight interval, partial-day exception, holiday API, or
admin UI.

## Verified starting evidence

- Task 030 and its fresh `2026-08-14.1` live evidence are committed at
  `b301d9b` and `499a079`; the worktree was clean before this contract.
- `public.clinics` currently stores only `id`, `name`, and timestamps.
  Authenticated clinic staff have same-tenant read-only access; only
  `service_role` may mutate clinic rows.
- There is no clinic-hours table, closure table, operational-context RPC, or
  runtime open/closed decision.
- `planIntakeReply` returns closed fixed copy. The Queue consumer obtains a
  tenant-scoped `conversationId` and already finalizes the resulting reply
  atomically through the reviewed outbox path.
- New/unregistered-pet requests currently become the existing
  `human_handoff` decision. The reviewed appointment engine refuses to list or
  hold a slot unless the conversation already has a tenant-owned `pet_id`.
  Therefore this task must not pretend that a new-pet appointment mode exists.
- The current generic handoff copy is the safe fallback when contact
  configuration is absent, malformed, or unavailable.

## Required behavior

### 1. Database profile and schedule

The migration must:

- add nullable `contact_phone_e164 text` and `public_address text` columns to
  `public.clinics`;
- constrain non-null phone values to canonical E.164
  (`^\+[1-9]\d{1,14}$`);
- constrain non-null addresses to trimmed, non-empty text of at most 500
  characters;
- create `public.clinic_weekly_hours` with exactly:
  `clinic_id uuid`, `iso_weekday smallint`, `opens_at time without time
  zone`, `closes_at time without time zone`, and timestamps;
- use `(clinic_id, iso_weekday)` as the primary key, restrict weekdays to
  1..7, require `opens_at < closes_at`, and cascade clinic erasure;
- create `public.clinic_closure_dates` with `clinic_id uuid`,
  `closed_on date`, and `created_at`; use `(clinic_id, closed_on)` as the
  primary key and cascade clinic erasure;
- enable RLS on both new tables, remove default/public/anon/authenticated
  privileges, grant authenticated users read-only access through one
  same-clinic `vetai_private.is_clinic_staff(clinic_id)` SELECT policy per
  table, and grant `service_role` full table access;
- alter default table privileges only if an existing repository pattern
  requires it; do not broaden any role.

MVP ceiling: one non-overnight interval per weekday and full-day closures only.
Do not build split shifts or partial-day exceptions.

### 2. Tenant-safe operational-context RPC

Create:

`public.get_conversation_clinic_operational_context(
  p_conversation_id uuid,
  p_at timestamptz default pg_catalog.now()
)`

It must be `security invoker`, `stable`, `set search_path = ''`, executable
only by `service_role`, and return exactly one row with:

- `result text`: `configured | unconfigured | not_found`;
- `clinic_name text`;
- `contact_phone_e164 text`;
- `public_address text`;
- `is_open boolean`.

Rules:

1. Null/invalid required input raises before reading data.
2. Resolve `clinic_id` only through the exact conversation row; the caller
   never supplies a clinic ID.
3. Missing conversation returns `not_found` and four null payload fields.
4. A profile is `configured` only when clinic name and phone are valid and at
   least one weekly-hours row exists. Otherwise return `unconfigured` with
   four null payload fields.
5. Convert `p_at` to `Europe/Istanbul` inside PostgreSQL. `is_open=true`
   only when the local ISO weekday/time falls inside that day's half-open
   interval `[opens_at, closes_at)` and there is no matching full-day closure.
6. A configured clinic with no interval for that weekday is closed.
7. Never return another tenant's clinic data.

Do not use dynamic SQL or `SECURITY DEFINER`.

### 3. Native-fetch client and strict response parser

`src/clinicOperations.ts` must follow the existing native-fetch
service-role client rules:

- HTTPS or loopback HTTP only; no dependency and no logging;
- call only the fixed RPC above with `p_conversation_id`; runtime uses the
  RPC's server-side default clock;
- fail closed on missing configuration, network/non-2xx/JSON errors, arrays of
  other than one row, non-plain rows, extra/missing keys, unknown results, or
  incoherent nullability;
- `not_found | unconfigured | failed` carry no clinic values;
- `configured` requires a trimmed clinic name of 1..120 code points with no
  C0 control characters, canonical E.164 phone, null or trimmed address of
  1..500 code points with no C0 controls, and boolean `isOpen`;
- return fresh closed-union objects and never expose response/provider bodies.

### 4. Pure clinic-aware handoff reply

Add one pure function in `src/intakeReply.ts` that accepts an existing
`IntakeReplyPlan` plus the operational-context result:

- it may change only `{ kind: "send", category: "human_handoff" }`;
- emergency, safety, media, appointment, other categories, and `none` return
  behaviorally identical fresh values;
- `unconfigured | not_found | failed` preserve the existing generic
  `HUMAN_HANDOFF_TEXT`;
- configured/open uses exactly:

  `Bu talebi bot üzerinden yanıtlayamam. {clinicName} ile {phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`

- configured/closed uses exactly:

  `Bu talebi bot üzerinden yanıtlayamam. {clinicName} şu anda kapalı. Acil olmayan konular için çalışma saatleri içinde {phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`

Only validated clinic configuration may be interpolated. Never interpolate
owner, pet, complaint, message, address, provider, or model data.

### 5. Queue wiring

In `src/intakeConsumer.ts`:

1. Build the existing plan/base reply first, preserving all safety and
   appointment precedence.
2. Only when the base reply is `human_handoff`, call the operational-context
   client and pass its closed result to the pure clinic-aware reply function.
3. Operational-context failure or unconfigured data must fall back to the
   existing generic handoff reply and continue finalization; it must not create
   a retry/poison loop.
4. Persist the selected reply through the existing atomic finalizer/outbox.
5. Emergency copy must never be downgraded or personalized.
6. No OpenAI request, prompt, safety decision, stage transition, work-item
   priority, or appointment action may change.

The new lookup is allowed only on turns whose already-planned reply category is
`human_handoff`; ordinary intake, emergency, media, safety-question, and
appointment paths must make no operational-context request.

## Required tests

### SQL rollback fixture

The rollback-only SQL test must prove:

- phone/address/schedule/closure constraints;
- open inside `[opens_at, closes_at)`, closed exactly at `closes_at`, closed
  before opening, closed on an unscheduled weekday, and closure-date override;
- `Europe/Istanbul` evaluation with fixed `timestamptz` inputs;
- configured, unconfigured, and not_found null coherence;
- two conversations in different clinics never return one another's profile;
- service-role success, anon/authenticated RPC denial, authenticated same-clinic
  SELECT only, authenticated write denial, cross-clinic SELECT denial;
- clinic erasure cascades both schedule tables;
- zero fixture residue after rollback.

Static function-body regex is not a substitute for the behavioral time cases.

### TypeScript tests

Cover:

- every accepted and rejected RPC response shape and transport/config failure;
- C0/length/E.164 validation and no logging;
- pure reply behavior for open, closed, every fallback result, all untouched
  categories, fresh objects, determinism, and non-mutation;
- consumer open/closed personalization, fallback on client failure and
  unconfigured profile, exactly one lookup only for `human_handoff`, no lookup
  for emergency/ordinary/media/appointment paths, unchanged ack/retry results,
  and no extra OpenAI call.

## Documentation

`docs/clinic-operations.md` must explain:

- which clinic data is public operational configuration;
- `Europe/Istanbul` and half-open interval semantics;
- full-day closure precedence;
- fail-closed generic-copy behavior;
- the one-interval/no-overnight MVP ceiling;
- profile changes affect future handoff replies without prompt edits;
- this is controlled configuration, not arbitrary AI behavior.

Also state plainly:

- no clinic/admin edit UI exists yet;
- no appointment is offered to an unregistered pet;
- changing new-pet handoff into booking needs a separate implemented flow with
  safe pet creation/verification and explicit appointment confirmation;
- the new Turkish copy still requires clinic-veterinarian and Turkish
  legal/KVKK approval before production.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Migration apply and `supabase/tests/031_clinic_operations.sql` are
`NOT RUN` for Sonnet. Codex applies/tests them only on disposable
`vetai-test` after review.

Do not run either paid OpenAI eval: this task does not change the prompt,
model, extraction contract, or model context.

No commit, push, deploy, database mutation, real service call, plugin
installation, or external resource change is authorized for the implementer.

## Review gates

1. Codex reviews the complete migration/RLS/RPC/client/Queue path, runs local
   checks, and validates the migration plus rollback fixture on disposable
   `vetai-test`.
2. Claude Opus performs one read-only review of tenant isolation, hours/time
   semantics, emergency precedence, and truthful Turkish copy.
3. Codex applies only verified targeted fixes, updates `PROJECT_CONTEXT.md`,
   and commits after all gates pass.
4. Veterinarian and Turkish legal/KVKK review remain external production gates.

## Observed context

- Starting worktree matched "Verified starting evidence": Task 030/029
  evidence committed at `b301d9b`/`499a079`; `public.clinics` had only `id`,
  `name`, timestamps; no clinic-hours/closure table, no operational-context
  RPC; `planIntakeReply` returned closed fixed copy; the Queue consumer
  already obtained a tenant-scoped `conversationId` and finalized replies
  atomically through the reviewed outbox path (`finalize_intake_queue_job`).
- `supabase/migrations/20260814000100_clinic_operations.sql` was already
  present untracked in the worktree at session start (170 lines); it was
  read and checked against every rule in "Required behavior §1-2" (column
  types/constraints, `(clinic_id, iso_weekday)` / `(clinic_id, closed_on)`
  primary keys, `opens_at < closes_at`, RLS + `vetai_private.is_clinic_staff`
  read policy, `service_role`-only writes, `security invoker` / `stable` /
  `set search_path = ''` RPC, no `SECURITY DEFINER`, no dynamic SQL) but was
  **not executed against any database** — no `supabase db` command, no SQL
  client, no migration apply was run this session.
- `supabase/tests/031_clinic_operations.sql` was already present untracked
  and was **not executed** against any database (disposable `vetai-test` or
  otherwise) this session.
- The three Queue-consumer reply-finalization sites in
  `src/intakeConsumer.ts` (unsupported-media branch, early
  ceiling/already-`human_handoff`-stage branch, main extraction/planning
  branch) were located and confirmed structurally distinct from the
  appointment-offer/appointment-decision branches, which never call
  `finalize_intake_queue_job` and are therefore unaffected by this task.

## Delivery record

Implemented by Claude Sonnet, 2026-08-14.

**Files added** (all within declared scope): `src/clinicOperations.ts`,
`test/clinicOperations.test.ts`, `docs/clinic-operations.md`.
`supabase/migrations/20260814000100_clinic_operations.sql` and
`supabase/tests/031_clinic_operations.sql` were present in the worktree and
reviewed for contract compliance but not modified, applied, or executed.

**Files changed** (all within declared scope): `src/intakeReply.ts` (added
pure `applyClinicHandoffContext`), `src/intakeConsumer.ts` (wired the
operational-context lookup into all three finalize sites via a
`personalizeHandoffReply` helper, gated on the resolved reply already being
`{ kind: "send", category: "human_handoff" }`), `test/intakeReply.test.ts`
(added `applyClinicHandoffContext` coverage: open/closed/every fallback
result, all 9 untouched categories return fresh-but-equal plans, purity/
determinism/no-address-leak), `test/intakeConsumer.test.ts` (added clinic
route plumbing, a `clinicRow` fixture, fixed 10 pre-existing tests whose
fetch-call indices shifted because of the new clinic RPC call, and added a
dedicated `describe` block covering open/closed personalization exact text,
fallback to the generic handoff text on RPC failure/`unconfigured`/
`not_found`, zero clinic calls for non-`human_handoff` and `emergency_handoff`
replies, and personalization at both the ceiling/early-branch and
unsupported-media sites), `docs/database-schema.md` (new "Clinic operational
profile and hours" section), `docs/ai-behavior-and-safety.md` (new "Clinic
contact/hours personalization of `human_handoff`" section), `docs/inbound-queue.md`
(new "Clinic personalization of `human_handoff` replies" section),
`docs/product-roadmap.md` (Task 031 status paragraph only, Turkish, matching
the existing Task 029/030 status-paragraph convention).

**Verification run this session** (see command list under "Required
verification"):

- `pnpm install --frozen-lockfile` — already up to date, exit 0.
- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm test` (vitest) — 31/31 test files, 1262 passed, 2 pre-existing
  skips, 0 failed.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — bundled
  successfully (Total Upload 115.21 KiB / gzip 24.29 KiB), listed only the
  three pre-existing bindings, exited on `--dry-run` without deploying.
- `git diff --check` — exit 0, no whitespace errors (only CRLF/LF
  line-ending advisories, not check failures).
- `git status --porcelain` after all edits shows only files inside the
  declared scope list (8 modified, 5 new); nothing outside scope was
  touched; nothing was staged or committed.

**Explicitly not run this session**, per contract: migration apply,
`supabase/tests/031_clinic_operations.sql`, any SQL/database command, either
paid OpenAI eval, and any commit/push/deploy/plugin-install/external-resource
change. These remain for the Codex review gate on disposable `vetai-test`.

## Codex review record

Reviewed by Codex on 2026-08-14. Decision: `PASS_FOR_OPUS`; the task remains
`IN_REVIEW` until the required read-only Claude Opus gate completes.

Codex traced all three `finalize_intake_queue_job` reply sites and confirmed
that the operational-context RPC is called exactly once only after the
resolved reply is `human_handoff`. Emergency, ordinary intake, normal media,
and appointment paths do not perform this lookup. The existing deterministic
safety decision and atomic outbox finalization remain unchanged.

Targeted fixes applied during review:

- hardened `src/clinicOperations.ts` to reject non-plain rows, symbol/
  non-enumerable extra keys, throwing accessors, and truly absent runtime
  bindings without throwing;
- bounded the optional operational-context request with a five-second native
  `AbortSignal` timeout so a stalled personalization lookup falls back rather
  than consuming the intake lease indefinitely;
- made the database RPC treat untrimmed, over-120-character, or C0-control
  clinic names as `unconfigured`, matching the client trust boundary;
- extended unit/SQL regression coverage for those cases and for null
  `p_at`; and
- corrected migration/test/documentation validation markers after real
  disposable-project execution.

Disposable database evidence: Codex applied
`20260814000100_clinic_operations.sql` to `vetai-test`, then ran
`supabase/tests/031_clinic_operations.sql`. The fixture returned `PASS` with
`remaining_test_clinics=0`, `remaining_test_users=0`,
`remaining_test_hours=0`, and `remaining_test_closures=0`. No production
database was touched.

Final local verification after fixes:

- `pnpm install --frozen-lockfile` — PASS, already up to date;
- `pnpm typecheck` — PASS;
- `pnpm test` — PASS, 31/31 files, 1267 passed, 2 opt-in live evals skipped;
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — PASS,
  dry-run only, existing bindings unchanged;
- `git diff --check` — PASS (line-ending advisories only).

Neither paid OpenAI eval was run because Task 031 changes no prompt, model,
extraction schema, or model context. No commit, push, production deploy, or
production database mutation has occurred. Claude Opus should now perform the
contract's single read-only review of tenant isolation, Istanbul time/hour
semantics, emergency precedence, strict interpolation, and truthful Turkish
copy.

## Claude Opus review and final closure

Claude Opus completed the required read-only review on 2026-08-14 and returned
`PASS` with no blocking finding. It independently confirmed tenant derivation,
RLS/grants/cascades, Istanbul half-open interval semantics, closure precedence,
strict client parsing, three-site `human_handoff`-only wiring, emergency
precedence, fixed Turkish copy, and the absence of address/conversation-data
interpolation.

Codex closed Opus's optional address-validation finding in the same task by
adding the database-side control-character prohibition already enforced by
the client. The SQL fixture now also proves an exact `opens_at` instant,
control-character address rejection, and untrimmed/overlong/control-character
clinic names. The updated fixture passed on disposable `vetai-test` with
`PASS 0/0/0/0`. Final typecheck, all 1,267 normal tests, Worker dry-run, and
`git diff --check` passed again. The remaining veterinary and Turkish
legal/KVKK approvals are external production gates, not incomplete software
review work for Task 031.
