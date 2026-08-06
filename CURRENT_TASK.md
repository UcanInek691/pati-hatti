# Current task — 006 persisted conversation intake state

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex

## Goal

Add the smallest durable conversation-state foundation needed before AI
extraction. Store each conversation's current intake stage and structured
intake data in Supabase, expose narrowly scoped service-role RPCs to load and
advance that state, and call those RPCs through native Worker `fetch` helpers.

This task does not call an LLM, generate or send WhatsApp replies, classify
triage, create appointments, add queues, or wire state advancement into the
webhook handler.

## Starting context

- Starting commit: `5fc3ffb` on `main`.
- The worktree is clean.
- Task 005 persists signed inbound WhatsApp text messages atomically through
  `public.ingest_whatsapp_text_message(...)` and passed its disposable
  `vetai-test` SQL gate.
- `conversations` already carries `clinic_id`, `owner_id`, optional `pet_id`,
  and operational `status`; do not create a second conversation-state table.
- The Worker uses native `fetch` for Supabase RPC calls and has no Supabase SDK.

Before editing, follow `AGENTS.md`, verify these facts from the repository, and
fill the Observed context section. Stop if repository evidence conflicts.

## Allowed changes

- New migration
  `supabase/migrations/20260806000200_conversation_intake_state.sql`.
- New rollback SQL test
  `supabase/tests/006_conversation_intake_state.sql`.
- One small Worker module, preferably `src/conversationState.ts`.
- Tests for that module under `test/`.
- `docs/database-schema.md` for the new columns/RPCs.
- The Observed context and Delivery record sections of this file.

Do not change dependencies, lockfiles, webhook routing, Task 004/005
migrations, `Env`, Wrangler configuration, `AGENTS.md`, `PROJECT_CONTEXT.md`,
or unrelated behavior.

## Database contract

Alter `public.conversations` with:

- `intake_stage text not null default 'pet_identification'` constrained to:
  `pet_identification`, `complaint_collection`, `safety_check`,
  `ready_for_triage`, `appointment_offer`, `appointment_selection`,
  `appointment_confirmation`, `human_handoff`, `completed`.
- `intake_data jsonb not null default '{}'::jsonb`, constrained to a JSON
  object. It is a structured working document, not a raw webhook copy.
- `state_version integer not null default 1`, constrained to be positive.

Do not add a table, enum, trigger, extension, or dependency. Existing rows must
receive the defaults without data loss.

Create exactly two Data API functions:

1. `public.get_conversation_intake_context(p_conversation_id uuid)`
2. `public.advance_conversation_intake(...)`

Both functions must use `SECURITY INVOKER`, an empty `search_path`, fully
qualified objects, no dynamic SQL, and execution granted only to
`service_role` after revoking `PUBLIC`, `anon`, and `authenticated`.

### Context read RPC

Return exactly one row for an existing conversation containing:

- conversation ID, clinic ID, owner ID, optional pet ID;
- operational status, intake stage, intake data, and state version;
- owner display name;
- the owner's pets as a JSON array of `{ id, name, species }`, ordered
  deterministically by creation time then ID;
- at most the latest 12 messages as a chronological JSON array of
  `{ direction, content, created_at }`.

Return zero rows for an unknown conversation. Do not return phone numbers,
WhatsApp IDs, webhook hashes, secrets, or data from another owner/clinic.

### State advance RPC

Inputs must include conversation ID, expected state version, next stage,
optional pet ID, and a complete replacement `intake_data` JSON object. Keep
the update atomic and use optimistic concurrency:

- Reject an invalid/empty JSON document, invalid stage, nonpositive expected
  version, unknown conversation, or pet that does not belong to the
  conversation's owner and clinic.
- Permit the same stage (an idempotent data refresh).
- Otherwise permit only forward transitions in this graph:
  `pet_identification -> complaint_collection -> safety_check -> ready_for_triage -> appointment_offer -> appointment_selection -> appointment_confirmation -> completed`.
- Permit transition from any non-completed stage to `human_handoff`.
- `human_handoff` and `completed` are terminal in this task; only a same-stage
  refresh is allowed.
- Update only when `state_version = p_expected_version`; on success increment
  the version exactly once and return one row containing the new stage and
  version.
- Return zero rows for a stale version. Raise on all other invalid input. A
  rejected update must not mutate the conversation.
- When moving to `human_handoff`, also set operational `status = 'handoff'`.
  When moving to `completed`, set operational `status = 'completed'`.
  Other transitions must not silently reopen a handoff/completed conversation.

Use the existing composite pet/owner/clinic relationship as the tenant-safety
boundary; do not trust a caller-provided clinic ID.

## Worker helper contract

