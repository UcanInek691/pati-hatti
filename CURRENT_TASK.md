# Current task — 027 Yerel Türkçe kullanıcı test ekranı

Status: `COMPLETE`

Owner: Claude Sonnet

## Goal

Create a local-only Turkish demo surface that lets a non-technical product
owner exercise the reviewed deterministic intake, safety, reply, and
appointment-decision behavior without WhatsApp, OpenAI, Supabase, Cloudflare
Queues, real credentials, or production data.

This is a product-behavior simulator, not an integration test and not a
production route.

## Scope

Allowed changes:

- `src/localDemo.ts` (new, separate Worker entry)
- `test/localDemo.test.ts` (new)
- `wrangler.demo.toml` (new, local-only config with no bindings or triggers)
- `package.json` (`demo` script only; no dependency changes)
- `docs/local-demo.md` (new)
- `README.md` (one local-demo link/command only)
- `CURRENT_TASK.md` (implementer fills only Observed context and Delivery record)

Do not change:

- `src/index.ts`, `src/env.ts`, production `wrangler.toml`, migrations, prompts,
  safety rules, Turkish reply copy, existing runtime modules, dependencies, or
  lockfiles;
- production routes, Queue/Cron configuration, database state, secrets, or
  external services.

## Required behavior

### Local isolation

- `src/localDemo.ts` is a separate Worker entry and is never imported by
  `src/index.ts` or any production runtime module.
- `wrangler.demo.toml` has no Supabase, OpenAI, Meta, Queue, Cron, or secret
  bindings and defines no production resource.
- The demo performs no outbound `fetch`, database mutation, Queue operation,
  logging of user-entered text, or persistence. Refreshing the page resets it.
- The page and API responses use `Cache-Control: no-store` and a restrictive
  CSP. Remote/user-controlled text must be rendered with `textContent`, never
  inserted with `innerHTML`.

### Turkish tester experience

- `GET /` serves one dependency-free Turkish page with a prominent banner:
  "Yerel simülasyon — gerçek WhatsApp, yapay zekâ ve veritabanı kullanılmaz."
- The page explains in plain Turkish what is and is not being tested.
- It includes one-click synthetic scenarios for at least:
  1. known pet + ordinary complaint;
  2. pet identity clarification;
  3. unknown safety facts;
  4. one explicit emergency signal;
  5. explicit human request;
  6. medical-advice request;
  7. appointment request reaching an offer;
  8. exact `EVET`, exact `HAYIR`, and unrecognized appointment reply.
- Every scenario uses obviously synthetic identifiers and content; no real
  person, phone number, clinic, pet, or provider identifier.
- The visible result shows, in Turkish-friendly labels, the actual planner
  result, next stage, safety outcome, reply category/text, and appointment
  action where applicable. It must not claim that a message was sent, a staff
  member was notified, a database row changed, or an appointment was booked.
- The user can reset the screen and can rerun scenarios deterministically.

### Reuse the reviewed product logic

- Scenario inputs may be fixed local fixtures, but results must be computed by
  the existing exported production functions rather than copied rules:
  `planIntakeTurn`, `planIntakeReply`, and where applicable
  `planAppointmentAction` / `parseAppointmentDecision`.
- Do not duplicate the safety precedence, reply strings, stage logic, or
  EVET/HAYIR grammar in the demo.
- Invalid scenario IDs and malformed API requests fail closed with a generic
  400/404 response and no echo of request content.

### Local run command

- Add exactly one script:
  `"demo": "wrangler dev --config wrangler.demo.toml --local --port 8790"`.
- `docs/local-demo.md` gives non-technical Windows instructions:
  `pnpm.cmd demo`, open `http://127.0.0.1:8790`, stop with `Ctrl+C`.
- Document the limitation that this demo does not validate real OpenAI
  extraction, Meta webhook/delivery, Supabase RLS/migrations, Queue/DLQ, Cron,
  staff login, or production configuration.

## Acceptance criteria

- A non-technical Turkish reader can launch and use the demo without entering
  credentials or editing JSON.
- All required scenarios render a deterministic result through the existing
  reviewed pure functions.
- Emergency, human-handoff, unknown-safety, ordinary-intake, appointment
  offer, EVET, HAYIR, and repeat paths are visibly distinguishable.
- No production entry/config file changes and no real external call occurs.
- Tests cover routing, headers/CSP, all scenario outcomes, malformed/unknown
  requests, deterministic reruns, Turkish disclaimer, and the absence of
  production imports/bindings.
- Existing tests remain unchanged and passing.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --config wrangler.demo.toml --outdir .wrangler/demo-dry-run
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Also start `pnpm demo` and perform a local smoke test of `/` plus every scenario
API. If the known Windows `workerd` native crash recurs before a request is
handled, record the smoke test as `NOT RUN` with the exact failure; do not
weaken the implementation or add a dependency as a workaround.

No Opus review is required unless Codex finds a change to production runtime,
safety logic/copy, privacy behavior, or external-service boundaries.

## Observed context

- Reused pure planners without modification: `planIntakeTurn` (`src/intakeTurn.ts`),
  `planIntakeReply` (`src/intakeReply.ts`), `planAppointmentAction` and
  `parseAppointmentDecision` (`src/appointmentFlow.ts`), plus their types from
  `src/conversationState.ts` and `src/intakeExtraction.ts`.
- `src/intakeConsumer.ts` shows the real production routing order: `planIntakeTurn` →
  `planAppointmentAction`; a reply is only planned via `planIntakeReply` when
  `appointmentAction.kind === "none"`. `src/localDemo.ts`'s `runScenario` mirrors this
  exact order so the demo never diverges from production control flow.
