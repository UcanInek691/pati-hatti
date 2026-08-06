# Current task — 004 disposable database validation

Status: `COMPLETE`

Primary implementer and reviewer: Codex

## Goal

Apply the reviewed core tenant migration to the disposable Supabase project
`vetai-test` (`cyjpiapxvalqltcsywam`) and verify tenant isolation with real
PostgreSQL/RLS execution before any real-data deployment.

## Authorized external changes

- Apply `supabase/migrations/20260806000000_core_tenant_schema.sql` only to
  `vetai-test`.
- Run temporary database fixtures and assertions inside a transaction that is
  rolled back.
- Use the existing authenticated Supabase dashboard session when CLI access
  cannot be established without exposing credentials.

Do not touch another Supabase project, deploy the Worker, create real users,
store real clinic/patient data, expose credentials, or change billing.

## Required checks

- Migration executes without SQL errors.
- Exactly the eight expected application tables exist and have RLS enabled.
- `anon` has no application-table access.
- Authenticated staff can read their own clinic but not another clinic.
- Same-tenant CRUD succeeds on `owners`; cross-tenant insert/update fails.
- `webhook_events` is inaccessible to `authenticated`.
- Composite tenant foreign keys reject cross-clinic owner/pet/conversation
  relationships.
- Temporary fixtures leave no rows after rollback.

## Allowed repository changes

- This task record.
- `PROJECT_CONTEXT.md` and `docs/database-schema.md` after successful review.
- A minimal reusable SQL validation file only if the dashboard cannot execute
  the checks reliably without it.

## Delivery record

- Starting commit: `4f63be0`.
- Disposable project created in Frankfurt with automatic table exposure off
  and automatic RLS on.
- Migration execution: passed in the `vetai-test` SQL editor with `Success. No rows returned`.
- Validation: `supabase/tests/004_core_tenant_rls.sql` returned `PASS`, with
  `remaining_test_clinics = 0` and `remaining_test_users = 0` after rollback.
- Verified on PostgreSQL 17: exactly eight public application tables, RLS on
  all eight, no `anon` grants, same-clinic authenticated reads and owner CRUD,
  denial of cross-clinic reads/inserts/updates, denial of authenticated
  `webhook_events` access, and rejection of cross-clinic composite-FK links.
- The first dashboard attempt appended the validation SQL to the migration and
  stopped immediately on `schema "vetai_private" already exists`; no test data
  was created. Replacing the editor content and rerunning produced the passing
  result above.
- The repository is intentionally not CLI-linked and no database credential
  was written to disk or command output. Dashboard execution does not create a
  `supabase_migrations.schema_migrations` entry; production deployment must use
  the Supabase CLI migration workflow.
