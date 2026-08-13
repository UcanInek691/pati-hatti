# Current task — 028 Gerçek OpenAI yerel sohbet ve model eval temeli

Status: `COMPLETE`

Owner: Claude Sonnet

## Goal

Add an isolated, local-only Turkish chat surface that sends synthetic free-text
messages to the real OpenAI Responses API, feeds the validated extraction into
the existing deterministic planners, and displays the result without WhatsApp,
Supabase, Queue, production data, or production mutation.

Also add the smallest reusable live-evaluation harness needed to compare
`gpt-5.6-luna` and `gpt-5.6-terra` on a reviewed synthetic corpus. This task
creates evidence; it does not approve a model for production.

## Scope

Allowed changes:

- `src/openaiIntake.ts` — only a fail-closed request timeout and a closed,
  evaluation-only way to call the same request/parser path with Luna or Terra;
  the production default and existing caller behavior must remain Luna.
- `test/openaiIntake.test.ts` — timeout/model-boundary regression tests.
- `src/liveAiDemo.ts` (new, separate Worker entry).
- `test/liveAiDemo.test.ts` (new; all OpenAI fetches mocked).
- `test/liveOpenAiEval.test.ts` (new, explicitly opt-in live integration test).
- `evals/intake-live-cases.json` (new, synthetic cases only).
- `wrangler.live-ai.toml` (new, local-only; OpenAI key only).
- `.dev.vars.live-ai.example` (new placeholder only).
- `.gitignore` (ignore the matching real local secret file only).
- `package.json` (`live-demo` and `eval:openai` scripts only; no dependency
  changes).
- `docs/live-ai-demo.md` (new).
- `docs/product-roadmap.md` (status/cross-reference only if evidence requires a
  narrow correction; do not rewrite the roadmap).
- `README.md` (one short local-live-demo link/command only).
- `CURRENT_TASK.md` (implementer fills only Observed context and Delivery
  record).

Do not change:

- `src/index.ts`, `src/intakeConsumer.ts`, `src/env.ts`, production
  `wrangler.toml`, migrations, database functions, Queue/Cron wiring, WhatsApp
  code, prompts, extraction schema, deterministic safety rules, Turkish reply
  copy, staff UI, appointment logic, dependencies, or lockfiles;
- the production model constant (`OPENAI_INTAKE_MODEL`) or its current Luna
  behavior;
- any real external resource, secret, production configuration, database, or
  deployment.

## Required design

### Reuse one provider path

- Do not duplicate the OpenAI prompt, JSON Schema, response parser, or
  `parseIntakeExtraction` boundary.
- Refactor only as much as needed so the production wrapper still calls Luna
  exactly as today while the isolated demo/eval path may choose only the closed
  set `gpt-5.6-luna | gpt-5.6-terra`.
- Any missing/blank key, unsupported model, timeout, network failure, non-2xx,
  refusal, incomplete response, malformed body, or invalid extraction fails
  closed without logging message/provider content. Evaluation metadata is
  optional and must never weaken the production extraction boundary.
- Add a fixed 30-second `AbortSignal.timeout` to the shared provider fetch.
  Production behavior changes only by becoming bounded and returning the
  existing `{ ok: false }` result on timeout.

### Isolated live chat

- `src/liveAiDemo.ts` is a separate Worker entry and is never imported by
  `src/index.ts` or another production runtime module.
- It may import the existing OpenAI adapter and pure planners. It must not
  import Supabase, Queue, WhatsApp send/ingest, staff, outbox, or production
  Worker entry modules.
- Routes are limited to `GET /`, `GET /app.js`, and
  `POST /api/message`; everything else fails generically.
- The page is Turkish, dependency-free, and visibly says:
  - this path really sends the entered text to OpenAI;
  - no real person, clinic, phone, pet, or patient data may be entered;
  - it does not send WhatsApp, notify staff, mutate a database, or book an
    appointment;
  - refresh/reset clears the local session.
- Render user-controlled/provider-derived fields with `textContent`, never
  HTML sinks. Apply `Cache-Control: no-store`, a restrictive CSP, no logging,
  exact JSON media type, a small byte limit, strict UTF-8, exact request keys,
  and a maximum 2,000 Unicode-code-point message.
- The browser presents a chat-like message composer and visible reset. It may
  choose Luna or Terra only from a fixed select. Model choice is for local
  comparison and never becomes a production environment variable.
