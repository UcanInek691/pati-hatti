# Current task — 020 durable staff work items

Status: `READY`

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

Pending.

## Delivery record — Sonnet fills after coding

Pending.
