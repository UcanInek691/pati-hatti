# Current task — 030 Safe new-pet handoff and unsupported-media reply

Status: `READY`

Owner: Claude Sonnet

## Goal

Stop two pilot-blocking silent or misleading paths without adding a pet-
creation feature or any media analysis:

1. an explicit request to register a new/unregistered pet must use the existing
   truthful staff-handoff path; and
2. a supported inbound WhatsApp media type must receive one durable fixed
   Turkish reply instead of being silently ignored.

Reuse the existing signed webhook, tenant-safe ingestion, Queue lease,
deterministic safety gate, atomic finalizer, outbox, and delivery retry. Never
send media bytes/metadata to OpenAI or store them in application tables.

## Scope

Allowed changes:

- `prompts/intake-extraction-prompt.ts`
- `evals/intake-live-cases.json`
- `evals/intake-multiturn-live-cases.json` — prompt-version metadata only
- `src/whatsappIngest.ts`
- `src/index.ts` — import/call rename only if the extractor is renamed
- `src/intakeConsumer.ts`
- `src/intakeReply.ts`
- `test/whatsappIngest.test.ts`
- `test/index.test.ts`
- `test/intakeConsumer.test.ts`
- `test/intakeReply.test.ts`
- `test/intakeExtractionPrompt.test.ts`
- `docs/ai-behavior-and-safety.md`
- `docs/inbound-queue.md`
- `docs/intake-replies.md`
- `docs/product-roadmap.md` — Task 030 status only
- `CURRENT_TASK.md` — implementer fills only **Observed context** and
  **Delivery record**

Do not change:

- the `IntakeExtraction` shape, intent enum, runtime parser, JSON Schema,
  persisted snapshot schema, safety-signal set, or deterministic safety rules;
- pet tables, pet-creation RPCs, migrations, RLS, grants, outbox CHECK values,
  finalizer RPCs, Queue message shape/bindings, delivery sender, Cron, webhook
  signature/body limits, or any appointment behavior;
- production Luna selection, 30-second timeout, `store: false`, reasoning
  settings, safety identifier, dependency graph, lockfile, or environment
  bindings;
- existing emergency/human/safety/appointment Turkish copy;
- any real secret, production resource, deployment, or external service state.

Do not implement pet creation, media download, OCR, transcription, image/audio
analysis, WhatsApp interactive controls, a new reply category, a new database
column, or a generic message abstraction.

## Verified starting evidence

- Task 029 is committed at `37f279d`; the worktree is clean and
  `CURRENT_TASK.md` was `COMPLETE` before this contract.
- `extractTextMessages` currently ignores every non-text item. Valid image or
  audio webhooks therefore return 200 without persistence, Queue work, or a
  user reply.
- The signed text path already gives the required durable semantics:
  `(phone_number_id, message.id)` dedupe, tenant/account resolution, inbound
  persistence, versioned Queue job, lease/retry/DLQ, atomic reply outbox, and
  outbound retry/status tracking.
- `ingest_whatsapp_text_message` accepts a bounded text value and the Queue job
  carries only conversation/provider-message IDs. The claim returns the stored
  text. A fixed internal marker can therefore reuse this path without carrying
  any media bytes, URL, ID, caption, filename, MIME type, location coordinates,
  or contact-card data.
- `finalize_intake_queue_job` already accepts the existing `intake_received`
  reply category and same-stage updates. Reusing that neutral informational
  category avoids a migration solely for analytics taxonomy.
- The extraction contract already has `human_handoff`. The prompt can map an
  explicit new/unregistered-pet registration request to that existing intent;
  the unchanged safety gate then creates the existing staff work item and
  truthful call-the-clinic reply. No new intent or pet mutation is required.
- Task 029's production prompt version is `2026-08-13.1`. Any prompt text
  change requires one version bump and both eval corpus metadata values must
  stay aligned.
- The last complete verification passed frozen install, typecheck, 1,139
  normal tests (two opt-in live tests skipped), production/live-AI dry-runs,
  Opus review, and the user-authorized 30 x 2 live comparison. Luna remains the
  production extractor.

## Required design

### 1. New/unregistered pet requests use the existing handoff

Bump `INTAKE_EXTRACTION_PROMPT_VERSION` once to `2026-08-14.1` and add the
minimum explicit rule:

- when the owner clearly asks to add/register a pet that is new to or not yet
  registered with the clinic, emit the existing `human_handoff` intent;
- this classification authorizes no action: never claim a pet was registered,
  never create or output an ID, and never treat the stated name as an existing
  tenant match;
- still extract an explicitly stated pet name, species, complaint, symptoms,
  and safety signals normally;
- a medical-advice request and explicit safety facts retain their existing
  meanings; the deterministic gate remains authoritative;
- do not classify ordinary uses of “new” (new symptom, new toy, recently
  changed behavior) as a pet-registration request.

Keep the closed output schema unchanged. Update both corpus prompt-version
fields. Add a small set of single-turn synthetic cases covering at least:

- explicit new-pet registration with and without a stated name/species;
- “this pet is not registered” wording;
- a new-pet request containing an explicit red safety signal;
- negative “new symptom/new toy/recent change” examples.

These remain engineering labels, not veterinarian-approved evidence.

### 2. Recognized unsupported media enters the existing durable path

Replace the text-only extractor name with `extractInboundMessages` and preserve
the existing text behavior byte-for-byte. Recognize only this closed set of
owner media types as unsupported input:

```text
audio, contacts, document, image, location, sticker, video
```

For one of those types:

- validate the same `phone_number_id`, message `id`, `from`, and `timestamp`
  bounds used by text messages; malformed recognized media rejects the entire
  webhook with 400 before persistence;
- emit the existing `WhatsAppIngestItem` with one exported fixed internal
  marker as `messageText`;
- build the canonical hash from the validated envelope identifiers, timestamp,
  and declared media type, but never inspect/hash the nested media payload;
- use the existing contact-name fallback/cap and in-payload dedupe rules;
- identical duplicates collapse; the same provider ID with a conflicting
  supported kind or text remains fail-closed;
- ignore status-only events and non-text types outside the closed set (for
  example reaction/system/unknown) exactly as before.

The marker must be a fixed non-empty ASCII string below all current limits and
must contain no user/provider data. A real text message equal to the internal
marker may receive the fixed unsupported-media reply; this harmless collision
is an accepted MVP ceiling and must be documented rather than adding schema.

### 3. Media marker consumes zero paid model work

In `processIntakeQueueMessage`, detect the exact marker after claim + context
load and before previous-question selection, safety-identifier hashing, or any
OpenAI call.

- Read `context.intakeData` through `readCanonicalPersistedSnapshot`; malformed
  state retries and is never finalized as success.
- Never send the marker, prior question, snapshot, or media information to
  OpenAI.
- Preserve the current pet and canonical intake snapshot.
- Normally keep the current stage and atomically finalize the current lease
  with the fixed unsupported-media reply below.
- If the canonical snapshot already contains an explicit `true` emergency
  signal, preserve the existing deterministic emergency precedence: route a
  non-completed conversation to `human_handoff` and use the existing exact
  emergency reply instead. Do not infer a new safety fact from the media.
- A `completed` context stays completed and produces no new reply; this is a
  defensive branch because ingestion does not reuse completed conversations.
- Existing `applied | already_completed | stale_claim` acknowledgement and
  retry dispositions remain unchanged.

Use one pure fixed-copy helper in `src/intakeReply.ts`. To avoid a migration,
return the existing internal `intake_received` category with this exact text:

```text
Bu bot şu anda görsel, ses, video, belge, konum veya kişi kartı içeriğini değerlendiremiyor. Lütfen durumu yazılı mesajla açıklayın veya kliniğimizi telefonla arayın. Durum acilse bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.
```

The copy claims no analysis, upload, notification, or staff action; gives no
diagnosis/treatment; promises no response time; and includes an immediate
off-bot emergency escape.

### 4. Durability and privacy

- A processed recognized-media webhook persists the fixed marker through the
  existing RPC and awaits the existing Queue send before returning 200.
- Exact webhook redelivery and Queue redelivery must not create a second
  outbound reply.
- Unknown account, persistence failure, or Queue failure keeps the existing
  503 behavior.
- Do not log or persist media payloads, captions, IDs, URLs, filenames, MIME
  types, coordinates, contact cards, message text, or provider bodies.
- Do not add a real Meta/OpenAI/Supabase call in tests.

## Acceptance criteria

- Existing text/status/mixed webhook tests remain behaviorally unchanged.
- Each closed-set media type produces one marker item; reaction/system/unknown
  still produces none.
- Recognized media with malformed sender/id/timestamp/phone ID returns
  `{ ok:false }`; nested media fields are neither required nor read.
- Hash/dedupe tests prove nested media payload changes are ignored, while a
  conflicting declared type for the same key is rejected.
- A signed image/audio webhook uses the existing ingest RPC and Queue job,
  returning 200 only after both succeed; failure paths remain 503.
- A claimed marker makes zero OpenAI calls, preserves canonical state/pet,
  emits the exact fixed reply, and finalizes/acks through existing rules.
- A marker with malformed persisted state retries; sticky explicit emergency
  state uses the existing emergency reply and handoff precedence.
- Prompt/schema tests prove the new-pet rule, unchanged closed JSON shape, and
  aligned `2026-08-14.1` corpus metadata.
- New-pet positive/negative synthetic cases are present; normal tests make no
  paid call.
- No schema/RPC/migration/category/dependency/config/secret/deployment change.

## Required verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml --env live-ai --outdir .wrangler/dry-run-live-ai
git diff --check
```

Do not run `pnpm eval:openai` or `pnpm eval:openai-multiturn`. Sonnet must mark
live model evidence `NOT RUN`. After code review, Codex may run the existing
full synthetic Luna/Terra gate only with fresh explicit user authorization.

No commit, push, deploy, plugin installation, database mutation, real service
call, or external resource change is authorized for the implementer.

## Review gates

1. Codex reviews the diff and complete webhook -> ingest -> Queue -> marker ->
   finalizer/outbox call path, reruns all required local checks, and verifies
   no media or secrets cross a log/model/database boundary.
2. Claude Opus performs one narrow read-only review of the new prompt rule,
   emergency precedence, privacy boundary, and exact Turkish media copy. It
   need not review unrelated RLS, appointments, staff UI, or delivery code.
3. A live prompt eval requires separate user authorization. AI review and
   synthetic evidence do not replace veterinarian approval of clinical copy.
4. Codex records evidence, updates `PROJECT_CONTEXT.md`, and commits only after
   every applicable gate passes.

## Observed context

To be filled by the implementing agent from repository evidence.

## Delivery record

To be filled by the implementing agent after implementation and verification.

## Codex review record

Pending implementation.
