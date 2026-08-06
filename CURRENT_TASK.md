# Current task — 009 deterministic safety decision gate

Status: `READY`

Primary implementer: Claude Sonnet

Reviewers: Codex, then Claude Opus (read-only safety review)

## Goal

Add one provider-neutral, deterministic gate that converts an already
runtime-validated Task 007 `IntakeExtraction` into a small control-flow
decision. Explicit emergency signals must stop normal automation; unknown
safety facts must require a safety check; human and medical-advice requests
must route to staff.

This task does not call an LLM, generate user-facing medical text, diagnose,
score diseases, select treatments, mutate state, call Supabase, wire the
webhook, send WhatsApp messages, or claim local veterinarian approval.

## Starting context

- Implementation base: `bbf4536` on `main`. A later docs-only commit containing
  this task definition is the expected starting HEAD; worktree is clean.
- Task 007 provides the strict `IntakeExtraction` and eight explicit
  boolean-or-null `reported_safety_signals`.
- Task 008 provides a mocked-and-reviewed OpenAI adapter but it is not wired to
  any runtime flow.
- No deterministic safety decision module exists.
- Codex reviewed the conservative rule basis against Merck Veterinary Manual,
  ASPCA Poison Control, and the American College of Veterinary Surgeons on
  2026-08-06. These external references justify immediate professional care;
  they do not replace approval by VetAI's operating veterinarians.

Before editing, follow `AGENTS.md`, verify these facts, and fill Observed
context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/safetyDecision.ts`.
- New `test/safetyDecision.test.ts`.
- New `docs/safety-decision-gate.md` limited to this gate, its source basis,
  and its unapproved-for-production status.
- Fill the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, prompts, extraction/provider modules,
`Env`, Worker routing, Supabase code or migrations, Wrangler config,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Decision contract

Use only TypeScript/standard JavaScript. Reuse Task 007's exported types. Do
not add a rules engine, classes, configurable thresholds, numeric risk scores,
provider abstractions, or dependencies.

Export a `SafetySignal` union containing exactly the eight Task 007 safety
keys, a deterministic `evaluateSafetyDecision(extraction)` function, and this
closed result union:

- `{ kind: "emergency_handoff", positiveSignals: SafetySignal[] }`
- `{ kind: "human_handoff", reason: "user_requested_human" | "medical_advice_request" }`
- `{ kind: "needs_safety_check", unknownSignals: SafetySignal[] }`
- `{ kind: "continue_intake" }`

Rules, evaluated in this exact priority order:

1. If one or more safety signals are `true`, return `emergency_handoff` with
   every true key in the canonical order below. This overrides all other
   intents and flags.
2. Otherwise, if `user_requested_human === true` or
   `intent === "human_handoff"`, return `human_handoff` with reason
   `user_requested_human`.
3. Otherwise, if `intent === "medical_advice_request"`, return
   `human_handoff` with reason `medical_advice_request`.
4. Otherwise, if one or more safety signals are `null`, return
   `needs_safety_check` with every null key in canonical order. Null means
   unknown, never safe.
5. Only when every safety signal is explicitly `false`, return
   `continue_intake`.

Canonical signal order:

1. `breathing_difficulty`
2. `loss_of_consciousness`
3. `active_seizure`
4. `heavy_bleeding`
5. `major_trauma`
6. `possible_toxin_exposure`
7. `possible_foreign_object`
8. `unable_to_urinate`

Return fresh arrays and never mutate the extraction. Do not inspect complaint,
symptom text, species, pet identity, or `missing_information`; semantic
interpretation belongs to the validated extraction boundary, not this gate.
Do not produce guidance, a reply, a clinic destination, or a time estimate.

## Required tests

- Test each of the eight individual `true` signals returns
  `emergency_handoff`.
- Test multiple true signals preserve canonical order and the returned array
  is fresh.
- Test emergency precedence over human request, medical-advice intent, and
  remaining null signals.
- Test both human-request paths and their precedence over unknown signals.
- Test medical-advice routing and its precedence over unknown signals.
- Test all-null and mixed false/null inputs return every unknown key in
  canonical order.
- Test all-false returns only `continue_intake`.
- Prove unrelated extraction fields cannot change the same safety decision.
- Prove caller input is not mutated.
- Keep every existing test green.

## Documentation requirements

`docs/safety-decision-gate.md` must state:

- this is routing, not diagnosis or medical triage advice;
- `true` stops automation and requires immediate professional/emergency
  handling, `null` requires explicit safety clarification, and only all-false
  can continue;
- the rule basis is limited to the existing eight signals and these reviewed
  sources:
  - Merck Veterinary Manual, "Evaluation and Initial Treatment of Dog and Cat
    Emergencies": https://www.merckvetmanual.com/special-pet-topics/emergencies/evaluation-and-initial-treatment-of-dog-and-cat-emergencies
  - ASPCA, "What to Do if Your Pet Is Poisoned":
    https://www.aspca.org/news/what-do-if-your-pet-poisoned
  - American College of Veterinary Surgeons, "Urinary Obstruction in Dogs":
    https://www.acvs.org/small-animal/urinary-obstruction-in-dogs/
  - American College of Veterinary Surgeons, "Gastrointestinal Foreign
    Bodies": https://www.acvs.org/small-animal/gastrointestinal-foreign-bodies/
- these sources support conservative escalation but are not a substitute for
  clinic-specific veterinarian approval, Turkish emergency-service wording,
  legal/privacy review, or production validation;
- no user-facing response text or runtime wiring exists yet.

Do not copy long source passages, add new medical conditions, or write home
treatment/first-aid instructions.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, install dependencies/plugins, call an LLM, mutate
Supabase, or touch another external service.

## Mandatory review gate

After Sonnet delivers, Codex must inspect and rerun all checks. If Codex passes
the implementation, Claude Opus must then perform a read-only safety review of
the decision ordering, conservative null handling, source claims, and absence
of diagnosis/treatment. The module must not be wired into runtime behavior
until both reviews pass. Clinic veterinarian approval remains a separate
production requirement even after both AI reviews.

## Observed context — Sonnet fills before coding

- Starting HEAD:
- Initial worktree state:
- Relevant code/tests evidence:
- Planned files:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands and exact results:
- Checks not run and why:
- Known limitations:
- Risks for Codex/Opus review:
