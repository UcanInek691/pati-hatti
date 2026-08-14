# Current task — 034 Real staging and same-number WhatsApp evidence

Status: `READY`

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
4. **Cloudflare** — create the three exact staging Queues, set the eight secret
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

To be filled by the implementer from repository evidence before editing.

## Delivery record

To be filled by the implementer after Phase A implementation and local
verification. All live checks must be reported `NOT RUN — reserved for Codex`.

## Codex review record

Reserved for Codex.
