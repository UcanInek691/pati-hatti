# Current task — 014 deterministically plan one intake turn

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewers: Codex, then Claude Opus (read-only safety/architecture review)

## Goal

Add one pure, provider-neutral planner that combines an already-validated
current-turn extraction with the conversation's persisted intake snapshot,
resolves the pet only against the tenant-scoped context, evaluates the existing
deterministic safety gate, and chooses a database-valid next intake stage.

This creates the missing deterministic boundary needed by a later Queue
consumer. It does not add a Queue consumer, call an LLM, access Supabase,
generate/send a WhatsApp response, create a Queue, deploy, or change any
existing runtime wiring.

## Starting context

- Starting HEAD: `390832a` on `main`; worktree is clean.
- `ConversationIntakeContext` supplies the current stage/version, selected pet,
  the owner's tenant-scoped pets, and an opaque `intakeData` JSON object.
- `IntakeExtraction` is the strict, already-validated current-turn model output.
- `resolvePet` performs exact normalized matching without trusting model IDs.
- `evaluateSafetyDecision` owns the reviewed emergency/human/unknown/continue
  priority and must be reused unchanged.
- The database accepts the same stage or exactly one forward step in the fixed
  intake graph; any non-terminal stage may jump to `human_handoff`.
- Task 013 can later commit the planner's state update and lease completion
  atomically, but it is not wired in this task.

