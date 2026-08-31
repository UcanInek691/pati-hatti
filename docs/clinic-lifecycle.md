# Clinic provisioning and offboarding (Task 041)

Last verified: 2026-08-31.

## What this step does

Provides the smallest repeatable database lifecycle for adding, suspending,
resuming and permanently offboarding a clinic without free-form production
SQL, a platform-admin UI, billing logic or credential values in PostgreSQL.
It is the backend foundation for a future metadata-only `/admin` surface — it
does not build that surface, and `src/clinicLifecycle.ts` is not wired to any
public route in this task.

## Lifecycle state

`supabase/migrations/20260831000100_clinic_lifecycle.sql` adds
`clinics.operational_status` (`suspended | active | offboarding`, closed) plus
`suspended_at`, `offboarding_started_at`, and `offboarding_token`. Existing
clinics backfill to `active`; newly provisioned clinics start `suspended`.
Database `CHECK` constraints require `suspended_at` exactly for the
`suspended` state and require `offboarding_started_at`/`offboarding_token`
exactly for the `offboarding` state. The default suspended state supplies its
timestamp automatically; activation clears it.

Status is operational metadata only — it does not weaken tenant RLS,
authenticated staff reads, composite FKs, or the existing erasure cascades.

## Five service-role-only RPCs

All five are `SECURITY INVOKER`, `set search_path = ''`, no dynamic SQL, and
revoke `PUBLIC`/`anon`/`authenticated` — only `service_role` may execute
them. `src/clinicLifecycle.ts` calls each over native `fetch` against
`/rest/v1/rpc/<name>` with a 10-second timeout and exact response-shape
validation (column count, closed result enum, no extra fields).

- **`provision_clinic_v1(clinic_id, clinic_name, contact_phone_e164,
  public_address, owner_user_id, staff_role, whatsapp_account_id,
  phone_number_id, display_name)`** — atomically inserts the clinic (starts
  `suspended`), the primary `clinic_staff` membership, and the WhatsApp
  account (`automation_default = 'personal'`, the Task 034 hard-locked
  default). Creates no AI route, hours, slots, owner/pet/message data, or
  credential value. Exact replay returns `already_provisioned`; any
  partial/different reuse of the same `clinic_id` raises and rolls back
  rather than merging tenants. A missing `owner_user_id` (no matching Auth
  user) raises a foreign-key violation and rolls back the whole attempt.
  Closed result: `provisioned | already_provisioned`.
- **`suspend_clinic_v1(clinic_id)`** — locks the clinic, moves `active` to
  `suspended`, and atomically deletes only that clinic's own
  `pending | processing` outbox rows; accepted/failed rows, routes, staff,
  hours and slots are untouched, and every other clinic's outbox is
  untouched. Refuses an `offboarding` clinic by raising (offboarding only
  ever moves forward to finalize). Closed result:
  `suspended | already_suspended | not_found`.
- **`resume_clinic_v1(clinic_id)`** — moves only `suspended` to `active`;
  creates no route and sends nothing. Closed result:
  `resumed | already_active | refused_offboarding | not_found`.
- **`prepare_clinic_offboarding_v1(clinic_id)`** /
  **`finalize_clinic_offboarding_v1(clinic_id, offboarding_token)`** — one
  two-step destructive workflow. `prepare` locks the clinic, moves it to
  `offboarding`, clears its own pending/processing outbox work exactly like
  suspend, and mints a fresh UUID token (idempotent replay returns the same
  token via `already_offboarding`, never re-mints). `finalize` accepts only
  the current token: on success it writes a one-way SHA-256 hash of the
  token (never the raw token) plus clinic UUID, the fixed `offboarded` action,
  and timestamp to
  `public.clinic_offboarding_receipts` — a table with no foreign key to
  `clinics`, so the row survives the clinic's own cascade-delete in the same
  transaction — then deletes the clinic, which cascades through every
  existing tenant-scoped table (staff, WhatsApp account, owners,
  conversations, messages, outbox, etc.). An exact replay after deletion
  hashes the supplied token and, if it matches the surviving receipt,
  returns `already_offboarded` instead of `not_found`; any other
  wrong/stale token fails closed (raises while still offboarding, or returns
  `not_found` once the clinic is gone). No RPC can inspect, store, or mutate
  a Meta/WhatsApp credential — that stays entirely in the encrypted
  Cloudflare registry from Task 040.
  Closed results: prepare — `prepared | already_offboarding | not_found`;
  finalize — `finalized | already_offboarded | not_found`.

