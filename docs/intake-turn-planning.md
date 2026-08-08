# Intake turn planner (pure, not wired)

Last verified: 2026-08-08.

## What this step does

`src/intakeTurn.ts` exports one pure function, `planIntakeTurn(context,
extraction)`, that combines an already-validated current-turn extraction (see
`docs/database-schema.md` and `src/intakeExtraction.ts`) with a conversation's
persisted intake snapshot, resolves the pet only against the tenant-scoped
context, evaluates the existing deterministic safety gate
(`src/safetyDecision.ts`), and chooses a database-valid next intake stage. It
performs no persistence, lease action, LLM call, triage, response generation,
or other external effect, and it is not wired into any runtime path.

## Persisted snapshot schema

`context.intakeData` is untrusted persisted JSON. `PersistedIntakeData` is
`schema_version: 1` plus the exact validated extraction fields (`intent`,
`pet_name`, `species`, `complaint`, `symptoms`, `reported_safety_signals`,
`missing_information`, `user_requested_human`), reusing the extraction's
snake_case vocabulary rather than inventing a second one. Only two shapes are
accepted: an exact plain empty object (a conversation not planned yet) or an
exact `PersistedIntakeData` object whose extraction portion passes the
existing `parseIntakeExtraction` boundary. Every other shape — arrays, exotic
prototypes, thrown proxies, symbol or extra keys, missing keys, unknown
schema versions, and malformed nested data — fails closed to `{ kind:
"failed" }` rather than being repaired or coerced.

This is a bounded working intake snapshot for planning the next stage, not
the conversation record; the persisted messages remain the source of truth
for what was actually said.

## Deterministic merge rules

A validated current-turn extraction is merged into the accepted snapshot:

- A non-`unknown` current `intent` replaces the stored one; current `unknown`
  preserves a previous non-`unknown` intent.
- Non-null current `pet_name`, `species`, and `complaint` replace stored
  values; `null` never erases a previously explicit value.
- `symptoms` is an exact-string ordered union: existing order is kept, new
  unique values are appended, and only the newest 20 unique values survive.
  This bounds a working snapshot; it never deletes anything from message
  history.
- Each safety signal is merged independently: a stored `true` is sticky and
  cannot be cleared by a later turn; otherwise a current boolean replaces a
  stored `false`/`null`, while current `null` preserves whatever was stored.
  A missed fact on a later turn can never turn a known danger back into
  safety.
- `missing_information` is replaced by a fresh copy of the current turn's
  list only — it is advisory for the next question to ask, and must never
  decide safety or stage progression.
- `user_requested_human` is sticky via logical OR.

The merge never invents fields, fuzzy-matches clinical text, infers missing
facts, diagnoses, or calculates medical priority. Every returned snapshot and
its nested array/object is a fresh value, never a reference into the stored
snapshot, the current extraction, or the pet list.

## Pet identity and trust

No pet ID is ever accepted from extraction or persisted data — only exact
name resolution against `context.pets` (via the existing `resolvePet`) or an
already-selected `context.petId` is trusted. If `context.petId` is set but is
not present in `context.pets`, the planner fails closed. An already-selected
pet is authoritative: no stored or current name can silently switch it. If
the *current turn* explicitly names a pet and exact resolution does not
select that same pet, the planner reports `needs_clarification` while still
retaining the original `petId` in its output — a conflicting mention never
switches the pet underneath the conversation. When no pet is selected yet,
the planner reuses `resolvePet` over the merged extraction, preserving its
exact-match/single-pet-fallback behavior.

## Stage-decision precedence

In order, first match wins:

1. `completed` stays `completed` — a closed conversation is never reopened by
   the planner.
2. Outside the absolute `completed` rule above, an `emergency_handoff` or
   `human_handoff` safety decision always routes to (or keeps)
   `human_handoff`.
3. `human_handoff` otherwise stays `human_handoff`.
4. `pet_identification` advances to `complaint_collection` only when pet
   resolution is `matched`.
5. `complaint_collection` advances to `safety_check` only once the merged
   complaint is non-null or merged symptoms are non-empty.
6. `safety_check` advances to `ready_for_triage` only for `continue_intake`;
   `needs_safety_check` (any unknown signal) always holds it back.
7. `ready_for_triage` and the three appointment stages always hold. Triage
   and appointment progression belong to a later task; this planner
   deliberately never invents that logic.

The planner never skips a normal stage, moves backward, or advances an
appointment stage. Returning the same stage is intentional, not a no-op: it
lets a later atomic finalizer (Task 013's `finalize_intake_queue_job`)
persist newly gathered snapshot data and complete that message's lease in one
transaction even when the stage itself does not change yet.

## What this is not

- No database access, LLM call, network call, or logging happens in this
  module.
- No diagnosis, medication, dosage, treatment plan, or response text is
  produced or accepted.
- The module is not wired into the Worker, the Queue consumer, or any other
  runtime path, and this task is not production approval.
