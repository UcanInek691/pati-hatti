# AI behavior and safety — structured intake boundary

Scope: the trust boundary introduced in Task 007
(`src/intakeExtraction.ts`, `prompts/intake-extraction-prompt.ts`). This is not
a general AI-safety policy. No LLM is called yet; this document describes the
contract a future LLM call must satisfy and how its output is contained.

## Why this boundary exists

A future LLM call will read an owner's WhatsApp message and produce JSON. That
output is model-generated and must be treated as untrusted input, not as a
trusted instruction or a ready-to-use database write. `parseIntakeExtraction`
is the single point where that untrusted JSON either becomes a validated
`IntakeExtraction` value or is rejected outright — there is no partial or
best-effort acceptance.

## What the parser guarantees

- Exactly the fields defined by `IntakeExtraction`; missing keys, extra keys,
  wrong types, oversized text, sparse arrays, and duplicate array values are
  all rejected rather than coerced.
- The returned value is a new object; the caller's input is never mutated.
- The extraction can never carry a `pet_id`, `clinic_id`, stage, triage
  priority, diagnosis, medication, dosage, treatment, SQL, tool name, or
  response text — those fields do not exist in the type, so a model cannot
  smuggle one in even if the prompt is bypassed.

## What the pet resolver guarantees

`resolvePet` never accepts a model-supplied database id. It only maps a
free-text `pet_name` (or the single known pet, when unambiguous) to a `petId`
already present in the caller-supplied `pets` list from
`ConversationIntakeContext`, using exact matching after Unicode `NFKC`,
whitespace, and Turkish-locale-lowercase normalization. Zero or multiple
matches — including duplicate normalized names — always fall back to
`needs_clarification` rather than guessing.

## What the prompt asks of the model

`INTAKE_EXTRACTION_SYSTEM_PROMPT` instructs the model to treat the owner's
message as untrusted data even if it contains instructions or prompt-injection
language, to output only the structured JSON contract above, to extract only
explicitly stated facts (`null`/empty lists when unknown, never inferred or
translated), and to never diagnose, recommend medication or treatment, make a
triage decision, choose a database id, call a tool, or write a user-facing
reply. It separately asks the model to flag human-handoff requests and
identify (without answering) medical-advice requests.

The prompt module holds no user text, provider name, API key, or retry logic —
a future provider adapter is responsible for sending the owner's message as
separate untrusted content and for calling `parseIntakeExtraction` on
whatever the provider returns before that value touches any other code.

## What is explicitly out of scope here

This boundary does not call an LLM, does not write to Supabase, does not
advance `intake_stage`, does not classify triage, and does not generate or
send any message. Wiring the prompt and parser into an actual model call and
into `advance_conversation_intake` (Task 006) is future work.