- `IntakeReplyCategory` on `IntakeReplyPlan` nominally includes
  `appointment_offer|appointment_confirmed|appointment_declined|appointment_unavailable`,
  but `planIntakeReply` never returns them — the real appointment-reply text is produced
  inside Supabase RPCs (`finalize_appointment_offer_queue_job`,
  `finalize_appointment_decision_queue_job`), not by any reusable pure TypeScript
  function. The demo therefore never fabricates that text: whenever
  `appointmentAction.kind !== "none"`, the UI shows only the appointment action and
  displays `reply: null` with a note that the real message is generated in the database.
- `src/staffPage.ts` was read only as a reference pattern (dependency-free HTML/JS,
  security headers, `textContent`-only rendering) and is not imported by
  `src/localDemo.ts`, which defines its own local `SECURITY_HEADERS`/CSP constants to
  stay fully self-contained.
- Discovered during the local smoke test (not the documented Windows `workerd` native
  crash): `wrangler dev --local` treats every *named* export of the Worker entry module
  as a potential entrypoint and rejects non-function values with
  `Uncaught TypeError: Incorrect type for map entry '<name>': the provided value is not
  of type 'function or ExportedHandler'`. `src/localDemo.ts` originally exported the
  `LOCAL_DEMO_HTML`/`LOCAL_DEMO_APP_JS` string constants (and `runScenario`,
  `ScenarioResult`) for direct test import. Fixed by making them module-private and
  having `test/localDemo.test.ts` assert against the actual HTTP responses
  (`worker.fetch(...)`) instead of importing the constants — no dependency added, no
  production file touched.

## Delivery record

Implemented by: Claude (Sonnet 5 / Opus 5 session), 2026-08-11.

Files added: `src/localDemo.ts`, `wrangler.demo.toml`, `test/localDemo.test.ts`,
`docs/local-demo.md`.
Files edited (within allowed scope only): `package.json` (`demo` script only),
`README.md` (one local-demo link/command), `CURRENT_TASK.md` (this section).
No production file (`src/index.ts`, `src/env.ts`, production `wrangler.toml`,
migrations, prompts, safety rules, Turkish reply copy, existing runtime modules) was
changed. No dependency was added; `package.json`'s `devDependencies` are unchanged.

Verification results (run from repo root, `C:\Users\mehme\Documents\weosa all\vetai`):

- `pnpm install --frozen-lockfile` — OK, "Already up to date".
- `pnpm typecheck` (`tsc --noEmit`) — OK, no errors.
- `pnpm test` (`vitest run`) — OK, 27 test files / 1046 tests passed, including the new
  33 tests in `test/localDemo.test.ts` (routing, security headers, CSP, all 10 required
  scenario outcomes, malformed/unknown-request handling, deterministic reruns, the
  exact Turkish banner text, and the absence of production imports/bindings). All
  pre-existing tests remain unchanged and passing.
- `pnpm exec wrangler deploy --dry-run --config wrangler.demo.toml --outdir
  .wrangler/demo-dry-run` — OK: "No bindings found." Confirms the demo config defines
  no Supabase/OpenAI/Meta/Queue/Cron/secret binding.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — OK: production
  Worker still resolves its real bindings unchanged (`env.INTAKE_QUEUE`,
  `env.APP_TIMEZONE`, `env.WHATSAPP_GRAPH_API_VERSION`), confirming `src/index.ts` and
  the production `wrangler.toml` were not altered.
- `git diff --check` — exit 0 (only benign CRLF/LF autocrlf warnings on
  `CURRENT_TASK.md`, `README.md`, `package.json`; no whitespace errors).
- Local smoke test: ran `pnpm demo` (port 8790). Initial run hit a real startup crash
  (see Observed context) that was root-caused and fixed, not worked around. After the
  fix, the server started cleanly and every route was exercised manually:
  `GET /` → 200 HTML with banner text; `GET /app.js` → 200 JS; `GET /api/scenarios` →
  200 with all 10 scenario ids/labels; `POST /api/scenario` → 200 for all 10 scenario
  ids, response bodies inspected and match expected `plan`/`safetyDecision`/
  `appointmentAction`/`reply` shapes (e.g. the emergency scenario returned
  `safetyDecision: { kind: "emergency_handoff", positiveSignals: ["breathing_difficulty"] }`,
  `reply.category: "emergency_handoff"`); malformed JSON → 400; unknown scenario id →
  404; wrong content-type → 400; unknown path → 404. Server process was then stopped
  (`Stop-Process`) and confirmed no longer listening on port 8790.

No real WhatsApp, OpenAI, Supabase, or Cloudflare Queue call occurred at any point.
No commit, push, or deploy was performed.

Codex review, 2026-08-11:

- Confirmed the diff is limited to the local demo contract and does not alter
  the production entry, environment, Wrangler configuration, dependencies,
  migrations, prompts, safety rules, or reply copy.
- Tightened the local request boundary to reject extra JSON fields and applied
  the restrictive CSP to every HTML, script, API, and error response.
- Re-ran frozen install, typecheck, the full 1,047-test suite, both demo and
  production Worker dry-runs, and `git diff --check`; all passed. The demo
  dry-run has no bindings and the production binding list is unchanged.
- Opened the live local page in the in-app browser and verified the emergency
  and exact-EVET interactions through the rendered UI. The demo made no claim
  that it sent a message, notified staff, changed a database, or booked an
  appointment.
- Decision: PASS. Opus review is not required because no production, safety,
  privacy, or external-service boundary changed.