Add typed native-fetch helpers for the two RPCs. Follow the existing
`src/supabaseIngest.ts` transport rules instead of introducing a generic client
or abstraction layer:

- Construct RPC URLs with `new URL`.
- Require nonblank Supabase URL/key and HTTPS except loopback HTTP.
- Put the service-role key only in `apikey` and `Authorization` headers.
- Validate response shapes at runtime; never cast an unchecked response into a
  success value.
- Distinguish `not_found`, `stale`, and `failed` without exposing/logging
  response bodies.
- Never log intake data, message content, owner/pet identifiers, keys, or URLs.
- Do not modify `src/index.ts` in this task.

Keep the module small and direct. A little duplicated transport validation is
preferable to a speculative framework.

## Required tests

Unit tests with mocked native `fetch` must cover:

- exact RPC URLs, methods, headers, and request bodies;
- valid context parsing including null pet, pet list, and chronological recent
  messages;
- zero-row context as `not_found`;
- valid state advancement and returned version;
- zero-row advancement as `stale`;
- malformed/non-2xx/network responses and blank/insecure configuration as
  `failed`;
- no response body or sensitive inputs are logged.

Add a rollback SQL test proving:

- the new columns have the required defaults/constraints and a newly inserted
  conversation receives those defaults;
- context contains only the target owner/clinic, ordered pets, and the latest
  12 messages in chronological order;
- a valid forward transition and same-stage refresh each increment the version
  once;
- a stale update returns zero rows with no mutation;
- skipped/backward/terminal transitions fail without mutation;
- a cross-owner or cross-clinic pet assignment fails;
- handoff/completed transitions synchronize operational status;
- `anon` and `authenticated` cannot execute either RPC while `service_role`
  can;
- rollback removes every fixture.

Keep every existing test green.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not commit, push, deploy, link the repository to Supabase, mutate
external services, or write real credentials. Sonnet must not apply the
migration. Codex reviews first, then applies and tests it only in the
disposable `vetai-test` project.

## Observed context — Sonnet fills before coding

- Starting HEAD: `5c42c00` (`docs: define conversation state task`), one
  docs-only commit ahead of the `5fc3ffb` this task's "Starting commit"
  names — matches the established two-commit task-transition pattern.
  `git status --porcelain` was clean before any edit.
- Initial worktree state: clean. `src/index.ts` and `src/env.ts` read
  verbatim and confirmed unchanged from Task 005's delivery. `src/whatsappIngest.ts`
  confirmed to still contain Codex's post-review refinements (Unicode-safe
  length/truncation via `Array.from`, `MAX_ID_LENGTH = 512`, `Number.isSafeInteger`
  timestamp guard, `Map`-based conflict-vs-duplicate dedup) — none of that
  file touched, per the contract's file list.
- Relevant schema/RPC/test evidence: `public.conversations` (from
  `20260806000000_core_tenant_schema.sql`) already has `clinic_id`,
  `owner_id` (not null), `pet_id` (nullable, FK on `(pet_id, owner_id,
  clinic_id)`), and operational `status` — the intake columns were added
  with `ALTER TABLE`, no new table. `public.owners` and `public.pets` both
  carry `(id, clinic_id)`/`(id, owner_id, clinic_id)` uniqueness used as the
  tenant-safety join in the new RPCs. `src/supabaseIngest.ts` (Task 005,
  Codex-refined) was read in full and used as the direct template for
  `src/conversationState.ts`'s transport rules: `new URL` construction,
  `isLoopbackHttpUrl` (http allowed only for `localhost`/`127.0.0.1`/`[::1]`),
  service-role key only in `apikey`/`authorization` headers, runtime
  response-shape validation before trusting any field, blank-config and
  non-2xx/network/malformed-body all mapped to a `"failed"` outcome.
  `supabase/migrations/20260806000100_ingest_whatsapp_text_message.sql` was
  used as the template for the new migration's `SECURITY INVOKER`, empty
  `search_path`, fully-qualified, `revoke ... grant ... to service_role`
  pattern. `supabase/tests/005_ingest_whatsapp_text_message.sql` was used as
  the template for the new rollback SQL test's `begin/rollback`,
  nested-`begin...exception when insufficient_privilege/others then null`
  savepoint pattern, and role-switching (`set local role
  anon/authenticated/service_role` + `reset role`) conventions.
- Planned files: `supabase/migrations/20260806000200_conversation_intake_state.sql`,
  `src/conversationState.ts`, `test/conversationState.test.ts`,
  `supabase/tests/006_conversation_intake_state.sql`,
  `docs/database-schema.md` (new section appended) — matches the contract's
  Allowed changes list exactly. `src/index.ts`, `Env`, dependencies,
  lockfiles, and all Task 004/005 files were left untouched.
