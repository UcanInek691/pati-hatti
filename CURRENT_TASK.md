# Current task — 035 Pet onboarding (first-time owner pet registration)

Status: `READY`

Contract opened by: Claude Opus, standing in for Codex under Maya's explicit
delegation of 2026-08-25. Reverts to Codex ownership when Codex returns.

Depends on: Task 034 `COMPLETE` and committed (`0bcdd86`, 2026-08-25). Met.

## Problem

`resolvePet` (`src/intakeExtraction.ts:236`) only matches pets that already
exist for the owner, and no runtime path ever creates one. An owner with zero
registered pets therefore loops in `pet_identification` forever. Task 034
reproduced this on real staging and recorded it as
`PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED` (defect 6). This task adds the
one missing path: creating a pet, gated on the owner's explicit confirmation.

## Product decision — already taken, do not reopen without Maya

1. **Only an explicit owner confirmation turn may create a pet.** The bot reads
   the extracted name (and species, if extracted) back verbatim and creates the
   row only if the owner replies exactly `EVET`, using the same grammar the
   appointment confirmation already uses. An LLM extraction alone never writes
   a row.
2. **Duplicate names are refused on the AI write path only** (Maya, 2026-08-25,
   option (b)). See "Decision 2, as amended" below — this replaced an earlier
   table-wide unique index.
3. **Species is stored at creation** when the same confirmed turn supplied it,
   and left null otherwise.
4. **Bounded attempts.** A repeated or unparseable answer re-asks at most
   `MAX_PET_IDENTIFICATION_ATTEMPTS` (3) times, derived at read time from the
   already-loaded recent messages — no new column, no `schema_version` bump —
   and then hands off to a human. This is stricter and earlier than the
   existing 12-turn `NO_MODEL_STATE_VERSION_CEILING`.

### Decision 2, as amended (Maya, 2026-08-25 — option (b))

The duplicate-name rule is **not** a table-wide constraint. The first draft of
the migration created

```sql
create unique index pets_owner_normalized_name_key
  on public.pets (owner_id, (lower(btrim(name))));
```

which would also have bound clinic staff inserting directly through the
existing `pets_all` RLS policy, turning a legitimate registration — one owner
really does have two pets whose names collide under this normalization — into
a bare `23505` in a code path that never asked for the rule. The rule exists to
stop the AI from silently creating a second row for a pet the owner already
registered, so it now lives inside `finalize_intake_queue_job` as a conditional
`insert ... select ... where not exists (...)`, and staff writes are untouched.

Recorded ceiling, deliberately accepted for the pilot: `where not exists` is a
read-then-write check, not a constraint. Two finalize calls for the same owner
running concurrently in two different conversations can both pass it. The
per-conversation intake lease serializes the ordinary case. If duplicates are
ever observed, the upgrade path is a **partial** unique index covering only
AI-created rows — which first needs a provenance column on `public.pets` — and
never a table-wide one.

## What is already in the repository

The implementation landed on 2026-08-25 in the same session that opened this
contract, reviewed against the real migration history (the code was originally
drafted in a sandboxed working copy that could see only 3 migrations; every
inference it carried has now been checked against the real files):

- `supabase/migrations/20260825000100_pet_registration.sql` — forward-only
  replacement of `finalize_intake_queue_job` adding `p_create_pet_name` /
  `p_create_pet_species` (both `default null`, so an older Worker still calls
  it unchanged) and the new `duplicate_pet_name` result. Verified: the body is
  `20260814000300_selective_automation.sql`'s body plus the pet additions and
  nothing else, and nothing after that migration — including
  `20260822000100_strict_ai_allowlist.sql` — redefines the function.
- `src/petRegistration.ts` — the confirmation-turn planner.
- `src/intakeConsumer.ts`, `src/intakeJobLease.ts`, `src/intakeReply.ts` —
  additive wiring only.
- `test/petRegistration.test.ts` plus new blocks in
  `test/intakeConsumer.test.ts` and `test/intakeJobLease.test.ts`.
- `supabase/tests/035_pet_registration.sql` — rollback-only fixture in
  `033_selective_automation.sql`'s real shape. It replaces the draft
  `20260825000100_pet_registration_test.sql` that shipped in the handoff
  package; that draft was never installed, and must not be — it tested the
  unique index that decision (b) removed.
- `docs/kvkk-inceleme-paketi.md` — §3, §4, §5 and §8 updated in place. The
  separate `EK` annex from the handoff package was merged and not kept; a
  second KVKK source of truth must not exist.
- `docs/staging-runbook.md` §12.1 — migration-then-Worker deploy order.

## Acceptance criteria — what still has to happen

1. **Run `supabase/tests/035_pet_registration.sql` against the disposable
   `vetai-test` project and see it green.** As of 2026-08-25 this is `NOT RUN`:
   the project exists and is `ACTIVE_HEALTHY`
   (`supabase projects list` → ref `cyjpiapxvalqltcsywam`), and the Supabase
   CLI is authenticated, but no database password is available in this
   environment, no `psql` is installed, and no Docker daemon is present for a
   local stack. `supabase migration list` refuses without `--db-url`
   or `--password`. Nothing about the fixture has been executed anywhere.
   Whoever runs it must record the outcome in the fixture's own header and
   here. It covers: the AI path creating the pet atomically; the case- and
   whitespace-insensitive duplicate refusal writing nothing and advancing no
   state; **a staff insert of the same name through `pets_all` succeeding**
   (decision (b)); the AI path still refusing afterwards; a distinct name still
   being created with a trimmed name and a null species; and
   `create_pet_species` without `create_pet_name` raising.
2. **Run the duplicate-name pre-check on staging and record the result.**
   Also `NOT RUN`, same reason. Under decision (b) this is **no longer a
   blocker** — nothing in this migration constrains existing rows, so no
   pre-existing duplicate can make it fail to apply. It is now informational:
   it says whether any owner already has same-normalized-name pets, which is
   the population where the AI path will answer `duplicate_pet_name`.

   ```sql
   select p.clinic_id, p.owner_id, lower(btrim(p.name)) as normalized_name,
          count(*) as n, array_agg(p.id order by p.created_at) as pet_ids
   from public.pets p
   group by p.clinic_id, p.owner_id, lower(btrim(p.name))
   having count(*) > 1
   order by n desc;
   ```

   If it returns rows, do **not** treat merging them as part of this task:
   `conversations.pet_id` is `on delete no action` and
   `advance_conversation_intake` can never set it back to null
   (`coalesce(p_pet_id, c.pet_id)`), so consolidation needs manual `update`s
   and belongs in its own data-reconciliation task.
3. **Apply the migration to staging, then deploy the Worker — in that order.**
   `docs/staging-runbook.md` §12.1 is binding: migration first (the new
   parameters default to null, so the old Worker keeps working), Worker second.
   On rollback, the reverse. Requires explicit user approval per `AGENTS.md`;
   this contract does not grant it.
4. **Prove the loop is closed on staging**: a first-time owner sends a message,
   confirms with `EVET`, the pet row appears, and the conversation advances to
   `complaint_collection` instead of looping.
5. **KVKK.** §3/§4/§5/§8 are updated with the verified technical facts, but the
   legal decisions they open are unfilled and belong to the reviewing expert —
   in particular whether the confirmation prompt is itself an adequate
   disclosure moment, and whether pet records need provenance for export. This
   task must not answer those.

## Out of scope

- Any provenance column on `public.pets`.
- Merging or deleting existing duplicate pets.
- The staff Cloud API composer (Task 034's Coexistence `UNAVAILABLE`
  consequence) — still a separate controlled-pilot blocker.
- Retention periods and the lawyer review of `/privacy` — human gates, tracked
  in `docs/pilot-oncesi-plan.md` and `docs/production-readiness.md`.

## Checks at contract time — 2026-08-25

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean |
| Full suite | `npx vitest run` | 1,411 passed, 2 skipped, 33 files |
| Worker build | `npx wrangler deploy --dry-run` | built, 150.16 KiB |
| SQL fixture | `supabase/tests/035_pet_registration.sql` | **NOT RUN** — see criterion 1 |
| Staging pre-check | duplicate-name query | **NOT RUN** — see criterion 2 |

No staging or production migration was applied, no Worker was deployed, no
secret was created or rotated, and no Meta configuration was changed while
opening this contract.

---

# Completed task record — 034 Real staging and same-number WhatsApp evidence


Status: `COMPLETE` (closed 2026-08-25 — see "Task 034 closure record" at the end of this file)

Owner: Claude Sonnet (repository preparation), then Codex (review and live
execution); closed by Claude Opus standing in for Codex under Maya's explicit
delegation of 2026-08-25, Codex being unavailable.

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

## Phase D — strict AI allowlist before personal-number pilot (user amendment)

The user explicitly chose to test with a backed-up personal iPhone number and
requested a strict allowlist before any WhatsApp Business/Cloud API
registration. This remains part of Task 034 because it is a prerequisite for
the same live staging journey; no phone-number registration is authorized by
this repository phase.

### Required outcome

1. Every WhatsApp account defaults to `personal`: an unlisted direct sender's
   nested message content is not read, hashed, logged, persisted, queued, sent
   to OpenAI, or answered by VetAI.
2. Only an exact per-contact route explicitly set to `ai` enters automation.
   Existing `manual` and explicit `personal` overrides remain available.
3. Removing an override (`inherit`) returns that sender to the strict
   `personal` default.
4. The existing envelope-level routing lookup and honest Meta/Cloudflare
   transient-memory boundary remain unchanged. Group exclusion remains
   stronger and runs before contact routing.
5. No prompt, clinical copy, dependency, framework, new storage table, or
   production resource is added.

### Exact allowed changes

- New migration and rollback proof:
  `supabase/migrations/20260822000100_strict_ai_allowlist.sql`,
  `supabase/tests/034_strict_ai_allowlist.sql`; compatibility-only fixture
  update: `supabase/tests/033_selective_automation.sql` (the old proof must no
  longer insert now-forbidden account-level `ai/manual` defaults).
- Existing staff UI/parser tests: `src/staffPage.ts`,
  `test/staffPage.test.ts`.
- Narrow documentation/context: `docs/selective-automation.md`,
  `docs/staff-workflow.md`, `docs/database-schema.md`,
  `docs/staging-runbook.md`, `docs/product-roadmap.md`,
  `PROJECT_CONTEXT.md`, and this file.

No existing migration may be rewritten. No live database migration, Worker
deploy, Meta registration, secret mutation, paid OpenAI call, or production
change is authorized until local review passes and the user sees the exact
staging mutation plan.

### Review gate

- Codex: migration/call-path/UI review and all local verification.
- Claude Opus: mandatory narrow read-only review of the database constraint,
  pending-outbox cleanup, RLS/tenant behavior, and privacy wording before live
  staging apply.
- Human: iPhone backup is complete; normal WhatsApp/Business/Cloud API account
  changes remain a later explicit step.

### Phase D Codex local review record — 2026-08-22

Implemented the strict allowlist by reusing Task 033's existing route model:

- the forward migration sets every existing/new account default to the only
  permitted account-level value, `personal`;
- exact per-contact `ai | manual | personal` overrides and `inherit` remain
  unchanged; therefore only an explicit `ai` row enters automation;
- activation deletes still-`pending | processing` outbox rows without an
  exact AI route. Removing `processing` prevents lease-expiry reclaim/retry;
  one network request already handed to Meta still cannot be recalled.
  Terminal `accepted | failed` history remains;
- `/staff` accepts only a `personal` account default and otherwise fails the
  account-list parser closed, preventing a false "strict whitelist" claim;
- the existing Task 033 SQL proof was compatibility-updated to express its AI
  paths as explicit routes instead of obsolete account defaults.

