# Current task — 008 OpenAI intake extraction adapter

Status: `READY`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

Add one small Cloudflare-compatible adapter that sends a single untrusted
WhatsApp text message to the OpenAI Responses API and returns only a Task 007
runtime-validated `IntakeExtraction`.

This task creates and tests the provider boundary only. It does not connect the
adapter to the webhook, read or write Supabase, advance conversation state,
resolve a pet, classify triage, generate a reply, send WhatsApp messages, retry,
queue work, or make a real OpenAI request.

## Starting context

- Implementation base: `3f30940` on `main`. A later docs-only commit containing
  this task definition is the expected starting HEAD; worktree is clean.
- Task 007 exports `INTAKE_EXTRACTION_SYSTEM_PROMPT`,
  `INTAKE_EXTRACTION_PROMPT_VERSION`, `IntakeExtraction`, and the fail-closed
  `parseIntakeExtraction(value: unknown)` boundary.
- The project has no runtime dependencies and uses native `fetch` in Workers.
- `Env` has no OpenAI key yet.
- Official OpenAI documentation reviewed by Codex on 2026-08-06 confirms that
  `gpt-5.6-luna` supports the Responses API and Structured Outputs and is the
  cost-sensitive/high-volume model in the GPT-5.6 family. The adapter baseline
  is `reasoning.effort: "none"`; quality must later be evaluated against `low`
  before production.

Before editing, follow `AGENTS.md`, verify these facts, and fill Observed
context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/openaiIntake.ts`.
- New `test/openaiIntake.test.ts`.
- Add `OPENAI_API_KEY` to `src/env.ts` and a placeholder to
  `.dev.vars.example`.
- Update only the OpenAI-provider boundary section of
  `docs/ai-behavior-and-safety.md`.
- Fill the Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, database migrations, Worker routing,
Supabase helpers, the Task 007 parser/resolver/prompt, Wrangler config,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Provider contract

Use TypeScript and native Web APIs only. Do not add the OpenAI SDK, a schema
library, a provider interface, a generic HTTP client, classes, or speculative
abstractions.

Export:

- `OPENAI_INTAKE_MODEL` with the exact value `gpt-5.6-luna`.
- A single async function accepting the message text, a caller-supplied stable
  privacy-preserving `safetyIdentifier`, and `Env`.
- A result union containing either `{ ok: true, extraction }` or a generic
  `{ ok: false }`. Do not expose provider error bodies or refusal text.

Input rules:

- Reject an empty/whitespace-only API key, empty message, message over 65,536
  Unicode code points, or empty/whitespace-only safety identifier without
  calling `fetch`.
- Do not trim, rewrite, normalize, concatenate, or log the accepted message.
- The caller owns construction of the privacy-preserving safety identifier;
  this adapter only sends the supplied nonempty value. A later wiring task must
  never use a phone number, email, owner name, raw database UUID, or other
  directly identifying value.

Make exactly one `POST` request to the fixed endpoint
`https://api.openai.com/v1/responses` with:

- `Authorization: Bearer <OPENAI_API_KEY>` and JSON content type;
- model `gpt-5.6-luna`;
- the existing Task 007 system prompt as a `system` input item and the original
  message as a separate `user` input item;
- `safety_identifier` set to the caller-supplied value;
- `store: false`;
- `reasoning: { effort: "none", context: "current_turn" }`;
- `max_output_tokens: 1200`;
- no tools, previous response, conversation id, metadata, or user/profile data;
- Structured Outputs via `text.format` with `type: "json_schema"`,
  `name: "vetai_intake_extraction"`, and `strict: true`.

The JSON Schema must mirror the Task 007 shape:

- all eight top-level keys are required and the object has
  `additionalProperties: false`;
- all eight safety-signal keys are required, each boolean-or-null, and that
  nested object also has `additionalProperties: false`;
- intent and missing-information values use the exact Task 007 enums;
- nullable text fields are string-or-null; symptoms and missing information
  are arrays of strings/the enum respectively.

Do not depend on JSON Schema for the Task 007 code-point limits, uniqueness,
trimming, or final trust decision. The existing runtime parser remains the
authoritative gate.

## Response and failure contract

Treat the provider response as untrusted:

1. Catch network failures and return `{ ok: false }`.
2. Reject every non-2xx response without reading or logging its body.
3. Parse JSON inside a try/catch.
4. Require top-level `status === "completed"`.
5. Require exactly one output item of `type: "message"`; ignore non-message
   output items such as reasoning, but reject zero or multiple messages.
