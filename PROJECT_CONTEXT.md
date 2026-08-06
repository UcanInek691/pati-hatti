# VetAI project context

Last verified: 2026-08-06 by Codex.

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
- Queue/retry orchestration or outbound WhatsApp messages.
- Provider/webhook wiring for pet resolution, new-pet creation, and state
  orchestration.
- Deterministic triage and human handoff.
- Appointment operations.
- LLM integration, summaries, memory, embeddings, or RAG.
- Staff/admin panel.
- Production deployment and real external-service configuration.

## Environment constraints

- Supabase CLI is present and authenticated for project discovery.
- Docker is not installed. The disposable remote project `vetai-test` is available but the repository is intentionally not CLI-linked because no database credential is persisted.
- The test migration was executed through the authenticated Supabase SQL editor, so it is integration-tested but is not recorded in Supabase CLI migration history. A real deployment must still use `supabase db push` or the equivalent managed migration workflow.
- `rtk` was not available in earlier Codex shell sessions; agents may use native commands when a fresh availability check fails.

## Current phase

Task 007's provider-neutral structured extraction and exact pet-resolution
gate passed. The next phase is to connect a single LLM provider only for this
validated extraction path, then add deterministic safety/triage rules before
any AI-generated response or outbound WhatsApp delivery. Production deployment
remains out of scope.

## Durable safety invariants

- Service-role credentials exist only in secure Worker bindings and never in client code.
- Anonymous users receive no direct application-table access.
- Authenticated staff can access only clinics where membership is verified.
- Cross-tenant relationships are rejected by database constraints even if application code is wrong.
- Raw webhook payloads and sensitive clinical messages are not copied into logs or embeddings by default.
- Red-priority situations stop normal automation and trigger immediate human/emergency direction.

## Context maintenance

After each verified task, Codex updates only durable facts here: completed behavior, verified commands, accepted decisions, known blockers, and the next phase. Verbose implementation notes stay in Git history and completed task records rather than accumulating in this file.
