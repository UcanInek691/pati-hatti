# Current task — 030 Safe new-pet handoff and unsupported-media reply

Status: `COMPLETE`

Owner: Codex

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

Verified from repository state before editing:

- `git status` was clean; `HEAD` was `b940d34 docs: define safe media and new pet
  task`, directly on top of Task 029's `37f279d`. No conflict with this
  contract was found.
- `rtk` is not installed in this shell (`rtk: command not found`), so native
  commands were used, as `AGENTS.md` permits.
- `src/whatsappIngest.ts` skipped every message whose `type` was not `"text"`
  (`if (messageObj?.type !== "text") continue;`), confirming that a valid image
  or audio webhook returned 200 with no persistence, Queue job, or reply.
- `src/index.ts` had exactly one caller, `extractTextMessages(body)` at line 57;
  a repository-wide search found no other production or demo caller.
- `claimIntakeQueueJob` returns the stored `messageText`, and the Queue job
  carries only `conversationId`/`providerMessageId`, so a fixed marker can reuse
  the path without any media data.
- `readCanonicalPersistedSnapshot` already provides the fail-closed snapshot
  reader used by Task 029's no-model path, and `buildHandoffPlan` +
  `planIntakeReply` already produce the exact existing emergency copy.
- `IntakeReplyCategory` already contains `intake_received`, so no new category,
  CHECK value, or migration is needed.
- `prompts/intake-extraction-prompt.ts` was at version `2026-08-13.1`, matching
  the `prompt_version` field in both eval corpora.
- Constraint found in an out-of-scope test: `test/liveOpenAiEval.test.ts:264`
  asserts every single-turn case id matches `/^T028-\d{3}$/` and that
  `case_count === cases.length`. New cases therefore continue the `T028-0xx`
  numbering (`T028-067`…`T028-072`) rather than using a `T030-` prefix.

## Delivery record

### Changed files

Product code:

- `prompts/intake-extraction-prompt.ts` — version `2026-08-13.1` →
  `2026-08-14.1` and one new "New or unregistered pets" rule mapping an explicit
  registration request onto the existing `human_handoff` intent. Output contract
  untouched.
- `src/whatsappIngest.ts` — `extractTextMessages` renamed to
  `extractInboundMessages`; exported `UNSUPPORTED_MEDIA_MARKER`
  (`"__vetai_unsupported_media__"`); closed media set `audio, contacts,
  document, image, location, sticker, video`.
- `src/index.ts` — import and call rename only.
- `src/intakeReply.ts` — added `UNSUPPORTED_MEDIA_TEXT` and the pure
  `planUnsupportedMediaReply()` returning the existing `intake_received`
  category.
- `src/intakeConsumer.ts` — added the marker branch after claim + context load
  and before previous-question selection, safety-identifier hashing, and any
  OpenAI call.

Evals: `evals/intake-live-cases.json` (prompt/eval version `2026-08-14.1`,
`case_count` 66 → 73, seven new synthetic cases),
`evals/intake-multiturn-live-cases.json` (`prompt_version` only).

Tests: `test/whatsappIngest.test.ts`, `test/index.test.ts`,
`test/intakeConsumer.test.ts`, `test/intakeReply.test.ts`,
`test/intakeExtractionPrompt.test.ts`.

Docs: `docs/ai-behavior-and-safety.md`, `docs/inbound-queue.md`,
`docs/intake-replies.md`, `docs/product-roadmap.md`, and this file's two
implementer sections.

### Acceptance criteria satisfied

- Existing text/status/mixed webhook tests are behaviorally unchanged; only the
  extractor identifier was renamed. The one previously text-only assertion that
  used `type: "image"` to prove "unsupported types are ignored" now covers
  `reaction | system | unknown | button`, which is the same guarantee for types
  that remain outside the closed set.
- Each of the seven closed-set media types produces exactly one marker item;
  reaction/system/unknown/button produce none.
- Recognized media with a malformed sender, empty or oversized message id,
  malformed timestamp, or malformed phone-number id returns `{ ok: false }`;
  nested media fields are neither required nor read.
- Hash/dedupe: a bare `image` message and one carrying
  `{ id, mime_type, sha256, caption }` produce the identical `payloadHash`;
  identical duplicates collapse; a conflicting declared type or a text body for
  the same `(phone_number_id, message.id)` key returns `{ ok: false }`.
- A signed image/audio webhook uses the existing
  `ingest_whatsapp_text_message` RPC and the existing versioned Queue job and
  returns 200 only after both succeed; unknown account and Queue send failure
  return 503; malformed media returns 400 with zero fetch and zero Queue calls.
