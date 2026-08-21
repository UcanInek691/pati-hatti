# Current task — 034 Real staging and same-number WhatsApp evidence

Status: `IN_REVIEW`

Owner: Claude Sonnet (repository preparation), then Codex (review and live execution)

## Goal

Prepare and then exercise one isolated, synthetic-data staging environment for
the already-reviewed VetAI Worker. The task must establish evidence for:

1. migration-history-based Supabase staging;
2. a separate Cloudflare Worker, three separate staging Queues, Cron, and
   secret bindings;
3. a real Meta webhook/inbound/outbound/status journey;
4. all three Task 033 modes (`ai | manual | personal`); and
5. whether the selected Turkish pilot number can actually use WhatsApp
   Business App / Cloud API Coexistence and how app-originated message echoes
   behave.

This remains one task. Repository preparation does not authorize external
resource creation. After Codex review, Codex must obtain explicit user approval
before any cost-bearing resource creation, remote migration, secret mutation,
Meta configuration, or deployment.

## Product decision

- Staging uses synthetic clinic/owner/pet/message data only.
- No production resource, identifier, secret, phone number, or patient data may
  enter Git, logs, screenshots, or evidence documents.
- Coexistence is an empirical gate, not an assumed feature. Record either:
  - `VERIFIED`: the chosen number can continue using the Business App while the
    Cloud API path works and message echoes do not create bot loops; or
  - `UNAVAILABLE`: exact sanitized Meta UI/API evidence identifies the blocker,
    and a reviewed staff Cloud API composer becomes a controlled-pilot blocker.
- Do not build that composer in this task.

## Sources and constraints

- Cloudflare Wrangler named environments create distinct Workers and require
  bindings to be declared per environment:
  <https://developers.cloudflare.com/workers/wrangler/environments/>.
- Cloudflare Queue resources are created separately from Worker bindings:
  <https://developers.cloudflare.com/queues/reference/wrangler-commands/>.
- Supabase staging must use a separate environment and migration history, not
  copied production data or ad-hoc SQL-editor schema application:
  <https://supabase.com/docs/guides/deployment/managing-environments> and
  <https://supabase.com/docs/guides/local-development/cli-workflows>.
- Meta's current Business App onboarding/Coexistence path must be verified in
  the authenticated Meta UI for the actual test account; repository docs must
  not promise regional/account eligibility:
  <https://developers.facebook.com/docs/whatsapp/embedded-signup/direct-onboarding-existing-users/existing-whatsapp-business-app-users>.

## Phase A — Sonnet repository preparation

### Allowed changes

- `wrangler.staging.toml` (new)
- `docs/staging-runbook.md` (new)
- `docs/production-readiness.md`
- `docs/product-roadmap.md` (Task 033/034 status text only)
- `README.md` (one link only)
- `CURRENT_TASK.md` (`Observed context` and `Delivery record` only)

No source, prompt, migration, SQL fixture, test, dependency, lockfile, existing
Wrangler config, environment type, Queue consumer, reply text, or KVKK/veterinary
approval package may change.

### Staging Wrangler contract

Create one standalone `wrangler.staging.toml` that reuses `src/index.ts` and:

- names the Worker `vetai-staging`;
- uses the production compatibility date and the same non-secret variables;
- binds producer `INTAKE_QUEUE` to `vetai-intake-staging`;
- declares consumers for `vetai-intake-staging` and
  `vetai-intake-dlq-staging` with the exact production retry/batch settings;
- routes their dead letters respectively to `vetai-intake-dlq-staging` and
  `vetai-intake-terminal-dlq-staging`;
- declares the same Cron trigger;
- contains no route/custom domain, real identifier, secret, placeholder secret,
  automatic provisioning flag, or production Queue name.

Do not add a wrapper script or dependency. Wrangler dry-run plus the runbook's
native commands are sufficient.

### Staging runbook contract

`docs/staging-runbook.md` must be an executable Turkish checklist with these
closed sections:

1. **Authority and cost gate** — list every remote mutation and state that
   Codex pauses for explicit user approval before executing it.
2. **Read-only preflight** — confirm authenticated Cloudflare/Supabase/Meta
   accounts, current project/portfolio, intended region, current Queues/Workers,
   and expected spending tier before mutation.
