# VetAI project context

Last verified: 2026-08-14 by Codex.

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
- A minimal `staff_work_items` table now durably records human-handoff
  conversations and terminal outbound delivery failures without copying phone
  numbers or message content. Native PostgreSQL triggers deduplicate replays,
  upgrade a handoff to urgent when any persisted safety signal is true, and
  resolve provider-failure work when later delivered/read evidence arrives.
- Authenticated clinic staff have read-only access through one tenant-scoped
  RLS policy; anon has no access, and trigger writes run through two narrowly
  scoped empty-search-path `SECURITY DEFINER` functions with direct execution
  revoked. Composite FKs preserve clinic/conversation/outbox ownership and
  successful erasure paths cascade staff items.
- Task 020's migration, apply-time three-case backfill, rollback fixture, and
  catalog checks passed on disposable `vetai-test` with zero fixture residue.
  Frozen install, typecheck, 630/630 tests, Worker dry-run, and Codex review
  passed. Claude Opus's final architecture/RLS/safety review also passed with
  no blocking finding; no notification, staff UI, resolution API, deployment,
  or production migration was added.
- A dependency-free internal staff surface now supports password login
  directly to Supabase Auth, an urgent-first RLS-scoped open-work list,
  owner/pet/latest-20-message detail, manual refresh/logout, and one explicit
  resolve action. Only the publishable anon key reaches the browser; the
  service-role credential remains server-only. Remote values are rendered
  through `textContent`, staff responses are non-cacheable, and CSP blocks
  inline scripts, framing, base changes, and form submission.
- Resolution uses one authenticated-only empty-search-path `SECURITY DEFINER`
  RPC that locks the item, checks caller clinic membership, hides absent and
  cross-tenant rows behind the same `not_found` result, and preserves direct
  authenticated table-update denial. Task 021's migration and rollback proof
  passed on disposable `vetai-test` with zero fixture residue; 676/676 tests,
  typecheck, frozen install, Worker dry-run, local route smoke testing, and
  Codex review and the required final Claude Opus privacy/RLS review passed;
  nothing was deployed or applied to production.
- A backend-only appointment engine now lists pre-provisioned, same-clinic
  30-minute slots, holds one slot per conversation for ten minutes, switches
  holds atomically, and confirms only the current unexpired token before the
  slot starts. Composite foreign keys bind conversation, owner, pet, and
  clinic; RLS exposes the table and three fixed RPCs only to `service_role`.
- Task 022's migration and rollback fixture passed on disposable `vetai-test`
  with zero residue. Frozen install, typecheck, 756/756 tests, Worker dry-run,
  Codex review, and Claude Opus architecture/RLS/KVKK/concurrency review all
  passed after post-lock ownership and started-slot guards were added.
- The WhatsApp intake consumer now offers the earliest eligible appointment
  slot and accepts only exact normalized `EVET` or `HAYIR` decisions. An
  appointment is confirmed only by the current unexpired database token;
  deterministic safety and handoff decisions bypass all appointment RPCs.
- Task 023's migration and rollback fixture passed on disposable `vetai-test`
  with zero residue. Frozen install, typecheck, 904/904 tests, Worker dry-run,
  Codex review, and the required Claude Opus atomicity/confirmation/tenant/
  KVKK/copy review all passed. No production migration or deployment occurred.
- Exhausted intake jobs now enter a bounded dead-letter consumer. Its
  service-role-only finalizer locks the persisted event and conversation,
  atomically moves non-terminal conversations to `human_handoff`, relies on
  the existing trigger for tenant-scoped staff visibility, and completes the
  event. A configuration-only `GET /ready` endpoint reports only `ready` or
  `unavailable`. Task 024's migration and strengthened rollback fixture passed
  on disposable `vetai-test` with zero residue; 1013/1013 tests, typecheck,
  Worker dry-run, Codex review, and the required Claude Opus review passed.
  No production migration, Queue resource, secret, or deployment occurred.
- Two Turkish human-review packs now consolidate the actual MVP for external
  approval: `docs/veteriner-hekim-onay-paketi.md` contains every current
  safety/appointment message and its trigger, while
  `docs/kvkk-inceleme-paketi.md` contains the verified technical data flow,
  inventory, erasure behavior, and blank legal/retention decisions. They are
  review worksheets, not clinical or legal approval, and signed copies must
  remain outside the repository.
- Print-ready PDFs of both human-review packs are available under
  `output/pdf/`. The veterinarian version is five-page portrait A4 with a
  dedicated approval page; the KVKK version is nine-page landscape A4 for
  readable decision tables. Both preserve the source content, include plain-
  language technical glossaries, and were text-verified and visually reviewed.