- A claimed marker makes zero OpenAI calls, preserves the canonical snapshot,
  stage, and `petId`, emits the exact fixed reply under `intake_received`, and
  keeps the existing `applied | already_completed | stale_claim` → ack and
  `stale_state`/failure → retry dispositions.
- A marker with a malformed persisted snapshot retries after exactly two fetch
  calls and never finalizes; an already-persisted explicit emergency signal
  produces `human_handoff` plus the existing `emergency_handoff` copy; a
  `completed` conversation stays completed with a null reply.
- Prompt tests assert the new-pet rule, its no-authorization wording, the
  negative "new symptom / new toy" exclusion, the unchanged closed intent enum
  and field list, version `2026-08-14.1`, and matching `prompt_version` plus
  `case_count === cases.length` in both corpora.
- New-pet positive and negative synthetic cases are present and asserted by
  category; the normal test run makes no paid call (both live tests skipped).
- No schema, RPC, migration, reply category, dependency, config, secret, or
  deployment change.

### Checks run

```text
pnpm install --frozen-lockfile          PASS (already up to date, lockfile unchanged)
pnpm typecheck                          PASS
pnpm test                               PASS — 30 files, 1197 passed, 2 skipped (1199)
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run                                        PASS
pnpm exec wrangler deploy --dry-run --config wrangler.live-ai.toml --env live-ai --outdir .wrangler/dry-run-live-ai   PASS
git diff --check                        PASS (no whitespace errors)
```

The two skipped tests are the existing opt-in live gates. Test count moved from
the 1,139-normal-test baseline to 1,197 passed with the same 2 skipped.

### Not run, and why

- **Live model evidence: `NOT RUN`.** `pnpm eval:openai` and
  `pnpm eval:openai-multiturn` were not executed, as the contract requires. The
  prompt is now `2026-08-14.1`, so the recorded `2026-08-13.1` Luna/Terra
  results do **not** cover the new-pet rule. Any live gate needs fresh explicit
  user authorization.
- No commit, push, deploy, plugin install, database mutation, migration, real
  Meta/OpenAI/Supabase call, or external resource change was performed.
- No database or RLS check was run; this task adds no SQL.

### Known limitations

- **Marker collision (accepted MVP ceiling, per contract):** a real text message
  whose body is exactly `__vetai_unsupported_media__` receives the fixed
  unsupported-media reply. Documented in `docs/ai-behavior-and-safety.md` and
  `docs/inbound-queue.md`; no schema was added to distinguish it.
- **Category reuse:** the media reply shares the `intake_received` category, so
  that value alone cannot distinguish a normal receipt from a media reply in
  analytics. This was the contract's explicit trade to avoid a migration.
- **Finite media escalation:** the marker branch remains before previous-
  question selection and every paid operation, but it now enforces Task 029's
  existing finite-work boundary locally. An existing `human_handoff` stage or
  state version 12+ receives the truthful handoff reply, while persisted
  emergency and completed-terminal precedence remain unchanged.
- **New corpus expectations omit `missing_information`.** Scoring is per
  expected leaf, so omission is valid, but it makes these seven cases
  intentionally narrower than the older ones; guessing that field for a
  registration request would have added noise, not signal. Each new case carries
  a `note` saying so.
- New case ids use the `T028-0xx` prefix because the out-of-scope
  `test/liveOpenAiEval.test.ts` id regex requires it. The `category` values and
  notes identify them as Task 030 cases.
- Eval expectations remain engineering labels, not veterinarian-approved
  clinical evidence. The Turkish media copy still needs clinic-veterinarian and
  Turkish legal/privacy approval before production use.
- `src/index.ts` still names its local variable `textExtraction`; the contract
  allowed an import/call rename only, so the now-slightly-stale local name was
  left alone.

### Risks Codex or Opus should inspect

1. The conservative runtime pet boundary depends on the model producing a
   human-handled classification. The unchanged closed schema has no independent
   registration flag, so a model misclassification remains an accepted risk
   pending fresh live eval evidence.
2. The exact Turkish copy in `src/intakeReply.ts` — it must claim no analysis,
   upload, notification, or staff action, and it is not yet veterinarian
   approved.
3. The privacy boundary in `src/whatsappIngest.ts`: only validated envelope
   identifiers, the timestamp, the fixed marker, and the declared type enter the
   canonical hash. Confirm no nested media field can reach a hash, log, model,
   or database column.
