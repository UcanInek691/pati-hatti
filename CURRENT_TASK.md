# Current task — 020 durable staff work items

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewers: Codex, then one read-only Claude Opus architecture/RLS/safety
review. Opus is mandatory for this task because it introduces a
`SECURITY DEFINER` trigger boundary and makes human-handoff work visible to
authenticated clinic staff. Do not repeat the Opus review unless Codex makes
a material design change after it.

## Goal

Create a minimal, durable, tenant-safe staff work queue for:

- intake conversations that require human attention; and
- outbound WhatsApp replies that reached a terminal delivery failure.

Use PostgreSQL tables, constraints, RLS, and row triggers so every current or
future write path receives the same behavior without adding Worker wiring or
a dependency.

The resulting path is:

```text
conversation enters human_handoff ─┐
                                   ├─> durable staff_work_items row
outbound delivery becomes failed ──┘
```

This task does not notify staff, send email/push/WhatsApp alerts, add an admin
panel, assign work, let staff resolve work, expose phone numbers or message
content, alter intake replies, implement appointments, deploy, or create
external resources. Documentation must say plainly that durable visibility is
not the same as notification.

## Starting context

- Starting HEAD: `eefc970` on `main`; worktree was clean.
- Task 019 is committed and validated on disposable `vetai-test`.
- `conversations` is tenant-scoped and already readable by authenticated
  clinic staff under RLS. Its `intake_stage = 'human_handoff'` and
  `status = 'handoff'` identify conversations that require human handling.
- `intake_data.reported_safety_signals` is the validated persisted safety
  snapshot. Any literal JSON boolean `true` means the work is urgent; absence
  of a true value must not be described as clinically safe.
- `outbound_message_outbox.delivery_status = 'failed'` means bounded send
  attempts were exhausted. Its `provider_delivery_status = 'failed'` means a
  previously accepted provider message currently has failure evidence; a
  later `delivered` or `read` callback may supersede that evidence.
- The protected outbox contains recipient and reply PII and has no client RLS
  policy. This task must not expose or copy those values.
- Human-handoff reply text currently tells the user to contact a clinic; the
  product does not claim that staff were notified. This task preserves that
  truthful behavior.

Before editing, follow `AGENTS.md`, read `PROJECT_CONTEXT.md` and this file,
then verify these facts from source, callers, tests, migrations, scripts, Git
status, and recent commits. Stop on a material conflict.

## Allowed changes

- New migration
  `supabase/migrations/20260809000400_staff_work_items.sql`.
- New rollback SQL test `supabase/tests/020_staff_work_items.sql`.
- New `docs/staff-work-items.md`.
- Narrowly relevant updates to `docs/database-schema.md`,
  `docs/intake-replies.md`, `docs/outbound-delivery.md`, and
  `docs/outbound-status.md`.
- Fill only the Observed context and Delivery record sections of this file.

