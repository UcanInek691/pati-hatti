# Current task — 037 Second-pet registration and atomic pet finalization

Status: `READY`

Opened by Codex on 2026-08-27 after Task 036 closed and the fresh zero-pet
staging smoke passed. This task intentionally does **not** change the model
prompt, safety-question language, appointment behavior, production resources,
or the one-open-conversation-per-owner rule.

## Goal

Close two related defects with one minimal, reviewed change:

1. An owner who already has one or more registered pets must be able to register
   a distinctly named second pet when the current conversation has no selected
   `pet_id`. The existing `intake_confirmation` + exact `EVET` gate remains the
   only creation authority.
2. A stale optimistic version must never commit a newly inserted pet while the
   conversation advance fails. Pet insert, conversation link/stage advance,
   reply outbox insert, and lease completion remain one atomic operation.

## Verified starting evidence

- `PetResolution` currently has only `matched | needs_clarification`.
- `resolvePet()` returns `needs_clarification` both for “no matching registered
  pet” and “more than one normalized match”; those cases cannot safely share a
  creation decision.
- `isPetIdentityKnown()` accepts an unmatched candidate only when
  `context.pets.length === 0`, so an existing owner naming a second animal is
  held in `pet_identification`. Task 036 only bounded that loop with handoff.
- `finalize_intake_queue_job` inserts the pet before
  `advance_conversation_intake`. A normal `stale_state` return after the insert
  commits the pet, leaves `conversations.pet_id` unchanged, and leaves the
  intake lease processing until expiry.
- The active conversation model is one open conversation per owner. A
  conversation already linked to one pet may contain old clinical context;
  silently switching it to another animal is therefore outside this task and
  must fail closed to the existing human-handoff path.

## Product and safety decisions — binding

1. Extend the closed `PetResolution` union with exactly one candidate case for
   an explicit pet name that has **zero** normalized matches among the
   tenant-scoped `context.pets`. Do not add fuzzy matching or accept an ID from
   the model.
2. An explicit name with exactly one normalized match stays `matched`; more
   than one match stays `needs_clarification`; no explicit name keeps the
   existing single-pet fallback.
3. A `new_candidate` is identity-known only when `context.petId === null`.
   Whether the owner already has other pets is irrelevant. It may progress
   through complaint collection into the existing `intake_confirmation` flow.
4. `planPetRegistrationAction` may return `create` only for `new_candidate`
   after the exact confirmation grammar accepts `EVET`. A matched pet is never
   recreated; `needs_clarification` is never treated as a new pet.
5. If `context.petId` is non-null and the current turn explicitly names a
   different/unmatched pet, never silently relink the active conversation and
   never persist the new animal's identity or clinical facts as if they
   belonged to the selected pet. Route to the existing truthful human-handoff
   path. Preserve newly reported deterministic safety signals so an emergency
   still receives emergency copy and the staff work item can still become
   urgent. Do not diagnose or add new user-facing copy.
6. The Task 036 bounded-handoff fallback remains as defense in depth, but the
   valid unbound second-pet path must no longer reach it.
7. Before any pet insert, the finalizer must lock the exact tenant-scoped
   conversation row and verify `state_version = p_expected_version`. A mismatch
   returns the existing closed `stale_state` result with zero pet/outbox/state
   mutation and leaves the current lease available for the existing retry
   policy.
8. Once that row lock/version check succeeds, a later zero-row result from
   `advance_conversation_intake` is an invariant violation and must raise so
   the whole transaction rolls back. Do not turn database errors into success.
9. Keep the accepted pilot ceiling: the AI duplicate-name guard remains an
   application-level normalized-name check, not a table-wide unique index.
   Staff pet inserts remain unchanged.
10. No production migration, deploy, real WhatsApp/OpenAI call, commit, or push
    is authorized for the implementing agent.

## Required behavior

### Pure planning

- Zero registered pets + explicit “Minnoş” → `new_candidate`, identity known.
- Existing Karamel + unbound conversation + explicit “Minnoş” →
  `new_candidate`, progresses normally.
- Existing Karamel + unbound conversation + explicit “Karamel” → `matched`.
- Two normalized Karamel rows + explicit “Karamel” → `needs_clarification`.
- No explicit name + exactly one registered pet keeps the current automatic
  exact pet selection.
- Selected Karamel + explicit Minnoş/new unmatched name → human handoff,
  Karamel remains selected, Minnoş identity/complaint/symptoms are not merged
  into Karamel's persisted snapshot, and any true/null safety information from
  the new turn is still evaluated fail-closed.

### Confirmation and persistence

- An unbound owner with existing pets receives the same combined
  name/species/complaint confirmation already used for a first pet.
- No row is created before exact `EVET`.
- Exact `EVET` calls the existing finalizer creation parameters once; one new
  pet is created under the server-resolved clinic/owner, the conversation is
  linked to it, and the stage advances to `safety_check` atomically.
- `HAYIR`, correction, repeat, safety, human request, malformed snapshot,
  non-AI routing, stale claim, and completed conversation cannot create a pet.
- A normalized duplicate can never create another AI pet. The existing
  retry/self-heal behavior may remain, but must be explicitly tested.
- A stale expected version with creation parameters returns `stale_state` and
  proves: zero matching pet rows, unchanged conversation link/stage/version,
  zero reply outbox rows, and unchanged current lease token/status.
- Retrying the same logical turn with the current version creates exactly one
  pet and completes normally.

## Database requirements

- Add one forward-only migration after
  `20260826000100_intake_confirmation_stage.sql`; do not edit an applied
  migration.
- Replace only the current `finalize_intake_queue_job` signature/body and keep
  its result shape, grants, `SECURITY INVOKER`, volatility, empty search path,
  selective-automation suppression, reply validation, tenant derivation,
  duplicate guard, outbox behavior, and lease completion semantics unchanged
  except for the explicit atomically safe version check above.
- Add a rollback-only SQL proof. It must exercise the real RPC as
  `service_role`, cover an existing owner registering a distinct second pet,
  duplicate refusal, stale-version zero-mutation + successful retry, tenant
  isolation, and zero fixture residue. A single-session fixture may not claim
  to prove real concurrent blocking.
- Sonnet must mark both migration and fixture `NOT APPLIED` / `NOT RUN`.
  Codex will validate them on disposable `vetai-test` after review.

## Allowed changes

- `supabase/migrations/20260827000100_second_pet_registration_atomicity.sql`
- `supabase/tests/037_second_pet_registration_atomicity.sql`
- `src/intakeExtraction.ts`
- `src/intakeTurn.ts`
- `src/petRegistration.ts`
- `src/intakeConsumer.ts`
- `src/localDemo.ts` only if the closed resolution-label map requires it
- `test/intakeExtraction.test.ts`
- `test/intakeTurn.test.ts`
- `test/petRegistration.test.ts`
- `test/intakeConsumer.test.ts`
- `test/localDemo.test.ts` only if an existing scenario changes
- `docs/ai-behavior-and-safety.md`
- `docs/database-schema.md`
- `docs/inbound-queue.md`
- `docs/kvkk-inceleme-paketi.md`
- `CURRENT_TASK.md`, but the implementing agent may fill only this task's
  **Observed context** and **Delivery record** sections

Anything else requires Codex to amend this contract before implementation.
Do not edit `PROJECT_CONTEXT.md`; Codex owns it after verification.

## Required tests and checks

- Add focused unit/integration tests for every behavior listed above, including
  no OpenAI call on the selected-pet conflict handoff and no create parameters
  before exact confirmation.
- Preserve all existing safety, first-pet, appointment, routing, and outbound
  tests.
- Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

- Do not run a paid model eval: no prompt/model/extraction schema changes are
  authorized. Do not apply the migration or SQL fixture to any database.

## Review and staging gates

1. Sonnet implements and records evidence without commit/push/deploy.
2. Codex reviews the entire diff/call path, runs the required checks, applies
   the migration plus rollback fixture only to disposable `vetai-test`, and
   makes minimum corrections.
3. Claude Opus performs a mandatory read-only review of transaction atomicity,
   tenant/pet isolation, selected-pet conflict handling, RLS/grants, and KVKK
   retention semantics.
4. Only after PASS and Maya's separate approval may Codex migrate/deploy
   staging and run one live WhatsApp second-pet smoke. Production remains out
   of scope.

## Observed context

To be filled by the implementing agent from repository evidence.

## Delivery record

To be filled by the implementing agent.

---

# Current task — 035 Pet onboarding (first-time owner pet registration)

Status: `COMPLETE` (closed 2026-08-26 — see "Task 035 closure record" below,
directly above the Task 034 record). **This stamp covers engineering only.** Criterion 5's KVKK
questions were moved out of this task unanswered, to the human gate in
`docs/production-readiness.md` §1; nothing here is a legal sign-off, and the
production release gate is unchanged by this closure.

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
   `vetai-test` project and see it green.** `PASSED` — 2026-08-25, executed by
   Maya together with Claude Sonnet through the Supabase **dashboard SQL
   Editor** on `vetai-test` (ref `cyjpiapxvalqltcsywam`). Not run by Codex and
   not by Opus: the repository session still has no database access at all (no
   DB password, no `psql`, no Docker daemon for a local stack), so the
   dashboard was the only available route and remains so.
   A pre-check first showed
   `supabase/migrations/20260825000100_pet_registration.sql` was already
   applied on that project — `finalize_intake_queue_job` was already live in
   its 11-parameter form. The fixture then ran end to end with no error and
   reached its `rollback`: the last visible result row was fixture 3's
   `set_config`, everything after it being silent `do` blocks and the
   rollback itself. All six fixtures passed: the AI path creating the pet
   atomically; the case- and whitespace-insensitive duplicate refusal writing
   nothing and advancing no state; **a staff insert of the same name through
   `pets_all` succeeding** (decision (b)); the AI path still refusing
   afterwards; a distinct name created with a trimmed name and a null species;
   and `create_pet_species` without `create_pet_name` raising.
2. **Run the duplicate-name pre-check on staging and record the result.**
   `RUN` — 2026-08-25, same route (Maya + Claude Sonnet, dashboard SQL Editor)
   against `vetai-staging`. Result: **0 rows** —
   no existing owner has same-normalized-name pets, so nothing already in
   staging falls in the population that the AI path would answer
   `duplicate_pet_name` for. Under decision (b) this was already **not a
   blocker** — nothing in this migration constrains existing rows, so no
   pre-existing duplicate could make it fail to apply; it is informational
   only. The query that was run:

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
   `DONE` — 2026-08-25, in the runbook order, each step on Maya's separate
   explicit approval. `docs/staging-runbook.md` §12.1 is binding: migration
   first (the new parameters default to null, so the old Worker keeps
   working), Worker second. On rollback, the reverse.
   - **Migration.** Pushed through the managed CLI flow, not the SQL Editor,
     so it lands in migration history. Maya ran `supabase link` herself so the
     database password never entered the session. `supabase migration list`
     beforehand showed every earlier file matched local/remote through
     `20260822000100_strict_ai_allowlist` and `20260825000100` remote-empty;
     `supabase db push --dry-run` offered exactly one file. The real
     `supabase db push` applied `20260825000100_pet_registration.sql` with no
     error, and `supabase migration list` afterwards shows
     `20260825000100 | 20260825000100`. Staging's last migration is now
     `pet_registration`.
   - **Worker.** `pnpm exec wrangler deploy --config wrangler.staging.toml`
     (wrangler 4.118.0): 150.16 KiB upload / 31.51 KiB gzip, uploaded in
     11.00 s, triggers deployed in 15.23 s, version id
     `2ea1d3b7-5e5c-4cd6-9dcd-4dfc008d11ad`. Bindings as expected — the
     `INTAKE_QUEUE` producer, consumers on the intake queue and its DLQ, the
     `* * * * *` cron, `APP_TIMEZONE=Europe/Istanbul`,
     `WHATSAPP_GRAPH_API_VERSION=v25.0`.
   - **Post-deploy health.** `GET /health` → `200`
     `{"status":"ok","version":"0.1.0",...}`; `GET /ready` → `200`
     `{"status":"ready"}`.
   - Between the two steps staging ran the new schema against the old Worker,
     which is the safe direction of the §12.1 asymmetry; the window was a few
     minutes and no inbound traffic was driven through it deliberately.
