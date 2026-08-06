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

## OpenAI provider boundary (Task 008)

Scope: `src/openaiIntake.ts`. This adds one provider adapter around the Task
007 boundary above; it does not change what that boundary guarantees.

- **Model and cost tier**: `gpt-5.6-luna`, the cost-sensitive/high-volume
  model in the GPT-5.6 family, called through the Responses API with
  `reasoning.effort: "none"`. This is an evaluation baseline for a narrow,
  low-ambiguity extraction task, not a final choice — quality must still be
  compared against `effort: "low"` before production use.
- **No application-state storage**: every request sets `store: false`. This
  turns off Responses API storage of this call's input/output as retrievable
  application state; it is not a promise of Zero Data Retention or of what
  OpenAI's infrastructure retains for abuse monitoring. Production use still
  requires appropriate OpenAI organization data controls and a privacy/legal
  review.
- **One message, no history**: exactly one system input item (the unmodified
  Task 007 `INTAKE_EXTRACTION_SYSTEM_PROMPT`) and one user input item (the
  original owner message, sent unmodified as untrusted content) are sent. No
  `previous_response_id`, conversation id, tools, metadata, or user/profile
  data. `safety_identifier` is a caller-supplied, privacy-preserving value —
  this adapter never constructs it and never sends a phone number, email,
  owner name, or raw database id in its place.
- **Strict Structured Outputs, still not trusted**: `text.format` uses
  `type: "json_schema"`, `strict: true`, and a schema mirroring the Task 007
  `IntakeExtraction` shape (required keys, `additionalProperties: false` at
  both the top level and inside `reported_safety_signals`, and the same
  intent/missing-information enums). This narrows what the model can emit,
  but it does not replace validation: the response is parsed and only
  accepted after every provider-shape check (completed status, exactly one
  message, exactly one `output_text` item, no refusal/mixed content) passes
  and the resulting JSON is run through `parseIntakeExtraction`. A
  schema-conforming response that the runtime parser rejects is still
  discarded.
- **Fail closed, no leakage**: network errors, non-2xx responses, malformed
  JSON, unexpected status, wrong output shape, refusals, and parser
  rejection all return the same generic `{ ok: false }`. Provider response
  bodies, refusal text, the API key, and the accepted message are never
  logged or included in a thrown error.

Not implemented here: an actual production call (tests mock `fetch`
entirely), the `none`-versus-`low` reasoning-effort evaluation, retry or
fallback-model policy, request orchestration, and any change to conversation
state, pet resolution, triage, or outbound messaging.
