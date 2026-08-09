# Deterministic intake reply planner

Last verified: 2026-08-09.

## What this step does

`src/intakeReply.ts` exports one pure, provider-neutral function,
`planIntakeReply(currentStage, result)`, that converts an already-reviewed
`PlanResult` from `planIntakeTurn` (`src/intakeTurn.ts`) into either
`{ kind: "none" }` or `{ kind: "send"; category; text }` using fixed Turkish
copy. It performs no fetch, database call, LLM call, logging, timing,
randomness, or mutation, and returns a fresh object on every call.

It is wired into the Queue consumer (`src/intakeConsumer.ts`), which calls it
once per message with `(context.intakeStage, plan)` — the same raw
`planIntakeTurn` result used for the state transition, before any
poison-fallback substitution — and forwards the result to
`finalize_intake_queue_job` as the reply pair (see "Not yet wired" below and
`docs/database-schema.md`'s "Atomic intake finalization" section). Calling
`planIntakeReply` itself still performs no fetch, database call, LLM call,
logging, timing, randomness, or mutation.

## Why fixed deterministic copy for the MVP

A second LLM call to phrase the reply would be more expensive, harder to
audit, and could invent a diagnosis, a treatment, a medication, or a fact the
user never reported. Because the six reply categories are a closed,
enumerable set, exact fixed Turkish strings are cheaper, reviewable word for
word, and impossible to prompt-inject.

## Closed reply categories and precedence

`IntakeReplyCategory` is `emergency_handoff | human_handoff |
safety_questions | pet_identity | complaint | intake_received`. Rules are
applied in this exact order; the first that matches wins:

1. `currentStage === "completed"` → `{ kind: "none" }`, regardless of `result`.
2. `result.kind === "failed"` → fixed `human_handoff` reply.
3. `safetyDecision.kind === "emergency_handoff"` → fixed `emergency_handoff` reply.
4. `safetyDecision.kind === "human_handoff"` → fixed `human_handoff` reply.
5. `result.nextStage === "human_handoff"` for any other reason → fixed `human_handoff` reply.
6. `safetyDecision.kind === "needs_safety_check"` → `safety_questions` reply built only from its `unknownSignals`, in their existing canonical order.
7. `petResolution.kind === "needs_clarification"` → fixed `pet_identity` reply.
8. Merged `complaint` is `null` and merged `symptoms` is empty → fixed `complaint` reply.
9. Otherwise → fixed `intake_received` reply (a receipt confirmation only; it never claims an appointment was created or that triage was performed, even at an appointment or triage stage).

## Safety and privacy boundaries

- No reply diagnoses, lists possible diseases, or recommends medication,
  dosage, treatment, food/fluid administration, home monitoring, or a waiting
  period.
- The `emergency_handoff` copy directs immediate off-bot professional contact
  and never promises clinic staff are currently available.
- The `human_handoff` copy truthfully says the bot cannot answer, directs the
  user to call, and never claims staff were notified or promises a response.
- `safety_questions` text is built only from the closed
  `Record<SafetySignal, string>` question map selected by `unknownSignals`; it
  never asks about a signal already known true or false. Its fixed prefix tells
  the user not to wait for the bot when a listed condition is present or they
  are unsure.
- The generic receipt confirmation includes a fixed direct-contact instruction
  for any new symptom or worsening condition; it does not promise a later bot
  or staff response.
- No reply ever embeds owner name, pet name, complaint text, symptom text,
  clinic details, IDs, phone number, message text, or any other dynamic
  user/provider data. The only dynamic construction is joining the fixed
  safety questions selected by the closed `unknownSignals` list.
- An empty or unrecognized `unknownSignals` value fails closed to the fixed
  `human_handoff` reply instead of throwing or emitting an empty prompt; this
  is defense in depth behind the already-reviewed, compile-time-exhaustive
  safety gate in `src/safetyDecision.ts`, not a replacement for it.

## Terminal and poison-handoff behavior

A `completed` conversation always yields `none`: inbound persistence starts a
new conversation for later messages, so no further automated reply is owed to
a terminal one. A `result.kind === "failed"` plan — the same poison-snapshot
condition the Queue consumer atomically routes to `human_handoff`
(`docs/inbound-queue.md`) — always yields the fixed human-handoff reply here
too, so a corrupt snapshot cannot cause the reply planner to ask the user to
repeat potentially urgent information forever.

A conversation that reaches `intake_stage = 'human_handoff'` is separately,
durably recorded for clinic staff by Task 020's `public.staff_work_items`
(see [`docs/staff-work-items.md`](staff-work-items.md)), escalated to urgent
if any persisted safety signal was `true`. That is durable visibility in the
database, not a notification — the reply text above is still the only thing
that tells the user what happens next.

## Persisted, not yet sent

A planned reply is now persisted atomically: `src/intakeConsumer.ts` passes
this function's result to `finalizeIntakeQueueJob`
(`src/intakeJobLease.ts`), and `finalize_intake_queue_job` inserts exactly one
row into `outbound_message_outbox` in the same transaction as the
conversation-state advance and lease completion (see
`docs/database-schema.md`'s "Atomic intake finalization" section) — closing
the lost/duplicate-message window that direct sending from the Queue consumer
would have created. Claiming, sending, and delivery-outcome tracking for
those rows is described in [`docs/outbound-delivery.md`](outbound-delivery.md).

## Required approval gate

These Turkish strings, including the emergency and human-handoff copy, remain
unapproved for production until clinic-veterinarian and Turkish legal/privacy
review. Passing Codex or Claude Opus review is not veterinary approval.