4. **Prove the loop is closed on staging**: a first-time owner sends a message,
   confirms with `EVET`, the pet row appears, and the conversation advances to
   `complaint_collection` instead of looping.
   `DONE` — 2026-08-26, on `vetai-staging`, driven from Maya's whitelisted
   number. Closed **by derivation from the run's own recorded state**, not by a
   literal `complaint_collection` snapshot; Maya reviewed the derivation,
   accepted it, and declined a second run.
   - **The run.** Four inbound turns in one new conversation
     (`1aa4d07a-012b-45b0-b663-c7213ba9fd45`, `state_version` 5): the pet name,
     an answer to the safety questionnaire, `evet`, and one follow-up question.
     It deviated from the written plan — the first message was conversational
     ("merhaba köpeğimin adı karamel") and the safety answer carried a symptom
     with it ("bunlardan birisi yok sarhoş gibi yürüyor 15 dakikadır") — which
     is exactly what carried the conversation one stage past the point this
     criterion's wording anticipated observing.
   - **The pet row.** One row, `c0e06f64-3239-4289-85fd-c889ce7b4296`,
     `karamel`/`köpek`, correct `clinic_id`, and `conversations.pet_id` points
     at it. Both writes happen inside the same `finalize_intake_queue_job`
     call, so the row and the stage advance are atomic by construction — the
     property this criterion exists to prove.
   - **Why `complaint_collection` is proven even though the snapshot reads
     `safety_check`.** `advance_conversation_intake`
     (`20260806000200_conversation_intake_state.sql`) accepts exactly one
     forward step and raises on anything else. `pet_identification →
     safety_check` is two steps and therefore cannot have happened. The
     conversation being in `safety_check` today *requires* that it passed
     through `complaint_collection`. This is a database guarantee, not an
     inference.
   - **Corroboration.** `state_version` 5 is the default 1 plus exactly four
     advances, one per inbound turn — no room for a failed, repeated, or extra
     turn. And the reply sent on the `EVET` turn was the `intake_received`
     copy, which on a zero-pet `pet_identification` turn can only come from the
     creation branch: the ordinary path would have resolved
     `needs_clarification` and sent `PET_IDENTITY_TEXT`. That branch passes the
     literal `nextStage: "complaint_collection"` (`src/intakeConsumer.ts`).
   - **The safety detour was not a deviation from the design.** No "clean"
     re-run could have avoided it: on a first turn all eight safety signals are
     `null`, so `evaluateSafetyDecision` returns `needs_safety_check` and
     `planPetRegistrationAction` returns `none` on safety precedence
     (`src/petRegistration.ts:138`). The questionnaire always precedes the pet
     confirmation, and the shortest possible path to a created pet is three
     inbound turns.
5. **KVKK.** `MOVED OUT` — 2026-08-26, on Maya's decision. The engineering half
   was done: `docs/kvkk-inceleme-paketi.md` §3/§4/§5/§8 carry the verified
   technical facts of pet onboarding. The legal half was never this task's to
   answer, and closing this task does **not** answer it. Both open questions —
   whether the confirmation prompt is itself an adequate disclosure moment, and
   whether pet records need provenance for export — now live as named,
   individually visible bullets under the KVKK human gate in
   `docs/production-readiness.md` §1, alongside the third question Maya raised
   the same day about an opening recording notice. They block production
   release exactly as they did before; only their home changed. Do not treat
   this task's `COMPLETE` as covering them.

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
| SQL fixture | `supabase/tests/035_pet_registration.sql` | **PASSED** on `vetai-test` — 2026-08-25, Maya + Claude Sonnet via dashboard SQL Editor; all 6 fixtures, rolled back (criterion 1) |
| Staging pre-check | duplicate-name query | **RUN** on `vetai-staging` — 2026-08-25, same route; **0 rows** (criterion 2) |

No staging or production migration was applied, no Worker was deployed, no
secret was created or rotated, and no Meta configuration was changed while
opening this contract. The 2026-08-25 dashboard runs above touched only
`vetai-test` (inside a transaction that was rolled back) and a read-only
`select` on `vetai-staging`.

That held only until criterion 3 was approved. **Later the same day**, on
Maya's separate explicit approvals, `20260825000100_pet_registration.sql` was
pushed to staging and the staging Worker was redeployed — see criterion 3 for
the outputs. Staging's last migration is no longer `strict_ai_allowlist`. No
production change and no secret rotation at any point.

---

## Task 035 closure record — 2026-08-26

Closed by Claude Opus in Codex's role under Maya's standing delegation of
2026-08-25, on Maya's explicit instruction of 2026-08-26.

### What `COMPLETE` means here, and what it does not

Criteria 1-4 are met and recorded above with their evidence. Criterion 5 was
**moved out unanswered**, not met: its two KVKK questions are now named bullets
under the human gate in `docs/production-readiness.md` §1, together with the
third question Maya raised the same day. They block production release exactly
as before.

The move was Maya's call and it had a concrete reason: `AGENTS.md:23` forbids
starting a second task while the current one is `READY` or `IN_REVIEW`. Holding
035 open for a legal sign-off that no engineer can produce would have blocked
all further work indefinitely. `COMPLETE` here therefore means *the engineering
is done and proven on staging*, and nothing more. It is not a compliance
statement, it does not shorten the production gate, and it must not be cited as
evidence that any KVKK question was resolved.

### State at closure

