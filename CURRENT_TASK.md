# Current task — 003 core tenant schema and RLS

Status: `READY`

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
- `supabase/migrations/20260805_core_tenant_schema.sql`.
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

- Starting HEAD:
- Initial worktree state:
- Relevant existing files/patterns:
- Environment/tool availability verified:
- Planned files:
- Key schema/RLS risks identified:
- Conflicts or blockers:

## Delivery record — Sonnet fills after coding

- Changed files:
- Acceptance criteria satisfied:
- Commands run and exact results:
- Database checks actually run:
- Checks not run and why:
- Known limitations:
- Risks for Codex/Opus review:
