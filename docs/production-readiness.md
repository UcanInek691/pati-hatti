# Production readiness runbook

Last verified: 2026-08-10.

This is an executable checklist, not a claim of approval. Nothing in this
document marks any gate below as complete, and completing every code-level
task in this repository (through Task 024) is not production approval by
itself. It closes the last **code-level** MVP blocker (a dead-letter handoff
consumer and a configuration-only `/ready` endpoint); the gates below are
human decisions and operational setup that this codebase cannot make for
itself.

## 1. Human gates

- [ ] A named person or role owns clinic operations for this deployment
      (day-to-day monitoring, staff-item follow-up, incident response). Write
      their name/role and contact path here before go-live.
- [ ] A veterinarian at the operating clinic has read and approved every
      Turkish safety-check and appointment-flow message string the Worker can
      send using the Turkish
      [`veteriner-hekim-onay-paketi.md`](veteriner-hekim-onay-paketi.md).
      Approval must be recorded (who, date, which copy revision) before any
      real send.
- [ ] Turkish legal/KVKK (Kişisel Verilerin Korunması Kanunu) review and
      approval using the Turkish
      [`kvkk-inceleme-paketi.md`](kvkk-inceleme-paketi.md), covering at minimum:
  - the data-subject notice text and how/when it is shown,
  - the lawful basis relied on for processing pet-owner and pet-health data,
  - which roles (clinic staff, clinic owner, platform operator) may access
    what data,
  - retention periods for messages, intake data, and staff work items —
    **this document does not set or suggest a retention period; that is a
    legal decision**,
  - the deletion/export process for a data subject's request,
  - processor agreements with Cloudflare, Meta, OpenAI, and Supabase's
    hosting provider.
  - This step cannot be satisfied by an engineer's judgment call; it requires
    sign-off from whoever is accountable for KVKK compliance for the clinic.

No later section may be executed against real clinic/owner/pet data until
every box in this section is checked.

## 2. Managed data rollout

- [ ] A named person owns database backup and rollback for this rollout.
- [ ] Every migration under `supabase/migrations/`, in chronological
      filename order, is applied to the real production Supabase project
      through the managed Supabase CLI migration-history workflow (`supabase
      db push` or equivalent) — **not** by pasting SQL into the SQL Editor.
      Every migration through this task has so far only been validated on
      the disposable `vetai-test` project; see each migration's own
      `docs/*.md` note.
- [ ] After applying, verify the production catalog matches source: table
      list, RLS enabled per table, policy list, and function/table grants
      match what the migrations declare (spot-check with the same
      `pg_catalog`/`information_schema` queries the rollback test fixtures
      already use, run read-only).
- [ ] Rollback fixtures under `supabase/tests/*.sql` are **never** run
      against production. They exist only for disposable `vetai-test`
      validation; every one of them ends in `rollback;` by design and several
      assert on data that must not exist in production.

## 3. Cloudflare / Meta / OpenAI setup

- [ ] Create all three real Cloudflare Queue resources: `vetai-intake`,
      `vetai-intake-dlq`, and `vetai-intake-terminal-dlq`. Configure consumers
      only for the first two; the terminal queue is intentionally unconsumed
      (see §5 and §6).
- [ ] Deploy the Worker with both `[[queues.consumers]]` blocks in
      `wrangler.toml` (primary `vetai-intake` and the new `vetai-intake-dlq`
      consumer added in this task), and the `INTAKE_QUEUE` producer binding.
- [ ] Set every real secret (`WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`,
      `WHATSAPP_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`,
      `SUPABASE_ANON_KEY`, `OPENAI_API_KEY`) via `wrangler secret put`
      (encrypted secret bindings), never as a `[vars]` entry. **Never paste a
      real secret value into this document, a commit, an issue, or shell
      history** — use the interactive prompt or a piped value from a local,
      untracked file.
- [ ] Configure the Cron trigger (see `[triggers]` in `wrangler.toml`) and the
      Meta webhook subscription URL/verify token to point at the deployed
      Worker.
- [ ] Allow-list only the exact Meta Graph API version
      (`WHATSAPP_GRAPH_API_VERSION`, currently validated against `v<major>.0`
      by `/ready`) and OpenAI model the code actually calls
      (`src/openaiIntake.ts`); do not widen either without a corresponding
      code review.

## 4. Seed / admin prerequisites

- [ ] Create the real clinic row, its WhatsApp account mapping
      (`phone_number_id`), and clinic staff membership rows through an
      authorized administrative process against production. **No general
      admin provisioning UI exists in this codebase** — this is a manual,
      privileged, service-role operation performed by whoever owns the
      production database, not a self-serve flow.
- [ ] Seed at least one future appointment slot through the same authorized
      process before the smoke journey in §5 needs an `EVET`/`HAYIR`
      appointment decision.

## 5. Controlled smoke journey

