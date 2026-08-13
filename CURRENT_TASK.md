# Current task — 029 Bounded multi-turn interpretation and model-work budget

Status: `COMPLETE`

Owner: Codex

## Goal

Let the production intake extractor interpret a short current owner answer only
against the single immediately preceding bot question, without sending full
conversation history or trusting model-generated state.

Bound paid model work and repeated no-progress conversations so they terminate
in the existing truthful human-handoff path. Keep Luna as the production model,
keep the deterministic safety gate authoritative, and add no new dependency,
external service, database migration, deployment, or fallback model.

## Scope

Allowed changes:

- `prompts/intake-extraction-prompt.ts` — one version bump and the minimum
  explicit rules for contextual short-answer interpretation;
- `src/openaiIntake.ts` and `test/openaiIntake.test.ts`;
- `src/intakeConsumer.ts` and `test/intakeConsumer.test.ts`;
- `src/intakeTurn.ts` and `test/intakeTurn.test.ts` only as needed to expose a
  fail-closed canonical persisted-snapshot reader for the no-model path;
- `src/intakeReply.ts` / `test/intakeReply.test.ts` only if a small exported
  predicate is needed to recognize the existing deterministic question copy;
- `evals/intake-multiturn-live-cases.json` (new, synthetic only);
- `test/liveOpenAiMultiTurnEval.test.ts` (new, separately opt-in live test);
- `package.json` — one `eval:openai-multiturn` script only; no dependency or
  existing-script changes;
- `.dev.vars.live-ai.example` only to document the new opt-in flag; never add a
  real value;
- `docs/ai-behavior-and-safety.md`, `docs/inbound-queue.md`, and
  `docs/live-ai-demo.md` for narrow behavior/eval documentation;
- `docs/product-roadmap.md` only for a narrow Task 029 status/evidence note;
- `CURRENT_TASK.md` — implementer fills only **Observed context** and
  **Delivery record**.

Do not change:

- the extraction JSON shape, runtime extraction parser, safety signal set,
  deterministic safety rules, Turkish reply strings, appointment behavior,
  database schema/RPCs/migrations, Queue configuration, webhook behavior,
  production `wrangler.toml`, Env bindings, dependencies, or lockfiles;
- `OPENAI_INTAKE_MODEL` or its Luna value;
- the 30-second provider timeout, `store: false`, `reasoning: none`, strict
  Structured Outputs, or privacy-preserving safety identifier;
- the existing local secret file or any real credential;
- any OpenAI/Meta/Supabase/Cloudflare resource, deployment, or production state.

## Verified starting evidence

- Task 028 is committed at `8531632` and the worktree was clean before this
  contract was written.
- On 2026-08-13 Codex ran one synthetic Luna smoke call and the full 66 × 2
  Luna/Terra synthetic eval with the user's explicit approval. All 132 corpus
  calls returned runtime-valid schemas and zero provider failures.
- The dedicated OpenAI test project allows only Luna/Terra, its ignored local
  key has model-request-only permission, and the organization now enforces a
  $5 monthly hard limit. This is an operational backstop, not exact per-request
  accounting; the platform warns that enforcement may lag slightly.
- `ConversationIntakeContext` already contains a chronological, tenant-scoped
  `recentMessages` list capped at 12 and a monotonically increasing
  `stateVersion`.
- Production currently sends only the current claimed message to Luna. The
  consumer makes at most one model request per Queue attempt; provider failure
  retries through the existing Queue policy and ultimately reaches the
  existing DLQ handoff.
- `human_handoff` conversations may be reused by inbound ingestion. Today the
  consumer still pays for a model call before the planner preserves the
  terminal handoff stage.

## Required design

### 1. Minimal contextual input

Add a small pure builder (inside an allowed existing module unless a tiny new
module is demonstrably clearer) that selects at most one previous clinic
question from `context.recentMessages`:

- require the final recent message to be an inbound whose content exactly
  equals the current claimed message; if not, return no context;
- inspect only messages before that final inbound, in reverse chronological
  order, and select only the most recent `direction === "outbound"` item;