- Pet onboarding for first-time owners is live on `vetai-staging` and on no
  production surface. `20260825000100_pet_registration.sql` is in staging's
  migration history; the staging Worker carrying `src/petRegistration.ts` is
  deployed.
- The duplicate-name rule binds the AI write path only; staff writes through
  the `pets_all` RLS policy are deliberately unconstrained (Maya, 2026-08-25).
- One defect found during closure is recorded but not fixed: on `stale_state`,
  `finalize_intake_queue_job` returns without rolling back an already-committed
  pet insert, leaving an orphan row and a lease stuck in `processing`. Full
  description in `PROJECT_CONTEXT.md` under "Not implemented". The Worker's
  retry self-heals it, so it is not a release blocker; it is a candidate task.

---

# Current task — 036 Conversation flow, latency, and recording notice

Status: `COMPLETE` (closed 2026-08-27; implementation, database proof,
staging migration/deploy, bounded second-pet handoff, and the fresh zero-pet
live WhatsApp smoke all passed. Production remains unchanged.)

**Approved by Maya on 2026-08-26**, with two decisions recorded at approval
time:

1. **The stage model is to be redesigned properly, not patched.** The complaint
   must not be collected inside `pet_identification` to avoid a migration. A
   new stage, a changed rank map, and a new migration are explicitly in scope,
   and stage names must describe what the stage actually does. The full design
   had to be written into this contract before implementation started; it is
   the "Stage model redesign" section below.
2. Everything else in the drafted scope is approved as written: the correction
   action, the "şimdi ne yapacağım" mechanism (mechanism only — copy choice
   stays a veterinary-approval item), the recording-notice mechanism (text
   excluded, it belongs to the KVKK gate), inline outbound send, and lowering
   `max_batch_timeout`.

Drafted 2026-08-26 from Maya's four requests after that day's live staging
test, plus a source audit.

## Where this came from

Maya's words after the live run: conversations should move **"daha hızlı, daha
insancıl ve daha net."** Her concrete complaint from that run: she asked
*"şimdi ne yapacam peki"* and the bot replied with a byte-identical repeat of
its previous "Bilgileri aldım..." message — it answered nothing and read like a
machine.

That specific symptom is now explained from source, and it is not a bug in the
repeat detector. `intakeConsumer.ts`'s `hasRepeatedNoProgressQuestion` only
counts an outbound as repeatable if `isEligibleClinicQuestion` is true, which
requires the text to contain `?`. `INTAKE_RECEIVED_TEXT` has no question mark,
so the no-progress handoff can never fire on it, and an owner can be shown that
same closing line indefinitely. Whether the fix is to widen the eligibility
rule, to answer "what happens now" with real copy, or both, is part of this
task's scope.

## Current behavior, established from source

### 1. Confirmation timing

`planPetRegistrationAction` (`src/petRegistration.ts:129`) asks for confirmation
the moment it has a name: zero registered pets, safety clear, and a non-null
`plan.intakeData.pet_name` is enough. It does not wait for species and does not
wait for a complaint. The ask pins the conversation to `pet_identification`
(`src/intakeConsumer.ts`, ask branch) so the stage cannot advance while a
confirmation is outstanding.

### 2. What `HAYIR` does today

Maya's guess was right, and it is worse than she described:

- `parseYesNoReply` (`src/petRegistration.ts`) accepts **only** the exact
  strings `evet`, `hayır`, `hayir` after NFKC normalization, Turkish-locale
  lowercasing, and whitespace collapse. Everything else returns `"repeat"`.
- A `decline` produces `{ kind: "declined" }`, and `src/intakeConsumer.ts` then
  writes `{ ...intakeData, pet_name: null, species: null }` — both fields
  erased — and replies with the generic `PET_IDENTITY_TEXT`, *"Hangi evcil
  hayvanınız için yazıyorsunuz? Lütfen adını belirtin."* The owner starts over.
- A natural correction such as *"hayır, adı Karabaş"* is **not** a decline and
  **not** a correction: it is `"repeat"`, so the same confirmation is re-asked
  verbatim and the attempt counter advances toward `bounded_handoff`. The
  owner's actual correction is discarded even though the extractor already
  parsed the new name out of that same message.

### 3. Recording notice

There is none. No reply category, no prefix, nothing at conversation start. The
only privacy surface is the static `/privacy` page (`src/privacyPage.ts`).

### 4. The ~1 minute delay — found, and it is not a retry

The path, end to end:

| Step | Cost |
|---|---|
| Meta webhook → `enqueueIntakeJob` (`src/index.ts:130`) | immediate, in-request |
| Queue batching (`max_batch_timeout = 5`, `wrangler.staging.toml`) | 0-5 s |
| `extractIntakeViaOpenAi` — `gpt-5.6-luna`, `reasoning: { effort: "none" }`, `max_output_tokens: 1200`, 30 s ceiling | typically low single-digit seconds |
| `finalize_intake_queue_job` writes the reply into `outbound_message_outbox` — **it does not send it** | immediate |
| `drainOutboundMessages`, reachable **only** from the `scheduled` handler (`src/index.ts:239`) on cron `* * * * *` | **0-60 s** |

The delay is the last row. The reply is composed within seconds and then sits in
the outbox waiting for the next cron tick — ~30 s on average, ~60 s worst case,
every turn. It is structural, not a retry and not the model.

`retry_delay = 120` is a real setting but a different signature: it applies only
to genuine retries (`stale_state`, `duplicate_pet_name`, transient failures) and
would present as ~2 minutes on *some* turns, not ~1 minute on nearly all of
them. `wrangler tail` distinguishes the two cleanly — a retry logs a second
consumer invocation for the same message; the cron case logs exactly one.

**The cron cannot be made faster.** `* * * * *` is already Cloudflare's finest
cron granularity. Any real improvement has to stop waiting for cron at all.

Options, in the order I would put them to Maya:

1. **Send inline after finalize, keep cron as the safety net.** Call the
   existing claim/send/accept path from the queue consumer once the outbox row
   is written, and leave the cron drain untouched for anything the inline send
   misses. `drainOutboundMessages` already claims with a token before sending
   and accepts or releases afterwards, so reusing that path — never bypassing
   it — is what keeps double-send impossible. Removes essentially the whole
   delay. No new infrastructure, no new schedule, no extra Worker invocation
   beyond the one already running.
2. **Drop `max_batch_timeout` to 0-1 s.** Saves up to 5 s. One line, safe,
   trivially reversible, and worth doing regardless of option 1.
3. **Leave it.** Legitimate only if a delay is wanted; nothing in the record
   suggests it is.

**Plan verified 2026-08-26, before approval.** `wrangler whoami` reports the
account `Mehmetsait7072@gmail.com's Account`
(`1ac987ec7ff5add2ab333de15e8cff9f`), OAuth token, `queues (write)` in scope.
`wrangler queues list` returns the provisioned intake queues and their DLQs.
Cloudflare Queues cannot be provisioned on the Free plan at all, so this
account is on **Workers Paid**. The "Free tier limits" framing in the draft was
wrong and is withdrawn: neither option below is constrained by Free-plan
limits, and the inline send adds no billable invocation, because it runs inside
the queue-consumer invocation that already exists.

Two related facts found the same way, worth having on record:

- The stored OAuth token is **missing the `workers_tail:read` scope**, so
  `wrangler tail` will fail until someone runs `wrangler login` again. The
  draft above proposes `wrangler tail` for telling a cron wait apart from a
  retry; that will need the re-login first.
- The local wrangler is 4.118.0 while 4.126.0 is available. Not upgraded as
  part of this task — the deployed staging Worker was built with 4.118.0 and
  changing the toolchain mid-task would muddy any comparison.

## Hard constraints any design here must respect

These came out of the audit and each one rules out an otherwise obvious
approach:

- **One outbound reply per inbound message.** `outbound_message_outbox` carries
  `unique (clinic_id, source_provider_message_id)`
  (`20260809000100_intake_reply_outbox.sql:200`). A standalone recording notice
  as its *own* message on turn 1 is impossible without a schema change; a
  prefix on the existing first reply is not.
- **The reply-category set is closed in SQL.** `finalize_intake_queue_job`
  accepts exactly `emergency_handoff`, `human_handoff`, `safety_questions`,
  `pet_identity`, `complaint`, `intake_received`. A new category means a new
  migration.
- **Stages advance exactly one step.** `advance_conversation_intake` raises on
  anything else. Any reordering of the flow has to be expressible as
  single-step transitions.
- **Safety precedence is not negotiable.** On the first turn all eight safety
  signals are `null`, so `evaluateSafetyDecision` returns `needs_safety_check`
  and `planPetRegistrationAction` returns `none`
  (`src/petRegistration.ts:138`). The questionnaire always precedes the pet
  confirmation. "Fewer turns" cannot be bought here.

## Stage model redesign

Maya's decision 1. The problem being fixed: since Task 035,
`pet_identification` does two different jobs — work out *which* pet, and
confirm-and-create it. Deferring the confirmation until the complaint is known
would, under the old model, mean collecting complaints inside a stage called
`pet_identification`. Maya rejected that. So the second job gets its own stage
and its own name.

### The new stage

`intake_confirmation`, inserted between `complaint_collection` and
`safety_check`. It is the stage in which everything collected so far is put to
the owner in one message, and in which an `EVET` writes the `public.pets` row.
The name matches the existing `appointment_confirmation`, which already names a
stage the same way.

### Rank map, before and after

| Stage | Old rank | New rank |
|---|---|---|
| `pet_identification` | 0 | 0 |
| `complaint_collection` | 1 | 1 |
| **`intake_confirmation`** | — | **2** |
| `safety_check` | 2 | 3 |
| `ready_for_triage` | 3 | 4 |
| `appointment_offer` | 4 | 5 |
| `appointment_selection` | 5 | 6 |
| `appointment_confirmation` | 6 | 7 |
| `completed` | 7 | 8 |

`human_handoff` stays outside the rank map, reachable from any non-terminal
stage, exactly as today.

### How this satisfies the single-step rule

`advance_conversation_intake` allows a transition only when
`rank(next) = rank(current) + 1` (`20260806000200_conversation_intake_state.sql:172`).
The insertion keeps every rank consecutive, so every transition in the new
graph is still exactly one step:

```
pet_identification → complaint_collection → intake_confirmation → safety_check
  → ready_for_triage → appointment_offer → appointment_selection
  → appointment_confirmation → completed
```

Ranks are computed inside the function from a `constant jsonb` local, never
stored on the row, so renumbering costs nothing for conversations already in
flight: a conversation sitting in `safety_check` simply reads as rank 3 after
the migration instead of rank 2, and its remaining path is unchanged. **No
backfill, no data migration.** The one behavioral consequence is intended: a
conversation parked in `complaint_collection` when the migration lands will go
to `intake_confirmation` next, not to `safety_check`.

### Transition rules that change

`decideNextStage` (`src/intakeTurn.ts:188`) gets two edits:

- **Leaving `pet_identification` no longer requires a persisted pet.** Today it
  advances only on `petResolution.kind === "matched"`, which a first-time owner
  cannot satisfy before the row exists. It will advance when the pet identity
  is *known*: a matched existing pet, **or** a captured candidate name for an
  owner with no pets. The stage name stays honest — identification means we
  know which animal, not that we have written it down.
- **`complaint_collection` → `intake_confirmation`** on the same condition that
  today sends it to `safety_check` (`complaint !== null || symptoms.length >
  0`), and **`intake_confirmation` → `safety_check`** once the confirmation is
  settled.

### Where the pet row is written

Unchanged mechanically, moved in time: still the `p_create_pet_name` path of
`finalize_intake_queue_job`, still atomic with the stage advance and the outbox
insert, still guarded by the AI-path-only duplicate rule. It now fires from
`intake_confirmation` instead of `pet_identification`, and
`planPetRegistrationAction`'s stage gate moves with it.