6. Require that message to contain exactly one item of `type: "output_text"`
   with a string `text`. Refusals, mixed content, missing text, and multiple
   content items fail closed.
7. `JSON.parse` that text, then pass the value to
   `parseIntakeExtraction`. Return success only when that parser succeeds.

Never log or throw provider payloads, user text, the API key, refusal text, or
parsed extraction. No retry or fallback model belongs in this task.

## Required tests

Mock `globalThis.fetch`; no real network request or API key may be used.

- Prove the successful request uses the fixed HTTPS endpoint, POST, required
  headers, exact model/effort/context/token/store/safety fields, no tools, and
  two separate system/user input items without changing the message.
- Inspect the sent JSON Schema: exact required keys/enums, nullable fields,
  both `additionalProperties: false` boundaries, and `strict: true`.
- Prove a completed response with optional non-message reasoning plus exactly
  one valid output message is accepted and normalized by Task 007's parser.
- Prove no fetch for missing key, empty message, oversized Unicode message, or
  empty safety identifier.
- Prove generic failure for fetch rejection, non-2xx, invalid response JSON,
  incomplete/unknown status, missing/multiple messages, refusal/mixed/multiple
  content, non-string output text, invalid output JSON, and JSON that fails the
  Task 007 runtime parser.
- Ensure tests restore `globalThis.fetch` and keep all existing tests green.
- Assert source/request fixtures contain no real-looking secret.

## Documentation requirements

Extend `docs/ai-behavior-and-safety.md` only enough to record:

- the chosen model/API and why this narrow extraction uses the lowest-cost
  GPT-5.6 tier with reasoning disabled as an evaluation baseline;
- `store: false`, one-message-only input, separate untrusted user content,
  strict Structured Outputs, and the Task 007 runtime parser as final gate;
- `store: false` prevents Responses application-state storage but is not a
  promise of Zero Data Retention; production still requires appropriate
  OpenAI organization data controls and a privacy/legal review;
- the live API call, eval comparison (`none` versus `low`), retry policy,
  orchestration, and downstream state changes remain unimplemented.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, install dependencies/plugins, call OpenAI, mutate
Supabase, or touch another external service.

## Observed context — Sonnet fills before coding

- Starting HEAD: `a461b47` (on top of `3f30940`, docs-only). Worktree clean.
- Initial worktree state: clean, matches task's stated starting context.
- Relevant code/tests evidence: `prompts/intake-extraction-prompt.ts` exports
  `INTAKE_EXTRACTION_PROMPT_VERSION` and `INTAKE_EXTRACTION_SYSTEM_PROMPT`
  (not in `src/intakeExtraction.ts` as the task text implied by proximity —
  same exports exist, just in the prompt module; not a conflict).
  `src/intakeExtraction.ts` exports `IntakeExtraction` (8 top-level keys:
  intent, pet_name, species, complaint, symptoms, reported_safety_signals,
  missing_information, user_requested_human; `reported_safety_signals` has 8
  boolean-or-null keys) and `parseIntakeExtraction`. `src/env.ts` currently
  has no OpenAI key. No runtime deps in `package.json`; `vitest run` /
  `tsc --noEmit` are the test/typecheck scripts. Existing modules use plain
  functions (no classes), Result-style unions, `as const` key lists, 2-space
  indent, double quotes. `test/webhookSignature.test.ts` shows the house
  vitest style (describe/it, direct fetch/Request usage, no fixtures/mocks
  framework beyond vitest itself).
- Planned files: new `src/openaiIntake.ts`, new `test/openaiIntake.test.ts`,
  one line added to `src/env.ts`, one line added to `.dev.vars.example`, an
  appended section in `docs/ai-behavior-and-safety.md`, this file's Observed
  context and Delivery record.
- Conflicts or blockers: none found.

## Delivery record — Sonnet fills after coding

