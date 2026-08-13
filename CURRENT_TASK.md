# Current task — 028 Gerçek OpenAI yerel sohbet ve model eval temeli

Status: `READY`

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

To be filled by the implementer from repository evidence.

## Delivery record

To be filled by the implementer from repository evidence.
