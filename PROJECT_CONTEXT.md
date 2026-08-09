# VetAI project context

Last verified: 2026-08-09 by Codex.

## Product

VetAI is a WhatsApp-based digital reception and appointment system for veterinary clinics. It identifies owners and pets, gathers complaints naturally, remembers verified history, prioritizes conversations safely, manages appointments, and hands conversations to clinic staff.

It is not a veterinarian. It must not diagnose, produce disease possibilities, recommend medication or dosage, create treatment plans, or delay urgent human care.

## Architecture direction

- Runtime: Cloudflare Workers, TypeScript strict mode.
- Data/auth: Supabase PostgreSQL and Supabase Auth.
- Channel: WhatsApp Business Platform / Cloud API.
- Time zone: `Europe/Istanbul`.
- AI is limited to natural-language generation and structured extraction.
- Deterministic, veterinarian-approved rules own safety prioritization.
- Operational mutations use predefined validated tools; AI never receives free SQL access.
- Tenant isolation uses `clinic_id`, composite database relationships, and RLS.
- Structured pet data and conversation summaries come before embeddings/RAG.

## Verified implementation

The secure Worker baseline is committed on `main`:

- `GET /health` returns status/version metadata.
- `GET /webhooks/whatsapp` implements Meta verification without logging the token.
- `POST /webhooks/whatsapp` requires exact JSON media type, enforces a 256 KiB byte limit, verifies `X-Hub-Signature-256` over raw bytes with Web Crypto, rejects empty app-secret configuration, decodes strict UTF-8, and validates the basic WhatsApp event envelope.
- No webhook payload, token, signature, or secret is logged.
- Real secrets are excluded; `.dev.vars.example` contains placeholders.
- pnpm is pinned to `11.9.0`; Wrangler is on major version 4.
- The reviewed core Supabase migration defines eight tenant tables, composite tenant-safe foreign keys, explicit grants, and RLS policies. Privileged helpers live in `vetai_private` with restricted execution and an empty `search_path`.
- Claude Opus's RLS review findings were resolved: the migration uses a 14-digit timestamp filename, relies on Supabase CLI's implicitly transactional migration batch, and does not grant direct access to the trigger function.
- The migration was applied successfully to the disposable `vetai-test` Supabase project. A rollback-based PostgreSQL 17 test verified all eight RLS-enabled tables, zero anonymous grants, same-clinic staff access, cross-clinic denial, backend-only `webhook_events`, composite tenant foreign keys, and zero surviving fixture rows.
- Signed inbound WhatsApp text messages are now normalized and hashed by the
  Worker, deduplicated within each payload, and persisted through one native
  Supabase Data API RPC. The RPC atomically resolves the clinic, claims the
  webhook event, upserts the owner, reuses or creates one open conversation,
  inserts the inbound message, and marks the event processed.
- The ingestion migration was applied to `vetai-test`; its rollback SQL test
  passed idempotency, hash-conflict, unknown-account, owner-name preservation,
  handoff-conversation reuse, and function-grant checks with no surviving
  fixtures.
- Conversations now persist a constrained intake stage, structured intake
  document, and optimistic state version. Service-role-only RPCs return a
  tenant-scoped owner/pet/recent-message context and enforce forward-only,
  version-checked state changes with terminal handoff/completed behavior.
- The conversation-state migration and rollback SQL test passed in
  `vetai-test`, including stale updates, pet tenant boundaries, grants, latest-
  12 message ordering, and zero surviving fixtures.
- A provider-neutral intake contract now validates future model JSON strictly,
  rejects extra or malformed data, represents only explicitly reported facts,
  and cannot carry database IDs, actions, diagnosis, medication, or response
  text. Its versioned system prompt treats user content as untrusted data.
- Pet references resolve only by exact normalized name against the already-
  loaded tenant-scoped pet list, with a single-pet fallback and clarification
  for zero, multiple, duplicate-name, or fuzzy cases.