Local verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 3 files, 191 tests
pnpm test                        -> PASS; 32 files, 1344 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; bindings unchanged
staging Wrangler dry-run         -> PASS; bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
```

At this local-review stage, migration apply and SQL fixtures 033/034 were
`NOT RUN`; staging deploy, Meta number registration, WhatsApp account
conversion, and paid OpenAI eval were also untouched. The later records below
preserve the subsequent Opus and disposable-database results.

### Phase D Opus correction record — 2026-08-22

The first mandatory read-only Opus review returned `CHANGES_REQUIRED`.
Codex addressed the findings without adding a table, RPC, dependency, prompt,
clinical copy, or remote mutation:

- activation cleanup now deletes unauthorized `pending | processing` rows,
  preventing an expired processing lease from being reclaimed; documentation
  states that a network request already handed to Meta cannot be recalled;
- the 034 rollback proof now exercises the real unlisted ingest boundary and
  proves zero event/owner/conversation/message writes;
- the same fixture exercises the exact cleanup predicate across authorized
  pending, unauthorized pending/processing, terminal accepted/failed, and a
  same-recipient row in another account/tenant;
- the cross-tenant absence assertion now runs after `reset role`, outside
  authenticated RLS, and the resolver proof distinguishes identical contacts
  across two accounts;
- `/staff` keeps its “strict policy active” claim hidden until the account
  payload validates a `personal` default, and shows a fixed fail-closed
  warning otherwise; its retention and `inherit` copy now distinguishes an
  explicit route row from an unlisted number;
- migrations remain intentionally free of nested `begin/commit`, matching
  the reviewed Supabase CLI transaction invariant. The runbook now forbids
  statement-by-statement SQL Editor application and requires the managed
  file-atomic migration path.

At this correction stage, database execution remained `NOT RUN`; local
verification and a narrow Opus re-review were required before any staging
apply or phone registration. The later disposable-database record below is the
authoritative result after those gates.

Correction verification:

```text
pnpm install --frozen-lockfile   -> PASS; already up to date
pnpm typecheck                   -> PASS; zero errors
targeted Vitest                  -> PASS; 3 files, 111 tests
pnpm test                        -> PASS; 32 files, 1,344 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; bindings unchanged
staging Wrangler dry-run         -> PASS; bindings unchanged
git diff --check                 -> PASS; only benign autocrlf notices
```

### Phase D disposable database validation record — 2026-08-22

After explicit user approval, Codex validated Phase D only on the disposable
`vetai-test` project. The restored database already contained the first 17
migrations' schema but its CLI migration-history table was empty because the
older files had been applied through the dashboard. Codex recorded those 17
existing versions as applied, then reran `supabase db push --dry-run`; the only
remaining file was `20260822000100_strict_ai_allowlist.sql`.

Live disposable-database evidence:

```text
strict-allowlist migration apply -> PASS; vetai-test only
033 rollback fixture             -> PASS; zero visible fixture residue
034 rollback fixture             -> PASS 0/0/0
catalog/default/CHECK/RLS audit   -> PASS; 7/7 closed checks true
```

The final catalog audit proved the new migration-history record, the
`personal` column default, the named strict CHECK, all existing accounts on
`personal`, no unauthorized claimable `pending | processing` outbox row, RLS
enabled on all three affected tables, and zero 033/034 fixture residue.

Decision: `PHASE_D_DISPOSABLE_PASS`. The local Codex gate, mandatory Opus
read-only review, real migration apply, both rollback fixtures, and catalog
checks have passed. Task 034 remains `IN_REVIEW` because the strict migration
has not been applied to staging, no eligible pilot number is registered, and
the full real inbound/outbound chain is still unproved. No staging,
production, Meta, OpenAI, or iPhone mutation occurred in this validation.

### Phase D staging apply record — 2026-08-22

After separate user approval, Codex linked only to the existing
`vetai-staging` project. The remote migration history matched all first 17
local migrations, and `supabase db push --dry-run` offered only
`20260822000100_strict_ai_allowlist.sql`. Codex applied that single file
through the managed CLI transaction; no rollback fixture was run on staging.

Post-apply evidence:

```text
strict-allowlist migration apply -> PASS; vetai-staging only
catalog/default/CHECK/RLS audit   -> PASS; 6/6 closed checks true
migration history comparison     -> PASS; local/remote 18/18
post-apply migration dry-run      -> PASS; remote database up to date
```

The staging catalog audit proved the new migration record, the `personal`
default, the named strict CHECK, every existing account on `personal`, no
unauthorized claimable `pending | processing` outbox row, and RLS enabled on
the three affected tables. Task 034 remains `IN_REVIEW`: no eligible pilot
number exists, Coexistence is still `UNAVAILABLE`, and real inbound → Queue →
OpenAI → finalize → outbound/status evidence remains `NOT RUN`. No production,
Meta, OpenAI, or iPhone mutation occurred in this staging apply.

### Business App conversion and direct Coexistence probe — 2026-08-22

The user completed the reviewed iPhone backup, moved the same number from
WhatsApp Messenger to the WhatsApp Business App, and independently confirmed
that existing chats plus normal send/receive still work. Codex then opened the
existing Meta staging app's Production setup. The direct self-serve flow
offered only the standard `Add new number` wizard (`Business information → WA
Business Profile → Add number → Verify number`); it exposed no Coexistence,
existing-Business-App, or QR path. Codex closed the wizard before entering or
submitting any business information.

Decision: `COEXISTENCE_UNAVAILABLE_DIRECT_SELF_SERVE`. Do not use the standard
wizard for this personal-number pilot because it can move the number to
Cloud-API-only operation and remove the Business App inbox relied on for human
and personal replies. No phone number was registered with Cloud API, no
payment was added, and the Business App remained operational. The safe next
options are a separate API test number or a separately approved Embedded
Signup/Tech Provider/BSP Coexistence route; neither is authorized here.

## Phase E — dedicated Cloud API pilot number and staging publication (user amendment)

The user registered a separate, non-Coexistence pilot number in the existing
staging WABA and explicitly authorized completing the staging-only setup. This
amendment does not authorize production deployment, production data, a claim
of legal/KVKK approval, or use by unlisted senders.

### Required outcome

1. Serve a public Turkish staging privacy notice at `GET /privacy` without
   tracking, remote assets, secrets, phone numbers, patient data, or a false
   compliance/approval claim.
2. Keep all non-GET methods closed and preserve existing Worker routes.
3. Deploy only `vetai-staging`, enter that URL in the staging Meta app, and
   publish only after a separate action-time user confirmation.
4. Bind the newly registered phone-number ID to the existing synthetic staging
   WhatsApp account, keep the account default `personal`, and add only the one
   user-designated test sender as an exact `ai` route before real inbound.
5. Record only sanitized PASS/FAIL/NOT RUN evidence. Never record the pilot or
   sender number, token, message body, provider ID, or secret.

### Exact Phase E allowed changes

- `src/privacyPage.ts` (new), `src/index.ts`, `test/index.test.ts`.
- Narrow staging evidence/context only: `docs/staging-runbook.md`,
  `docs/production-readiness.md`, `PROJECT_CONTEXT.md`, and this file.

No migration, schema, prompt/model, clinical reply, dependency, production
configuration, or production resource may change. The public notice is a
truthful staging disclosure, not the missing lawyer-approved production
privacy package.

### Phase E observed context — 2026-08-23

Recorded by Claude (implementer) from repository evidence only. No Cloudflare,
Supabase, Meta, or OpenAI resource was created, called, or mutated.

- The privacy-notice half of Phase E was already present on disk and unrecorded
  when this session started: `src/privacyPage.ts`, the `/privacy` route in
  `src/index.ts`, and three `test/index.test.ts` cases (`GET /privacy`,
  `GET /privacy/`, `POST /privacy` → 405). Baseline run before any edit in this
  session: 32 files, 1,347 passed, 2 paid eval gates skipped — exactly the Phase
  D count of 1,344 plus those three. No Phase E delivery record existed.
- **BLOCKING defect found — the staging Worker's Queue consumer is inert.**
  `src/index.ts`'s `queue()` handler selected its processor by exact production
  resource name (`batch.queue === "vetai-intake"` /
  `"vetai-intake-dlq"`). `batch.queue` carries the real Cloudflare resource
  name, and `wrangler.staging.toml` declares consumers for
  `vetai-intake-staging` and `vetai-intake-dlq-staging`. On `vetai-staging`
  every batch therefore fell to the `null` processor and retried: intake
  exhausted its three attempts into `vetai-intake-dlq-staging`, that queue
  exhausted its three attempts into `vetai-intake-terminal-dlq-staging`, and no
  dead-letter staff handoff was ever created. The exact Phase E / Task 034 live
  gate — real inbound → Queue → OpenAI → atomic finalize → outbound → status —
  could not have passed on staging, and the failure would have looked like a
  Meta or Supabase problem rather than a routing one.
- The existing queue-routing tests only ever asserted production names
  (`vetai-intake`, `vetai-intake-dlq`, `vetai-intake-terminal-dlq`), so the
  suite could not detect the gap. `wrangler deploy --dry-run` cannot detect it
  either: it validates bindings, not the handler's name matching.
- Both affected files (`src/index.ts`, `test/index.test.ts`) are already inside
  the Exact Phase E allowed-change list, so no amendment to that list was
  needed. No other file was touched.

### Phase E delivery record (partial) — 2026-08-23

#### Changed files

- `src/index.ts` — queue routing now resolves through two explicit named sets,
  `INTAKE_QUEUE_NAMES` (`vetai-intake`, `vetai-intake-staging`) and
  `INTAKE_DEAD_LETTER_QUEUE_NAMES` (`vetai-intake-dlq`,
  `vetai-intake-dlq-staging`). Terminal dead-letter names are deliberately in
  neither set: they have no declared consumer and must keep failing closed to
  `retry`. No other behavior, route, header, or handler changed; production
  routing is byte-for-byte equivalent to the previous exact-match branch.
- `test/index.test.ts` — four added cases: staging intake routes only to the
  primary processor; staging DLQ routes only to the dead-letter processor;
  every line-anchored `queue = "..."` name declared in `wrangler.toml` and
  `wrangler.staging.toml` resolves to exactly one processor and acks; both
  terminal dead-letter names still retry with no processor called. The third
  case reads the two Wrangler configs so future config drift fails the suite
  rather than staging.
- `docs/staging-runbook.md` — new §14 (Faz E) execution section and a
  corrected header date. Every §14 item is `[ ]`; no live checkbox was marked
  and no live claim was added. §14.0 records the redeploy prerequisite created
  by the queue-routing defect above, §14.2 records that the Phase B temporary
  Meta token has expired, §14.4 restates the exact `whatsapp_accounts` /
  `whatsapp_contact_routes` / `clinic_staff` shapes the binding and allowlist
  steps depend on, and §14.6 restates the external gates Phase E does not
  close.
- `CURRENT_TASK.md` — this Observed context and Delivery record only.

No source outside `src/index.ts`, no migration, SQL fixture, prompt, model,
clinical copy, dependency, lockfile, Wrangler config, or secret was touched.

#### Regression proof

The three name-dependent new cases were run against the previous exact-match
branch and failed (3 failed / 77 passed); against the fix they pass (80/80).
The suite therefore reproduces the defect rather than merely accompanying it.

#### Exact checks and results

Run in an isolated Linux sandbox holding a faithful copy of the worktree, not
on the developer machine.

```text
pnpm install --frozen-lockfile   -> PASS; lockfile honored, 80 packages
pnpm typecheck                   -> PASS; zero errors
targeted Vitest (index.test.ts)  -> PASS; 80 tests (was 76)
pnpm test                        -> PASS; 32 files, 1,351 passed,
                                     2 paid eval gates skipped