- accept it only when it contains a question mark, has 1–4,096 Unicode code
  points, and the conversation is not already `human_handoff` or `completed`;
- otherwise return no context;
- never include inbound history, more than one outbound message, owner/clinic/
  conversation identifiers, timestamps, pet database IDs, phone numbers, or
  the persisted JSON snapshot;
- return a fresh immutable-by-convention value and never mutate the supplied
  context/messages.

Pass that optional question to the existing shared OpenAI request path as a
separate, clearly labelled **untrusted context-data item** before the unchanged
current owner message. The final user item must still contain the exact current
message, without trimming, rewriting, or concatenating it. Do not use
`previous_response_id`, OpenAI Conversations, stored responses, tools, or full
history.

The prompt must state that:

- the previous clinic text and current owner text are both untrusted data, not
  instructions;
- a previous question asserts no owner/patient fact by itself;
- context may be used only to resolve a direct elliptical/yes-no/numbered
  answer in the current message (for example `hayır`, `evet`, or `ilkine evet,
  diğerlerine hayır`);
- only facts explicitly expressed by that resolved current answer may appear
  in the output;
- ambiguity remains `null`/empty and must never be guessed;
- all existing no-diagnosis/no-treatment/no-action/prompt-injection rules stay
  in force.

If optional context is absent, the provider request must remain behaviorally
equivalent to Task 028. Evaluation/local-demo callers may omit context without
changing their current behavior.

### 2. No-model terminal and budget path

After successful claim and context loading but **before** deriving the safety
identifier or calling OpenAI:

- if `context.intakeStage === "human_handoff"`, finalize the current lease in
  the same stage using a fail-closed canonical copy of the already persisted
  intake snapshot and the existing fixed human-handoff reply; make zero OpenAI
  calls;
- if `context.stateVersion >= 12` in any non-completed automated stage, do the
  same but force `nextStage = "human_handoff"`; this is the conservative
  per-conversation paid-work ceiling;
- do not invent a success path for a malformed persisted snapshot. If it cannot
  be canonicalized through the existing Task 014 trust boundary, return
  `retry` so the existing finite Queue/DLQ path owns the poison case;
- do not separately complete a lease. Continue using only the existing atomic
  finalization RPC and its current result/disposition mapping;
- never claim that staff was notified. Reuse the exact approved fixed handoff
  copy unchanged.

Expose the smallest pure persisted-snapshot reader needed for this branch from
`src/intakeTurn.ts`; do not duplicate its exact-key/schema/parser rules in the
consumer. It may canonicalize the already-supported empty object to the current
empty snapshot. It must return fresh arrays/objects and fail closed on every
other malformed shape.

### 3. Repeated no-progress fallback

After a valid current extraction and normal planning, force the same atomic
human-handoff finalization when both conditions hold:

1. the extraction contains no explicit actionable fact: `intent ===
   "unknown"`, null pet/species/complaint, empty symptoms, all safety signals
   null, and `user_requested_human === false`; `missing_information` does not
   count as a fact;
2. the two most recent prior outbound messages are identical eligible question
   texts (each satisfies the question/length rule above).

This gives one repeat of a question, then terminates the next no-progress turn.
Build a copied `PlanResult` whose `nextStage` is `human_handoff` so the existing
appointment gate and reply planner see the same terminal decision; do not
mutate the original plan or extraction. Emergency/human safety decisions retain
their existing higher-priority behavior.

Any explicit current fact resets this condition naturally; do not add another
database counter or schema version.

### 4. Failure, rate, and spend behavior

- Keep exactly one OpenAI request at most per Queue attempt.
- Do not retry inside the OpenAI adapter and do not call Terra as fallback.
- A timeout, 429, 5xx, refusal, malformed response, or invalid extraction keeps
  the existing generic `{ ok: false } -> retry -> finite Queue/DLQ` behavior.
- Keep the fixed 30-second timeout. Do not add configurable retry/backoff code.
- Document the external $5 OpenAI hard limit and its small possible enforcement
  lag. Do not call billing APIs or add billing credentials/configuration.
