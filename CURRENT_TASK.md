# Current task — 003 core tenant schema and RLS

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex

Security reviewer after Codex: Claude Opus (read-only)

## Goal

Create the minimum Supabase/PostgreSQL tenant schema and RLS foundation. This task produces SQL and concise schema documentation only; it does not connect the Worker to Supabase.

## Before implementation

Follow `AGENTS.md`. Verify the repository rather than trusting this summary, then fill the Observed context section before editing product files. If the worktree contains unexplained changes or repository facts conflict with this contract, stop and report the conflict.

Do not modify `AGENTS.md`, `PROJECT_CONTEXT.md`, `AI_WORKFLOW.md`, existing Worker source, existing tests, package dependencies, or lockfiles.

## Allowed changes

- `supabase/config.toml` only if minimal configuration is actually needed.
- `supabase/migrations/20260806000000_core_tenant_schema.sql`.
- `docs/database-schema.md`.
- The **Observed context** and **Delivery record** sections of this file.

## Required tables

Create only:

- `clinics`
- `clinic_staff`
- `whatsapp_accounts`
- `owners`
- `pets`
- `conversations`
- `messages`
- `webhook_events`

## Data-model requirements

- Use UUID primary keys and `timestamptz` timestamps.
- Every tenant-owned table has `clinic_id NOT NULL`.
- `clinic_staff.user_id` references `auth.users`; `(clinic_id, user_id)` is its primary key.
- `whatsapp_accounts.phone_number_id` is globally unique. Store no token or secret.
- `owners` has unique `(clinic_id, phone_e164)` and a basic E.164 check.
- Pet-to-owner, conversation-to-owner/optional-pet, and message-to-conversation relationships cannot cross clinic boundaries. Enforce this with composite unique/foreign-key constraints, not application assumptions.
- If a conversation references a pet, the pet must belong to that conversation's owner as well as its clinic.
- Create a clinic-scoped partial unique index for non-null `messages.whatsapp_message_id`.
- `webhook_events` has a clinic-scoped unique provider event ID plus `payload_hash`, `processing_status`, `received_at`, optional `processed_at`, and masked/sanitized `last_error`. Do not store the raw webhook payload.
- Add only useful relationship, phone, status, and recency indexes.
- Reuse one `set_updated_at()` trigger function for mutable tables.
- Use `text` plus checks rather than PostgreSQL enum types.

Allowed state values:

- `clinic_staff.role`: `admin`, `veterinarian`, `receptionist`.
- `conversations.status`: `active`, `handoff`, `completed`.
- `messages.direction`: `inbound`, `outbound`, `system`.
- `webhook_events.processing_status`: `received`, `processing`, `processed`, `failed`.

## RLS and privileges

- Enable RLS on every table.
- Add one small `is_clinic_staff(uuid)` helper based on `auth.uid()` and `clinic_staff` membership. It must be `SECURITY DEFINER`, use a fixed safe `search_path`, and contain no dynamic SQL.
- Revoke public function execution; grant only what `authenticated` and `service_role` require.
- Explicitly revoke application-table access from `anon`.
- `authenticated` may read only same-tenant `clinics`, `clinic_staff`, and `whatsapp_accounts`; their management remains service-role-only.
- Same-tenant authenticated staff may select/insert/update/delete `owners`, `pets`, `conversations`, and `messages`. Apply correct `USING` and `WITH CHECK` policies.
- Create no `anon` or `authenticated` policy for `webhook_events`; secure backend service role owns it.
- Combine RLS and constraints so changing a submitted `clinic_id` cannot create cross-tenant data or relationships.

## Documentation

`docs/database-schema.md` must briefly explain each table and relationship, tenant isolation, RLS access, why raw webhook payloads are not stored, and why service-role credentials belong only in Worker secret bindings.

State explicitly that the migration has not yet been applied to a real Supabase project and requires both Opus security review and migration/RLS testing in a disposable project before use.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Use a safe, connection-free Supabase CLI syntax check only if one is genuinely available. Docker and a linked disposable project are currently absent, so report database migration/RLS execution as `NOT RUN` unless repository evidence proves that changed. Never claim the migration was applied based only on reading SQL.

Do not add dependencies, real secrets, production URLs, destructive `DROP` statements, seed patient data, commits, pushes, deployments, or external mutations.

## Acceptance criteria

- Scope contains only the allowed files.
- All eight tables and required tenant constraints are present.
- Cross-clinic and pet/owner mismatches are blocked at database level.
- RLS and grants match this contract; `anon` has no application-table access.
- No raw webhook payload or secret-storage column exists.
- Existing Worker checks remain green.
- Unrun database checks are reported honestly.

## Observed context — Sonnet fills before coding