Do not change TypeScript, tests, dependencies, lockfiles, Env bindings,
Wrangler configuration, existing migrations/SQL fixtures, prompts, reply
copy, intake/safety/planning behavior, webhook/Queue/Cron behavior,
`AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Database contract

### Staff work table

Create `public.staff_work_items` with exactly these data fields:

- `id uuid primary key default gen_random_uuid()`;
- `clinic_id uuid not null`;
- `conversation_id uuid not null`;
- `kind text not null` in `human_handoff | delivery_failure`;
- `priority text not null` in `urgent | normal`;
- `reason text not null` in
  `emergency_handoff | human_handoff | send_attempts_exhausted | provider_failed`;
- `source_outbox_id uuid` nullable;
- `status text not null default 'open'` in `open | resolved`;
- `created_at timestamptz not null default now()`;
- `resolved_at timestamptz` nullable.

Add named checks enforcing all state coherence:

- `open` requires `resolved_at is null`; `resolved` requires a non-null
  `resolved_at`;
- `human_handoff` requires a null `source_outbox_id` and a reason of
  `emergency_handoff | human_handoff`;
- `delivery_failure` requires a non-null `source_outbox_id` and a reason of
  `send_attempts_exhausted | provider_failed`;
- only `emergency_handoff` is `urgent`; every other reason is `normal`.

Tenant ownership must be structural:

- clinic FK to `clinics(id)` with `ON DELETE CASCADE`;
- composite `(conversation_id, clinic_id)` FK to
  `conversations(id, clinic_id)` with `ON DELETE CASCADE`;
- add the minimum unique key needed on
  `outbound_message_outbox(id, clinic_id)`, then use a composite
  `(source_outbox_id, clinic_id)` FK with `ON DELETE CASCADE`.

Add partial uniqueness so there can be at most:

- one open `human_handoff` item per clinic/conversation; and
- one open `delivery_failure` item per clinic/source-outbox row.

Add one staff-list index beginning with `(clinic_id, status, priority,
created_at, id)`. Do not add speculative assignment, note, payload, phone,
message-content, SLA, retry, or notification columns.

### RLS and privileges

- Enable RLS on `staff_work_items`.
- Revoke all table access from `PUBLIC`, `anon`, and `authenticated`.
- Grant `SELECT` to `authenticated` and all required backend access to
  `service_role`.
- Add exactly one authenticated `SELECT` policy using the existing
  `vetai_private.is_clinic_staff(clinic_id)` helper.
- Do not permit authenticated insert/update/delete in this task. Staff
  resolution is a later, explicit workflow.

### Human-handoff trigger

Create one private trigger function and trigger on relevant
`conversations` updates. The function must:

- derive clinic and conversation only from `NEW`;
- create an open `human_handoff` item whenever the resulting
  `NEW.intake_stage = 'human_handoff'`;
- inspect only JSON boolean values under
  `NEW.intake_data.reported_safety_signals`; if any value is literal `true`,
  use `urgent/emergency_handoff`, otherwise use
  `normal/human_handoff` without calling it safe;
- tolerate absent/non-object safety data without raising;
- deduplicate repeated handoff-stage messages while one item remains open;
- upgrade an existing open normal item to urgent/emergency if a later update
  contains any true safety signal;
- allow a future new open item after an earlier item has been resolved.

Use `SECURITY DEFINER` only because authenticated conversation updates must
not require direct insert rights on `staff_work_items`. Fix
`search_path = ''`, fully qualify every object, use no dynamic SQL, accept no
caller parameters, and revoke direct execution from all roles. The trigger
must not weaken the existing conversation policies.

Backfill one coherent open handoff item for each existing handoff-stage
conversation, applying the same priority/reason rule and deduplication.

### Delivery-failure trigger

Create one private trigger function and trigger on relevant
`outbound_message_outbox` updates. It must derive every identifier from
`NEW`, copy no PII, and:

- when `delivery_status` newly becomes `failed`, create one open normal
  `delivery_failure/send_attempts_exhausted` item;
- when `provider_delivery_status` newly becomes `failed`, create one open
  normal `delivery_failure/provider_failed` item;
- when a prior provider status `failed` is superseded by `delivered` or
  `read`, resolve only the matching open `provider_failed` item and set its
  `resolved_at`; never auto-resolve `send_attempts_exhausted`;
- create nothing for unrelated, accepted, sent, delivered, or read updates;
- deduplicate replays while an item remains open.

Use the same narrowly scoped `SECURITY DEFINER`, empty-search-path,
fully-qualified, no-dynamic-SQL posture. Backfill current terminal
`delivery_status = 'failed'` and current
`provider_delivery_status = 'failed'` rows using identical rules.

Trigger/backfill failures must abort the originating database transaction;
do not swallow errors or create a partial state.

## Required rollback SQL test

`supabase/tests/020_staff_work_items.sql` must run inside `BEGIN`/`ROLLBACK`
and prove at least:

- a normal handoff creates one normal item; repeated handoff updates do not
  duplicate it;
- any literal true persisted safety signal creates or upgrades the one open
  item to urgent/emergency, without hardcoding the current signal names;
- absent or malformed/non-object safety data does not raise and creates a
  normal item rather than asserting safety;
- after a simulated resolved item, a later handoff update may create one new
  open item;
- exhausted send and provider failure transitions create the exact failure
  reason once; unrelated transitions create none;
- delivered/read supersession resolves an open provider-failed item, while
  an exhausted-send item remains open;
- all named state checks and composite tenant FKs reject invalid/cross-tenant
  rows with zero partial mutation;
- owner/conversation, account/outbox, and clinic erasure cascades leave no
  dangling staff items;
- RLS is enabled; clinic staff A can select only clinic A rows; unrelated
  staff, `anon`, and unauthenticated callers cannot see rows;
- `authenticated` cannot insert, update, or delete rows directly;
- trigger functions cannot be executed directly and only the intended table
  privileges/policy exist;
- rollback leaves zero fixture residue.

The single-session fixture cannot prove true concurrent trigger races.
Document that limitation and rely on the partial unique indexes plus
`ON CONFLICT` behavior for race safety.

The post-migration rollback fixture also cannot prove apply-time backfill by
itself. During Codex's disposable database gate, seed one eligible row for
each of the three backfill cases before applying the migration, then verify
that applying it creates exactly one coherent item per source and leaves no
residue after the test database is cleaned.

## Documentation

Create `docs/staff-work-items.md` describing:

- the two work kinds, closed reasons, and urgent rule;
- database-trigger creation, replay deduplication, emergency escalation, and
  provider-failure auto-resolution;
- tenant/RLS boundaries and the no-PII-copy rule;
- erasure cascades;
- staff read-only status in this task;
- no alert/notification, assignment, acknowledgement/resolution API, UI,
  appointment flow, retention job, deployment, or real operations test;
- migration and SQL fixture as `NOT APPLIED` until Codex validates them.

Update existing documentation only where necessary to link this durable work
queue and remove any claim that handoff/failure visibility is wholly absent.
Do not claim that a person was notified or will respond.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Sonnet must not apply the migration or SQL fixture. Mark both database checks
`NOT RUN`; Codex alone reviews and runs them on disposable `vetai-test`.

Do not commit, push, deploy, call real Meta/OpenAI/Supabase endpoints, create
a resource, install a plugin, or mutate an external service.

## Review gate

After Sonnet delivers, Codex reviews the full migration, trigger paths,
backfill, tenant FKs, RLS/grants, emergency escalation, provider-failure
resolution, erasure behavior, tests, and docs. Codex applies the migration and
rollback fixture only to disposable `vetai-test`, makes minimum fixes, reruns
all required checks, and records the result.

Then Claude Opus performs one read-only review focused on the
`SECURITY DEFINER` boundary, authenticated staff visibility, tenant/RLS
isolation, emergency work escalation, failure auto-resolution, PII/KVKK, and
erasure behavior. A PASS closes the task; otherwise Codex makes only the
verified blocking fixes and requests a narrow re-check if the design changed.

## Observed context — Sonnet fills before coding

Verified before coding, HEAD `eefc970` on `main`, worktree clean, no
material conflict found:

- `conversations` (`20260806000000_core_tenant_schema.sql`) has
  `unique (id, clinic_id)`; `intake_stage` includes `human_handoff`
  (`20260806000200_conversation_intake_state.sql`); `intake_data jsonb not
  null default '{}'` checked to be a JSON object; `advance_conversation_intake`
  bypasses its terminal-stage guard when `p_next_stage = v_current_stage`, so
  a conversation already at `human_handoff` can receive further UPDATEs while
  staying at that stage — the trigger must handle repeated updates, not only
  the first transition.
- `outbound_message_outbox` (`20260809000100_intake_reply_outbox.sql`,
  `..._outbound_delivery.sql`, `..._outbound_status_tracking.sql`) had no
  `unique (id, clinic_id)` yet, so the task's own instruction to add the
  minimum such key is required, not optional. Its named CHECK
  `outbound_message_outbox_provider_status_check` requires
  `provider_delivery_status` non-null only when `delivery_status =
  'accepted'`, which structurally proves `delivery_status = 'failed'` and
  `provider_delivery_status = 'failed'` can never both hold on the same row,
  simplifying the delivery-failure partial-unique-index key to
  `(clinic_id, source_outbox_id)` without needing `reason`.
- `vetai_private.is_clinic_staff(target_clinic_id uuid)` exists
  (`20260806000000_core_tenant_schema.sql`) as the standard `SECURITY
  DEFINER`, `STABLE`, `search_path = ''` membership check already used by
  every authenticated `SELECT` policy in this project; reused as-is.
- `intake_data.reported_safety_signals` (`src/safetyDecision.ts`,
  `src/intakeTurn.ts`) is a JSON object of named boolean/null signal values
  on the persisted snapshot, confirming the contract's requirement to scan
  generically for any true value rather than naming specific signals.
- `conversations_one_open_per_owner_idx`
  (`20260806000100_ingest_whatsapp_text_message.sql`) is a pre-existing
  partial unique index on `conversations (clinic_id, owner_id) WHERE status
  IN ('active', 'handoff')`, unrelated to this task's schema but relevant to
  the rollback test's fixture design (each independent test conversation
  needed its own owner).
- No existing doc claimed handoff/failure visibility was permanently
  impossible; `docs/outbound-delivery.md` and `docs/outbound-status.md` each
  had one sentence saying a failed/failed-provider row was "only visible via
  direct database inspection," which this task's docs updates narrow rather
  than contradict.

## Delivery record — Sonnet fills after coding

Files added (no other files touched):

- `supabase/migrations/20260809000400_staff_work_items.sql` — table,
  constraints, partial unique indexes, list index, RLS/grants/policy,
  `vetai_private.has_true_safety_signal`, the human-handoff trigger
  (`vetai_private.sync_human_handoff_work_item`), the delivery-failure
  trigger (`vetai_private.sync_delivery_failure_work_item`), and the three
  backfill statements.
- `supabase/tests/020_staff_work_items.sql` — rollback-only fixture
  (`BEGIN`/`ROLLBACK`) covering all twelve required proofs from this file's
  "Required rollback SQL test" section, plus the documented single-session
  concurrency-race limitation.
- `docs/staff-work-items.md` — new task doc.
- Narrow edits: `docs/database-schema.md` (new "Staff work items" section
  linking the migration/test, marked not yet applied),
  `docs/outbound-delivery.md` ("Failed rows have no operational owner yet"
  now links the durable `send_attempts_exhausted` work item instead of
  saying failed rows are invisible outside direct DB inspection),
  `docs/outbound-status.md` ("Not built here" now links the durable
  `provider_failed` work item and its delivered/read auto-resolution),
  `docs/intake-replies.md` (one paragraph after the poison-handoff section
  noting the durable handoff record; reply copy itself is unchanged).

`git status --porcelain` before any check matched exactly this file list —
no unrelated changes.

Verification:

- `pnpm install --frozen-lockfile` — OK, already up to date.
- `pnpm typecheck` — OK, zero errors (no TypeScript changed by this task).
- `pnpm test` — OK, full suite passed (no TypeScript changed by this task).
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — OK,
  built and validated bindings, exited on `--dry-run` as expected.
- `git diff --check` — OK, zero whitespace/conflict-marker errors (checked
  against both the modified tracked docs and, via a temporary
  `git add -N` / `git reset` that changed no content, the three new files).
- Migration apply and rollback-fixture run: **NOT RUN**. Per this task's
  explicit instruction, Sonnet did not apply
  `supabase/migrations/20260809000400_staff_work_items.sql` or run
  `supabase/tests/020_staff_work_items.sql` against any database, disposable
  or otherwise. Codex applies and runs both against disposable `vetai-test`.

No commit, push, deploy, or call to a real Meta/OpenAI/Supabase endpoint was
made. No resource was created and no plugin installed.

Next: Codex review (full migration, trigger paths, backfill, tenant FKs,
RLS/grants, emergency escalation, provider-failure resolution, erasure
behavior, tests, docs), then apply + rollback fixture on disposable
`vetai-test`; then the mandatory read-only Claude Opus review of the
`SECURITY DEFINER` boundary, staff visibility, tenant/RLS isolation,
emergency escalation, failure auto-resolution, PII/KVKK, and erasure
behavior.

## Codex review record — 2026-08-09

Decision: `PASS`, pending the mandatory single Claude Opus read-only review.

Targeted fixes made during review:

- Renamed the table-level priority/reason coherence constraint to
  `staff_work_items_reason_priority_check`. PostgreSQL generated the same
  `staff_work_items_priority_check` name for the inline closed-value check,
  so the original migration stopped at `CREATE TABLE` with a duplicate
  constraint-name error.
- Added the required `next_attempt_at = null` to the fixture's unrelated
  accepted-row transition; the original test data violated Task 018's
  accepted-state CHECK before reaching the behavior under test.
- Isolated the account-to-outbox cascade by nulling the fixture webhook
  event's account link before standalone account deletion. The pre-existing
  webhook-event FK intentionally remains `NO ACTION` and can block account
  deletion while event history carries the link; documentation now states
  that boundary instead of implying every standalone account deletion must
  succeed.

Local verification after fixes:

- `pnpm install --frozen-lockfile` — pass, already up to date.
- `pnpm typecheck` — pass, no errors.
- `pnpm test` — pass, 630/630 across 21 files.
- `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` — pass;
  67.02 KiB / gzip 15.07 KiB, bindings unchanged, no deployment.
- `git diff --check` — pass; only existing LF/CRLF notices.

Disposable database validation (`vetai-test` only):

- Seeded one pre-migration urgent handoff, one exhausted-send row, and one
  provider-failed row. Applying the migration succeeded and backfilled
  exactly the three expected coherent open work items.
- Ran `supabase/tests/020_staff_work_items.sql`: `PASS`; remaining test
  clinics, auth users, work items, and outbox rows were all zero.
- Read-only catalog verification returned: ten staff-work columns, RLS
  enabled, one policy, two triggers, two `SECURITY DEFINER` trigger
  functions, authenticated SELECT true, authenticated INSERT false, anon
  SELECT false, authenticated direct trigger execution false, and zero
  remaining staff-work rows.

Not run: production migration workflow, real clinic/staff operation, alert or
UI behavior, deployment, resource creation, push, or true two-session trigger
race.

## Claude Opus review record — 2026-08-09

Decision: `PASS`. No blocking finding and no narrow re-review required.

Opus independently confirmed the two `SECURITY DEFINER` boundaries, empty
search paths, revoked execution, single tenant-scoped read policy, composite
tenant FKs, generic literal-true emergency escalation, atomic dedup/upgrade,
provider-failure-only auto-resolution, PII-free table shape, erasure chains,
and truthful no-notification wording.

Non-blocking follow-ups carried forward:

- staff list queries must use `priority DESC` so textual `urgent` sorts before
  `normal`;
- one open delivery-failure item per outbox currently relies on the existing
  CHECK that makes exhausted-send and provider-failed states mutually
  exclusive;
- the future staff workflow should add a regression proving urgent work is
  never downgraded by a later normal handoff update;
- work-item durability is intentionally bounded by its source conversation or
  outbox lifetime because KVKK erasure cascades take precedence.