- Use an obviously synthetic fixed clinic/owner/pet context. Return and display
  the real validated extraction, planner result, next stage, safety decision,
  reply, appointment action, selected model, elapsed time, and token usage when
  present. Never claim a real side effect.
- Keep session state only in browser memory and return a new strictly validated
  state after each turn so planner merge behavior can be exercised. The model
  still sees only the current inbound text in this task; label that limitation
  clearly because Task 029 owns contextual short-answer interpretation.
- Cap a browser session at 20 live calls and disable further send actions until
  reset. Document that the authoritative cost ceiling is the OpenAI project
  budget, not a browser control.

### Local secret isolation

- `wrangler.live-ai.toml` has no production binding, Queue, Cron, Supabase,
  Meta, staff, or other secret. It exposes only `OPENAI_API_KEY` from the
  untracked environment-specific local vars file.
- The committed example contains only a placeholder. The real file is ignored.
- Documentation must never ask the user to paste a key into a command, URL,
  browser form, source file, or committed config. Use an untracked local vars
  file and recommend a dedicated OpenAI project with a small budget.

### Live eval harness

- `evals/intake-live-cases.json` contains at least 60 clearly synthetic Turkish
  cases with stable IDs and expected structured facts. Cover ordinary intake,
  missing/unknown safety facts, all eight explicit true safety signals,
  explicit false facts, human request, medical-advice request, appointment
  request, spelling/spacing noise, prompt injection, and short-answer cases
  whose current-turn-only limitation is explicitly expected.
- Do not fabricate a veterinarian approval label. Mark cases as synthetic
  engineering expectations until a named veterinarian reviews them.
- `test/liveOpenAiEval.test.ts` is skipped unless an explicit live-eval flag and
  key are present. Normal `pnpm test` performs zero real call.
- The opt-in test runs the same cases against Luna and Terra with a bounded
  concurrency of one, repeats each case only when an explicit repeat count is
  supplied, and has a hard maximum of 2,000 provider calls per run.
- It prints or writes only aggregate metrics and failing synthetic case IDs:
  schema success, expected-field match, per-signal true/false/null counts,
  human/medical/appointment intent match, latency percentiles, provider failure
  count, missing-usage count, input/output token totals when reported, and
  estimated model cost. Never print keys, full prompts, full messages, raw
  provider bodies, or model output.
- A live run is evidence only. The production model remains Luna regardless of
  results; changing it requires a later reviewed task and the thresholds in
  `docs/product-roadmap.md`.

## Acceptance criteria

- The existing deterministic demo remains unchanged and still makes no
  external call.
- Production `extractIntakeViaOpenAi(message, safetyIdentifier, env)` keeps the
  same signature, same Luna default, same strict schema/parser, and same closed
  result, with only the new timeout behavior.
- The live demo uses the real adapter path with mocked fetch in automated
  tests, carries no production binding, and cannot accept an arbitrary model.
- A non-technical Turkish tester can enter synthetic free text, see a
  conversation-like sequence and reset it, while the current-turn-only model
  limitation remains visible and truthful.
- No user/provider content or secret is logged or persisted.
- The normal suite performs no network call. Live API execution is separately
  opt-in, bounded, synthetic-only, and cost-aware.
- No dependency, production route/config, database, Queue, WhatsApp, safety
  rule/copy, or appointment mutation change occurs.

## Required verification

Run without a real key:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml --outdir .wrangler/live-ai-dry-run
pnpm exec wrangler deploy --dry-run --config wrangler.demo.toml --outdir .wrangler/demo-dry-run
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Start the live demo with mocked/no key only to verify missing configuration
fails closed and no production binding appears. Do not make a real OpenAI call
as the implementing agent.

After Codex review, Codex or the user may perform the opt-in live run with a
dedicated local OpenAI project/key and a confirmed small budget. If no key or
budget is available, report the real live run as `NOT RUN`; never substitute a
mock result for live evidence.

No Opus review is required unless Codex finds a change to production model
selection, prompt/schema semantics, deterministic safety behavior, privacy
claims, or another production external-service boundary beyond the fixed
fail-closed timeout.

## Observed context

- Before this task, `src/openaiIntake.ts` exposed only
  `extractIntakeViaOpenAi(message, safetyIdentifier, env)`, always calling
  `OPENAI_INTAKE_MODEL = "gpt-5.6-luna"` with no request timeout (the fetch
  call had no `signal`).