- Conflicts or blockers: none. Repository state matched the contract's
  "Starting context" claims in every respect that could be verified by
  reading the repository (no live Supabase connection was available or
  used, consistent with the contract's prohibition on Sonnet applying the
  migration).

## Delivery record — Sonnet fills after coding

- Changed files:
  - `supabase/migrations/20260806000200_conversation_intake_state.sql` (new)
    — `ALTER TABLE public.conversations` adding `intake_stage`, `intake_data`,
    `state_version`; `public.get_conversation_intake_context(p_conversation_id
    uuid)`; `public.advance_conversation_intake(p_conversation_id,
    p_expected_version, p_next_stage, p_pet_id, p_intake_data)`. Not applied
    to any database.
  - `src/conversationState.ts` (new) — `getConversationIntakeContext` and
    `advanceConversationIntake` native-`fetch` Worker helpers.
  - `test/conversationState.test.ts` (new) — 28 tests.
  - `supabase/tests/006_conversation_intake_state.sql` (new) — rollback SQL
    test. Not executed against any database.
  - `docs/database-schema.md` — appended a "Persisted conversation intake
    state" section (no "validation passed" callout yet, since this task's
    migration hasn't been applied anywhere).
  - `CURRENT_TASK.md` — this Observed context and Delivery record.
  - No other file touched. `src/index.ts`, `src/env.ts`, dependencies,
    lockfiles, Task 004/005 migrations, `AGENTS.md`, and `PROJECT_CONTEXT.md`
    are unchanged.
- Acceptance criteria satisfied:
  - Three new columns added by `ALTER TABLE` only, with the exact defaults/
    constraints specified; no new table/enum/trigger/extension/dependency.
  - Both RPCs are `SECURITY INVOKER`, `set search_path = ''`, fully qualify
    every relation, use no dynamic SQL, and `revoke ... from public, anon,
    authenticated` / `grant ... to service_role` only.
  - Context RPC returns one row scoped to the target conversation's own
    owner/clinic (joins `owners`/`pets`/`messages` on the resolved
    `clinic_id`/`owner_id`, never a caller-supplied one), pets ordered by
    `created_at, id`, at most the latest 12 messages returned in
    chronological order via a `limit 12` subquery ordered `desc` then
    re-aggregated `asc`, zero rows for an unknown id, and never selects
    `phone_e164`/`whatsapp_message_id`/hashes.
  - Advance RPC validates `p_expected_version > 0`, `p_next_stage` against
    the 9-value graph, `p_intake_data` as a JSON object, and (when provided)
    that `p_pet_id` belongs to the resolved owner+clinic — all via `raise
    exception` before any `UPDATE` runs, so a rejection cannot mutate.
    Same-stage refresh is always permitted. Forward transitions are
    restricted to exactly one step via a fixed rank map. `human_handoff` is
    reachable from any stage except `completed` and except itself (handled
    by the same-stage branch). Both `human_handoff` and `completed` block
    every transition away from themselves, including into each other. The
    `UPDATE ... WHERE state_version = p_expected_version` plus `FOUND` check
    is what turns a stale version into a zero-row return instead of an
    error. `status` is synced to `handoff`/`completed` only on those two
    target stages; every other transition leaves `status` untouched.
  - `src/conversationState.ts` mirrors `src/supabaseIngest.ts`'s transport
    rules exactly (own local `isLoopbackHttpUrl` copy, per the contract's
    preference for small duplication over a shared abstraction): `new URL`,
    HTTPS-except-loopback, service-role key only in `apikey`/`authorization`
    headers, full runtime validation of the response shape before any field
    is trusted, and `not_found`/`stale`/`failed` are distinguished without
    ever logging a response body, intake data, or an identifier.
    `src/index.ts` was not touched.
  - Required unit test coverage (URL/method/headers/body for both RPCs,
    null-pet/pet-list/chronological-message parsing, zero-row → `not_found`,
    valid advance + returned version, zero-row advance → `stale`, malformed/
    non-2xx/network/blank-and-insecure-config → `failed`, no logging) is all
    present in `test/conversationState.test.ts`.
  - The rollback SQL test covers every required bullet: defaults on insert,
    a constraint-violation check, tenant-scoped/ordered/12-message-capped
    context with an explicit cross-conversation leak check, one-increment
    forward and same-stage transitions, a stale zero-row/no-mutation update,
    skipped/backward/terminal-transition rejections each verified to leave
    `state_version` unchanged, cross-owner and cross-clinic pet rejection,
    non-object `intake_data`/nonpositive version/unknown-conversation
    rejection, `human_handoff` and `completed` status sync plus their
    terminal enforcement (including blocking `completed -> human_handoff`),
    `anon`/`authenticated` denial vs. `service_role` success on both RPCs,
    and a final `rollback` plus zero-row `PASS` assertion.
