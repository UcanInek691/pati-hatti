# Current task — 031 Clinic profile, hours, and after-hours handoff

Status: `READY`

Owner: Claude Sonnet

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

To be filled by the implementer from repository evidence.

## Delivery record

To be filled by the implementer.
