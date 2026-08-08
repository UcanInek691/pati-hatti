# Current task — 014 deterministically plan one intake turn

Status: `READY`

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

- Starting HEAD:
- Initial worktree state:
- Relevant code/tests/migration evidence:
- Planned files:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands and exact results:
- Checks not run and why:
- Known limitations:
- Risks for Codex/Opus review:
