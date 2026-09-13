# Safety decision gate

`src/safetyDecision.ts` (`evaluateSafetyDecision`) is a deterministic routing
step, not diagnosis or medical triage advice. It converts an already
runtime-validated Task 007 `IntakeExtraction` into one of four control-flow
outcomes. It does not generate user-facing text, does not select a clinic
destination or time estimate, and does not read complaint text, symptoms,
species, pet identity, or `missing_information`.

## Meaning of each outcome

Five-step precedence, checked in this exact order (Task 062 moved unknown-signal
triage ahead of the medical-advice handoff — see
`docs/olaylar/2026-09-13-triyaj-oncesi-devir.md`):

1. `emergency_handoff`: one or more of the eight safety signals is explicitly
   `true`. This stops normal automation and requires immediate
   professional/emergency handling. It takes priority over every other
   outcome, including an explicit human request or a medical-advice intent.
2. `human_handoff` (`reason: "user_requested_human"`): the user explicitly
   asked for a person (`user_requested_human` or `intent: "human_handoff"`).
   Evaluated only after the emergency check; not deferred by unknown signals.
3. `needs_safety_check`: no signal is `true`, but one or more of the eight
   signals is `null` (unknown). `null` is never treated as safe — it requires
   explicit clarification before intake can continue. This includes an
   `intent: "medical_advice_request"` turn: unresolved safety facts are asked
   about before the medical-advice request is handed to staff.
4. `human_handoff` (`reason: "medical_advice_request"`): the intent is
   `medical_advice_request` and all eight signals are now explicitly `false`.
   Reached only once step 3 no longer applies.
5. `continue_intake`: returned only when every one of the eight safety signals
   is explicitly `false` and the intent is not `medical_advice_request`.

## Rule basis

The eight signals and the conservative "true stops everything, null is never
safe" handling are limited to what Task 007 already extracts. Codex reviewed
this conservative posture against the following sources on 2026-08-06:

- Merck Veterinary Manual, "Evaluation and Initial Treatment of Dog and Cat
  Emergencies":
  https://www.merckvetmanual.com/special-pet-topics/emergencies/evaluation-and-initial-treatment-of-dog-and-cat-emergencies
- ASPCA, "What to Do if Your Pet Is Poisoned":
  https://www.aspca.org/news/what-do-if-your-pet-poisoned
- American College of Veterinary Surgeons, "Urinary Obstruction in Dogs":
  https://www.acvs.org/small-animal/urinary-obstruction-in-dogs/
- American College of Veterinary Surgeons, "Gastrointestinal Foreign Bodies":
  https://www.acvs.org/small-animal/gastrointestinal-foreign-bodies/

These sources support escalating conservatively on breathing difficulty, loss
of consciousness, active seizure, heavy bleeding, major trauma, possible toxin
exposure, possible foreign object, and inability to urinate. They do not
substitute for clinic-specific veterinarian approval, Turkish emergency-service
wording, legal/privacy review, or production validation.

## Status

Wired into the real intake path: `planIntakeTurn` (`src/intakeTurn.ts`) calls
`evaluateSafetyDecision` on every turn, and the Queue consumer
(`src/intakeConsumer.ts`) turns its outcome into the stage transition and
outbound reply category (`safety_questions`, `emergency_handoff`, or
`human_handoff`). This is not the same as being live for real owners: no
staging/production deploy or real WhatsApp canary has been authorized (Task
062 explicitly withholds that), and the exact Turkish safety-copy wording
still requires clinic veterinarian and Turkish legal/privacy approval before
activation. Activating real traffic is a separate, explicitly owner-approved
step — see the current task's "Mandatory review and activation boundary".