3. **Supabase** — create/select a dedicated staging project; link only after
   showing the exact project ref; run migration dry-run then migration-history
   push; compare migration list; never run rollback fixtures or production data.
4. **Cloudflare** — create the three exact staging Queues, set the seven secret
   bindings interactively, deploy only `vetai-staging`, and verify bindings,
   Cron, `/health`, and `/ready`.
5. **Synthetic prerequisites** — one fabricated clinic/account/staff user/pet,
   one future appointment slot, and one designated test sender. No real patient
   or friend conversation.
6. **Meta** — webhook challenge, `messages` subscription, real inbound text,
   outbound delivery/status callback, and sanitized evidence fields.
7. **Selective automation matrix** — sequentially verify the same designated
   sender in `personal`, `manual`, then `ai`; state exact expected persistence,
   Queue, OpenAI, outbox, and reply behavior for each.
8. **Manual-takeover race** — switch an AI contact to manual while work is
   pending and prove no new outbox reply is committed; acknowledge that a reply
   already submitted to Meta cannot be recalled.
9. **Appointment and safety smoke** — synthetic safety handoff, staff-item
   visibility, appointment offer → `EVET`, and separate offer → `HAYIR`.
10. **Coexistence evidence** — eligibility/onboarding result, Business App
    inbound visibility, API reply visibility in the app, app-originated
    `smb_message_echoes` behavior, and explicit no-loop/no-persistence result.
11. **Evidence template** — timestamps, closed PASS/FAIL/NOT RUN result, HTTP or
    closed RPC outcome, redacted resource alias, and screenshot filename only;
    never raw bodies, phone numbers, tokens, user text, provider IDs, or keys.
12. **Stop/rollback/cleanup** — unsubscribe webhook or disable Worker first,
    allow Queue disposition without purge, use forward-only migration repair,
    and list resource deletion only as an explicitly approved final action.
13. **Decision table** — define the exact `VERIFIED` vs `UNAVAILABLE`
    Coexistence outcomes and the resulting pilot decision.

The runbook must distinguish facts that Sonnet can validate locally from live
steps reserved for Codex. It must not mark a live checkbox complete.

### Documentation corrections

- Update `docs/production-readiness.md` so staging is performed before any
  production smoke journey and cross-link the new runbook.
- Update only the stale Task 033/034 status paragraphs in
  `docs/product-roadmap.md`: Task 033 is complete and validated on disposable
  `vetai-test`; Task 034 repository preparation is in progress, with live
  evidence still not run.
- Add one README link to the staging runbook.

## Phase B — Codex live execution (not Sonnet)

After Phase A delivery, Codex reviews the diff and reruns local checks. Then:

1. perform read-only account/resource discovery;
2. present the exact resource plan and any expected price to the user;
3. request explicit approval;
4. create/configure only the approved staging resources;
5. execute the runbook with synthetic data;
6. record sanitized evidence in the Codex review record or a new evidence file
   only if Codex first adds that file to this contract;
7. stop immediately on target ambiguity, secret exposure, real-person data, an
   unexpected charge, or any tenant/safety failure.

No production deployment is authorized by Task 034.

## Acceptance criteria

### Repository gate

- Staging config is syntactically valid and has only staging resource names.
- Production `wrangler.toml` and runtime behavior are unchanged.
- Runbook contains every section above and no live claim.
- No secret or real identifier appears in the diff.
- No new code, dependency, test framework, migration, or schema change.

### Live evidence gate

Task 034 becomes `COMPLETE` only if Codex records all of the following after
explicit approval:

- migration history and read-only RLS/grant catalog checks pass on staging;
- three staging Queues, Worker bindings, Cron, `/health`, and `/ready` pass;
- real Meta inbound → Queue → OpenAI → atomic finalize → outbound → status
  works using synthetic text;
- `personal`, `manual`, and `ai` behavior matches Task 033 exactly;
- safety handoff, staff visibility, `EVET`, and `HAYIR` smoke paths pass;
- Coexistence is honestly classified `VERIFIED` or `UNAVAILABLE` with sanitized
  evidence and a corresponding pilot decision;
- no production resource/data was touched and no secret was recorded.

If external access or eligibility is absent, do not fabricate completion. Keep
the task in review and record the exact blocker.