### Everyone goes through `intake_confirmation`

A returning owner whose pet already matches has nothing to create, but still
gets the combined confirmation. This costs that owner one extra round trip, and
that is deliberate: the turn it replaces is the one that produced Maya's
complaint, where the bot had nothing left to ask and repeated *"Bilgileri
aldım..."* at her. Replacing a dead-end filler turn with a real question is the
"daha net" half of the request. One stage, one code path, one honest name — no
conditional skip, which the single-step rule would reject anyway.

### Migration surface

One new forward-only migration, following the technique already used twice in
this repository (`20260814000300`, `20260825000100`):

1. `conversations.intake_stage` CHECK constraint — drop and re-add with
   `intake_confirmation`.
2. `advance_conversation_intake` — redefine with the new rank map.
3. `finalize_intake_queue_job` — redefine (from its current 11-argument Task
   035 body) with `intake_confirmation` in the `p_next_stage` allowlist and a
   new `intake_confirmation` value in the `p_reply_category` allowlist.
4. `outbound_message_outbox.reply_category` CHECK — drop and re-add with
   `intake_confirmation`, following the precedent at
   `20260810000200_whatsapp_appointment_flow.sql:20`.

The appointment RPCs need no change: they accept only `ready_for_triage` and
`appointment_offer` as planned stages (`20260814000300:810`), and both keep
their meaning and their consecutive ranks.

TypeScript surface: the `IntakeStage` union and its runtime array
(`src/conversationState.ts`), the parallel arrays in `src/intakeJobLease.ts` and
`src/liveAiDemo.ts`, `decideNextStage`, `planPetRegistrationAction`'s stage
gate, the consumer branches, and the reply-category union.

## Proposed scope

1. **Defer the confirmation and combine it.** Hold the ask until name, species,
   and complaint (when the owner offers one) are collected, then confirm once,
   in the new `intake_confirmation` stage designed above.
2. **Make correction a first-class outcome.** Add a `correction` action beside
   `confirm`/`decline`/`repeat`: when the owner's reply carries a new name or
   species, keep the fields they did not contradict, apply the ones they did,
   and re-confirm with the updated values. Stop erasing both fields on decline.
   A correction is progress and must not count against
   `MAX_PET_IDENTIFICATION_ATTEMPTS`; only genuinely unparseable repeats should.
3. **Answer "şimdi ne yapacam peki" instead of repeating.** Either widen
   `isEligibleClinicQuestion` so a repeated non-question closing line can still
   trigger the no-progress path, or give that state real copy. Copy choice is a
   veterinary-review item (below), not an engineering one.
4. **Recording notice — draft only, do not finalize.** Given the one-reply-per-
   inbound constraint, the cheapest shape is a one-line prefix on the
   conversation's first outbound reply rather than a new message or new
   category. Candidate Turkish text, **explicitly a draft**:

   > *Bilgilendirme: Güvenlik ve yasal yükümlülükler gereği bu görüşmedeki
   > mesajlar kayıt altına alınmaktadır.*

   This wording must not ship on an engineer's or the AI's say-so. It is the
   same notice-timing question already open under the KVKK gate, and it is
   filed there (`docs/production-readiness.md` §1, third bullet). Implementing
   the *mechanism* can proceed on Maya's approval; the *text* ships only after
   KVKK sign-off.
5. **Latency.** Options 1 and 2 above, presented to Maya with the plan question
   answered first.

## Approvals this task will need, separately

| Item | Whose approval |
|---|---|
| Recording-notice wording | KVKK sign-off — already filed under the production-readiness gate |
| Any change to the confirmation, complaint, or closing copy | Reviewing veterinarian (`docs/veteriner-hekim-onay-paketi.md`) |
| Stage-model change implied by deferring confirmation | Maya, as a contract decision |
| Inline outbound send | Maya, plus a staging deploy under the `docs/staging-runbook.md` §12.1 order |

## Explicitly out of scope

- The `stale_state` orphan-pet defect recorded in `PROJECT_CONTEXT.md`. Related
  file, unrelated fix; it deserves its own task.
- Anything in production. This task, like 035, ends at staging.


## Implementation record — 2026-08-26

Every scope item above is implemented, verified locally, proven against a live
Postgres on vetai-test, and applied to vetai-staging with the Worker deployed
back to back on Maya's approval. Production stays out of scope. The one item
still open is the live smoke test, recorded at the end of this section.

### Changed files

| File | Change |
|---|---|
| `supabase/migrations/20260826000100_intake_confirmation_stage.sql` | New. The four-part migration surface designed above: the `conversations_intake_stage_check` list, the rank map inside `advance_conversation_intake`, the `outbound_message_outbox_reply_category_check` list, and the two allowlists inside `finalize_intake_queue_job`. Not applied anywhere yet. |
| `src/conversationState.ts`, `src/intakeJobLease.ts`, `src/liveAiDemo.ts` | `intake_confirmation` inserted after `complaint_collection` in the `IntakeStage` union and in all three `INTAKE_STAGES` sets. |
| `src/intakeTurn.ts` | `decideNextStage` rewritten around the new stage; new `isPetIdentityKnown` helper. |
| `src/intakeReply.ts` | New `intake_confirmation` reply category. The identity ask is now keyed on `nextStage === "pet_identification"` instead of on pet resolution — see the note below. |
| `src/petRegistration.ts` | `correction` and `confirmed` actions; `buildIntakeConfirmationText` replaces `buildPetConfirmationText`; `planPostCreationReply` renamed `planPostConfirmationReply`; decline no longer erases collected fields. |
| `src/intakeConsumer.ts` | `prepareOutboundReply` (the single outbound choke point) now also attaches the recording notice; `hasRepeatedNoProgressQuestion` widened; the confirmation branch finalizes into `intake_confirmation` and passes `intakeData` through unchanged. |
| `src/index.ts` | The queue handler drains the outbound outbox via `ctx.waitUntil` as soon as the turn is written; cron kept as the safety net. |
| `src/localDemo.ts` | Stage and reply-category labels for the new values. |
| `wrangler.toml`, `wrangler.staging.toml` | Both consumers' `max_batch_timeout` 5 → 1. |
| `docs/database-schema.md`, `docs/intake-turn-planning.md` | Stage chain and transition rules updated. |