Before editing, follow `AGENTS.md`, verify these facts from repository evidence,
and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/intakeTurn.ts`.
- New `test/intakeTurn.test.ts`.
- New `docs/intake-turn-planning.md`.
- Fill the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, migrations, `Env`, Worker routing,
`wrangler.toml`, Queue producer/lease/finalization behavior, conversation RPCs,
the extraction parser/prompt/provider adapter, pet resolver, safety gate,
existing tests, README, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Persisted snapshot contract

Export a `PersistedIntakeData` type with exactly the validated extraction fields
plus `schema_version: 1`. Keep the existing snake_case field names so the
trusted extraction can be stored without a second parallel vocabulary:

- `schema_version`;
- `intent`;
- `pet_name`;
- `species`;
- `complaint`;
- `symptoms`;
- `reported_safety_signals`;
- `missing_information`;
- `user_requested_human`.

Treat `context.intakeData` as untrusted persisted JSON. Accept only:

1. an exact plain empty object, representing a conversation not planned yet; or
2. an exact plain `PersistedIntakeData` object whose extraction portion passes
   the existing `parseIntakeExtraction` boundary.

Reject arrays, exotic prototypes, accessors/proxies that throw, symbol or extra
keys, missing keys, unknown schema versions, and malformed nested data. Return a
closed failure result; do not throw or repair corrupt persisted state.

Never mutate or return a nested reference from the context, extraction, or pet
list. The successful snapshot and every nested object/array must be fresh.

## Deterministic merge contract

Merge a validated current extraction into the accepted snapshot as follows:

- Start an empty snapshot with `intent: "unknown"`, nullable text as `null`,
  empty arrays, all eight safety signals as `null`, and
  `user_requested_human: false`.
- A non-`unknown` current intent replaces the stored intent; current `unknown`
  preserves a previous non-`unknown` intent.
- Non-null current `pet_name`, `species`, and `complaint` replace stored values;
  null never erases a previously explicit value.
- Symptoms are an exact-string ordered union. Existing order is retained, new
  unique values are appended, and only the newest 20 unique values are kept.
  This is a bounded working snapshot, not deletion from message history.
- For each safety signal: stored `true` is sticky; otherwise a current boolean
  replaces stored `false`/`null`, while current `null` preserves the stored
  value. Thus missing current-turn facts never turn known danger into safety.
- `missing_information` is replaced by a fresh copy of the current turn's list;
  it is advisory and must not decide safety or stage progression.
- `user_requested_human` is sticky with logical OR.

Do not invent fields, normalize or fuzzy-match clinical text, infer missing
facts, diagnose, or calculate medical priority.

## Pet-selection contract

- Never accept an ID from extraction or persisted intake data.
- If `context.petId` is non-null, it must identify exactly one entry in
  `context.pets`; otherwise fail closed.
- An already-selected context pet remains authoritative. No current or stored
  name may silently switch it. If the current extraction explicitly names a
  pet and exact resolution does not select that same pet, report
  `needs_clarification` while retaining the selected ID.
- If no pet is selected, reuse `resolvePet` over the merged extraction and the
  context pets. Preserve its exact-match/single-pet behavior.

## Planner API and closed result

Export one pure function:

`planIntakeTurn(context: ConversationIntakeContext, extraction: IntakeExtraction)`

Return only:

- `{ kind: "planned", nextStage, petId, intakeData, petResolution,
     safetyDecision }`; or
- `{ kind: "failed" }`.

Use the existing `IntakeStage`, `PetResolution`, and `SafetyDecision` types
rather than copying their unions. `intakeData` is the fresh merged
`PersistedIntakeData`. `petResolution` is `matched` or `needs_clarification`;
when an existing pet is retained, a matched result must contain that ID.

Evaluate safety by passing the merged extraction fields through the existing
`evaluateSafetyDecision`. Do not reimplement or reorder the gate.

Choose `nextStage` with this exact precedence:

1. If the current stage is `completed`, keep `completed`.
2. If the safety decision is `emergency_handoff` or `human_handoff`, choose
   `human_handoff` (or keep it when already there).
3. If the current stage is `human_handoff`, keep `human_handoff`.
4. At `pet_identification`, advance to `complaint_collection` only when pet
   resolution is `matched`; otherwise keep `pet_identification`.
5. At `complaint_collection`, advance to `safety_check` only when the merged
   complaint is non-null or merged symptoms are non-empty; otherwise keep
   `complaint_collection`.
6. At `safety_check`, advance to `ready_for_triage` only for
   `continue_intake`; `needs_safety_check` keeps `safety_check`.
7. At `ready_for_triage` and all three appointment stages, keep the current
   stage. Later tasks own triage and appointment progression.

The planner must never skip a normal stage, move backward, or progress an
appointment. The same-stage result is intentional: it lets a later atomic
finalizer persist newly gathered data while completing that message's lease.

## Required tests

Use table-driven tests where it keeps the suite small. Cover at least:

- exact empty/snapshot acceptance and rejection of every trust-boundary class
  above, including thrown proxy input and symbol-keyed extras;
- every merge rule, the 20-symptom newest-value bound, fresh nested references,
  frozen-input non-mutation, and deterministic repeat output;
- no selected pet, single-pet fallback, exact-name match, ambiguous/fuzzy/no
  match, valid retained pet, missing retained ID, and an explicit conflicting
  pet name that cannot switch the selected pet;
- emergency and human-handoff precedence from every representative stage;
- completed/handoff terminal retention;
- same-stage and one-step behavior for pet identification, complaint
  collection, safety check, ready-for-triage, and appointment stages;
- unknown safety signals never reaching `ready_for_triage`, explicit false
  signals reaching it, and a stored true signal remaining an emergency when
  the current extraction reports null or false;
- no diagnosis, medication, response text, database access, logging, network
  call, or input mutation.

Do not duplicate tests already proving the internals of
`parseIntakeExtraction`, `resolvePet`, or `evaluateSafetyDecision`; prove only
their composition and the new planner behavior.

## Documentation requirements

Document:

- the snapshot schema and deterministic merge rules;
- that it is a bounded working intake snapshot, while persisted messages remain
  the conversation record;
- stage-decision precedence and why appointment progression is intentionally
  absent;
- pet-ID trust and conflict behavior;
- that the planner produces data for Task 013 but performs no persistence,
  lease action, LLM call, triage, response generation, or external effect;
- that the module is not wired into runtime and is not production approval.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, call an LLM, create a Queue, mutate Supabase, or
touch another external service.

## Mandatory review gate

After Sonnet delivers, Codex reviews the diff/call paths and reruns all checks.
If Codex passes it, Claude Opus performs a read-only review focused on merge
safety, sticky emergency facts, pet identity, stage precedence, and fail-closed
persisted-state parsing before this task becomes complete.

## Observed context — Sonnet fills before coding

- Starting HEAD: `390832a`, matching the task's stated starting HEAD; worktree
  clean at start (repo ownership metadata mismatch under Windows required
  `git config --global --add safe.directory`-style workarounds for `git`
  commands, so verification below uses non-git evidence only where noted).
- Initial worktree state: no local modifications; `src/intakeTurn.ts`,
  `test/intakeTurn.test.ts`, and `docs/intake-turn-planning.md` did not exist.
- Relevant code/tests/migration evidence: `src/conversationState.ts` defines
  `ConversationIntakeContext`, `IntakePet`, and the 9-value `IntakeStage`
  union; `src/intakeExtraction.ts` defines `IntakeExtraction`,
  `ReportedSafetySignals`, `PetResolution`, `parseIntakeExtraction`, and
  `resolvePet` (exact-normalized match, single-pet fallback, never trusts a
  model ID); `src/safetyDecision.ts` defines `SafetyDecision` and
  `evaluateSafetyDecision` with fixed emergency > human/medical-advice >
  unknown-signal > continue precedence. `PersistedIntakeData`'s 8
  non-schema-version fields are structurally identical to `IntakeExtraction`,
  so `resolvePet`/`evaluateSafetyDecision` can be called directly on a merged
  snapshot value.
- Planned files: `src/intakeTurn.ts`, `test/intakeTurn.test.ts`,
  `docs/intake-turn-planning.md`, plus this file's Observed context/Delivery
  record sections — matching the Allowed changes list exactly.
- Conflicts or blockers: none found; repository evidence matched the task's
  starting-context claims.

## Delivery record — Sonnet fills after coding

- Changed files: new `src/intakeTurn.ts` (`PersistedIntakeData` type,
  `planIntakeTurn`), new `test/intakeTurn.test.ts` (52 tests), new
  `docs/intake-turn-planning.md`; this file's Observed context/Delivery
  record sections. No other file was touched.
- Acceptance criteria satisfied: exact-empty/exact-`PersistedIntakeData`
  snapshot trust boundary with fail-closed rejection of arrays, exotic
  prototypes, thrown proxies, symbol/extra/missing keys, and unknown schema
  versions; every merge rule (sticky intent/pet_name/species/complaint,
  20-newest symptom union, per-signal stickiness, fresh
  `missing_information`, sticky OR `user_requested_human`) with fresh
  non-shared nested references and no mutation of frozen inputs; pet
  selection that never trusts an ID, fails closed on a stale retained
  `petId`, retains an existing pet against a same-turn conflicting name
  (`needs_clarification` while keeping the ID), and otherwise reuses
  `resolvePet` unchanged; the exact 7-step stage precedence including
  `completed`/`human_handoff` terminal retention, emergency/human priority
  over normal advancement, and same-stage holds at `ready_for_triage` and
  all three appointment stages; `evaluateSafetyDecision` reused unchanged
  over the merged snapshot, so a sticky stored `true` signal still forces
  `human_handoff` even when the current turn reports `null`/`false`. No
  Queue, database, LLM, or wiring change was made.
- Commands and exact results: `pnpm install --frozen-lockfile` → up to date;
  `pnpm typecheck` → clean, no errors; `pnpm test` → 14 files, 385/385 passed
  (52 new in `intakeTurn.test.ts`); `pnpm exec wrangler deploy --dry-run
  --outdir .wrangler/dry-run` → succeeded, only the pre-existing
  `INTAKE_QUEUE`/`APP_TIMEZONE` bindings listed, no new bindings; `git diff
  --check` → exit 0 (one harmless LF/CRLF autocrlf notice, no whitespace
  errors). `git` required a per-invocation `-c safe.directory=*` override to
  run at all under this checkout's Windows ownership metadata; no git config
  file was modified.
- Checks not run and why: none of the required checks were skipped.
- Known limitations: the planner is pure and intentionally not wired into
  any runtime path (Worker, Queue consumer, or Task 013's finalizer); it
  performs no persistence, so Task 013's atomic finalize call is still the
  only place a plan can take effect. `missing_information` is carried only
  as advisory data and never influences `nextStage`, by design.
- Risks for Codex/Opus review: verify the pet-conflict rule specifically —
  the conflict check in `resolvePetForContext` intentionally uses the raw
  current-turn `extraction.pet_name`, not the merged snapshot's `pet_name`,
  because using the merged value would let a turn that mentions no pet
  spuriously re-trigger single-pet-fallback logic against an already-settled
  `petId`; confirm this matches the intended "current extraction" wording in
  the contract. Also verify `resolvePet(merged, context.pets)` and
  `evaluateSafetyDecision(merged)` being called with a `PersistedIntakeData`
  value (structurally compatible with `IntakeExtraction`, with an extra
  `schema_version` field) is the intended reuse rather than a type
  workaround to revisit.

## Codex review record

- Decision: `PASS_TO_OPUS` on 2026-08-08. The planner remains pure and
  unwired; its merge, pet-selection, safety, and stage-decision paths match the
  active contract.
- Reviewed the complete new source/test/documentation files, the existing
  extraction parser and pet resolver, the deterministic safety gate, the
  conversation-stage RPC contract, runtime imports, and the Sonnet delivery
  record.
- Accepted the two implementation choices flagged by Sonnet:
  - pet conflict detection correctly uses only the current turn's explicit
    `pet_name`; a stored name must not manufacture a new conflict when this
    turn names no pet;
  - `PersistedIntakeData` deliberately has the complete `IntakeExtraction`
    structure plus `schema_version`, so passing the merged value directly to
    `resolvePet` and `evaluateSafetyDecision` is ordinary structural typing,
    not a bypass of either boundary.
- Targeted fixes made during review:
  - replaced enumerable-only snapshot key inspection with one
    `Reflect.ownKeys` check, so non-enumerable string extras are rejected along
    with symbol extras;
  - removed the new fixed safety-signal iteration list and derives merge keys
    from the already-validated stored signal object, preventing a future signal
    addition from being silently omitted;
  - added a regression test for a hidden non-enumerable extra field.
- Verification after fixes: frozen install passed; typecheck passed; all 386
  tests in 14 files passed (53 planner tests); Wrangler dry-run passed with
  only the existing producer/environment bindings; `git diff --check` passed;
  runtime-wiring, forbidden-API, and NUL-byte scans were clean.
- Database validation was not applicable: this task adds no migration, RPC, or
  database access. No LLM, Queue, Supabase mutation, deploy, commit, or push
  was performed during implementation/review.
- Mandatory remaining gate: Claude Opus must perform the contracted read-only
  review of fail-closed snapshot parsing, merge safety, sticky emergency facts,
  pet identity/conflict behavior, and stage precedence before Codex can mark
  the task complete and commit it.

## Claude Opus review record

- Decision: `PASS` on 2026-08-08 after reading the context files and actual
  Task 014 diff, including Codex's delivery-time fixes.
- Independently reran typecheck and all 386 tests, confirmed the allowed-file
  scope, no runtime wiring, and no network/logging/random/time side effects.
- Confirmed the snapshot trust boundary, tenant-scoped pet identity, current-
  turn pet conflict rule, sticky emergency behavior, database-valid same-stage
  terminal updates, and forward-only stage progression.
- No current correctness or security defect was found. Follow-up requirements
  accepted for the Queue consumer: corrupt snapshot failures are poison and
  must not retry forever; safety must not be inferred from `nextStage` alone;
  later triage must honor the deterministic gate even when the persisted stage
  is already `ready_for_triage`.
- Final cleanup after Opus:
  - initialized merged safety signals from a complete spread of the validated
    stored object before applying per-key updates, removing the remaining
    empty-object assertion and preserving future validated keys by default;
  - simplified the documentation's completed-versus-handoff precedence text;
  - recorded the Queue-consumer safety requirements in `PROJECT_CONTEXT.md`.
- Final verification after that cleanup: frozen install, typecheck, all 386
  tests, Wrangler dry-run, and `git diff --check` passed. The Worker binding
  list remained unchanged and the planner remained unwired.
