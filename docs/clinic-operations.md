# Clinic profile, hours, and after-hours handoff (Task 031)

Last verified: 2026-08-14.

The migration and rollback-only SQL fixture passed on disposable
`vetai-test` on 2026-08-14 with zero fixture residue. This is not a
production migration record or a veterinary/legal approval.

## What this step does

Task 031 makes each clinic's public contact details and weekly opening hours
tenant-scoped, deterministic configuration, and uses them only to personalize
the existing non-emergency `human_handoff` reply with a truthful clinic name,
phone number, and open/closed statement. It does not add a new reply
category, a booking mode, or any AI-chosen policy: the OpenAI prompt, model,
extraction schema, and safety precedence are unchanged by this task.

Three pieces implement it:

- `supabase/migrations/20260814000100_clinic_operations.sql` adds
  `contact_phone_e164`/`public_address` to `public.clinics`, two new tables
  (`public.clinic_weekly_hours`, `public.clinic_closure_dates`), and
  `public.get_conversation_clinic_operational_context(p_conversation_id,
  p_at)` (see `docs/database-schema.md`).
- `src/clinicOperations.ts` is a native-fetch client that calls that RPC and
  strictly parses the response into a closed
  `ClinicOperationalContextResult` union.
- `src/intakeReply.ts` exports `applyClinicHandoffContext(plan, context)`, a
  pure function that only rewrites an already-planned
  `{ kind: "send", category: "human_handoff" }` reply; `src/intakeConsumer.ts`
  calls it exactly when a turn's reply resolves to `human_handoff`.

## Which clinic data is public operational configuration

`contact_phone_e164`, `public_address`, the weekly opening intervals, and
full-day closure dates are the clinic's own public-facing operational
configuration — the same kind of information a clinic would put on a sign or
a website, not a clinical or personal fact about any owner, pet, or
conversation. Changing this configuration changes future `human_handoff`
replies without touching the AI prompt, because the reply text is built from
the RPC result, never chosen by the model.

## `Europe/Istanbul` and half-open interval semantics

The RPC converts its `p_at timestamptz` input to `Europe/Istanbul` inside
PostgreSQL (a fixed UTC+3 offset; Turkey has not observed DST since 2016) and
compares the local ISO weekday and time against that weekday's row in
`clinic_weekly_hours`. A clinic is open only when the local time falls inside
the half-open interval `[opens_at, closes_at)` — open at the exact opening
instant, already closed at the exact closing instant. A configured clinic
with no `clinic_weekly_hours` row for that weekday is closed for that whole
day, not an error.

## Full-day closure precedence

A matching row in `clinic_closure_dates` for the local calendar date always
forces the clinic closed for that entire day, even during an otherwise-open
weekly interval. Closure dates are checked in the same query as the weekly
interval, so there is no window where the two can disagree.

## Fail-closed generic-copy behavior

`get_conversation_clinic_operational_context` returns `not_found` (unknown
conversation), `unconfigured` (missing name/phone or no weekly-hours row at
all), or `configured`. `src/clinicOperations.ts` additionally fails to a
fourth state, `failed`, on any transport error, non-2xx response, malformed
JSON, wrong row count, unexpected/missing keys, or a value that fails
strict validation (non-canonical E.164 phone, untrimmed or oversized name/
address, a C0 control character, a non-boolean `is_open`). Every one of
`not_found | unconfigured | failed` carries no clinic values, and
`applyClinicHandoffContext` maps all three to the existing, already-reviewed
generic `HUMAN_HANDOFF_TEXT` — the same text a `human_handoff` reply always
used before this task. The optional lookup has a five-second request timeout;
a rejected, timed-out, misconfigured, or unreachable profile loses only the
personalization and falls back to the generic copy.

## The one-interval/no-overnight MVP ceiling

Each clinic may have at most one weekly opening interval per ISO weekday
(`clinic_weekly_hours` is keyed on `(clinic_id, iso_weekday)`) and that
interval may not cross midnight (`opens_at < closes_at` is enforced by a
table constraint). Split shifts (e.g. a lunch closure), partial-day
exceptions, and overnight hours are out of scope for this task and are not
represented by the schema.

## Personalized copy

When the operational context is `configured`, `applyClinicHandoffContext`
replaces the generic handoff text with exactly one of:

```text
Bu talebi bot üzerinden yanıtlayamam. {clinicName} ile {phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.
```

```text
Bu talebi bot üzerinden yanıtlayamam. {clinicName} şu anda kapalı. Acil olmayan konular için çalışma saatleri içinde {phone} numarasından iletişime geçin. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.
```

`{clinicName}` and `{phone}` are the only interpolated values, and both come
only from the strictly validated RPC result. No owner name, pet name,
complaint text, message text, clinic address, provider identifier, or model
output is ever interpolated into any reply. Every other reply
category — `emergency_handoff`, `safety_questions`, `pet_identity`,
`complaint`, `intake_received`, and the appointment categories — and
`{ kind: "none" }` pass through `applyClinicHandoffContext` unchanged. The
emergency copy in particular is never downgraded, delayed, or personalized:
it is not routed through this function at all, because the consumer only
calls it once a turn's reply has already resolved to `human_handoff`.

## Queue wiring: exactly-once, `human_handoff`-only lookup

`src/intakeConsumer.ts` builds the normal plan/base reply first, preserving
all existing safety and appointment precedence unchanged. Only if that
resolved reply is `{ kind: "send", category: "human_handoff" }` does it call
`getConversationClinicOperationalContext(conversationId, env)` and pass the
result to `applyClinicHandoffContext`. This happens identically at each of
the three sites where a reply is finalized (the unsupported-media branch, the
early ceiling/already-`human_handoff`-stage branch, and the main
extraction/planning branch), so the personalization is available regardless
of which path produced the `human_handoff` reply. Ordinary intake, emergency,
safety-question, unsupported-media (when it does not resolve to
`human_handoff`), and appointment-offer/decision turns make no
operational-context request at all, and no OpenAI request, safety decision,
stage transition, work-item priority, or appointment action is affected by
this lookup. See `docs/inbound-queue.md` for the full claim → context →
extract → plan → finalize pipeline this fits into.

## This is controlled configuration, not arbitrary AI behavior

The model never sees clinic hours, never decides whether the clinic is open,
and never chooses this reply's wording. `planIntakeReply` (or the equivalent
media/ceiling logic) decides the reply *category* exactly as before Task 031;
this task only ever substitutes fixed, server-validated text for an already
-decided `human_handoff` category, the same way changing a clinic's phone
number in the database changes future replies without anyone editing a
prompt.

## Not yet built

- No clinic/admin UI exists yet to edit contact details, weekly hours, or
  closure dates; today that requires a direct `service_role` write.
- No appointment is offered to an unregistered/new pet by this task. The
  reviewed appointment engine still refuses to list or hold a slot unless the
  conversation already has a tenant-owned `pet_id` (see
  `docs/appointment-booking-engine.md`); a new-pet request still becomes the
  existing `human_handoff` decision, now possibly personalized with clinic
  contact details.
- Turning that new-pet handoff into an in-bot booking flow needs a separate,
  fully implemented feature with safe pet creation/verification and explicit
  appointment confirmation — it is not part of this task and must not be
  assumed to exist.
- This new Turkish copy is not yet approved for production: it still
  requires the same clinic-veterinarian and Turkish legal/KVKK review as the
  rest of the fixed reply copy in `docs/intake-replies.md`. Passing Codex or
  Claude Opus review is not veterinary or legal approval.