Perform steps 1–8 against production with synthetic, non-patient data only
(a test phone number and a fabricated pet/complaint) — never a real owner's
data. Steps 9–10 are failure injection and must run only in an isolated
pre-production/canary Worker, Queue chain, and disposable database configured
like production. Never break a shared production secret or endpoint to force
a retry. Stop and fix before continuing if any step's actual result differs
from its expected result.

1. `GET /health` returns `200 { "status": "ok" }`.
2. `GET /ready` returns `200 { "status": "ready" }`. If it returns `503`,
   stop — configuration is incomplete; do not proceed.
3. The Meta webhook challenge (`GET /webhooks/whatsapp`) succeeds with the
   real verify token.
4. Send one signed synthetic inbound WhatsApp text message; confirm it is
   persisted (`docs/database-schema.md`) and a job reaches `vetai-intake`.
5. Confirm the Queue message is claimed, sent to OpenAI, and the
   conversation state advances (`docs/inbound-queue.md`).
6. Trigger a safety/human-handoff path with synthetic wording and confirm
   the conversation reaches `human_handoff` and a `staff_work_items` row
   appears for the clinic (`/staff`), with the correct priority.
7. Confirm an outbox row is sent and its delivery status callback is
   recorded (`docs/outbound-delivery.md`).
8. Walk one synthetic appointment through offer -> `EVET` confirm and,
   separately, offer -> `HAYIR` decline
   ([`docs/whatsapp-appointment-flow.md`](whatsapp-appointment-flow.md)).
9. In the isolated canary only, **deliberately exhaust the primary consumer's
   retries** for one synthetic message using a canary-only invalid Supabase
   binding or another reproducible failure that cannot affect production
   traffic. Confirm Cloudflare routes it to `vetai-intake-dlq`, the
   dead-letter consumer picks it up, and the conversation reaches
   `human_handoff` (or the appropriate closed result) via
   `finalize_intake_dead_letter`.
10. Confirm that recovery step happens **before** the four-day retention
    window on an unconsumed queue elapses — see §6's DLQ monitoring
    requirement. Cloudflare documents that a queue without an active
    consumer, or a dead-letter queue configured on the DLQ itself
    (`vetai-intake-terminal-dlq` here), retains messages for four days; see
    [Cloudflare's dead-letter queues documentation](https://developers.cloudflare.com/queues/configuration/dead-letter-queues/).
    `vetai-intake-terminal-dlq` is temporary recovery storage for that
    four-day window, not an audit archive — nothing in this codebase reads
    from it.

## 6. Operations

- [ ] Alert on Worker exceptions/error-rate (Cloudflare dashboards or Logpush
      to an external sink).
- [ ] Alert on backlog depth for all three queues: `vetai-intake`,
      `vetai-intake-dlq`, and `vetai-intake-terminal-dlq`. A non-zero
      `vetai-intake-terminal-dlq` backlog is the last-resort signal that a
      message is about to age out of its four-day retention window and needs
      manual recovery.
- [ ] Alert on failed outbox sends (`docs/outbound-delivery.md`).
- [ ] Alert on, or at minimum regularly review, open/urgent
      `staff_work_items` rows per clinic — **a staff work item being created
      is not the same as anyone being notified**; someone must actually watch
      `/staff` or a query against `staff_work_items` for this to have any
      effect. A normal-priority item created from the
      `{ "dead_letter_handoff": true }` marker represents **unassessed** risk,
      not low risk, and must also be reviewed promptly.
- [ ] Alert on webhook signature-verification failures and repeated Meta
      webhook delivery failures.
- [ ] Alert on repeated OpenAI extraction failures.
- [ ] Document who owns responding to each alert above and their expected
      response time before go-live.

## 7. Go / no-go and rollback

**No-go** if any of the following is true at deploy time:

- Any §1 human gate is unchecked.
- A secret value has leaked into a commit, log, or this document.
- A tenant-isolation (RLS or tenant-scoped join) failure is found in
  production verification.
- DLQ/terminal-queue backlog monitoring (§6) is not wired up.
- Clinic/veterinarian copy or KVKK privacy approval is missing or stale
  relative to the deployed copy.
- The webhook-triggered Worker path cannot be disabled quickly and safely
  (e.g., by pausing the Cloudflare route or webhook subscription) if
  something goes wrong during the smoke journey.

**Rollback order** (no destructive command is included here; each step is an
operational action, not a code snippet):

1. Disable the Meta webhook subscription or pause the Worker's route so no
   new inbound messages are accepted.
2. Let in-flight Queue batches drain or fail closed to their DLQ/terminal
   queue naturally — do not purge a queue.
3. If a migration must be reverted, write and review a forward-only
   corrective migration rather than editing history; coordinate with the
   backup/rollback owner from §2 before touching production data.
4. Re-run the §5 smoke journey after any fix, before re-enabling the
   webhook.

Passing Task 024's own review gate (Codex validation on disposable
`vetai-test`, then one narrow Opus review of the new database finalizer,
tenant isolation, staff visibility, and fail-closed Queue behavior) completes
the code-level MVP. It does **not** check any box in this document.