- `src/localDemo.ts` (Task 027) already established the pattern this task
  reused: a separate Worker entry point never imported by `src/index.ts`,
  its own `wrangler.demo.toml`, `Cache-Control: no-store` + restrictive CSP
  security headers, `textContent`-only DOM rendering in embedded vanilla
  JS, and source-text regex isolation tests in
  `test/localDemo.test.ts`.
- The pure planners (`planIntakeTurn`, `planIntakeReply`,
  `planAppointmentAction`/`parseAppointmentDecision`) already had no I/O
  and no provider dependency, so they could be reused unchanged by the new
  live demo without modification.
- `src/intakeConsumer.ts` already established the
  `intakeData as unknown as Record<string, unknown>` cast used to bridge
  `PersistedIntakeData` into a plain JSON-serializable shape; the same
  cast was reused in `src/liveAiDemo.ts` for consistency rather than
  inventing a new pattern.
- `evaluateSafetyDecision` returns `continue_intake` only when every
  `reported_safety_signals` value is explicitly `false` (all-`null`
  produces `needs_safety_check`); this determined the safety-signal
  fixture used in `test/liveAiDemo.test.ts`'s success-path tests.

## Delivery record

Changed files:

- `src/openaiIntake.ts` — added `REQUEST_TIMEOUT_MS = 30_000` and
  `AbortSignal.timeout(REQUEST_TIMEOUT_MS)` on the shared fetch; extracted
  the shared request/parse logic into private `callOpenAiForIntake`,
  parameterized by model/credentials; production
  `extractIntakeViaOpenAi` is now a thin Luna-only wrapper with the same
  signature and result shape; added closed evaluation-only
  `extractIntakeViaOpenAiForEvaluation` restricted to
  `EVALUATION_MODELS = {"gpt-5.6-luna", "gpt-5.6-terra"}`; added
  `extractUsage()` for optional token-usage parsing.
- `test/openaiIntake.test.ts` — added timeout-signal and abort-fails-closed
  tests, and a 5-test `extractIntakeViaOpenAiForEvaluation` suite covering
  the closed model set, per-model request/response shape, usage parsing,
  and missing-key fail-closed behavior.
- `src/liveAiDemo.ts` (new) — isolated Worker entry: `GET /`, `GET /app.js`,
  `POST /api/message`; imports only `./conversationState` (types),
  `./intakeTurn`, `./intakeReply`, `./appointmentFlow`, `./openaiIntake`;
  fixed synthetic clinic/owner/pet context; strict request/state
  validation (exact keys, 2000-code-point message cap, closed
  Luna/Terra model set, 20-call session cap, byte-limited strict-UTF-8
  body reading); Turkish page with all required disclosures; `app.js`
  renders only via `textContent`, no `console.*`, no `eval`/`Function`/
  HTML-sink usage.
- `test/liveAiDemo.test.ts` (new, 36 tests) — routing/headers, all 5
  required Turkish disclosures + call-cap/budget note, `app.js` safety
  properties, request-validation-fails-closed (content type, malformed
  JSON, non-object body, exact keys, message length bounds, model closed
  set, state shape, call-count cap, byte limit, invalid UTF-8),
  success path across two turns with mocked fetch exercising the real
  planner chain, provider-failure/missing-key fail-closed, and
  local-isolation-from-production-runtime source-text checks.
- `evals/intake-live-cases.json` (new) — 66 synthetic Turkish cases (IDs
  `T028-001`..`T028-066`, all unique) covering ordinary intake (15),
  missing/unknown safety facts (5), all 8 explicit-true safety signals
  (8), all 8 explicit-false safety signals (8), human request (5),
  medical-advice request (5), appointment request (5), spelling/spacing
  noise (5), prompt injection (5), and short-answer/current-turn-limitation
  cases (5). Marked as synthetic engineering expectations, not
  vet-approved.
- `test/liveOpenAiEval.test.ts` (new) — `describe.skipIf` gated on
  `LIVE_OPENAI_EVAL=1` AND a non-empty `OPENAI_API_KEY`; sequential
  (concurrency-1) loop over the corpus × {Luna, Terra} × repeat count
  (default 1); hard cap asserted at 2000 total planned calls before any
  call is made; reports only aggregate metrics (schema success/failure,
  expected-field exact-match count, per-signal true/false/null counts,
  human/medical/appointment intent-match counts, latency p50/p90/p99,
  provider failure count, missing-usage count, token totals, and an
  optional cost estimate computed only from caller-supplied
  `LIVE_OPENAI_EVAL_PRICE_*_PER_1M_{LUNA,TERRA}` env vars, never a
  fabricated price) plus failing case IDs only — never message text, keys,
  raw provider bodies, or model output. Two always-on gate tests confirm
  the opt-in skip condition and that the corpus loads with ≥60 cases,
  with zero network calls.