- A native-fetch OpenAI Responses adapter now submits one untrusted message to
  `gpt-5.6-luna` with `store: false`, current-turn/no reasoning, a
  privacy-preserving safety identifier, and strict Structured Outputs. It
  accepts only a completed single-message response that also passes the Task
  007 runtime parser; all provider, refusal, and malformed-output failures are
  generic and fail closed. Tests use a mocked fetch; no live model call has
  been made.
- A provider-neutral deterministic safety gate now routes the validated intake
  contract with fixed precedence: any explicit emergency signal stops normal
  automation, human and medical-advice requests route to staff, unknown safety
  facts require clarification, and only eight explicit false values may
  continue. The canonical signal list is compile-time exhaustive, is reused by
  the runtime intake planner, and both Codex and Claude Opus reviews passed.
- Inbound persistence now returns a validated, tenant-scoped conversation ID
  for both newly processed and exact-duplicate WhatsApp messages. Unknown
  accounts return no locator; malformed Data API results and orphaned duplicate
  events fail closed. The forward migration and rollback SQL test passed on
  `vetai-test`, including cross-tenant same-provider-ID isolation and
  service-role-only execution, with zero surviving fixtures.
- After successful inbound persistence, the webhook now awaits a Cloudflare
  Queue producer send before returning HTTP 200. Both processed and exact-
  duplicate outcomes enqueue a versioned job containing only conversation and
  provider-message IDs; missing bindings and send failures return 503. No real
  Queue resource, consumer, or deployment exists yet.
- Untrusted Queue bodies now have a strict three-field runtime parser, and
  persisted inbound events have a database-backed `pending | processing |
  completed` intake lease with a fixed 120-second expiry and UUID claim token.
  Tenant-safe claim/completion RPCs lock the exact message/event pair, allow
  expired-lease reclaim, and prevent a superseded token from completing. Only
  `service_role` can execute them; native-fetch clients validate every Data API
  success shape and fail closed.
- The lease migration and rollback SQL test passed on disposable `vetai-test`
  with zero surviving fixtures; 307/307 TypeScript tests, typecheck, frozen
  install, and Worker dry-run passed. Codex and Claude Opus reviews passed.
  The SQL test proves a sequential second claim; true two-session blocking was
  reviewed from PostgreSQL locking semantics rather than exercised directly.
- A service-role-only atomic finalization RPC now locks the current intake job,
  delegates the existing optimistic conversation-state transition, and
  completes the matching lease in one PostgreSQL transaction. It returns a
  closed `applied | already_completed | stale_claim | stale_state` result and
  rolls back state if completion cannot succeed. Its native-fetch client
  validates the exact Data API row shape and is wired only through the bounded
  intake consumer.
- The finalization migration and rollback test passed on disposable
  `vetai-test`, including a real service-role claim/write/finalize path,
  cross-tenant same-provider isolation, stale token/state behavior, invalid
  transition rollback, privileges, and zero fixture residue. 333/333 tests,
  typecheck, frozen install, Worker dry-run, Codex review, and Claude Opus
  review passed.
- A pure, provider-neutral intake-turn planner now validates a versioned
  persisted snapshot, deterministically merges explicit facts across turns,
  keeps reported danger and human requests sticky, resolves pet identity only
  against tenant-scoped context, reuses the reviewed safety gate, and selects
  only a same-stage, one-step-forward, or human-handoff transition. Corrupt
  snapshots fail closed; the planner is consumed by the bounded Queue
  consumer. Codex and Claude Opus reviews passed with 386/386 tests.
- A bounded Cloudflare Queue consumer now connects the reviewed intake
  pipeline in runtime order: strict job parsing, database lease claim,
  tenant-scoped context fetch, privacy-preserving owner hash, structured
  OpenAI extraction, deterministic planning, and atomic state/lease
  finalization. Each message is explicitly acknowledged or retried; one
  rejected message cannot prevent sibling disposition.