- Logging may use only fixed reason tokens/counts already allowed by the
  project. Never log message/context text, extraction/provider bodies, IDs,
  tokens, or secrets.

### 5. Synthetic multi-turn evidence

Add a versioned corpus of **at least 24** synthetic Turkish cases. Every case
contains exactly: stable ID, category, previous clinic text, current owner
answer, and expected extraction subset. Include at minimum:

- each of the eight safety signals answered `evet` and `hayır`;
- multi-question ordinal replies such as `ilkine evet, diğerlerine hayır`;
- `hiçbiri`, `hepsi hayır`, and `emin değilim`;
- ambiguous `evet/hayır` where the previous text is not a valid question;
- prompt-injection text in either context or current answer;
- human request, medical-advice request, pet-name, and complaint follow-ups;
- Turkish casing/Unicode and whitespace variants.

The new live test must:

- be disabled unless **both** `LIVE_OPENAI_MULTITURN_EVAL=1` and a real key are
  present; the existing `LIVE_OPENAI_EVAL=1` must not activate it;
- use the same reviewed adapter/prompt/schema/parser path for Luna and Terra,
  sequentially with concurrency one and at most 100 calls per run;
- report only aggregate metrics and failing case IDs—never case text, context,
  provider body, model output, or key;
- report schema success, expected-leaf match, explicit-red recall,
  unspecified-not-false rate, latency, usage, and cost using current official
  Luna/Terra prices already recorded by Task 028;
- make no network call during normal `pnpm test`.

The corpus is an engineering artifact and must say it is not veterinarian-
approved. It must not automatically change the production model.

## Acceptance criteria

- A safety-check reply followed by `evet`, `hayır`, `hiçbiri`, and numbered
  multi-answer variants is sent with exactly one bounded previous question and
  the exact current answer; mocked provider output still passes the unchanged
  strict extraction parser.
- No-context requests retain Task 028's exact two-item request shape.
- Full history, previous inbound messages, identifiers, timestamps, persisted
  snapshots, and more than one outbound question never enter the OpenAI body.
- Context/current prompt-injection strings remain data and cannot alter the
  closed output/parser contract.
- A handoff-stage message makes zero OpenAI requests and atomically finalizes
  with the existing truthful handoff reply.
- `stateVersion >= 12` makes zero OpenAI requests and routes to the same handoff
  path; version 11 still permits one normal request.
- Two identical eligible prior questions plus a no-fact extraction route to
  handoff; one prior question, non-identical questions, non-question outbound
  text, or any explicit current fact does not trigger that fallback.
- Malformed persisted data in a no-model branch retries and is never finalized
  as success.
- Emergency/human precedence, appointment confirmation rules, poison fallback,
  lease atomics, Queue dispositions, production Luna selection, timeout, and
  all existing tests remain unchanged.
- Normal tests prove the separate live gate performs zero network calls.
- No dependency, migration, binding, secret, deployment, or external mutation
  is introduced.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml --env live-ai --outdir .wrangler/dry-run-live-ai