- Starting HEAD: `7df443e` ("docs: add repository context protocol"), branch `main`.
- Initial worktree state: clean (`git status` → "nothing to commit, working tree clean"). Repo has a dubious-ownership Git safety flag (dir owned by a different Windows user than the current session); worked around per-invocation with `git -c safe.directory=...` rather than changing global config, so no config was mutated.
- Relevant existing files/patterns: no `supabase/` or `docs/` directories exist yet — both are created fresh by this task. `src/env.ts` already declares `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on `Env` but nothing in `src/` consumes them yet (matches PROJECT_CONTEXT.md "Not implemented" list). `wrangler.toml` has no Supabase binding. No existing SQL/migration files or trigger-function patterns to reuse.
- Environment/tool availability verified: `rtk` not found (native commands used, reported once here per AGENTS.md). Supabase CLI present (`2.108.0`). Docker not installed (`docker: command not found`) — matches PROJECT_CONTEXT.md. No linked/disposable Supabase project. `supabase db *` subcommands (`diff`, `lint`, `push`, `pull`, `reset`, `start`, `query`, `advisors`) all require a live Postgres connection (local via Docker or a linked remote project); none is connection-free, so no genuine offline syntax check exists — only manual SQL review was performed.
- Planned files: `supabase/migrations/20260806000000_core_tenant_schema.sql`, `docs/database-schema.md`. No `supabase/config.toml` added — not needed since no CLI project commands are run in this task.
- Key schema/RLS risks identified: (1) composite FKs need `UNIQUE(id, clinic_id)`-style helper constraints on parent tables since `id` alone can't be an FK target for a multi-column reference; used this to also enforce "pet must belong to conversation's owner" via a 3-column FK `(pet_id, owner_id, clinic_id) → pets(id, owner_id, clinic_id)`. (2) `is_clinic_staff()` must be `SECURITY DEFINER` with a fixed `search_path` to avoid privilege-escalation/search-path hijacking. (3) `service_role` bypasses RLS in Supabase but still needs explicit table GRANTs (RLS bypass ≠ privilege grant), so grants are set explicitly rather than assumed. (4) the initial implementation chose `ON DELETE RESTRICT` for `conversations → pets`; Codex review changed this to `NO ACTION` while retaining direct-delete protection.
- Conflicts or blockers: none. Repository evidence matches `PROJECT_CONTEXT.md` and `CURRENT_TASK.md`; proceeding.

## Delivery record — Sonnet fills after coding

- Changed files:
  - `supabase/migrations/20260806000000_core_tenant_schema.sql` (new; renamed during review to use Supabase's 14-digit timestamp convention)
  - `docs/database-schema.md` (new)
  - `CURRENT_TASK.md` (Observed context / Delivery record sections only)
  - No `supabase/config.toml` added — not needed for this task.
- Acceptance criteria satisfied:
  - Scope contains only allowed files (2 new files + this task file).
  - All eight required tables present with UUID PKs and `timestamptz` columns; every tenant table has `clinic_id NOT NULL`.
  - Cross-clinic/pet-owner mismatches blocked at the DB level via composite FKs: `pets(owner_id, clinic_id) → owners(id, clinic_id)`; `conversations(owner_id, clinic_id) → owners(id, clinic_id)`; `conversations(pet_id, owner_id, clinic_id) → pets(id, owner_id, clinic_id)` (enforces "pet must belong to the conversation's owner and clinic" in one constraint); `messages(conversation_id, clinic_id) → conversations(id, clinic_id)`.
  - `clinic_staff` PK is `(clinic_id, user_id)`, `user_id` references `auth.users`.
  - `whatsapp_accounts.phone_number_id` globally unique; no token/secret column anywhere.
  - `owners` unique `(clinic_id, phone_e164)` with a basic E.164 check.
  - Clinic-scoped partial unique index on `messages.whatsapp_message_id` (`where whatsapp_message_id is not null`).
  - `webhook_events`: clinic-scoped unique `provider_event_id`, plus `payload_hash`, `processing_status` (checked enum), `received_at`, optional `processed_at`, length-capped `last_error`; no raw-payload column.
  - Allowed state values match exactly (`clinic_staff.role`, `conversations.status`, `messages.direction`, `webhook_events.processing_status`).
  - Single reused `set_updated_at()` trigger function attached to every mutable table that has `updated_at` (not `messages`, which is immutable/has none, and not `webhook_events`, which wasn't specified to have one).
  - `text` + `check` used throughout, no enum types.
  - RLS enabled on all 8 tables; `is_clinic_staff(uuid)` is `SECURITY DEFINER`, fixed `search_path`, no dynamic SQL; public execute revoked, granted to `authenticated`/`service_role` only.
  - `anon` explicitly revoked on every application table.
  - `authenticated`: read-only on `clinics`/`clinic_staff`/`whatsapp_accounts`; full same-tenant CRUD (via `USING`+`WITH CHECK`) on `owners`/`pets`/`conversations`/`messages`; no policy at all on `webhook_events` (service-role only).
  - Only relationship/phone/status/recency indexes added (see Indexes section of the migration) — no speculative indexes.
- Commands run and exact results:
  - `pnpm install --frozen-lockfile` → `Already up to date. Done in 587ms using pnpm v11.9.0`.
  - `pnpm typecheck` (`tsc --noEmit`) → passed, no output/errors.
  - `pnpm test` (`vitest run`) → 30/30 tests passed (unchanged; this task touched no TS/test files).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` → succeeded: "Total Upload: 4.99 KiB / gzip: 1.89 KiB", `--dry-run: exiting now.`
  - `git diff --check` → exit 0 (only a benign CRLF-normalization notice on `CURRENT_TASK.md`, not a whitespace-error finding).