4. Whether bumping `eval_version` on the single-turn corpus (its case set
   changed) while leaving the multi-turn corpus's `eval_version` at
   `2026-08-13.1` is the record you want; the contract limited the multi-turn
   file to prompt-version metadata only.
5. Prompt-rule wording: whether mapping registration requests onto
   `human_handoff` risks over-triggering on adjacent phrasing (adoption,
   ownership transfer, second-opinion) that the seven synthetic cases do not
   cover.

The multi-turn corpus still has `eval_version: 2026-08-13.1` while its
`prompt_version` metadata follows the active `2026-08-14.1` prompt. The
recorded 30-case Luna/Terra results in `PROJECT_CONTEXT.md` explicitly remain a
`2026-08-13.1` baseline and are not evidence for the revised prompt.

## Codex review record

### Decision

`PASS` on 2026-08-14. The implementation scope, signed-webhook
path, durable ingestion/Queue/finalization path, fixed Turkish reply, and
zero-model media branch passed Codex review. The mandatory narrow Claude Opus
review found one blocking finite-escalation regression; Codex applied the
targeted fix and the narrow Opus recheck passed.

### Findings and targeted fixes

1. **Fixed — new-pet name could bind to an existing tenant pet.** The prompt
   classified registration correctly, but `planIntakeTurn` could still exact-
   match the stated name or use its one-pet fallback. `src/intakeConsumer.ts`
   now applies a conservative runtime boundary to human-handled turns
   (`human_handoff`, explicit human request, or `medical_advice_request`): only
   an already-selected conversation pet is preserved, while current-turn text
   cannot introduce a pet association. This also covers combined registration
   + explicit-human and registration + medical-advice messages without adding
   a schema field or text heuristic. Three direct regression tests plus a
   combined medical-advice regression prove the boundary.
2. **Fixed — combined registration + medical advice was prompt-ambiguous.** The
   prompt now explicitly preserves `medical_advice_request`; synthetic case
   `T028-073` and a prompt assertion lock the precedence. The three new symptom
   expectations were aligned with the prompt's exact-as-reported contract.
3. **Clarified — privacy wording.** Documentation and source comments now say
   nested media fields are not inspected or extracted. This is precise: the
   signed request body is necessarily read and JSON-parsed, but caption/media
   id/MIME/location/contact-card fields never enter the canonical hash,
   application item, RPC body, Queue body, logs, model input, or stored reply.

The marker remains before previous-question selection and all paid work. After
Claude Opus identified that this placement bypassed Task 029's finite-work
ceiling, the branch was corrected locally: an existing handoff stage or state
version 12+ now receives the truthful handoff reply. A persisted explicit
emergency still wins, and completed remains terminal with no reply.

### Verification rerun by Codex

- `pnpm.cmd install --frozen-lockfile` — PASS, already up to date.
- `pnpm.cmd typecheck` — PASS.
- `pnpm.cmd test` — PASS, 1,204 passed and 2 opt-in live tests skipped across
  30 files.
- Production `wrangler deploy --dry-run` — PASS; existing Queue/timezone/Graph
  API bindings unchanged.
- Live-AI config `wrangler deploy --dry-run` — PASS; no bindings found, as
  intended.
- `git diff --check` — PASS; only line-ending advisories.

No database migration was added, so no database validation applies. No live
OpenAI eval, commit, push, deploy, Meta call, Supabase mutation, or Queue
mutation was performed. Prompt version `2026-08-14.1` therefore still needs a
fresh explicitly authorized live eval after review; Task 029's earlier numbers
are not evidence for this prompt revision.

### Claude Opus review follow-up

The first narrow read-only review returned `CHANGES_REQUIRED` for one blocking
issue: the marker branch returned before Task 029's state-version/handoff
ceiling, allowing media-only conversations to repeat indefinitely without a
staff work item. The fix adds the existing ceiling condition to the marker
branch without moving it past any paid work. Regression tests cover both state
version 12 and an already-`human_handoff` conversation; both finalize to the
truthful handoff reply with zero OpenAI calls.

Non-blocking review notes were also recorded: the model-classification
dependency is explicit in the safety documentation; the delivery record now
says 66 → 73 / seven cases; and the earlier 30-case multi-turn results remain
explicitly identified as a `2026-08-13.1` baseline rather than evidence for the
active `2026-08-14.1` prompt. Claude Opus's narrow read-only recheck returned
`PASS`: the finite escalation, emergency precedence, completed terminal path,
zero-model guarantee, regression tests, classification limitation, case count,
and baseline distinction were all confirmed. This review does not replace
veterinarian or Turkish legal/KVKK approval.
