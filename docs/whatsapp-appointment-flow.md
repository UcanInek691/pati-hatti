# WhatsApp single-slot appointment confirmation flow

**Status: validated only on disposable `vetai-test` on 2026-08-10.** The
migration (`supabase/migrations/20260810000200_whatsapp_appointment_flow.sql`)
applied successfully there, and the rollback-only proof fixture
(`supabase/tests/023_whatsapp_appointment_flow.sql`) returned `PASS` with zero
residue. It has not been applied to production or recorded in production
migration history. TypeScript-side code (`src/appointmentFlow.ts`, its
consumer wiring) has been typechecked and unit tested; no real Meta or OpenAI
call and no production Supabase call has been made.

## Goal

Wire the already-reviewed Task 022 appointment-slot engine
(see [`docs/appointment-booking-engine.md`](appointment-booking-engine.md))
into the existing intake Queue consumer
(see [`docs/inbound-queue.md`](inbound-queue.md)) with the smallest possible
flow: offer the single earliest available slot, ask a fixed `EVET`/`HAYIR`
question, and act on an exact-match reply. The database — not the Worker, not
the LLM — remains the sole authority over whether a slot ends up held or
confirmed.

## The exact single-slot journey

1. A conversation reaches `ready_for_triage` with a matched pet and an
   `appointment_request` intent (as extracted and planned by the existing
   `planIntakeTurn`/`intakeReply` pipeline — this task adds no new intent or
   extraction field).
2. The consumer calls `finalize_appointment_offer_queue_job`, which — in one
   transaction — advances the conversation one step at a time to
   `appointment_offer`, lists the single earliest eligible slot for the
   conversation's own clinic (via the existing, unmodified
   `list_available_appointment_slots`), holds it (via the existing,
   unmodified `hold_appointment_slot`), advances to `appointment_selection`,
   and writes one outbox reply with the held slot's start time.
3. If no eligible slot exists, the same call instead advances straight to
   `human_handoff` and writes the no-slot reply — the owner is never left in
   `appointment_offer` with nothing to answer.
4. Once at `appointment_selection`, the existing single extraction and safety
   pass still runs first. If it remains safe, the raw inbound message is then
   parsed as an appointment decision: exact-match `EVET` confirms, exact-match
   `HAYIR`/`HAYIR`-style negatives decline, and anything else repeats the same
   offer unchanged.
5. `finalize_appointment_decision_queue_job` acts on that decision atomically:
   - `confirm` advances to `appointment_confirmation`, calls the existing,
     unmodified `confirm_appointment_slot` with the exact hold token, advances
     to `completed`, and writes the confirmed reply with the confirmed time.
   - `decline` releases the held slot back to `available`, advances straight
     to `completed`, and writes the fixed declined reply. No confirmed slot is
     ever created on decline.
   - `repeat` makes no database mutation beyond a same-stage state refresh and
     re-sends the identical offer copy for the same held slot.
   - If the hold is missing or has expired by the time a `confirm`/`repeat`
     decision arrives, the conversation instead advances to `human_handoff`
     with a truthful "no longer available" reply — the flow never invents or
     silently re-holds a different slot in place of the one the owner was
     shown.

Everything above happens inside two new RPCs
(`finalize_appointment_offer_queue_job`,
`finalize_appointment_decision_queue_job`); no Task 022 RPC, table, or
migration is modified. Both new RPCs are `security invoker`, `set search_path
= ''`, and granted only to `service_role` (revoked from `public`, `anon`,
`authenticated`), matching every other finalizer in this project.

## Deterministic command grammar

`src/appointmentFlow.ts`'s `parseAppointmentDecision` is a pure function over
raw inbound message text only — never over model-extracted fields, dates, or
ids:

1. Unicode-normalize (`NFKC`), trim, collapse internal whitespace to single
   spaces, and lowercase with Turkish (`tr`) locale rules (so dotted/dotless
   `İ`/`I` behave correctly).
2. An exact match against `evet` returns `confirm`.
3. An exact match against `hayır` or the ASCII-folded `hayir` returns
   `decline`.