- Changed files:
  - New `src/openaiIntake.ts` — exports `OPENAI_INTAKE_MODEL` and
    `extractIntakeViaOpenAi(message, safetyIdentifier, env)`.
  - New `test/openaiIntake.test.ts` — 22 tests, `globalThis.fetch` mocked,
    restored in `afterEach`.
  - `src/env.ts` — added required `OPENAI_API_KEY: string`.
  - Existing typed Env fixtures in `test/index.test.ts`,
    `test/conversationState.test.ts`, and `test/supabaseIngest.test.ts` — added
    inert placeholder values after Codex review so the binding stays required.
  - `.dev.vars.example` — added `OPENAI_API_KEY=[openai-api-key]` placeholder.
  - `docs/ai-behavior-and-safety.md` — appended the "OpenAI provider boundary
    (Task 008)" section only; Task 007 section untouched.
  - This file — Observed context and this Delivery record.
- Acceptance criteria satisfied:
  - Adapter uses only TypeScript/native Web APIs (`fetch`, `TextEncoder`
    unused/not needed here) — no SDK, schema library, provider interface,
    HTTP client, or class.
  - Rejects empty/whitespace API key, empty message, message over 65,536
    code points, and empty/whitespace safety identifier before calling
    `fetch`; message is never trimmed/rewritten/logged (asserted in tests).
  - Exactly one POST to `https://api.openai.com/v1/responses` with the
    required headers, `model: "gpt-5.6-luna"`, separate system/user input
    items, `safety_identifier`, `store: false`,
    `reasoning: { effort: "none", context: "current_turn" }`,
    `max_output_tokens: 1200`, no tools/previous-response/conversation/
    metadata/user, and strict `text.format` json_schema mirroring the Task
    007 shape (required keys, both `additionalProperties: false`
    boundaries, exact enums, nullable text/signal fields).
  - Response handling: network-catch, non-2xx rejected unread, JSON
    parsed in try/catch, requires `status === "completed"`, requires
    exactly one `message` output item (ignoring e.g. `reasoning` items),
    requires exactly one `output_text` content item with string `text`,
    `JSON.parse`s that text, and only returns success when
    `parseIntakeExtraction` (imported, unmodified) accepts it. All failure
    paths return the same generic `{ ok: false }` with no logged payload,
    refusal text, key, or parsed extraction.
- Commands and exact results:
  - `pnpm install --frozen-lockfile` → "Already up to date".
  - `pnpm typecheck` → passed, no errors.
  - `pnpm test` → 10 test files, 190 tests, all passed (22 new in
    `openaiIntake.test.ts`).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
    succeeded, `--dry-run: exiting now.`
  - `git diff --check` → only benign "LF will be replaced by CRLF" advisory
    warnings, no conflict markers or whitespace errors, exit 0.
  - `git status --porcelain` → only the files listed above; no stray
    changes.
- Checks not run and why: none of the required verification commands were
  skipped. No real OpenAI call, commit, push, or deploy was made, per the
  task's constraints.
- Known limitations:
  - None within the implemented adapter boundary. The live provider call,
    eval comparison, retry policy, and orchestration remain intentionally
    deferred as described above.
  - The JSON Schema encodes nullability with `type: ["string", "null"]` /
    `["boolean", "null"]` (OpenAI Structured Outputs' documented way to
    express a nullable field under `strict: true`); the task text doesn't
    name a specific schema encoding, so this is an implementation choice
    worth Codex's review.
  - `gpt-5.6-luna` / GPT-5.6 family and the cited Responses API behavior are
    outside this Sonnet session's verifiable knowledge; per the task, no
    real call was made, so this was taken as given from Codex's stated
    documentation review rather than independently confirmed.
- Risks for Codex review:
  - Confirm the input-item shape `{ role: "system"/"user", content: <string> }`
    matches the intended Responses API "system input item" / "user input
    item" phrasing (no other shape is described in the task).

## Codex review and verification

- Reviewed the native-fetch adapter, all request/response branches, schema,
  tests, environment binding, documentation, and official OpenAI guidance.
- Kept the provider code unchanged: the Responses input-item shape,
  `text.format` Structured Outputs request, nullable unions, `store: false`,
  `safety_identifier`, and `reasoning.context: "current_turn"` match the
  reviewed API guidance.
- Made `OPENAI_API_KEY` a required `Env` binding, consistent with the task and
  all existing secrets; added inert placeholders to the three existing typed
  test fixtures. Runtime missing/blank-key rejection remains unchanged.
- Codex verification: frozen install passed; strict typecheck passed; 190/190
  tests passed; Wrangler dry-run passed at 11.44 KiB / gzip 3.62 KiB; final
  secret-pattern and whitespace checks passed.
- Decision: `PASS`. No real OpenAI request, deployment, or external mutation
  was performed.