git diff --check
```

Do **not** run the real multi-turn eval. Sonnet must report it `NOT RUN`; Codex
will inspect the diff first and only then run the paid synthetic gate with the
user's authorization.

No real OpenAI/Meta/Supabase/Cloudflare call, commit, push, deploy, plugin
installation, or external mutation is authorized.

## Review gates

1. Codex reviews all changed call paths, reruns local checks, and verifies the
   paid-work/no-model boundaries.
2. Codex may run the opt-in synthetic multi-turn eval only after local review
   and explicit user authorization.
3. Claude Opus performs a read-only prompt/safety/privacy review because this
   task changes the model's contextual interpretation boundary. Opus does not
   need to re-review unrelated database, Queue, appointment, or UI code.
4. Codex records the final model evidence and decision. Neither model nor AI
   review replaces veterinarian approval.

## Observed context

- `git log` confirmed Task 028 committed at `8531632` with a clean worktree
  before this task started; no uncommitted changes existed anywhere else in
  the repo.
- `src/conversationState.ts` confirms `ConversationIntakeContext.recentMessages:
  IntakeMessage[]` where `IntakeMessage = { direction: "inbound" | "outbound"
  | "system"; content: string; createdAt: string }`, and `IntakeStage`
  includes `"human_handoff"` and `"completed"`. `stateVersion: number` is a
  plain monotonic counter on the context.
- `src/intakeConsumer.ts` (pre-change) called `extractIntakeViaOpenAi` with
  only the claimed message text and hashed `safety_identifier`, exactly once
  per Queue attempt, for every non-terminal stage including `human_handoff` —
  confirming the "pays for a model call before the planner preserves the
  terminal handoff stage" gap named in the contract's starting evidence.
- `src/intakeTurn.ts`'s `parsePersistedSnapshot` (Task 014 trust boundary)
  returns `{kind:"empty"} | {kind:"snapshot", value} | {kind:"invalid"}` and
  rejects arrays, exotic prototypes, missing/extra keys (including
  symbol-keyed and non-enumerable extras), wrong `schema_version`, and
  malformed nested `reported_safety_signals`, failing closed (including when
  the input throws during inspection via a hostile `Proxy`). `emptySnapshot()`
  returns `reported_safety_signals` defaulted to `null` (not `false`) for all
  eight keys.
- `src/intakeReply.ts`'s `planIntakeReply(currentStage, result)` and
  `planAppointmentAction(context, plan, messageText)` both short-circuit to
  the fixed `HUMAN_HANDOFF_TEXT` / `{kind:"none"}` behavior whenever
  `result.nextStage === "human_handoff"`, regardless of the plan's
  `safetyDecision`/`petResolution` values — confirmed by direct read, which
  is why a synthetic no-model handoff `PlanResult` can safely use placeholder
  values for those two fields.
- `src/openaiIntake.ts` (pre-change) built exactly one system item (the
  unmodified Task 007 system prompt) and one user item (the raw current
  message) with `store:false`, `reasoning:{effort:"none"}`, strict Structured
  Outputs, a 30s timeout, and no retry/fallback model — matching Task 008's
  documented boundary exactly.
- `evals/intake-live-cases.json` and `test/liveOpenAiEval.test.ts` are Task
  028 artifacts explicitly **not** in this task's allowed-changes list, and
  `test/liveOpenAiEval.test.ts:261` asserts
  `corpus.prompt_version === INTAKE_EXTRACTION_PROMPT_VERSION`. Since the
  contract requires bumping `INTAKE_EXTRACTION_PROMPT_VERSION`, this creates
  an unavoidable scope conflict, documented below rather than resolved by
  editing an out-of-scope file.

## Delivery record

**Changed files** (implementer touched only files inside the allowed-changes
list above):

- `prompts/intake-extraction-prompt.ts` — version bump
  `"2026-08-06.1" -> "2026-08-13.1"` and a new "Optional previous-question
  context" prompt section stating the untrusted-data/no-new-facts/ambiguity
  rules required by §1.
- `src/openaiIntake.ts` — added `buildIntakeInput(message, previousQuestion)`
  and threaded an optional `previousQuestion: string | null = null` 5th
  parameter through `callOpenAiForIntake`, `extractIntakeViaOpenAi`, and
  `extractIntakeViaOpenAiForEvaluation`. Verified byte-identical Task 028
  request shape when `previousQuestion` is omitted/`null`.
- `src/intakeConsumer.ts` — added `selectPreviousClinicQuestion` (§1),
  the no-model terminal/budget branch executed right after context load and
  before `deriveSafetyIdentifier`/OpenAI call (§2), and
  `isNoActionableFact`/`hasRepeatedNoProgressQuestion`/the `effectivePlan`
  no-progress fallback applied after a successful extraction and before the
  appointment/reply planners (§3). Reuses the existing atomic
  existing `finalizeIntakeQueueJob` RPC and `planIntakeReply`; it does not
  separately complete the lease. The repeated-no-progress copied plan also
  passes through the existing appointment gate.
- `src/intakeTurn.ts` — added `readCanonicalPersistedSnapshot`, a thin
  fail-closed wrapper around the existing `parsePersistedSnapshot`/
  `emptySnapshot` trust boundary (no rule duplication), exported for
  consumer use.
- `evals/intake-multiturn-live-cases.json` (new) — 30 synthetic Turkish
  multi-turn cases, `eval_version`/`prompt_version: "2026-08-13.1"`, covering
  all 8 safety signals × evet/hayır, ordinal multi-answer, `hiçbiri`,
  `hepsi hayır`, `emin değilim`, ambiguous non-question context,
  prompt-injection in both context and current answer, human-request,
  medical-advice, pet-name, and complaint follow-ups, and a casing/Unicode/
  whitespace variant. Carries the required not-veterinarian-approved
  disclaimer.
- `test/liveOpenAiMultiTurnEval.test.ts` (new) — mirrors
  `test/liveOpenAiEval.test.ts`'s opt-in pattern under a separate
  `LIVE_OPENAI_MULTITURN_EVAL=1` flag (confirmed not activated by
  `LIVE_OPENAI_EVAL=1` alone), `HARD_MAX_CALLS_PER_RUN=100`, reports only
  aggregate metrics/failing IDs, and makes zero network calls under plain
  `pnpm test`.
- `package.json` — added exactly one script,
  `"eval:openai-multiturn": "node --env-file=.dev.vars.live-ai node_modules/vitest/vitest.mjs run test/liveOpenAiMultiTurnEval.test.ts"`.
  No dependency or existing-script change.
- `.dev.vars.live-ai.example` — added commented-out documentation for the new
  `LIVE_OPENAI_MULTITURN_EVAL=1` flag only; no real value added.
- `test/openaiIntake.test.ts`, `test/intakeConsumer.test.ts`,
  `test/intakeTurn.test.ts` — new unit tests covering: unchanged two-item body
  when no previous question is passed; a labelled untrusted context item added
  when one is; the eligible-context-item threading and its negative case (a
  non-question prior message) at the consumer level; both no-model paths
  (`human_handoff` stage and `stateVersion >= 12`, each asserted to make zero
  OpenAI calls) and the `stateVersion === 11` boundary (still one normal
  call); a completed stage's exemption from the ceiling; a malformed
  persisted snapshot on the no-model path returning `retry` and never
  finalizing; the no-progress fallback's positive case and its three negative
  cases (one prior question only, an actionable fact present, two
  non-identical prior questions); and `readCanonicalPersistedSnapshot`'s
  empty/valid/malformed-shape behavior (reusing the existing malformed-shape
  table).
- `docs/ai-behavior-and-safety.md`, `docs/inbound-queue.md`,
  `docs/live-ai-demo.md` — narrow Task 029 addenda describing the bounded
  context item, the two no-model paths, and the new opt-in multi-turn eval
  command, without editing any existing Task 007/008 content.
- `docs/product-roadmap.md` — one short Task 029 status/evidence paragraph
  only; no other task's listing was touched.
- `CURRENT_TASK.md` — this Observed context / Delivery record fill-in only.

**Verification commands run and results:**

```text
pnpm typecheck                → clean, zero errors
pnpm test                     → Test Files: 1 failed | 29 passed (30)
                                 Tests: 1 failed | 1127 passed | 2 skipped (1130)
