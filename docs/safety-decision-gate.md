# Safety decision gate

`src/safetyDecision.ts` (`evaluateSafetyDecision`) is a deterministic routing
step, not diagnosis or medical triage advice. It converts an already
runtime-validated Task 007 `IntakeExtraction` into one of four control-flow
outcomes. It does not generate user-facing text, does not select a clinic
destination or time estimate, and does not read complaint text, symptoms,
species, pet identity, or `missing_information`.

## Meaning of each outcome

- `emergency_handoff`: one or more of the eight safety signals is explicitly
  `true`. This stops normal automation and requires immediate
  professional/emergency handling. It takes priority over every other
  outcome, including an explicit human request or a medical-advice intent.
- `human_handoff`: the user explicitly asked for a person
  (`user_requested_human` or `intent: "human_handoff"`), or the intent is
  `medical_advice_request`. Evaluated only after the emergency check.
- `needs_safety_check`: no signal is `true`, but one or more of the eight
  signals is `null` (unknown). `null` is never treated as safe — it requires
  explicit clarification before intake can continue.
- `continue_intake`: returned only when every one of the eight safety signals
  is explicitly `false`.

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

Unapproved for production. No user-facing response text or runtime wiring
exists yet — this module is not called from the Worker, webhook, or any
provider adapter. It must pass Codex's implementation review and Claude
Opus's read-only safety review, and still requires separate clinic
veterinarian approval, before any wiring work begins.