production Wrangler dry-run      -> PASS; Worker "vetai",
                                     env.INTAKE_QUEUE (vetai-intake)
staging Wrangler dry-run         -> PASS; Worker "vetai-staging",
                                     env.INTAKE_QUEUE (vetai-intake-staging)
```

Sandbox caveat, recorded rather than hidden: `@types/node` is an uninstalled
optional peer under `--frozen-lockfile`, so the sandbox needed it added locally
before `tsc` could resolve the `node:fs` / `node:path` imports that several
existing test files already use. That install was local to the sandbox only;
`package.json` and `pnpm-lock.yaml` are unchanged in the repository. Codex
should rerun `pnpm typecheck` on the developer machine to confirm.

#### Checks not run and why

- `git status`, `git diff --check`, and any commit: this session had no shell
  on the developer machine, only file read/write. Line-ending and worktree
  cleanliness must be confirmed by Codex or the user before commit.
- Every live Cloudflare, Supabase, Meta, and OpenAI step of Phase E
  (deploy, privacy URL entry, app publication, phone-number-ID binding,
  designated-sender `ai` route, real inbound/outbound/status journey):
  `NOT RUN`. Phase E items 2-5 remain entirely open.
- No paid OpenAI call or eval was made.

#### Known limitations / risks to inspect

- The staging Worker currently deployed at the time of this record predates
  this fix. Any staging Queue evidence gathered before a redeploy is invalid,
  and any message already sitting in `vetai-intake-terminal-dlq-staging` got
  there through the defect, not through a real failure.
- The fix hardcodes four resource names. A third environment, or a rename of
  any queue, must update `src/index.ts` together with its Wrangler config; the
  added config-drift test is what surfaces that, so it must not be weakened.
- The `/privacy` notice is a truthful staging disclosure written by an AI and
  is still not the lawyer-approved KVKK package required before production.

### Phase E live execution record — 2026-08-23

Executed with the user present, each remote mutation separately approved by
them at the time. Raw identifiers, phone numbers, and secrets are suppressed.

#### What was executed

- `vetai-staging` redeployed with the queue-routing fix. Deploy output listed
  `Consumer for vetai-intake-staging` and `Consumer for vetai-intake-dlq-staging`.
- Meta app: privacy policy URL set to the staging Worker's `/privacy`; the app
  was then **published** on the user's explicit approval.
- Staging database: the `whatsapp_accounts` row was rebound from the old Meta
  **test** number to the pilot number (it would otherwise have resolved
  `unknown_account` for every real inbound); the synthetic staff Auth user's
  `clinic_staff` membership was inserted; and one exact `ai` contact route was
  added for the single designated test sender.
- The `ai` route was set by calling the real `set_whatsapp_contact_route` RPC
  from a database session assuming the staff user's identity
  (`set local role authenticated` + real `auth.uid()`, the pattern the repo's
  own SQL fixtures use). Recorded deviation: this is not the `/staff` browser
  path the runbook prescribes. No table was written directly, and
  `is_clinic_staff` genuinely authorized the call — but the `/staff` UI itself
  remains untested.
- `WHATSAPP_ACCESS_TOKEN` was replaced with a permanent Meta token after the
  expired one was proven invalid by three failed delivery attempts.

#### Live evidence — the full chain now passes

Real inbound → signed webhook → signature verified → persisted → `ai` route →
Queue → OpenAI → atomic finalize → outbox → real outbound → Meta delivery
status callback. Worker tail showed `processed: 1` and
`Queue vetai-intake-staging (1 message) - Ok`; the conversation advanced to
`pet_identification`; two outbox rows reached `accepted` on their first
attempt with `provider_status_at` populated.

**The queue-routing fix is what made this possible.** Before it, `batch.queue`
never matched a processor on staging and the message would have retried into
the terminal dead-letter queue with no reply and no visible error.

#### Diagnosis worth preserving

After publishing, real messages still produced no webhook for roughly an hour.
Meta's own `messages` field `Test` control was the discriminating experiment:
that request **did** reach the Worker, proving the callback registration,
signature layer, and Worker were all sound, and isolating the fault to how the
real message was being targeted. The chain fired on the first attempt once the
message was started from Meta's "Customer replies" **QR flow**. Future real
inbound tests should always start from that QR.

#### Open defects found and deliberately not fixed here

1. `src/index.ts` returns `503` for `unknown_account`. Meta can throttle an
   endpoint that repeatedly returns `5xx`, so this can become self-inflicted.
   It should return `200` and ignore the event. Outside the Phase E allowed
   change list; needs its own contract.
2. Three duplicate "weosa" WABAs exist in the portfolio; only one holds the
   number. This materially slowed diagnosis.
3. Business-initiated (template) sending is blocked — Meta's "Add payment"
   step is incomplete. User-initiated 24-hour-window replies are unaffected.
4. The permanent access token was pasted into a chat transcript during this
   session and must be regenerated to invalidate it.
5. `/staff` was never opened; §7 matrix, §8 takeover race, and §9 safety and
   appointment smoke remain `NOT RUN`, and §9's clinic-hours and slot
   prerequisites are still absent.
6. **BLOCKING product gap — an owner with no registered pet loops forever.**
   Observed in the real conversation, not inferred: after the safety gate
   cleared, the system asked for the pet's name, the user answered with the
   name, and the identical fixed question was sent again. The model was not
   at fault — `conversations.intake_data` held the correctly extracted
   `pet_name` and `species` for that reply. `resolvePet`
   (`src/intakeExtraction.ts:236`) only ever matches against pets **already
   stored** for the owner; with none stored it returns `needs_clarification`,
   and `src/intakeReply.ts:92` re-sends the fixed pet-identity copy. No
   runtime path creates a pet anywhere in `src/` — there is no
   `insert into public.pets`. Every first-time owner therefore dead-ends.
   The user chose to record this rather than paper over it with a seeded pet
   row, so the loop is still reproducible on staging for whoever fixes it.
   Any fix must decide who a pet record is created for, on whose consent, and
   under which KVKK basis, so it needs its own contract and the applicable
   review gates rather than a quick patch.

#### Changed files in this phase

`docs/staging-runbook.md` (§6, §11, §14 evidence and the new §14.5b defect
list) and this record. No source, migration, or configuration changed after
the queue fix.

### Phase F — `unknown_account` acknowledgement (executed 2026-08-23)

Defect 1 above was fixed, because it is bounded, needs no schema, prompt,
clinical copy, or retention change, and it actively risks Meta throttling
webhook delivery for the whole account while it stands.

- `src/index.ts` now counts `unknown_account` under its own counter and
  acknowledges with HTTP 200 instead of folding it into `failed` and returning
  503. `failed` still returns 503; `manual` and `ignored` are unchanged. The
  new counter appears in the persistence log line so a stale or misconfigured
  `phone_number_id` stays visible rather than silently swallowed.
- `test/index.test.ts`: `unknown_account` added to the 200-outcome table, a
  test pinning the separate counter, and a test proving a genuinely
  unrecognized RPC result still returns 503. Two pre-existing tests asserted
  the old 503 and were updated in place with a comment recording the date and
  reason, so the change is not silently rewritten history.
- `docs/inbound-queue.md`: the outcome list now states the behavior and why.

Verification: `pnpm typecheck` PASS; `pnpm test` PASS (32 files, 1,354 passed,
2 paid eval gates skipped). Not deployed — the live staging Worker still runs
the previous build.

### Proposed next task — pet onboarding (defect 6)

Written here for Codex to lift into its own contract; **not** authorized or
implemented by Task 034.

Problem: `resolvePet` only matches pets already stored for the owner, and no
runtime path creates one, so a first-time owner cannot pass
`pet_identification`. Reproducible on staging right now.

Why it is gated rather than patched: creating a pet record from message
content is a new data-retention path. It decides what personal data VetAI
originates about an identifiable owner, on what consent, and with what
erasure behavior. Under `AGENTS.md` and the Phase C/D precedent that requires
a new contract plus the applicable Opus/KVKK review gate, and
`docs/kvkk-inceleme-paketi.md` must be updated in the same change.

Design questions the contract must close before code:

1. Who may create a pet — only an explicit owner confirmation turn, or the
   extraction alone? An LLM-extracted name silently becoming a stored record
   is the weaker option and should be justified if chosen.
2. What identifies a duplicate: exact normalized name per owner, or does the
   owner get asked when two pets are similar? Today's resolver already fails
   closed on multiple matches, and that behavior should survive.
3. Species is optional in the schema but the extractor often supplies it;
   decide whether it is stored at creation or left null pending confirmation.
4. Erasure: pets cascade from owners today. Confirm that an owner-erasure
   request still removes auto-created pets, and that a pet created in error
   can be removed without breaking `conversations.pet_id`'s `no action` FK.
5. The loop itself is a defect independent of pet creation: even with
   onboarding built, an owner who never supplies a usable name must reach a
   bounded outcome — human handoff — rather than repeating one fixed line
   forever. A bounded-attempt counter needs storage, and
   `PersistedIntakeData` currently fails closed on any unexpected key, so it
   implies a `schema_version` bump and its own migration.

Suggested review gates: Codex for the RPC, call path, and RLS; Claude Opus
read-only for the retention, consent wording, and erasure cascade; human for
the KVKK package text.

Decision: `PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED`. Task 034 remains
`IN_REVIEW`: the transport chain is proven end to end, but defect 6 blocks
every first-time owner, the §7-§9 behavioral gates are unproven, the other
defects above are open, and the external veterinary/legal/KVKK production
gates are untouched. Defect 6 should be triaged before any further live
behavioral testing, because §7's `ai` path and §9's appointment smoke both
run through the pet-identification stage that currently dead-ends.

---

## Task 034 closure record — 2026-08-25

Closed by Claude Opus acting in Codex's role (review, checks, `PROJECT_CONTEXT.md`,
commit) under Maya's explicit delegation, Codex being unavailable. Codex's normal
authority is unchanged; this is a stand-in, not a redefinition of the role.

### What was reviewed

The Phase F working tree, uncommitted at review time:

- `src/index.ts` — `INTAKE_QUEUE_NAMES` / `INTAKE_DEAD_LETTER_QUEUE_NAMES` sets
  replacing the two hardcoded production queue names (the Phase E staging
  defect), the `/privacy` route, and the `unknown_account` outcome now
  answering `503` instead of `200`.
- `src/privacyPage.ts` (new) — static Turkish staging privacy notice, no
  inline script, `default-src 'none'` CSP, `nosniff`, `no-referrer`,
  `GET`-only with a `405 + Allow: GET` for anything else.
- `test/index.test.ts` — pins the `unknown_account` `503`, the `/privacy`
  headers/method handling, and the queue-name sets.
- `docs/inbound-queue.md`, `docs/staging-runbook.md`, `docs/pilot-oncesi-plan.md`.

Review verdict: accepted as written. Two points recorded rather than changed:

1. The `/privacy` page is truthful about the staging pilot but is still **not
   lawyer-approved**, and it states no concrete retention period because none
   has been decided. That is honest disclosure of an open gap, not a defect of
   this task — it stays a controlled-pilot blocker, tracked in
   `docs/pilot-oncesi-plan.md`.
2. `unknown_account` returning `503` deliberately asks Meta to redeliver rather
   than silently dropping a message for an account the staging database does
   not know. It is the correct failure direction for a pilot, and it is pinned
   by test so a future refactor cannot quietly turn it back into a `200`.

### Checks actually run — 2026-08-25

| Check | Command | Result |
| --- | --- | --- |
| Typecheck | `npx tsc --noEmit` | clean, no output |
| Entrypoint tests | `npx vitest run test/index.test.ts` | 83 passed / 1 file |
| Full suite | `npx vitest run` | 1,411 passed, 2 skipped, 33 files |
| Worker build | `npx wrangler deploy --dry-run --outdir <tmp>` | built, 150.16 KiB / 31.51 KiB gzip |

Honest scoping note on the full-suite number: that run happened on a working
tree that **also** contained the Task 035 pet-onboarding preparation (landed in
the same session, committed separately). Task 034 alone was at 1,354 passing at
the end of Phase E; the pet-onboarding files account for the rest. The 83-test
entrypoint run above is the Task-034-only figure.

No staging or production migration was applied, no Worker was deployed, no
secret was created or rotated, and no Meta configuration was changed in the
course of closing this task.

### What Task 034 did and did not establish

Established: migration-history staging, a separate staging Worker with its own
queues/cron/secrets, a real signed Meta webhook → inbound → outbound → status
journey, and all three Task 033 modes (`ai | manual | personal`).

Not established, carried forward rather than quietly dropped:

- **Coexistence is `UNAVAILABLE`**, with sanitized Meta evidence recorded in
  the Phase D/E records. A reviewed staff Cloud API composer therefore remains
  a controlled-pilot blocker, and was correctly not built here.
- **Pet onboarding is blocked** (`PHASE_E_CHAIN_PROVEN_PET_ONBOARDING_BLOCKED`):
  a first-time owner still cannot pass `pet_identification`, because
  `resolvePet` (`src/intakeExtraction.ts:236`) only matches pets that already
  exist and no runtime path creates one. This is defect 6 and is now Task 035
  below.
- The retention period, the lawyer review of `/privacy`, and the KVKK §7–§9
  boxes remain open and belong to humans, not to this task.