- Invalid jobs and terminal/missing claims are acknowledged, transient or
  stale-state failures are retried, and retry configuration is bounded to
  three attempts with a 120-second delay and a declared dead-letter queue.
  Corrupt snapshots are replaced with a fresh current-turn snapshot and
  atomically routed to human handoff instead of retrying forever. No WhatsApp
  send occurs in this consumer. Codex review passed with 413/413 tests,
  typecheck, frozen install, and Worker dry-run.
- A pure deterministic reply planner now maps the reviewed turn result to a
  closed Turkish fixed-copy response or terminal `none`. Emergency and unknown
  safety paths tell the user not to wait for the bot and to contact an open
  veterinary clinic; human-handoff copy truthfully says the bot cannot answer
  and does not claim staff notification. No dynamic owner, pet, complaint,
  symptom, clinic, or provider data is inserted into reply text.
- The reply planner is wired into the intake consumer and its result is
  persisted, but no code sends it to WhatsApp. Codex and Claude Opus safety
  reviews passed after wording fixes. Clinic-veterinarian and Turkish
  legal/privacy approval remain required before production use.
- Inbound webhook events now preserve the exact tenant-scoped WhatsApp account
  used for receipt. Exact duplicate legacy rows may backfill a null link under
  a row lock; a different linked account raises instead of being overwritten.
- A backend-only, service-role-only outbox now stores at most one deterministic
  pending reply per tenant-scoped inbound event. The finalizer atomically
  advances state, inserts the optional outbox row, and completes the current
  lease; routing values and recipient phone are derived inside PostgreSQL.
  Composite foreign keys enforce tenant boundaries and cascade pending replies
  during owner/account/source erasure.
- Task 017 passed 452/452 tests, frozen install, typecheck, Worker dry-run,
  Codex review, and two-stage Claude Opus architecture/RLS/KVKK review. Its
  migration and rollback test passed on disposable `vetai-test`, including
  exact-account isolation, atomic rollback, RLS/grants, erasure cascades, old
  seven-argument finalizer compatibility, and zero fixture residue.
- A service-role-only outbound delivery protocol now claims the oldest due
  outbox row under a five-minute lease, routes it through the exact inbound
  WhatsApp account, retries at most three times with a two-minute delay, and
  atomically records Meta acceptance plus one outbound conversation-history
  row. Expired third-attempt work is terminally exhausted instead of starving.
- A UTC one-minute scheduled Worker drains at most ten rows globally per run.
  Meta sends use native fetch, validated fixed text requests, a 30-second
  timeout, and additive-response-field tolerance around a strict provider ID.
  Delivery remains explicitly at-least-once: an acceptance lost before the
  database commit may produce a duplicate send, and HTTP acceptance is not
  delivered/read proof.
- Task 018's migration and rollback fixture passed on disposable `vetai-test`,
  including tenant/account routing, leases/tokens, bounded retry/exhaustion,
  atomic accept/replay/collision handling, privileges/RLS, erasure cascades,
  and zero fixture residue. Frozen install, typecheck, 564/564 tests, Worker
  dry-run, Codex review, and final Claude Opus review passed. No real Meta
  request, deployment, Cron resource creation, or production configuration
  occurred.
- Signed WhatsApp webhooks now extract supported outbound `sent | failed |
  delivered | read` callbacks before mutation, tolerate additive/unsupported
  provider fields, and persist a bounded status summary through one native
  service-role RPC. Status-only callbacks never enqueue intake work; mixed
  callback replays remain idempotent.
- Status routing locks an accepted outbox row only when exact account phone-
  number ID, provider message ID, and recipient match. The summary is non-
  regressing (`sent < failed < delivered < read`), with provider time used
  only to order repeated same-rank events; accepted remains distinct from
  sent/delivered/read.
- Task 019's migration and rollback fixture passed on disposable `vetai-test`,
  including rank/timestamp behavior, cross-tenant account isolation, null-
  coherent CHECK enforcement, RLS/grants, erasure cascades, and zero residue.
  Frozen install, typecheck, 630/630 tests, Worker dry-run, and Codex review
  passed. No real Meta callback, deployment, or production migration ran.

Verified evidence before the context-system change:

- Product-code baseline: `e50a2f7`.
- Workflow baseline: `a9ea3f8`.
- Frozen install passed.
- Typecheck passed.
- 30/30 tests passed.
- Wrangler dry-run passed.
- Worktree was clean.

## Not implemented

- General-purpose application queries; only the inbound WhatsApp persistence
  RPC is implemented.
- Operational monitoring and alerts for terminal send/provider failures.
- New-pet creation beyond selecting an existing tenant-scoped pet.
- Deterministic triage and actual staff notification/handoff operations.
- Appointment operations.
- Summaries, memory, embeddings, or RAG.
- Staff/admin panel.
- Production deployment and real external-service configuration.

## Environment constraints

- Supabase CLI is present and authenticated for project discovery.
- Docker is not installed. The disposable remote project `vetai-test` is available but the repository is intentionally not CLI-linked because no database credential is persisted.
- The test migration was executed through the authenticated Supabase SQL editor, so it is integration-tested but is not recorded in Supabase CLI migration history. A real deployment must still use `supabase db push` or the equivalent managed migration workflow.
- `rtk` was not available in earlier Codex shell sessions; agents may use native commands when a fresh availability check fails.

## Current phase

Task 019 now persists reviewed outbound provider-status callbacks without
confusing acceptance with delivery. The next phase is Task 020: define a
minimal backend staff work queue for human handoff and terminal delivery
failures before appointments or a staff UI. No Cron, Queue, or DLQ resource
has been created and production deployment remains out of scope.

## Durable safety invariants

- Service-role credentials exist only in secure Worker bindings and never in client code.
- Anonymous users receive no direct application-table access.
- Authenticated staff can access only clinics where membership is verified.
- Cross-tenant relationships are rejected by database constraints even if application code is wrong.
- Raw webhook payloads and sensitive clinical messages are not copied into logs or embeddings by default.
- Red-priority situations stop normal automation and trigger immediate human/emergency direction.
- A lease guarantees one successful completer, not one executing worker after
  expiry/reclaim; irreversible effects must be independently idempotent or
  committed atomically with current-token completion.
- `stale_state` does not renew a lease; consumer retries must fit within the
  original expiry and poison/invalid payload failures must not retry forever.
- A corrupt persisted intake snapshot is a poison condition: the consumer must
  surface it for staff/handoff handling and must not silently drop it or retry
  it forever.
- Consumers must inspect the planner's `safetyDecision`, not infer safety from
  `nextStage` alone; a completed stage remains terminal, and later triage work
  must still honor the deterministic gate result.
- User-facing copy must not claim staff notification or response unless such an
  operation is durably implemented. Unknown or worsening safety conditions
  must preserve an immediate off-bot professional-contact path.
- The current Turkish safety copy is not production-approved until a clinic
  veterinarian and Turkish legal/privacy reviewer approve it; AI review does
  not replace those gates.
- Pending outbox rows contain recipient phone data and must cascade with
  owner/account/source erasure. Future webhook-event retention must not prune
  a source event while its reply is still pending, or the cascade would
  intentionally discard that unsent reply.
- Accepted outbox rows still retain recipient phone and fixed reply content.
  Future retention must never prune `pending` or `processing` rows, must keep
  erasure cascades intact, and should minimize accepted-row retention without
  deleting the authoritative outbound history needed by product policy.
- An exact accepted replay is resolved before claim-token comparison and
  returns `already_accepted`; this is intentional idempotency, not current-
  lease authorization. Different provider IDs still raise.
- The scheduled sender's ten-row cap is global rather than per clinic; future
  fairness or backlog controls must treat that as an operational constraint.
- Deterministic fail-closed consumer errors can exhaust the configured three
  attempts. A real DLQ resource, monitoring path, and operational owner are a
  production blocker even though no such resource is created in this repo yet.

## Context maintenance

After each verified task, Codex updates only durable facts here: completed behavior, verified commands, accepted decisions, known blockers, and the next phase. Verbose implementation notes stay in Git history and completed task records rather than accumulating in this file.