- A separate binding-free local Worker demo now lets a non-technical Turkish
  tester run ten synthetic intake, safety, handoff, and appointment-decision
  scenarios through the reviewed pure planners. It makes no external call,
  changes no production route or configuration, and clearly distinguishes
  simulation from real messaging, notification, persistence, and booking.
  Task 027 passed 1,047/1,047 tests, both Worker dry-runs, Codex review, and a
  rendered browser smoke test; no Opus review was needed.
- A second, isolated local Worker can send synthetic Turkish free text through
  the real reviewed OpenAI extraction adapter and existing pure planners while
  exposing no Supabase, Meta, Queue, Cron, or production binding. It accepts
  only Luna or Terra, validates browser-returned state before a paid call,
  limits one browser session to 20 calls, applies a 30-second provider timeout,
  renders remote values only with `textContent`, and never claims a real side
  effect. The production model remains Luna.
- Task 028 also adds a versioned 66-case synthetic engineering corpus and an
  explicitly opt-in, sequential Luna/Terra evaluator. It reports schema,
  expected-field, critical-signal recall, unknown-signal fail-open, intent,
  latency, token, and official-price cost metrics without printing messages or
  model output. Task 028 passed 1,100/1,100 normal tests with one live test
  correctly skipped, three Worker dry-runs, secret/config checks, and Codex
  review; no production deployment or model change occurred.
- On 2026-08-13 Codex then ran the user-authorized live gate against a dedicated
  OpenAI test project using synthetic text only. One Luna smoke request passed,
  followed by all 66 cases on both Luna and Terra (132 calls) sequentially in
  about 4 minutes 51 seconds. Both models returned 66/66 runtime-valid schemas
  with zero provider failures. Luna matched 817/990 expected leaf fields
  (82.53%). The visible Terra report showed 9/9 explicit red signals, 9/9
  explicit false signals, 509/510 unspecified signals preserved as not-false,
  and 15/15 targeted human/medical-advice/appointment intents; its token-based
  estimate was $0.242272. These are engineering labels, not veterinarian-
  approved evidence, so production remains Luna pending the reviewed Task 029
  multi-turn corpus and human safety review.
- The dedicated OpenAI test project allows only Luna and Terra. Its local key
  is restricted to model requests, remains only in the ignored
  `.dev.vars.live-ai`, and the organization now has an enforced $5 monthly hard
  limit. The platform warned that enforcement is not instantaneous and a small
  overage is possible; the dashboard showed $0.26 spend immediately after the
  smoke and comparison run.
- Task 029 is complete. Production now gives Luna only the exact current
  inbound message plus at most the single immediately preceding eligible bot
  question, labelled as untrusted context data; it never sends full history.
  `human_handoff` and non-completed state version 12+ paths make no model call,
  repeated no-progress questions terminate in the truthful handoff path, and
  the canonical persisted snapshot preserves deterministic emergency reply
  precedence. Claude Opus's post-fix read-only safety/privacy review passed.
- On 2026-08-14 Codex ran the user-authorized 30-case multi-turn corpus once
  against Luna and Terra (60 sequential calls, synthetic text only). Both
  returned 30/30 valid schemas, zero provider failures, 12/12 explicit-red
  recall, 24/24 explicit-false accuracy, 204/204 unspecified-not-false, and
  zero unexpected explicit-red signals. Luna matched 51/52 expected leaves
  and 29/30 exact cases for an estimated $0.011948; Terra matched 52/52 and
  30/30 for $0.119816. Luna remained the production extractor because it met
  every mandatory gate at roughly one tenth of Terra's model cost. The one
  Luna mismatch was complaint-follow-up case `T029-027`, not a safety signal.
  This is a new `2026-08-13.1` engineering baseline, not veterinarian-approved
  clinical evidence and not directly comparable to the earlier prompt version.
  Task 030 later advanced the active prompt to `2026-08-14.1`; these recorded
  numbers are not evidence for that revision.
- Task 030 is complete. Explicit new/unregistered-pet registration requests
  reuse the truthful staff-handoff path without creating a pet or claiming an
  action occurred. Human-handled turns preserve only an already-selected
  conversation pet; current-turn names and the one-pet fallback cannot create
  an association. This boundary depends on correct model classification because
  the closed extraction schema has no registration flag.
- Signed WhatsApp `audio | contacts | document | image | location | sticker |
  video` messages now enter the existing durable ingest/Queue/finalizer/outbox
  path as a fixed internal marker. Nested media fields are not inspected,
  extracted, hashed, logged, persisted, or sent to OpenAI. Normal media gets a
  fixed Turkish unsupported-media reply with zero model work; persisted
  emergency signals retain emergency precedence, completed stays terminal,
  and an existing handoff stage or state version 12+ uses the finite truthful
  handoff path instead of repeating indefinitely.