- `wrangler.live-ai.toml` (new) — `name`, `main = "src/liveAiDemo.ts"`,
  `compatibility_date`, and an `[env.live-ai]` block (no `[vars]`, queue,
  cron, or binding) so `wrangler dev --env live-ai` loads
  `.dev.vars.live-ai` instead of the shared `.dev.vars`.
- `.dev.vars.live-ai.example` (new) — placeholder
  `OPENAI_API_KEY=[openai-api-key]` only.
- `.gitignore` — added `.dev.vars.live-ai` (the real, untracked secret
  file).
- `package.json` — added `live-demo` script
  (`wrangler dev --config wrangler.live-ai.toml --env live-ai --local
  --port 8791`) and `eval:openai` script
  (`vitest run test/liveOpenAiEval.test.ts`); no dependency changes.
- `docs/live-ai-demo.md` (new) — setup, secret isolation, required
  disclosures, and the opt-in eval-harness usage.
- `README.md` — one new section with a short link to
  `docs/live-ai-demo.md` and the `pnpm live-demo` command.
- `docs/product-roadmap.md` — not changed; its existing Task 028
  description was already accurate and required no correction.
- `CURRENT_TASK.md` — this Observed context / Delivery record only.

Test results:

- `pnpm install --frozen-lockfile` — already up to date, no changes.
- `pnpm typecheck` (`tsc --noEmit`) — clean, no errors.
- `pnpm test` (`vitest run`) — **29 test files passed, 1093 tests passed,
  1 test skipped** (the opt-in live-eval test, correctly gated), 0
  failures. Includes the pre-existing full suite plus all new/modified
  files.
- `pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml
  --outdir .wrangler/live-ai-dry-run` — succeeded, **"No bindings
  found."** (confirms no production binding leaks into the live-ai
  config); emitted a benign `[env.live-ai]`/`-e|--env` mismatch warning
  because the required command omits `--env`, which does not affect the
  dry-run result.