- Database checks actually run: **NOT RUN.** Docker is not installed and no disposable/linked Supabase project is configured in this environment (consistent with `PROJECT_CONTEXT.md`). Every `supabase db *` subcommand (`diff`, `lint`, `push`, `pull`, `reset`, `start`, `query`, `advisors`) requires a live Postgres connection — none is connection-free — so no CLI syntax check was possible either. Verification of the SQL was manual/static review only (checked for: valid multi-table `GRANT`/`REVOKE` syntax, partial-index syntax, FK column-list correctness against the composite `UNIQUE` constraints they target, no unused constraints — one dead `unique (id, clinic_id)` on `pets` was found in self-review and removed since no FK referenced it, keeping only the `(id, owner_id, clinic_id)` unique that `conversations` actually uses).
- Checks not run and why: migration apply / RLS policy testing against a real or local Postgres — no Docker, no linked project, per above. This must happen in a disposable Supabase project before the migration is trusted.
- Known limitations:
  - `messages.content` and `pets.species` are minimal fields not explicitly requested by the task contract but included because a messages/pets table without them would not be usable; no other speculative columns were added.
  - `webhook_events.last_error` sanitization is enforced only as a length cap (≤500 chars) in SQL — actual redaction of tokens/payload content is an application-layer responsibility, not something SQL can guarantee.
  - No seed/fixture data, since none was requested and the migration is unapplied.
- Risks for Codex/Opus review:
  - Please double-check the 3-column FK `conversations(pet_id, owner_id, clinic_id) → pets(id, owner_id, clinic_id)` — this is the key mechanism enforcing "pet belongs to the conversation's owner and clinic" purely at the DB level; worth confirming it can't be bypassed (e.g. via `NULL` semantics — `MATCH SIMPLE` FK is satisfied if any column is `NULL`, but `pet_id` is the only nullable column in that triple, `owner_id`/`clinic_id` are `NOT NULL`, so the constraint always fully applies whenever `pet_id` is non-null).
  - `is_clinic_staff()` `SECURITY DEFINER` function is the sole gate for all read/write RLS policies — worth an independent read for search-path or logic issues.
  - Cascade behavior was reviewed independently: `clinic_id` FKs cascade (tenant deletion removes tenant data), while `conversations → pets` uses `NO ACTION` so direct pet deletion remains blocked without prematurely rejecting a larger statement whose related cascades settle first.

## Codex review — 2026-08-06

- Scope verified: only this task record, the migration, and schema documentation changed.
- Corrected the security boundary: privileged functions now live in the non-exposed `vetai_private` schema, use an empty `search_path`, and have explicit schema/function privileges.
- Removed an explicit transaction wrapper after Opus review and source verification: Supabase CLI executes the migration statements and migration-history insert as one implicitly transactional batch.
- Replaced the pet-history FK's immediate `RESTRICT` action with `NO ACTION`; direct pet deletion remains blocked while related cascades in one statement can settle before the constraint check.
- Static structure verified: eight required tables, composite tenant FKs, RLS on every table, no authenticated policy for `webhook_events`, no raw-payload or secret-storage column.
- Database migration/RLS execution remains `NOT RUN`: Docker and a disposable linked Supabase project are unavailable.
- Claude Opus review completed with changes required. Blocking findings were resolved: the transaction wrapper was removed, the migration now uses a 14-digit timestamp filename, and authenticated users no longer receive an unnecessary grant on the trigger function.
- `FORCE ROW LEVEL SECURITY` was not added: application access must not use owner/postgres credentials, and Supabase service roles intentionally bypass RLS. Default privileges were not changed because that is grantor- and project-wide policy beyond this migration's eight-table scope; every application-table migration must continue to revoke/grant explicitly.
- Real migration and RLS execution remains `NOT RUN` until a disposable local/test database is available; this limitation must remain visible before any real deployment.
- Final verification after Opus fixes: frozen install passed; typecheck passed; 30/30 tests passed; Wrangler dry-run passed; `git diff --check` passed; static SQL check found 8 tables, 8 RLS-enabled tables, 7 policies, zero explicit transaction statements, zero public-schema `SECURITY DEFINER` functions, and a valid 14-digit migration filename.