- Commands and exact results:
  - `pnpm install --frozen-lockfile` → `Already up to date`.
  - `pnpm typecheck` → clean, no output.
  - `pnpm test` → `Test Files 7 passed (7)`, `Tests 103 passed (103)`
    (28 new in `conversationState.test.ts`; all prior 75 tests still green).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
    succeeded, `Total Upload: 11.44 KiB / gzip: 3.62 KiB`, `--dry-run:
    exiting now.`
  - `git diff --check` → exit 0 (only CRLF-on-touch advisory warnings on
    `CURRENT_TASK.md`/`docs/database-schema.md`, not whitespace errors).
- Database checks actually run: none. No live Postgres/Supabase connection
  was used or available in this session; the migration and SQL rollback
  test were written and self-reviewed but never executed, per the
  contract's explicit prohibition on Sonnet applying this migration.
- Checks not run and why: the SQL rollback test itself
  (`supabase/tests/006_conversation_intake_state.sql`) — by contract, only
  Codex applies and tests migrations, and only in the disposable
  `vetai-test` project.
- Known limitations:
  - The advance RPC treats an omitted-vs-explicit-null `p_pet_id` the same
    way (leaves the existing `pet_id` untouched via `coalesce`); there is no
    way to explicitly clear an already-assigned pet through this RPC. The
    contract only calls `p_pet_id` "optional," not describes a clearing
    path, so this was the minimal reading — flagging in case a later task
    needs pet reassignment/clearing.
  - `p_intake_data` is validated only for being a JSON object, not for any
    particular key shape; the contract calls it "a structured working
    document," and no schema was specified, so no further validation was
    added.
  - The Worker helpers are unused — nothing calls them yet, matching the
    contract's explicit exclusion of webhook wiring from this task.
- Risks for Codex review:
  - The advance RPC's forward-transition rule is a hardcoded jsonb rank map
    (`v_stage_rank`) checked as `next_rank = current_rank + 1`; this is the
    single piece of logic most worth exercising directly in `vetai-test`
    against every adjacent pair and against at least one skip-ahead and one
    backward pair, since a rank-map typo would silently change which
    transitions are legal.
  - The zero-row-on-stale-version behavior depends on plpgsql's `FOUND`
    variable being set correctly by `UPDATE ... RETURNING ... INTO`; I
    could not execute this to confirm empirically, and an earlier draft of
    this function had a bug here (unconditionally calling `return next`
    regardless of whether the `UPDATE` matched a row, which would have
    returned a phantom `(NULL, NULL)` row on every stale update instead of
    zero rows) — worth Codex's specific attention since it's the kind of
    off-by-something that only shows up under an actual concurrent-update
    test.
  - `jsonb_agg(... order by ...)` inside a scalar subquery (for `pets`) and
    an outer-aggregate-over-a-limited-inner-subquery (for `recent_messages`,
    to get "last 12, then chronological") are both correct patterns as far
    as I can verify by reading, but neither has run against real Postgres
    in this session.
  - I did not add an explicit `where p_conversation_id is not null` guard on
    the context RPC (relying on `c.id = null` naturally matching zero rows)
    — behaviorally correct but worth a second look since the advance RPC
    does raise explicitly on a null conversation id, which is an
    intentional asymmetry (read RPC: zero rows for "not found" including
    null id; write RPC: raise for any invalid input including null id).

## Codex review and verification

- Reviewed both RPCs, the Worker response parser, transition and optimistic-
  concurrency paths, grants, tenant-safe pet lookup, message-window query,
  migration scope, and rollback test. No unresolved blocking finding remains.
- Tightened the Worker trust boundary with exact intake-stage, operational-
  status, message-direction, and positive-version validation.
- Fixed the database contract so `advance_conversation_intake` rejects an
  empty `{}` intake document, and added unit/SQL coverage for the new boundary.
- The first live SQL-test attempt exposed a fixture conflict with Task 005's
  one-open-conversation-per-owner index. The terminal-state fixtures now use
  separate owners; no production migration logic was changed for that issue.
- Codex verification: frozen install passed; strict typecheck passed; 108/108
  tests passed; Wrangler dry-run passed; final diff/NUL/whitespace checks
  passed.
- Applied `20260806000200_conversation_intake_state.sql` only to the disposable
  `vetai-test` Supabase project. The SQL editor reported success.
- Ran `supabase/tests/006_conversation_intake_state.sql` against that project.
  The final run returned `PASS` with zero surviving clinics, owners, pets,
  conversations, and messages after rollback.
- Decision: `PASS`. Production deployment remains out of scope and must use a
  managed Supabase migration workflow.