## Required local verification

Sonnet runs:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

No paid OpenAI eval is required because prompt/model/extraction/safety/reply
logic is out of scope.

## Review gate

- Mandatory: Codex config/runbook review and all live execution.
- Claude Opus is not required because no new RLS, clinical safety, KVKK data
  boundary, or runtime logic is allowed. If implementation crosses one of
  those boundaries, stop and revise the contract rather than silently adding
  an Opus gate.

## Observed context

- Repository was clean at start (`git status --short` empty); last commit
  `9ee9afc docs: define real staging evidence task`.
- Production `wrangler.toml`: Worker `vetai`, `main = "src/index.ts"`,
  `compatibility_date = "2025-01-01"`, `[vars]` = `APP_TIMEZONE`,
  `WHATSAPP_GRAPH_API_VERSION`; producer/consumer bindings for
  `vetai-intake` → `vetai-intake-dlq` → `vetai-intake-terminal-dlq` with
  `max_batch_size=1`, `max_batch_timeout=5`, `max_retries=3`,
  `retry_delay=120`/`300`; Cron `* * * * *`. `wrangler.staging.toml` mirrors
  this exactly with staging Worker/queue names, per the contract.
- `src/env.ts`, `src/readiness.ts`, and a complete `env.*` usage scan show
  exactly **seven** runtime-required
  non-`[vars]` values (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY`,
  `OPENAI_API_KEY`, `WHATSAPP_ACCESS_TOKEN`), matching
  `docs/production-readiness.md` §3 and `.dev.vars.example`. Codex corrected
  the Phase A contract from eight to seven during review; no eighth runtime
  value exists.
- `docs/product-roadmap.md`'s Task 033 status paragraph was stale relative to
  `PROJECT_CONTEXT.md` (Task 033 is recorded complete, validated on
  disposable `vetai-test`, 1,336/1,336 tests, Codex + Opus review passed);
  updated in place along with a new Task 034 in-progress paragraph.
- Confirmed routes in `src/index.ts`: `GET /health`, `GET /ready`,
  `GET|POST /webhooks/whatsapp`, `/staff*`.
- `supabase/migrations/` currently ends at
  `20260814000300_selective_automation.sql`; `supabase/tests/` currently
  ends at `033_selective_automation.sql` — used as the exact reference point
  in the runbook's Supabase migration-list comparison step.

## Delivery record

### Changed files

- `wrangler.staging.toml` (new) — standalone staging config, no source/route/
  secret/production Queue name.
- `docs/staging-runbook.md` (new) — Turkish executable checklist, all 13
  contract sections present, every live item unchecked (`[ ]`), no live
  claim.
- `docs/production-readiness.md` — one paragraph added to §5 requiring
  staging to pass first, cross-linking the new runbook.
- `docs/product-roadmap.md` — Task 033 status paragraph corrected to
  "complete/validated"; new Task 034 repository-preparation-in-progress
  paragraph added. No other text changed.
- `README.md` — one link added to `docs/staging-runbook.md`.
- `CURRENT_TASK.md` — this Observed context and Delivery record only.

No source, prompt, migration, SQL fixture, test, dependency, lockfile,
existing Wrangler config, environment type, Queue consumer, reply text, or
KVKK/veterinary approval package was touched.

### Acceptance criteria satisfied (repository gate)

- Staging config is syntactically valid and uses only staging resource
  names — confirmed by the staging Wrangler dry-run (see below).
- Production `wrangler.toml` and runtime behavior are unchanged (not
  edited; production dry-run output unchanged from baseline expectations).
- Runbook contains all 13 required sections and marks no live checkbox
  complete.
- No secret or real identifier appears in the diff (`git diff` for the four
  changed tracked files scanned for secret/token/key/password patterns:
  none found; new files contain only placeholder/redacted-alias examples).
- No new code, dependency, test framework, migration, or schema change.

### Exact checks and results

```text
pnpm install --frozen-lockfile   → "Already up to date", exit 0
pnpm typecheck                   → tsc --noEmit, no output, exit 0
pnpm test                        → 32 test files passed, 1336 passed / 2 skipped (1338 total), exit 0
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  → Worker "vetai", queue "vetai-intake" binding, exit 0
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
                                  → Worker "vetai-staging", queue "vetai-intake-staging" binding, exit 0
git diff --check                 → only LF/CRLF line-ending warnings, no whitespace errors, exit 0
```

### Live checks

All Meta/Cloudflare/Supabase live steps in `docs/staging-runbook.md`
(§§2–10, §12): `NOT RUN — reserved for Codex`. No Cloudflare, Supabase,
Meta, or OpenAI resource was created, modified, or called. No deploy,
remote migration, or secret mutation occurred.

### Known limitations / risks for Codex to inspect

- The runbook's §10 Coexistence steps (Business App inbox visibility,
  `smb_message_echoes` behavior, no-loop confirmation) are necessarily
  written from documentation and code reading, not from an authenticated
  Meta session — Codex must treat every expected behavior there as a
  hypothesis to empirically confirm, not a given.
- The runbook assumes the designated test sender and Meta test WABA number
  are already available to Codex; provisioning/selecting that number is a
  Phase B action outside this task's allowed file list.
- `wrangler queues create` for the three staging queues must run before
  `wrangler deploy --config wrangler.staging.toml` (queue bindings do not
  auto-provision the underlying resource); the runbook §4 sequences this
  correctly but Codex should confirm current Wrangler behavior has not
  changed.

## Codex review record

Phase A repository preparation reviewed with minimum corrections:

- corrected the task's mistaken secret count from eight to the seven values
  actually used by `Env`, `checkReadiness`, `.dev.vars.example`, and the full
  `env.*` usage scan;
- corrected the cost preflight: Cloudflare Queues is available on Workers
  Free with 10,000 operations/day and fixed 24-hour retention; Workers Paid
  remains an optional minimum-$5 tier with longer retention, not a staging
  prerequisite;
- removed the misleading notion of a Cloudflare deployment region and kept
  the real Supabase region plus Cloudflare account/plan checks;
- clarified the Task 033 test count in the roadmap.

Independent local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
pnpm test                        -> PASS; 32 files, 1336 passed,
                                     2 paid eval gates skipped
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
                                  -> PASS; production config unchanged
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
                                  -> PASS; vetai-staging and staging producer binding
git diff --check                 -> PASS; only benign autocrlf notices
```

Read-only Phase B preflight, with identifiers suppressed from tool output:

- Cloudflare CLI authentication: missing; Queue discovery therefore not
  available and no Cloudflare mutation was attempted.
- Supabase CLI authentication: present; four projects were returned and the
  existing disposable `vetai-test` project is present. Project refs, account
  identifiers, and names other than the already-documented alias were not
  emitted.
- Meta authenticated preflight: not run yet.

Decision: `PHASE_A_PASS`. Task 034 remains `IN_REVIEW`; live execution cannot
start until Cloudflare/Meta read-only discovery is complete, the exact plan and
price are shown to the user, and the user explicitly approves the remote
mutations. No Opus review or paid model eval is required for Phase A.

### Codex Phase B live execution record — 2026-08-15

The user approved the isolated staging mutations after a zero-cost plan was
shown. Raw account/project/app/phone/provider identifiers and every secret were
suppressed from this record.

Completed evidence:

- Cloudflare authentication was granted with the minimum Worker/Queue scopes
  needed for this task. Three staging Queue resources were created, the
  `vetai-staging` Worker was deployed with the reviewed producer/consumer/
  DLQ/Cron bindings, and all seven runtime secrets were stored only through
  encrypted or interactive inputs.
- `GET /health` returned 200/`ok` and a cache-busted `GET /ready`
  returned 200/`ready`.
- A separate free Supabase staging project was created and linked. All 17
  migrations were applied through migration history; local/remote migration
  order matched.
- The Supabase CLI's linked database test command required unavailable local
  Docker. Codex instead ran the 17 rollback-only SQL proofs in the staging SQL
  Editor. All passed and left zero fixture residue. This was a deliberate
  deviation from the initial runbook's `do not run fixtures on staging` rule and
  is recorded rather than hidden; it will not be repeated.
- One clearly synthetic clinic and the exact Meta test-number account mapping
  were inserted into staging. One synthetic manual-routing override was added;
  no real owner, patient, pet, message, or recipient phone was stored.
- A free unpublished Meta app/test WABA/test number was created. The staging
  callback challenge passed, the `messages` field is subscribed, and the
  app secret, verify token, and refreshed temporary access token are present
  only in encrypted runtime storage.
- Meta's fixed test template was sent from the test number to a user-verified
  recipient and the user confirmed receipt. This proves only Meta test-number
  outbound delivery; it does not prove the VetAI outbox/sender path.
- Expected incremental cost for the executed Cloudflare, Supabase, and Meta
  steps was `$0`. No OpenAI request or paid evaluation was run.

Unresolved live gate:

- Meta explicitly states that an unpublished app receives dashboard-generated
  test webhooks only and receives no production inbound/status data. The
  dashboard showed test-number status events, but a bounded Worker tail
  observed no webhook invocation.
- The dashboard's webhook-field `Test` control produced no Worker request in
  either the new or classic Meta screen. It was not counted as a pass.
- The user has no WhatsApp Business App account or eligible pilot number;
  Coexistence is therefore honestly classified `UNAVAILABLE`. Only the
  free Cloud API test number exists.
- Consequently real inbound → Queue → OpenAI → atomic finalize → VetAI
  outbound → status, the selective-automation matrix, the takeover race,
  safety/staff smoke, and appointment `EVET`/`HAYIR` paths remain
  `NOT RUN`.
- Publishing is intentionally not authorized: veterinary copy approval,
  Turkish legal/KVKK approval, a production privacy-policy surface, durable
  Meta credentials, and an eligible business/pilot number are still absent.

Decision: `PHASE_B_PARTIAL_BLOCKED`. Task 034 remains `IN_REVIEW`.
No production resource or data was touched, no secret was recorded, and no
claim of full staging completion is made.

Post-record local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
pnpm test                        -> PASS; 32 files, 1336 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; production binding unchanged
staging Wrangler dry-run         -> PASS; staging Queue binding
git diff --check                 -> PASS; only benign autocrlf notices
sanitized diff scan              -> PASS; only a documented migration
                                     timestamp matched the long-number rule
```

## Phase C — pre-Business-number runtime hardening (user amendment)

The user explicitly requested one final code-safety pass before connecting an
eligible WhatsApp Business number. This is an amendment to Task 034 rather than
a second active task.

### Required outcome

1. Group-originated WhatsApp traffic must never enter automation. If Meta
   delivers a recognizable group event, acknowledge the signed webhook without
   reading, hashing, logging, persisting, queueing, sending to OpenAI, or
   replying to its nested message content.
2. Audit the adjacent inbound/routing/Queue/outbound/staff/appointment trust
   boundaries for similarly reachable correctness, privacy, tenant, loop, or
   unbounded-cost failures.
3. Fix only reproducible or source-proven defects. Do not add speculative
   abstractions, dependencies, schema, features, or production resources.
4. Preserve direct-chat behavior, the three selective-automation modes,
   signature verification, fail-closed parsing, deterministic safety
   precedence, and all existing tenant/RLS boundaries.

### Audit gate and scope control

- Codex first records evidence-backed findings and the exact affected files in
  this section. Source edits are forbidden until that finding list is closed.
- Allowed review surface: `src/index.ts`, `src/whatsappIngest.ts`,
  `src/contactAutomation.ts`, Queue consumers/finalizers, outbound sender/status,
  staff routes, appointment flow, their direct tests, and the matching docs.
- After the audit, Codex may amend the exact allowed-change list below once.
  Any database/RLS, clinical-copy, prompt/model, or new data-retention change
  requires a new explicit contract and the applicable Opus/human review gate.
- No remote mutation, deploy, paid OpenAI call, Meta publication, or real
  Business number is authorized.

### Required verification

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --config wrangler.staging.toml --dry-run --outdir .wrangler/staging-dry-run
git diff --check
```

### Closed audit findings

1. **BLOCKING — recognizable group messages can enter the direct-chat path.**
   Meta's current Groups webhook contract carries inbound group messages in
   the ordinary `messages` field with an additive message-level `group_id`.
   `extractInboundMessages` ignores that discriminator and currently treats
   the participant's numeric `from` as a direct-chat sender. The same parser
   must also recognize the documented/additive `recipient_type: "group"` and
   `context.group_id` shapes defensively. A recognized group candidate must be
   skipped before route resolution, contacts/profile access, nested content,
   hashing, persistence, Queue, OpenAI, or reply creation; other direct
   candidates in the same signed batch must continue normally.
2. **HIGH — internal RPC fetches are not locally bounded.** Most Supabase RPC
   clients used by webhook, Queue, appointment, dead-letter, and outbound
   paths have no AbortSignal. A stalled origin can therefore outlive the
   120-second intake lease, allowing a reclaimed second worker and duplicate
   paid model work even though only one finalize can win. Every affected
   native-fetch RPC call must fail closed after 10 seconds. Combined with the
   existing 30-second OpenAI/Meta bounds and 5-second clinic-hours bound, the
   normal intake path remains below the lease ceiling.
3. **No new source-proven defect** was found in the remaining reviewed
   boundaries. `smb_message_echoes`, history, lifecycle, reaction, system,
   and unknown fields are ignored because they are not supported inbound
   `messages` candidates; outbound sends force `recipient_type: "individual"`;
   selective-automation is rechecked at claim time; Queue retries and outbound
   attempts are finite; appointment mutations remain confirmation-gated; and
   staff rendering remains fixed-copy/escaped. Existing documented
   at-least-once, route-race, retention, and external-approval ceilings remain
   unchanged and are not silently relabeled as fixed.

### Exact Phase C allowed changes

- Group exclusion: `src/whatsappIngest.ts`,
  `test/whatsappIngest.test.ts`, `test/index.test.ts`.
- Ten-second internal-RPC bounds: `src/contactAutomation.ts`,
  `src/supabaseIngest.ts`, `src/supabaseOutboundStatus.ts`,
  `src/intakeJobLease.ts`, `src/conversationState.ts`,
  `src/intakeDeadLetter.ts`, `src/outboundDelivery.ts`,
  `src/appointmentFlow.ts`, `src/appointmentEngine.ts`, and their matching
  existing unit-test files.
- Narrow documentation/context: `docs/inbound-queue.md`,
  `docs/selective-automation.md`, `docs/outbound-delivery.md`,
  `docs/appointment-booking-engine.md`, `docs/production-readiness.md`,
  `PROJECT_CONTEXT.md`, and this file.

No migration, SQL fixture, prompt/model, reply copy, dependency, configuration,
secret, remote resource, or production identifier may change.

### Phase C Codex review and verification record — 2026-08-21

Implemented and independently reviewed the two closed findings with no schema,
prompt, copy, dependency, configuration, or remote-service change:

- `src/whatsappIngest.ts` now excludes value/message `group_id`, explicit
  `recipient_type: "group"`, and `context.group_id` before route lookup or
  nested content/profile access. Throwing-getter tests prove those fields are
  untouched; a mixed-batch test proves direct traffic still proceeds.
- A signed Worker-level group fixture returns HTTP 200 with zero fetch and
  Queue calls, proving no RPC, persistence, Queue, OpenAI, or reply path runs.
- The nine previously unbounded Supabase client fetch boundaries now use
  `AbortSignal.timeout(10_000)` and preserve their existing generic fail-closed
  results. Existing 5-second clinic-hours and 30-second OpenAI/Meta bounds are
  unchanged.
- Source tracing found no second group/echo reply path: only
  `extractInboundMessages` imports content into intake; `smb_message_echoes`,
  history, lifecycle, reaction, system, and unknown fields remain ignored;
  outbound Meta calls still force `recipient_type: "individual"`.

Verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 11 files, 636 tests
pnpm test                        -> PASS; 32 files, 1343 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; production bindings unchanged
staging Wrangler dry-run         -> PASS; staging bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
sanitized diff review            -> PASS; no real secret or identifier added
```

No migration/database check was required because no SQL changed. No live Meta,
OpenAI, Supabase, Cloudflare mutation, deploy, publication, or Business-number
connection occurred. The existing Task 034 Phase B live blockers remain.

Decision: `PHASE_C_PASS`. The code hardening is ready to commit; Task 034 as a
whole remains `IN_REVIEW` until the user supplies an eligible WhatsApp Business
pilot number and the external veterinary/legal production gates are closed.