pnpm install --frozen-lockfile→ "Already up to date"
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                               → succeeds, unchanged bindings (INTAKE_QUEUE,
                                 APP_TIMEZONE, WHATSAPP_GRAPH_API_VERSION)
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml \
  --env live-ai --outdir .wrangler/dry-run-live-ai
                               → succeeds, "No bindings found" (unchanged)
git diff --check              → exit 0, no whitespace errors (only benign
                                 CRLF/LF line-ending notices)
```

**The one test failure (documented, expected, out of implementer's allowed
scope to fix):**
`test/liveOpenAiEval.test.ts > live eval opt-in gate > loads a corpus of at
least 60 synthetic cases without making any network call` fails with
`AssertionError: expected '2026-08-06.1' to be '2026-08-13.1'`. Root cause:
the contract requires bumping `INTAKE_EXTRACTION_PROMPT_VERSION` to
`"2026-08-13.1"`, but `evals/intake-live-cases.json` and
`test/liveOpenAiEval.test.ts` are Task 028 artifacts outside this task's
allowed-changes list, so their `prompt_version` field was correctly left
unchanged rather than edited out of scope. This is the only failing test in
the suite; it makes no network call and is purely a version-string assertion.
Codex must decide the resolution (e.g., bump `evals/intake-live-cases.json`'s
`prompt_version` as an explicitly separate, narrow follow-up, since that file
is not gated by this task's scope list).

**Checks explicitly not run (per contract):**
The real multi-turn OpenAI evaluation (`pnpm eval:openai-multiturn`) was
**NOT RUN** — no `LIVE_OPENAI_MULTITURN_EVAL` flag was set and no real
OpenAI call, commit, push, deploy, or external mutation was performed at any
point in this task, per the user's explicit instruction and the contract's
review gates. Codex authorizes and runs the live gate after review, with the
user's explicit authorization.

**Known limitations / risks for Codex and Opus review:**

- The scope-conflict test failure above needs an explicit Codex decision
  before this task can be marked `COMPLETE`.
- `selectPreviousClinicQuestion`'s eligibility check only inspects the single
  nearest prior outbound message before the matching final inbound message;
  it does not scan further back, matching §1's "select only the most recent
  `direction === "outbound"` item" requirement exactly, but Codex should
  confirm this reading against production `recentMessages` ordering
  (chronological, capped at 12) is what was intended.
- `hasRepeatedNoProgressQuestion` scans the two most recent outbound messages
  anywhere in `recentMessages` (skipping inbound/system messages in between),
  not requiring them to be adjacent outbound turns; this matches "the two
  most recent prior outbound messages are identical eligible question texts"
  literally, but is worth an explicit second read against real conversation
  shapes.
- The no-model terminal/budget path builds a synthetic `PlanResult` with
  placeholder `safetyDecision: {kind:"continue_intake"}` / `petResolution:
  {kind:"needs_clarification"}` values; this is safe because
  `planIntakeReply` is confirmed (see Observed context) to short-circuit on
  `nextStage === "human_handoff"` before reading those fields. The
  no-progress branch copies a real plan and its appointment gate also stops
  on `nextStage === "human_handoff"`. These order dependencies must stay
  covered by consumer tests if either planner is reordered.
- Live multi-turn eval evidence is entirely unrun in this session; Codex's
  authorized real run is the only remaining evidence gap before any
  production behavior change could be considered validated end-to-end.

## Codex review record

Local review result: **PASS, pending only the explicitly authorized paid
multi-turn eval.**

Codex traced the production call path from Queue claim through context load,
the no-model branches, bounded OpenAI input, deterministic planning,
appointment gating, reply planning, and atomic finalization. The implementation
keeps one OpenAI request at most per Queue attempt, preserves Luna in
production, sends only the exact current message plus at most one labelled
untrusted prior question, and makes zero model calls in the handoff/version
ceiling branches. The canonical snapshot reader reuses the existing Task 014
trust boundary and returns fresh nested values.

Targeted Codex corrections:

- explicitly authorized a one-line `evals/intake-live-cases.json`
  `prompt_version` update so the full normal test suite remains green after
  the required prompt-version bump;
- required every new multi-turn case to have exactly the five contract fields
  and removed explanatory `note` extras;
- corrected `unspecifiedNotFalseRate` so it measures absent expected safety
  leaves as well as explicit `null` leaves;
- required the repeated-no-progress fallback to see the exact current claimed
  message as the final inbound before considering two prior outbound questions,
  preventing stale/later history from forcing a handoff;
- added boundary tests for all four short-answer examples, single-context data
  minimization, final-message mismatch, the 4,096-code-point ceiling,
  non-question repeats, stale history, and fresh nested snapshot copies;
- corrected narrow documentation wording and recorded the external $5 limit's
  possible enforcement lag.

Codex checked the official OpenAI model pages on 2026-08-13: Luna text pricing
is $0.20 input / $1.20 output per 1M tokens and Terra is $2.00 / $12.00. The
official conversation-state guide confirms that manually supplied message
items are a supported way to provide bounded state; this implementation does
not use stored responses, Conversations, tools, or full history.

Verification after the corrections:

```text
pnpm install --frozen-lockfile -> PASS (already up to date)
pnpm typecheck -> PASS
pnpm test -> PASS (30 files, 1,139 passed, 2 opt-in live tests skipped)
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run -> PASS
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml --env live-ai --outdir .wrangler/dry-run-live-ai -> PASS
git diff --check -> PASS (line-ending notices only)
```

Claude Opus's first read-only gate returned `CHANGES_REQUIRED`. Codex accepted
and closed both blocking findings with minimum in-scope changes:

- the no-model handoff plan now calls the unchanged
  `evaluateSafetyDecision` on the canonical persisted snapshot, so a sticky
  explicit danger signal retains `emergency_handoff` reply precedence without
  any OpenAI call;
- repeated-no-progress can no longer override a `completed` conversation.

Codex also documented that a *new* post-handoff danger statement is not
extracted and therefore cannot automatically raise an existing staff item to
urgent, added exact production-style multiline safety-question cases, and
made unexpected explicit `true` safety signals fail a case and appear as a
separate aggregate false-positive metric. Opus's prompt-version finding had
already been closed by the one-line Task 028 corpus metadata update recorded
above; its report referred to the pre-correction state.

Post-fix verification repeated the complete required gate: frozen install,
typecheck, all 30 test files (1,139 passed; two opt-in live tests skipped),
production dry-run, live-AI dry-run, and `git diff --check` all passed.

Claude Opus's narrow read-only re-check returned **PASS** on 2026-08-14. It
independently verified the restored deterministic emergency precedence, the
`completed`-stage guard, the documented post-handoff urgency limitation, the
production-format multiline safety-question cases, the unexpected-explicit-
`true` metric, and the aligned prompt version. It reported no new finding.
This software review does not replace the separate veterinarian approval of
clinical copy, safety questions, emergency directions, or triage thresholds.

No real OpenAI call, commit, push, deploy, plugin installation, or other
external mutation was performed during local review.

The user explicitly authorized the paid multi-turn gate on 2026-08-14. Codex
then ran `pnpm eval:openai-multiturn` once against the dedicated, restricted
OpenAI test project: 30 synthetic cases x 2 models, sequentially, 60 total
calls, in 127.8 seconds. The test itself passed (7/7).

- Luna: 30/30 valid schemas, zero provider failures, 51/52 expected leaves
  (98.08%), 29/30 exact cases, one complaint-follow-up mismatch
  (`T029-027`), 12/12 explicit-red recall, 24/24 explicit-false accuracy,
  204/204 unspecified-not-false, zero unexpected explicit-red signals,
  p50/p90/p99 1,842/4,601/4,913 ms, and estimated cost `$0.011948`.
- Terra: 30/30 valid schemas, zero provider failures, 52/52 expected leaves
  and 30/30 exact cases, the same perfect safety metrics and zero unexpected
  explicit-red signals, p50/p90/p99 1,661/2,373/8,737 ms, and estimated cost
  `$0.119816`.
- Combined estimated cost: `$0.131764`. No message text, prior question,
  provider body, model output, identifier, token, or secret was logged.

Decision: keep Luna as the production extraction model. It passed every
mandatory safety, schema, provider-failure, and latency gate; Terra's single
additional exact complaint-field match does not justify roughly 10x model
cost for this bounded structured-extraction role. The run establishes the new
`2026-08-13.1` engineering baseline; it is not directly comparable to the
pre-prompt-change Task 028 percentage and is not veterinarian-approved
clinical evidence. Task 029 is complete; no deployment or production-state
change was made.