### One design consequence found during implementation

Deferring pet creation means a first-time owner's pet resolution stays
`needs_clarification` for the whole conversation, because there is no `pets`
row to match against until they confirm. `planIntakeReply` used to key the
"hangi hayvanınız" question on exactly that, so it would have re-asked for the
pet on every turn after the deferral. The question is now keyed on the planned
stage instead, which is the fact it was really asking about. Two tests in
`test/intakeReply.test.ts` pin both halves of this.

### Verification actually run

| Check | Result |
|---|---|
| `npx vitest run` | 1421 passed, 2 skipped, 0 failed (33 files) |
| `npx tsc --noEmit` | clean |
| `npx wrangler deploy --dry-run` | ok, 152.54 KiB |
| `npx wrangler deploy --dry-run --config wrangler.staging.toml` | ok, 152.54 KiB |

### SQL fixtures — run on vetai-test (`cyjpiapxvalqltcsywam`) 2026-08-26

The SQL fixtures in `supabase/tests/` were updated for the new stage —
`006` (the stale-version case had to stay a legal one-step transition, and the
service-role block now walks `complaint_collection -> intake_confirmation ->
safety_check`), `024` (the full-chain walk array and the two state_version
assertions that follow from it), and `035` (a new Fixture 7 that creates the
pet on the real `intake_confirmation -> safety_check` edge and proves nothing
is written to `pets` before the owner confirms).

All three were run against vetai-test after this migration was applied there,
and all three passed: `006` and `024` returned their `PASS` row, `035`
returned no rows as designed. That run found one fixture bug, fixed here.
`006`'s last service-role block passed `p_intake_data => '{}'::jsonb` to a
call it expected to fail on `illegal transition`, but
`advance_conversation_intake` validates its arguments *before* the transition
check, so the call raised `invalid intake_data` and the block re-raised. The
payload is now `'{"test": true}'::jsonb`, matching the ten other
non-intake_data error tests in the same file. The two permission tests keep
`'{}'` deliberately: `EXECUTE` is checked before the body runs, so the payload
never reaches validation there.

Two earlier fixture failures were investigated and ruled out as unrelated to
this task. `013` and `017` have been broken since Task 033 (2026-08-22): they
call `ingest_whatsapp_text_message` without a `whatsapp_contact_routes` row,
which the strict AI allowlist now answers `'ignored'`. Both were withdrawn
from this task's runbook and left for a separate fix.

### Staging migration and deploy — 2026-08-26, on Maya's approval of the pair

Applied and deployed back to back in one session, deliberately, because the
new rank map inside `advance_conversation_intake` shifts
`complaint_collection -> safety_check` from +1 to +2. The Task 035 Worker and
the Task 036 schema are incompatible on exactly that one transition, and
`finalize_intake_queue_job` has no exception handler around that call, so a
turn on that edge inside the window would have surfaced as a queue retry.

| Step | Output |
|---|---|
| Exposure check, immediately before | one active conversation, at `safety_check`; zero at `complaint_collection`, so the only affected edge was empty |
| `supabase migration list` before | `20260826000100` local-only, Remote column empty |
| `supabase db push --linked` | `Applying migration 20260826000100_intake_confirmation_stage.sql` then `Finished`. 18:59:49Z to 18:59:52Z |
| `npx wrangler deploy --config wrangler.staging.toml` | `Uploaded vetai-staging`, version `12ae7efb-3f1e-4fe9-9df4-2c62f6cc9958`, producer and both consumers listed. Done 19:00:27Z |
| Window between the two | **38 seconds**, against a consumer `retry_delay` of 120s: anything caught in it would have retried after the new Worker was live |
| `supabase migration list` after | Local and Remote both `20260826000100`, applied `2026-08-26 00:01:00`. No history drift |
| Schema check on staging | all four objects carry `intake_confirmation`; `finalize_intake_queue_job` has exactly **1** overload, so the old 11-argument signature really was dropped |
| `GET /health` | `200` `{"status":"ok","version":"0.1.0"}` |
| `GET /ready` | `200` `{"status":"ready"}` |
| Failure check after the pair | no new failed outbox rows; the single `failed_at` row dates from 2026-08-23 and is unrelated. Zero handoffs |

The migration went through `supabase db push`, not the dashboard, so
`supabase_migrations.schema_migrations` recorded it. That distinction matters:
vetai-test received the same migration by dashboard paste, which applies the
DDL without writing the history row, so a later `db push` against that project
will try to apply it a second time and fail. Accepted on a disposable test
project, never acceptable here.

**There is no rollback out of this.** `wrangler rollback` would restore the
Task 035 code against the Task 036 schema, which is the broken combination the
back-to-back pair existed to avoid. Recovery is fix-forward only.

### Still open

The live smoke test from the allowlisted test number: one turn confirming the
conversation stops at `intake_confirmation` with nothing written to `pets`,
and that only `evet` creates the pet and moves it to `safety_check`. It needs
a real inbound WhatsApp message, so it is Maya's step, not a command this
session can run.

### Smoke test round 1 — 2026-08-27, and the loop it found

Round 1 first hit a stale conversation. Maya's message landed in
`1aa4d07a…`, created 2026-08-25, which already carried pet `karamel` and had
passed pet identity long before this task existed — so it answered
`intake_received` at `ready_for_triage` with no recording notice
(`withRecordingNotice` fires only at `state_version === 1`) and proved nothing
either way. It was the same single active conversation the pre-migration
exposure check had found at `safety_check`. Closed with `status='completed'`
on Maya's approval, which releases the
`(clinic_id, owner_id) where status in ('active','handoff')` partial unique
index so the next inbound opens a fresh conversation.