- `pnpm exec wrangler deploy --dry-run --config wrangler.demo.toml
  --outdir .wrangler/demo-dry-run` — succeeded, "No bindings found.",
  unchanged from before this task.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run`
  (production `wrangler.toml`) — succeeded, production bindings
  unchanged.
- `git diff --check` — exit 0; only benign LF→CRLF line-ending advisory
  warnings on 4 files (Windows checkout behavior), no real whitespace
  errors.
- Manual fail-closed check: started `pnpm live-demo` locally with no
  `.dev.vars.live-ai` file present (so `OPENAI_API_KEY` is undefined).
  `GET /` returned 200 with the expected security headers. `POST
  /api/message` with a synthetic ASCII message returned
  `{"ok":false,"model":"gpt-5.6-luna","elapsedMs":0,"state":{...,
  "callCount":1}}` — i.e. it failed closed immediately, before any
  fetch could occur (guaranteed by `callOpenAiForIntake`'s credential
  check preceding the `fetch` call), and no production binding was
  reachable. The server was then stopped. As the implementing agent, no
  real OpenAI API call was made at any point.
  - Note: an earlier manual check using a Turkish-language curl payload
    unexpectedly returned 400 instead of the same fail-closed 200; this
    traced to the local shell mangling UTF-8 bytes in a single-quoted
    heredoc on this Windows/Git-Bash setup, not a defect — the worker's
    strict-UTF-8 body validation correctly rejected the malformed bytes.
    Automated coverage of both valid and deliberately-invalid UTF-8
    bodies already exists in `test/liveAiDemo.test.ts` and passed.

Live/real checks NOT run (as instructed — no real OpenAI call, no real
secret, no commit/push/deploy):

- The real OpenAI Responses API was never called under either model.
- `test/liveOpenAiEval.test.ts`'s live-run test was not executed — report
  as **NOT RUN**. It requires `LIVE_OPENAI_EVAL=1` and a real
  `OPENAI_API_KEY`; per the task's binding constraint against real
  secrets/calls, this was intentionally left for Codex/the user to run
  opt-in with a dedicated, budget-capped OpenAI project.
- No commit, push, or deploy was performed.

Known limitations / risks for Codex (and Opus if warranted) to inspect:

- The live-eval harness's "expected-field match" metric uses strict
  `JSON.stringify` deep equality against `evals/intake-live-cases.json`'s
  `expected` objects. Real model output may reasonably diverge in wording
  (e.g. `complaint` phrasing) while still being clinically correct; the
  corpus and its `$disclaimer` field document this as expected
  engineering-only ground truth, not a pass/fail correctness bar — Codex
  should confirm this framing is acceptable before any live run is
  treated as evidence.
  - `evals/intake-live-cases.json`'s `expected` values were authored by
    the implementer from the JSON Schema in `src/openaiIntake.ts`, not by
    a veterinarian; the file's `$disclaimer` says so explicitly.
- `estimateCostUsd` in `test/liveOpenAiEval.test.ts` only computes a cost
  when the caller supplies `LIVE_OPENAI_EVAL_PRICE_*_PER_1M_{LUNA,TERRA}`
  env vars; with no price configured it reports `null` rather than a
  fabricated number — Codex should confirm this is the desired behavior
  versus, e.g., a hard failure.
- The `pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml`
  dry run (as specified, without `--env`) emits a Wrangler warning about
  the `[env.live-ai]` block vs. the missing `-e` flag; this is expected —
  `.dev.vars.live-ai` file selection only activates when `--env live-ai`
  is passed (as `live-demo` in `package.json` does) — but Codex should
  re-verify this Wrangler environment-file convention against the
  installed Wrangler version (4.118.0) since it is version-sensitive
  behavior this implementer could not fully black-box test without a
  real key.
- No change was made to `docs/product-roadmap.md`; its existing forward
  reference to Task 028 was judged accurate as written. Codex should
  confirm no roadmap status/threshold table needs updating now that
  Task 028 evidence-gathering tooling exists (the roadmap explicitly
  still gates any model change on a later reviewed task).
- This implementer ran `wrangler dev --config wrangler.live-ai.toml
  --env live-ai --local --port 8791` locally to verify fail-closed
  behavior, then terminated the full process tree; Codex should be aware
  this leaves no persistent local state, but should independently confirm
  no `workerd`/`wrangler` process remains running in its own review
  environment.

## Codex review record

Decision: `PASS` on 2026-08-13. No Opus review was required because the
production model, prompt/schema semantics, deterministic safety decisions,
reply copy, and production bindings were unchanged; the only production-path
behavior change is the specified fail-closed 30-second timeout.

Targeted review fixes:

- The local model allow-list is now an immutable two-item tuple and untrusted
  provider usage metadata accepts only nonnegative safe integers.
- Browser-returned intake state is parsed through the existing extraction
  validator before any paid request, and a pet ID outside the single fixed
  synthetic context is rejected. The textarea limit now matches the server's
  2,000-code-point ceiling.
- Secret setup no longer places an API key in a shell command. `pnpm
  eval:openai` loads the ignored `.dev.vars.live-ai` file through Node's
  built-in `--env-file`; a placeholder-only local check proved the command
  loads and remains skipped without live opt-in.
- The eval now records eval/prompt/model versions, scores expected leaf fields
  independently, reports explicit-red-signal recall, explicit-false accuracy,
  and unspecified-not-false rate, and always computes cost from the official
  prices checked on 2026-08-13. The contradictory `T028-064` expectation was
  corrected so explicit “kanama yok” maps to `heavy_bleeding=false`.
- The roadmap's JSONL wording was corrected to match the committed JSON corpus.
  Browser call count is documented truthfully as a convenience rather than a
  billing hard stop.

Codex verification:

- `pnpm install --frozen-lockfile` — pass, already up to date.
- `pnpm typecheck` — pass, zero errors.
- `pnpm test` — pass: 29 files, 1,100 tests passed, one opt-in live test
  skipped, zero failures.
- Live-AI, deterministic-demo, and production Wrangler dry-runs — all pass;
  both demo bundles expose no bindings and production bindings are unchanged.
- `pnpm eval:openai` with an ignored placeholder file and live flag disabled —
  pass, four local gate tests passed and the live test skipped; zero network
  call.
- `git diff --check` — pass; only benign Windows line-ending advisories.
- Real-looking secret scan — no match; `.dev.vars.live-ai` absent after the
  local check; no Wrangler/workerd process remained.

Real Luna/Terra API execution remains `NOT RUN`. It requires the user's
separate OpenAI test project/key and explicit confirmation of a small spend.
