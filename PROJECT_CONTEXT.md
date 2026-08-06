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

Verified evidence before the context-system change:

- Product-code baseline: `e50a2f7`.
- Workflow baseline: `a9ea3f8`.
- Frozen install passed.
- Typecheck passed.
- 30/30 tests passed.
- Wrangler dry-run passed.
- Worktree was clean.

## Not implemented

- Runtime Supabase client and application queries.
- Webhook idempotency, persistence, queue/retry, or outbound WhatsApp messages.
- Owner/pet matching and conversation state.
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

Task 004's disposable database and tenant-isolation gate passed. The next phase is to connect the Worker to predefined Supabase persistence operations for webhook idempotency; production deployment remains out of scope.

## Durable safety invariants

- Service-role credentials exist only in secure Worker bindings and never in client code.
- Anonymous users receive no direct application-table access.
- Authenticated staff can access only clinics where membership is verified.
- Cross-tenant relationships are rejected by database constraints even if application code is wrong.
- Raw webhook payloads and sensitive clinical messages are not copied into logs or embeddings by default.
- Red-priority situations stop normal automation and trigger immediate human/emergency direction.

## Context maintenance

After each verified task, Codex updates only durable facts here: completed behavior, verified commands, accepted decisions, known blockers, and the next phase. Verbose implementation notes stay in Git history and completed task records rather than accumulating in this file.