Round 1 proper then exposed a real defect, and it is a blocker for closing
this task. Conversation `7d006d0c…` opened clean, sent the recording notice on
turn 1 (so that half of Task 036 is proven), asked the safety questions, and
then locked at `pet_identification`, re-sending the identical
`PET_IDENTITY_TEXT` on every turn with no exit. Cause: `PetResolution` has no
"known owner, new animal" case and `isPetIdentityKnown` accepts a candidate
name only when the owner has no pets on file, so Maya's test account — which
still owns `karamel` from Task 035 — can never register a second pet. The
Task 029 net misses it because the owner re-sends the name each turn, keeping
`isNoActionableFact` false. Full analysis and the permanent-fix direction are
recorded in `PROJECT_CONTEXT.md`.

Mitigated here, not fixed: `stalledOnPetIdentity` in `src/intakeConsumer.ts`
adds `pet_identification` to the same bounded-handoff floor
`intake_confirmation` already had. Holding at `pet_identification` while the
identical question has already gone out twice now hands off to a human. Three
tests in `test/intakeConsumer.test.ts` pin it: the loop hands off, one prior
question does not, and a name that actually advances the stage is untouched.
The pre-existing fixture that asserted the opposite was rewritten — with
`pet_name: "Pamuk"` against an owner whose only pet is Fluffy it was pinning
this very loop as correct behaviour, and its `not.toBe` form would also have
passed on an undefined body.

`npx vitest run` 1423 passed, 2 skipped, 0 failed. `npx tsc --noEmit` clean.
`npx wrangler deploy --dry-run --config wrangler.staging.toml` ok. Worker-only
change, no migration.

#### Round 1 recovery and reviewed Worker deploy — 2026-08-27

Codex resumed the review and reran the complete local gate: frozen install,
typecheck, 1,423 tests with the two paid eval gates skipped, production and
staging Wrangler dry-runs, and `git diff --check` all passed. The accidental
`ponytail:` word in the new source comment was removed; runtime behavior did
not change. Supabase staging migration history matched all 20 local migrations.

On Maya's explicit approval, the Worker-only mitigation was deployed to
`vetai-staging` as version `82573d66-3907-4935-9749-54556793eb6e`. The real
staging URL then returned `200` from both `/health` and `/ready`. A read-only
Meta audit confirmed that the staging app is published, its registered number
is subscribed, its callback targets the staging Worker, and the `messages`
webhook field is subscribed. No production resource changed.

Maya separately approved deleting the synthetic `karamel` pet so Task 036 can
exercise its real zero-pet path. Read-only inspection established exactly one
pet row, exactly one referencing conversation (already `completed`), no
appointment row, and no pet link on the active `7d006d0c…` conversation. The
core composite FK is `ON DELETE NO ACTION`, so a guarded atomic staging block
first set the completed conversation's `pet_id` to null and then deleted only
that exact pet row. Postcondition query: zero matching pets, the completed
conversation unlinked, and `7d006d0c…` still `active`,
`pet_identification`, `state_version = 4`, `pet_id is null`.

One test-procedure correction is now explicit: a `handoff` conversation is
still reused by `ingest_whatsapp_text_message`, because the partial unique/open
conversation predicate covers both `active` and `handoff`. Handoff alone can
never open the next fresh conversation; the old row must first be closed.

The next real inbound exposed a second sequencing mistake in the original
test plan rather than a product failure. Because `karamel` had already been
deleted, the owner was genuinely zero-pet at context read. The old
`pet_identification` conversation therefore unlocked normally instead of
reaching `stalledOnPetIdentity`: the inbound persisted, an outbound reply was
accepted, and the conversation advanced to `complaint_collection`,
`state_version = 5`, still with `pet_id is null`. On Maya's separate approval,
Codex then changed only that staging conversation's operational `status` from
`active` to `completed`; message history, intake stage/data, owner data, and
outbox rows were retained. The open-conversation partial unique constraint is
now released, so the following inbound — not the one just processed — is the
first genuinely fresh zero-pet Task 036 smoke turn. The bounded second-pet
handoff remains covered by local regression tests and deployed code, but this
specific live run did not exercise it after the pet fixture was removed.

### Smoke test round 2 — fresh zero-pet path passed, 2026-08-27

Maya then sent a genuinely fresh complaint from the allowlisted staging
number. A new active conversation opened with `pet_id is null`; its first
outbound reply carried the recording-notice prefix and the deterministic
safety questions. `public.pets` still contained zero rows.

After Maya explicitly answered all eight safety questions negatively, the
conversation produced the combined `intake_confirmation` prompt for
`Minnoş` / `Kedi` / `2 gündür yemek yemiyor`. A second read of `public.pets`
still showed zero rows, proving that extraction and the confirmation prompt do
not create a pet.

Only after Maya sent the exact `EVET` confirmation did staging contain one
`public.pets` row (`Minnoş`, `Kedi`). The same active conversation's `pet_id`
then referenced that exact row, advanced to `safety_check` at
`state_version = 4`, and the Worker emitted its normal
post-confirmation reply. This closes the live acceptance criterion: pet
creation is deferred until explicit confirmation and the created row is linked
to the conversation in the same finalized turn. No production resource was
changed.

### Task 036 closure record

- Local gate: frozen install, typecheck, 1,423 tests passed with two paid eval
  gates skipped, production and staging dry-runs, and `git diff --check` all
  passed.
- Database gate: the Task 036 migration and affected rollback fixtures passed
  on `vetai-test`; migration history is aligned on `vetai-staging`.
- Live gate: recording notice, deterministic safety questions, deferred
  combined confirmation, zero rows before `EVET`, one linked pet after `EVET`,
  and inline outbound delivery were observed on staging.
- Known limitation: owners who already have a different pet on file still use
  the bounded human-handoff floor; the full second-pet registration flow is a
  separate task recorded in `PROJECT_CONTEXT.md`.
- Production deployment and the external veterinary/KVKK gates remain open.

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