4. Anything else — including `"evet lütfen"`, `"kesinlikle evet"`, punctuation,
   emoji, a bare `"tamam"`, or a stray digit — returns `repeat`, never
   `confirm` or `decline`. There is no fuzzy matching, no substring matching,
   and no LLM involved in this decision; the exact fixed grammar is the whole
   contract.

This mirrors the project's existing "AI limited to generation/extraction,
deterministic rules own safety-and-flow-control" boundary
(see `PROJECT_CONTEXT.md`) — the same discipline already applied to safety
signal handling.

## Natural entry into the deterministic flow (Task 038)

After a successful, safety-clear pet/intake confirmation, the system sends the
fixed question `Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?`.
The next
message and that one bounded prior question may let the structured extractor
recognize a natural affirmative or request to see suitable times as
`appointment_request`; direct appointment requests continue to work without
the invitation. Clear refusal, postponement or ambiguity must not enter the
offer path, and a mixed symptom/appointment message keeps the symptom so the
existing safety and planning rules can run first.

Because persisted intake normally keeps a prior non-unknown intent, an
`unknown` extraction is reset to neutral `routine_request` whenever the stored
intent is the action intent `appointment_request`. This prevents a stale
earlier request from opening an offer after the owner declines, defers, sends
an ambiguous message or has messages batched out of the context selector; it
does not classify the owner's wording or bypass the model for positive answers.
Consequently `appointment_request` is intentionally non-sticky across a later
`unknown` turn: a direct request acts on the turn where it is stated, or the
owner can re-express it after intake (including through the fixed invitation).

This changes only how the existing offer flow is reached. The model cannot
invent a day or time, choose a slot, access a booking token or write reply
copy. `planAppointmentAction` and the tenant-scoped database RPC still select
the earliest real future slot. After that slot is shown and held, the grammar
below is deliberately unchanged: only exact normalized raw-text `EVET` or
`HAYIR` may confirm or release that specific hold. Prompt revision
`2026-08-28.1` passed the approved 246-call Luna/Terra synthetic gate on
2026-08-28 with every mandatory safety and appointment metric satisfied.

When safety facts are still unresolved at pet/intake confirmation, the safety
questions retain priority. Once the subsequent answer safely advances
`safety_check → ready_for_triage`, the system sends the same appointment
invitation. Thus both the already-clear and ordinary ask-then-clear paths reach
the proactive question without weakening safety precedence.

## Safety precedence

Safety always outranks the appointment flow, at every stage, including mid
`appointment_selection`. `planAppointmentAction`
(`src/appointmentFlow.ts`) checks the already-computed `safetyDecision` and
`nextStage` from the existing `planIntakeTurn` **before** looking at the
conversation's current stage:

- An `emergency_handoff` or `human_handoff` safety decision, or a planned
  `nextStage` of `human_handoff`, always routes to the existing, unmodified
  human-handoff reply path (`planIntakeReply` / `finalize_intake_queue_job`)
  — never to an appointment RPC, even if the conversation was sitting in
  `appointment_selection` with an active hold waiting only for `EVET`/`HAYIR`.
- Only once safety has cleared does stage routing apply: at
  `appointment_selection`, every message is parsed as a decision; at
  `ready_for_triage` or `appointment_offer`, a matched pet plus an
  `appointment_request` intent triggers an offer; every other combination
  takes the existing intake-reply path unchanged.

No appointment RPC is ever called on a conversation that safety would have
otherwise sent to `human_handoff`.

## Atomic boundaries

Both new RPCs follow the same pattern as the existing
`finalize_intake_queue_job` (see
[`docs/database-schema.md`](database-schema.md)'s "Atomic intake finalization"
section): one transaction composes the already-reviewed one-step primitives
(`advance_conversation_intake`, `list_available_appointment_slots`,
`hold_appointment_slot`, `confirm_appointment_slot`,
`complete_intake_queue_job`) instead of duplicating their logic, so a crash or
partial failure between "advance conversation state," "mutate the slot," and
"write the outbox reply and complete the lease" is impossible — either all of
them happen or none of them do. Concretely:

- Offering a slot, advancing to `appointment_selection`, and writing the offer
  reply happen in the same transaction as the hold itself; the conversation
  can never end up at `appointment_selection` without a genuinely held slot
  (or, symmetrically, at `appointment_offer`/`human_handoff` with a hold that
  isn't reflected in any outbox reply).
- Confirming, advancing to `completed`, and writing the confirmed reply happen
  together; the conversation can never reach `completed` with a slot that
  claims `confirmed` in the reply but is not `confirmed` in
  `appointment_slots`.
- Declining, releasing the slot back to `available`, and writing the declined
  reply happen together; a race where two workers both see the same "declined"
  outcome and both try to release is impossible because the conversation row
  is locked first, exactly as Task 022's own RPCs lock the conversation before
  the slot.
- Every branch completes the same intake Queue lease
  (`complete_intake_queue_job`) inside the same transaction as its own state
  change, so the lease-completion window that `finalize_intake_queue_job`
  already closes for ordinary intake turns is closed identically here — no
  separate HTTP round trip, no window where the lease could complete without
  the matching state change or vice versa.
- If the advisory slot listed in step 3 loses the hold race to a different
  conversation between listing and holding, the whole transaction raises
  instead of silently retrying or picking a different slot — the caller
  (the Queue consumer) sees this as an ordinary retryable failure and a later
  delivery re-lists, re-holds, and re-offers from whatever is genuinely
  available.

## Istanbul rendering

Every user-facing time in this flow is rendered with
`to_char(<timestamptz> at time zone 'Europe/Istanbul', 'DD.MM.YYYY HH24:MI')`
inside the SQL RPCs themselves — never formatted in the Worker, and never
sent to the owner as a raw UTC instant or an unzoned string. This matches
Task 022's own stated boundary (see
[`docs/appointment-booking-engine.md`](appointment-booking-engine.md)'s "Time
and pet snapshot boundaries" section): slots are stored as UTC-aligned
`timestamptz` instants, and only the product time zone rendering at the
point of composing owner-facing copy is new here.

## Truthful hold/confirm semantics

The reply copy never says more than the database has actually done at the
moment it is written, in the same transaction:

- The offer reply says the slot is "temporarily reserved" and that the
  appointment "has not yet been finalized" (*"Bu saat geçici olarak ayrıldı;
  randevu henüz kesinleşmedi."*) — because at that point the slot is only
  `held`, with a 10-minute hold from Task 022's own `hold_appointment_slot`,
  not `confirmed`.
- The confirmed reply is only ever written after `confirm_appointment_slot`
  itself has returned `confirmed` in the same transaction — it is never sent
  speculatively ahead of the actual state change.
- The declined reply is only ever written after the slot has actually been
  released back to `available` (or after confirming there was nothing left to
  release) in the same transaction.
- A `repeat` decision re-sends the identical offer copy for the *same* slot
  and does not extend, refresh, or re-issue the hold — if the hold has
  genuinely expired by the time a repeat/confirm arrives, the flow does not
  pretend it is still active; it routes to human handoff with the
  "no longer available" copy instead.

## Failure and handoff behavior

- **No eligible slot when offering**: advance straight to `human_handoff`
  with *"Şu anda bot üzerinden sunabileceğim uygun randevu saati yok. Lütfen
  kliniğimizi telefonla arayın."* — the owner is told to call, not left
  waiting on a bot that has nothing to offer.
- **Hold missing or expired when a decision arrives** (`confirm` or `repeat`
  with no valid unexpired hold on a still-future slot): advance to
  `human_handoff` with *"Ayırılan randevu saati artık kullanılamıyor. Lütfen
  kliniğimizi telefonla arayın."*
- **An impossible state** (for example a slot already `confirmed` while the
  conversation is still at `appointment_selection`, which normal flow control
  cannot produce) makes the RPC raise rather than return a success row, so
  the transaction rolls back and the Queue consumer retries instead of
  reporting a false outcome.
- **Consumer-side defensive gaps** (a planned pet id of `null` reaching the
  offer/decision branch despite a "matched" pet resolution, which the current
  planner cannot actually produce but the consumer does not trust blindly)
  retry rather than call an appointment RPC with an invalid pet id.
- In every handoff case above, the reply text tells the owner to call the
  clinic directly — consistent with the rest of this project's human-handoff
  copy (see [`docs/database-schema.md`](database-schema.md) and
  `src/intakeReply.ts`'s `HUMAN_HANDOFF_TEXT`) — because automation could not
  safely finish the booking, not because something is being hidden from the
  owner.

## Every omitted appointment feature

Deliberately out of scope for this single-slot MVP, unchanged from Task 022's
own stated scope (see
[`docs/appointment-booking-engine.md`](appointment-booking-engine.md)) and
extended with what this task specifically does not add:

- No menu of multiple slot choices, no free-text date/time requests, no
  WhatsApp interactive buttons/lists — only a plain-text `EVET`/`HAYIR`
  exchange.
- No reschedule or cancel-after-confirmation flow; `HAYIR` before confirmation
  is the only way to not book, and it ends the conversation's appointment
  attempt rather than offering a different slot.
- No calendar UI, veterinarian/room/service assignment, or external calendar
  sync.
- No reminder message before the appointment time.
- No retry-with-a-different-slot loop after a lost hold race or an expired
  hold — every such case routes to human handoff and a phone call, not a
  second automated attempt.
- No new WhatsApp send, Worker route, Env binding, Queue message shape, or
  webhook parsing change — this task only adds two SQL RPCs, one TypeScript
  RPC-client module, and narrow routing inside the existing consumer.
- No production deploy and no real external API call of any kind.

## Staff visibility, not notification

Exactly as already documented for staff work items
(see [`docs/staff-work-items.md`](staff-work-items.md)), nothing in this task
pages, emails, or otherwise pushes a notification to clinic staff. A
conversation that reaches `human_handoff` through this flow (no slot,
expired hold, or a safety signal) becomes visible the same durable way any
other human-handoff conversation already does — staff must actively check
their existing queue to see it. The owner-facing copy in every handoff case
in this document says plainly to call the clinic; automation does not assume
someone is watching a screen at the moment it gives up.

## TypeScript client and consumer wiring

`src/appointmentFlow.ts` exports:

- `parseAppointmentDecision(messageText)` — the pure grammar above.
- `planAppointmentAction(context, plan, messageText)` — the pure safety/stage
  router above, called from `src/intakeConsumer.ts` immediately after the
  existing `planIntakeTurn` call and before the existing
  `planIntakeReply`/`finalize_intake_queue_job` call.
- `finalizeAppointmentOfferQueueJob` / `finalizeAppointmentDecisionQueueJob` —
  native-`fetch` service-role Data API clients for the two new RPCs, following
  the same conventions as every other RPC client in this project
  (`src/appointmentEngine.ts`, `src/conversationState.ts`,
  `src/intakeJobLease.ts`): HTTPS-or-loopback-only transport, strict local
  input validation before any network call, exact-key-count row validation,
  and collapse of any transport failure, non-2xx response, or malformed body
  to `{ kind: "failed" }` — never throws, never logs request or response
  contents.

`src/intakeConsumer.ts`'s `processIntakeQueueMessage` calls
`planAppointmentAction` right after `planIntakeTurn` resolves. An `"offer"`
action calls `finalizeAppointmentOfferQueueJob`; a `"decision"` action calls
`finalizeAppointmentDecisionQueueJob`; a `"none"` action falls through to the
existing, unmodified `planIntakeReply`/`finalize_intake_queue_job` path. The
disposition table below extends the existing one in
[`docs/inbound-queue.md`](inbound-queue.md) without changing any existing row:

| Step               | Outcome                                                              | Disposition |
|--------------------|-----------------------------------------------------------------------|-------------|
| appointment offer   | `offered` / `unavailable` / `already_completed` / `stale_claim`      | `ack`       |
| appointment offer   | `stale_state` / `failed`                                             | `retry`     |
| appointment decision| `confirmed` / `declined` / `repeated` / `stale_hold` / `already_completed` / `stale_claim` | `ack` |
| appointment decision| `stale_state` / `failed`                                             | `retry`     |

Neither new RPC client is ever wired into any path outside this consumer;
`src/appointmentEngine.ts`'s three lower-level RPCs remain unwired everywhere
else, exactly as before this task.

## Verification

Codex reran the full local gate after review: typecheck, 904/904 tests, Worker
dry-run, frozen install, and diff checks passed. The migration applied
successfully to disposable `vetai-test`; its rollback-only fixture returned
`PASS` with every reported `023%` residue count at zero. See the Codex review
record in `CURRENT_TASK.md`. Production remains untouched.