- Task 030 passed frozen install, strict typecheck, 1,204 tests with 2 opt-in
  live tests skipped, production and live-AI Worker dry-runs, Codex review, and
  Claude Opus's post-fix read-only safety/privacy review. No live evidence yet
  covers prompt `2026-08-14.1`; the fixed Turkish copy and clinical routing
  still require veterinarian and Turkish legal/KVKK approval before production.

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
- Operational alerts/notifications, staff assignment, and administrative user
  or clinic management.
- New-pet creation beyond selecting an existing tenant-scoped pet.
- Deterministic triage and actual staff notification/handoff operations.
- Summaries, memory, embeddings, or RAG.
- A full staff/admin panel beyond the minimal read/detail/resolve surface.
- Production deployment and real external-service configuration.

## Environment constraints

- Supabase CLI is present and authenticated for project discovery.
- Docker is not installed. The disposable remote project `vetai-test` is available but the repository is intentionally not CLI-linked because no database credential is persisted.
- The test migration was executed through the authenticated Supabase SQL editor, so it is integration-tested but is not recorded in Supabase CLI migration history. A real deployment must still use `supabase db push` or the equivalent managed migration workflow.
- `rtk` was not available in earlier Codex shell sessions; agents may use native commands when a fresh availability check fails.

## Current phase

Tasks 028 through 030 are complete, including the authorized synthetic
Luna/Terra live runs, bounded multi-turn interpretation, no-model budget stops,
finite no-progress/media handoff, safe new-pet routing, unsupported-media
handling, and the $5 OpenAI hard-limit setup. Luna remains the production
extractor based on the recorded gates above, but prompt `2026-08-14.1` still
needs fresh authorized live evidence. The next planned technical task is Task
031: clinic profile, hours, and after-hours decisions.

Production release remains blocked on the human approvals and operational
setup in `docs/production-readiness.md`; no real notification, production
resource, secret configuration, production migration, or deployment has
occurred.

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
- Staff work items contain routing identifiers and closed operational reasons,
  never recipient phone numbers or message content. They are durable
  visibility, not proof that a person was notified or responded.
- A normal-priority staff item backed by the fixed
  `{ "dead_letter_handoff": true }` marker means the message's safety risk was
  not evaluated; it must not be interpreted as a low-risk classification.
- Standalone WhatsApp-account deletion may be blocked while the pre-existing
  webhook-event account link remains; successful owner/account/outbox/clinic
  erasure paths must cascade related staff work items and leave no dangling
  operational record.
- Staff work-list queries must order textual priority with `priority DESC` so
  `urgent` precedes `normal`. Work-item durability is intentionally bounded by
  source conversation/outbox lifetime because KVKK erasure cascades take
  precedence over an immutable audit trail.
- The one-open-delivery-item invariant currently depends on the protected
  outbox CHECK that makes exhausted-send and provider-failed states mutually
  exclusive. A future relaxation of that CHECK must revisit the partial unique
  key and trigger conflict behavior together.
- Appointment slot times are absolute `timestamptz` instants aligned on UTC
  half-hours and must be rendered in `Europe/Istanbul` by user-facing flows.
  A current hold cannot be confirmed after its slot has started.
- An appointment slot's `pet_id` is the booking-time snapshot copied from its
  conversation. Later conversation pet changes do not rewrite a held or
  confirmed slot; a flow changing the selected pet must explicitly re-hold.
- The appointment engine's deterministic row-lock order and ownership
  revalidation were reviewed from PostgreSQL semantics and stored function
  definitions. The rollback fixture is single-session and does not claim a
  real two-session blocking test.
- LLM-extracted appointment intent may start only a reversible ten-minute slot
  offer. It cannot select a slot identifier, supply a booking token, or confirm
  an appointment; confirmation requires exact normalized raw-text `EVET` after
  the deterministic safety gate permits normal intake.
- If safety or handoff precedence interrupts appointment confirmation, the
  existing hold is not released or extended by that path. It may remain until
  its fixed expiry and is then reclaimable; a started slot with a still-live
  hold follows the same bounded self-healing behavior.
- Real OpenAI demos and evals use only synthetic text and a dedicated ignored
  local secret file. Their browser call counter is not a billing hard stop;
  spending must be monitored in the separate OpenAI project. Eval/model/prompt
  versions and current prices must be recorded, and no live result may change
  the production model without a separately reviewed task.
- The dedicated OpenAI test organization currently enforces a $5 monthly hard
  limit. It is an operational backstop rather than an exact transaction cap:
  enforcement can lag slightly, and production still needs bounded per-
  conversation work, Queue retry/DLQ behavior, and monitored usage.

## Context maintenance

After each verified task, Codex updates only durable facts here: completed behavior, verified commands, accepted decisions, known blockers, and the next phase. Verbose implementation notes stay in Git history and completed task records rather than accumulating in this file.