## Runtime suspension boundary

- `vetai_private.effective_contact_automation_mode` (the single shared
  resolver used by `ingest_whatsapp_text_message`,
  `resolve_whatsapp_contact_automation`, `claim_intake_queue_job`, and all
  three finalizers) returns `personal` for any non-`active` clinic before it
  even looks at a contact route or `automation_default`. Its clinic
  `FOR KEY SHARE` lock is held until the caller transaction ends, so
  suspend/offboarding's `FOR UPDATE` cannot overtake an already-authorized
  write and an automation call cannot use a stale active decision after the
  lifecycle transition commits. A suspended or offboarding clinic's inbound
  is therefore ignored with zero webhook/owner/conversation/message residue;
  existing unlisted/personal privacy behavior is otherwise unchanged.
- `claim_outbound_message_v2()` claims rows only for `active` clinics; the
  suspend/prepare cleanup above handles the rest. A claim concurrent with the
  suspension commit can still win before cleanup deletes its outbox row, and
  a request already handed to Meta cannot be recalled. This leaves a bounded
  claim-to-send window in which delivery may occur without a surviving outbox
  row; suspension is not represented as an instantaneous provider-side stop.
- Delivery-status callbacks (`record_whatsapp_outbound_status`) for
  already-`accepted` rows remain recordable while a clinic is
  suspended/offboarding — status tracking matches on the outbox row and
  provider fields, independent of clinic status.
- Staff RLS visibility remains available during suspension so operators can
  inspect and resolve work; no staff mutation privilege is broadened.

## Pilot activation order

1. `provision_clinic_v1` (clinic starts `suspended`).
2. Add the account entry to the encrypted Cloudflare registry (Task 040).
3. Verify `/ready`.
4. Configure hours, slots, and explicit AI routes through the existing
   reviewed operations (not part of this task's RPCs).
5. `resume_clinic_v1`.
6. Synthetic inbound/outbound/status smoke test.

## Offboarding order (reverse)

1. `suspend_clinic_v1` or `prepare_clinic_offboarding_v1`.
2. Remove the account entry from the encrypted Cloudflare registry.
3. Verify `/ready`.
4. Confirm no outstanding outbox work for the clinic.
5. `finalize_clinic_offboarding_v1` with the current token.
6. Revoke Meta/system-user access externally (outside this codebase).
7. Review the clinic staff identities in Supabase Auth and separately delete
   users who no longer serve any clinic. Finalize removes `clinic_staff` links
   but intentionally cannot delete shared `auth.users`, identities, or sessions.

The outstanding-work check is also a concurrency barrier: finalization can
deadlock with an already-running intake finalizer because the two paths lock
clinic and owner rows in opposite order. PostgreSQL aborts one participant;
the intake lease may retry, so operators must drain work before finalization.

## Explicit prerequisite

Supabase Auth user creation/invitation is not part of this lifecycle.
`provision_clinic_v1` links an existing Auth user UUID; passwords, OTPs,
email invitations, and browser sessions are handled elsewhere. Auth-user
erasure is likewise separate: successful clinic finalization does not delete
`auth.users`, `auth.identities`, or `auth.sessions`.

The persistent `suspended_at default now()` deliberately makes a direct
`active` insert fail unless it also supplies `suspended_at = null`; supported
provisioning uses the RPC, which writes both coherently. An exact provision
replay is idempotent only while the clinic remains in its original suspended
state; replay after resume is rejected as a conflicting reuse.

## Verification

`supabase/tests/041_clinic_lifecycle.sql` is a rollback-only fixture proving
every closed result above, provisioning idempotency/conflict/missing-user
rejection, the suspension boundary (including a dedicated non-active-clinic
skip proof for `claim_outbound_message_v2()`), resume's `offboarding` refusal,
the full offboard two-step workflow (current token, stale token, exact
replay, cascade, receipt hash), RLS/grants denial for `authenticated`/`anon`,
and zero fixture residue. `test/clinicLifecycle.test.ts` covers the TypeScript
client: request shape, all closed results, malformed/additive Data API
shapes, non-2xx/network failures, the loopback-only plain-HTTP rule, the exact
10-second `AbortSignal.timeout` argument, and no logging of the request, response, or offboarding
token.
