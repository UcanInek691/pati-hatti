# Current task — 016 plan deterministic intake replies

Status: `COMPLETE`

Primary implementer: Claude Sonnet

Reviewer: Codex, then Claude Opus for the user-facing safety wording only

## Goal

Add one pure, provider-neutral reply planner that converts the already
reviewed intake-turn result into a closed Turkish reply or an explicit
`none` result.

This task defines and tests the exact user-facing text before any database
outbox or WhatsApp sending is added. It must not call an LLM, Supabase,
Cloudflare, Meta, or any other external service. It must not be wired into the
Queue consumer yet.

The MVP deliberately uses fixed deterministic text instead of a second LLM
call. This is cheaper, easier to audit, and prevents diagnosis, treatment,
medication, invented facts, or prompt-controlled reply text.

## Starting context

- Starting HEAD: `3872439` on `main`; worktree is clean.
- `planIntakeTurn` returns a closed `PlanResult`. A successful plan contains
  the exact next stage, tenant-safe pet resolution, merged intake snapshot,
  and reviewed deterministic `SafetyDecision`.
- Safety precedence is already owned by `evaluateSafetyDecision`; this task
  must consume its result rather than re-evaluate symptoms or signals.
- The Queue consumer atomically finalizes state and lease but deliberately
  sends no reply. Direct sending there would create a lost-message or
  duplicate-message window, so runtime wiring remains out of scope until an
  atomic outbox boundary exists.
- Completed conversations are not reused by inbound persistence; new inbound
  messages receive a new active conversation.

Before editing, follow `AGENTS.md`, verify these facts from repository
evidence, and fill Observed context. Stop if repository evidence conflicts.

## Allowed changes

- New `src/intakeReply.ts`.
- New `test/intakeReply.test.ts`.
- New `docs/intake-replies.md`.
- Fill only the Observed context and Delivery record sections of this file.

Do not change runtime wiring, `src/index.ts`, `src/intakeConsumer.ts`, existing
planner/extraction/safety modules, prompts, environment bindings, Wrangler
configuration, dependencies, migrations, database tests, Queue behavior,
README, `AGENTS.md`, or `PROJECT_CONTEXT.md`.

## Public contract

Add these exported types and function in `src/intakeReply.ts`:

```ts
export type IntakeReplyCategory =
  | "emergency_handoff"
  | "human_handoff"
  | "safety_questions"
  | "pet_identity"
  | "complaint"
  | "intake_received";

export type IntakeReplyPlan =
  | { kind: "none" }
  | { kind: "send"; category: IntakeReplyCategory; text: string };

export function planIntakeReply(
  currentStage: IntakeStage,
  result: PlanResult,
): IntakeReplyPlan;
```

Reuse `IntakeStage`, `PlanResult`, and `SafetySignal` directly. Do not copy the
safety evaluator, stage graph, extraction parser, or pet resolver. Do not add
classes, factories, template engines, locale frameworks, configuration layers,
or dependencies.

The function must be pure and deterministic: no fetch, time, randomness,
crypto, logging, mutation, or environment access. Return a fresh object on
every call.

## Exact precedence and reply behavior

Apply these rules in order:

1. If `currentStage === "completed"`, return `{ kind: "none" }` regardless of
   the result. Completed conversations are terminal and inbound persistence
   starts a new conversation for later messages.
2. If `result.kind === "failed"`, return the fixed `human_handoff` reply. This
   mirrors the Queue consumer's poison-snapshot handoff rather than asking the
   user to repeat potentially urgent information forever.
3. For a planned result with `safetyDecision.kind === "emergency_handoff"`,
   return the fixed `emergency_handoff` reply.
4. For `safetyDecision.kind === "human_handoff"`, return the fixed
   `human_handoff` reply.
5. If `result.nextStage === "human_handoff"` for any other reason, return the
   fixed `human_handoff` reply. Do not infer or expose a medical reason.
6. For `safetyDecision.kind === "needs_safety_check"`, return one
   `safety_questions` reply containing only the questions mapped from its
   `unknownSignals`, in the array's existing canonical order. Do not ask about
   signals that are already explicitly true or false.
7. If `petResolution.kind === "needs_clarification"`, return the fixed
   `pet_identity` reply.
8. If merged `complaint` is null and merged `symptoms` is empty, return the
   fixed `complaint` reply.
9. Otherwise return the fixed `intake_received` reply. Appointment and triage
   actions are not implied; this is only receipt confirmation.

Never insert owner name, pet name, complaint, symptom, clinic details, IDs,
phone number, message text, or any other dynamic user/provider data into a
reply. The only dynamic construction allowed is joining the fixed safety
questions selected by the closed `unknownSignals` list.

## Exact Turkish copy

Use these strings exactly, including punctuation. Do not ask an LLM to rewrite
them.

- `emergency_handoff`:
  `Bu durum acil olabilir. Bot üzerinden yanıt beklemeyin; en yakın açık veteriner kliniğini hemen arayın veya doğrudan kliniğe başvurun.`
- `human_handoff`:
  `Bu talebi bot üzerinden yanıtlayamam. Lütfen kliniğimizi telefonla arayın. Durum acilse veya kötüleşiyorsa bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun.`
- `pet_identity`:
  `Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.`
- `complaint`:
  `Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?`
- `intake_received`:
  `Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun.`

For `safety_questions`, use this exact prefix:

`Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın. Bu durumlardan biri varsa veya emin değilseniz bot yanıtını beklemeden en yakın açık veteriner kliniğine başvurun:`

Then append one line per unknown signal as `\n- <question>`, using a
compile-time-exhaustive `Record<SafetySignal, string>`:

- `breathing_difficulty` → `Nefes almakta güçlük var mı?`
- `loss_of_consciousness` → `Bilinç kaybı var mı?`
- `active_seizure` → `Şu anda devam eden nöbet var mı?`
- `heavy_bleeding` → `Şiddetli veya durmayan kanama var mı?`
- `major_trauma` → `Araç çarpması, yüksekten düşme veya başka ciddi bir travma oldu mu?`
- `possible_toxin_exposure` → `Zehirli olabilecek bir maddeye maruz kalmış olabilir mi?`
- `possible_foreign_object` → `Yabancı bir cisim yutmuş olabilir mi?`
- `unable_to_urinate` → `İdrar yapamıyor mu?`

If a future malformed internal value somehow supplies an empty or unknown
question list, fail closed to the fixed `human_handoff` reply; do not emit an
empty safety prompt or silently acknowledge intake. This is defense in depth,
not a replacement for the typed safety gate.

## Safety boundaries

- Replies must never diagnose, list possible diseases, recommend medication,
  dosage, treatment, food/fluid administration, home monitoring, or a waiting
  period.
- Emergency copy must direct immediate off-bot professional contact; it must
  not promise that clinic staff are currently available.
- Human-handoff copy must not promise a response time.
- Human-handoff copy must not claim or imply that staff were notified; the
  current system only persists handoff state and directs the user to make
  contact.
- Safety questions collect explicit yes/no facts only; they do not decide or
  communicate a diagnosis, and their fixed prefix must preserve the immediate
  off-bot escape instruction when any listed condition is present or unknown.
- The source basis remains the reviewed deterministic gate. Merck Veterinary
  Manual lists breathing difficulty, ongoing seizures, loss of consciousness,
  severe bleeding, trauma, poisoning, and blocked urine flow among problems
  requiring immediate treatment:
  https://www.merckvetmanual.com/special-pet-topics/emergencies/evaluation-and-initial-treatment-of-dog-and-cat-emergencies
- These strings remain unapproved for production until clinic-veterinarian and
  Turkish legal/privacy review. Passing Codex/Opus review is not veterinary
  approval.

## Required tests

Use compact table-driven tests. Cover at least:

- completed is always `none`, including planned emergency and failed results;
- failed result routes to fixed human handoff;
- emergency beats human request, unknown signals, pet clarification, and
  missing complaint;
- human handoff beats safety clarification, pet clarification, and complaint;
- a human-handoff next stage routes to human handoff even with a continue
  safety decision;
- safety clarification beats pet/complaint questions and includes only the
  unknown signals in the supplied canonical order;
- every `SafetySignal` maps to the exact required Turkish question;
- empty/invalid unknown-signal data fails closed to human handoff without
  throwing;
- pet clarification beats complaint;
- missing complaint and zero symptoms asks for complaint;
- a symptom with null complaint and a complaint with zero symptoms both reach
  `intake_received` when earlier rules do not apply;
- appointment/triage stages do not claim that an appointment was created or
  that triage was performed;
- exact copy, immutability/fresh results, determinism, no logging, and absence
  of dynamic sensitive values;
- existing tests remain unchanged and passing.

Do not add broad snapshot tests for the whole source file. Assert the public
result and exact safety text directly.

## Documentation

Create `docs/intake-replies.md` describing:

- closed reply categories and precedence;
- why fixed deterministic copy is used for MVP;
- safety and privacy boundaries;
- terminal `none` and poison-handoff behavior;
- that no reply is persisted, queued, generated by an LLM, or sent yet;
- that atomic outbox persistence is required before runtime wiring;
- the required clinic-veterinarian and Turkish legal/privacy approval gate.

## Verification

Run:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run
git diff --check
```

Do not commit, push, deploy, create external resources, call a real LLM/API,
mutate Supabase, install a plugin/MCP integration, or touch another service.

## Review gate

After Sonnet delivers, Codex reviews the precedence, exact copy, privacy
boundary, exhaustiveness, and tests, applies only targeted fixes, and reruns
all checks. Because this task introduces user-facing emergency wording, Claude
Opus then performs one read-only safety review. No implementation proceeds to
outbox/runtime wiring until both reviews pass. Clinic-veterinarian approval is
still required before production regardless of either AI review.

## Observed context — Sonnet fills before coding

- Verified `AGENTS.md`, then `PROJECT_CONTEXT.md`, then this file, in order.
- Confirmed HEAD is `b6d5094` on `main` and the worktree was clean before
  coding (`git status --porcelain=v1` returned no output).
- `git diff --stat 3872439 b6d5094 -- . ':!CURRENT_TASK.md'` returned no
  output: the only change between this task's stated starting HEAD (`3872439`)
  and the actual HEAD is the commit that added this task file. No repository
  evidence conflicted with the "Starting context" section.
- Read `src/conversationState.ts` (`IntakeStage` union, 9 stages including
  `human_handoff` and `completed`), `src/intakeTurn.ts` (`PlanResult` closed
  union with `planned`/`failed`, `PersistedIntakeData` interface), and
  `src/intakeExtraction.ts` (`PetResolution` union) to confirm exact field
  names to reuse.
- Read `src/safetyDecision.ts` in full: `SafetyDecision` is
  `{ kind: "emergency_handoff"; positiveSignals } | { kind: "human_handoff";
  reason } | { kind: "needs_safety_check"; unknownSignals } | { kind:
  "continue_intake" }`, `SafetySignal` is derived from a compile-time-exhaustive
  `CANONICAL_SIGNAL_ORDER` of 8 signal names, and `unknownSignals`/
  `positiveSignals` are already filtered in canonical order by
  `evaluateSafetyDecision`, so this task's planner does not need to re-sort.
- Read `test/intakeTurn.test.ts` for existing fixture/import conventions
  (relative `../src/...` imports, `vitest` `describe`/`it`/`it.each`) to match
  style in the new test file.
- Read `docs/inbound-queue.md` and `PROJECT_CONTEXT.md`'s "Current phase" to
  confirm no reply-sending or outbox work is in scope yet and that this task
  is the sanctioned next phase after Task 015.
- Planned files: new `src/intakeReply.ts`, new `test/intakeReply.test.ts`, new
  `docs/intake-replies.md`; no other files planned for change.
- No conflicts or blockers found.

## Delivery record — Sonnet fills after coding

- Changed files: added `src/intakeReply.ts`, `test/intakeReply.test.ts`,
  `docs/intake-replies.md`. No other file was modified; `git status
  --porcelain=v1` after coding shows exactly these three untracked files.
- `planIntakeReply(currentStage, result)` implements the exact 9-rule
  precedence from this file: `completed` → `none` regardless of `result`
  (checked first, independent of `result.kind`); `failed` → fixed
  `human_handoff`; then for a `planned` result, `safetyDecision.kind ===
  "emergency_handoff"` → `emergency_handoff`; `"human_handoff"` →
  `human_handoff`; `nextStage === "human_handoff"` for any other reason →
  `human_handoff`; `"needs_safety_check"` → `safety_questions` built only from
  its `unknownSignals` in their already-canonical order; `petResolution.kind
  === "needs_clarification"` → `pet_identity`; merged `complaint === null &&
  symptoms.length === 0` → `complaint`; otherwise → generic `intake_received`
  (never claims an appointment/triage action).
- All five Turkish strings and the `safety_questions` prefix/question map are
  copied verbatim from this file's "Exact Turkish copy" section, including
  punctuation. `SAFETY_SIGNAL_QUESTIONS` is typed
  `Record<SafetySignal, string>`, so removing or renaming a `SafetySignal`
  key fails the build at compile time.
- Every `sendReply(...)` call constructs and returns a new object literal, and
  `{ kind: "none" }` is a fresh literal at its own call site, satisfying
  "return a fresh object on every call." The module contains no `fetch`,
  `Date`, `Math.random`, `crypto`, `console.*`, or mutation of any input.
- `planSafetyQuestionsReply` fails closed to the fixed `human_handoff` reply
  both when `unknownSignals` is empty and when any entry is not an own key of
  `SAFETY_SIGNAL_QUESTIONS` (defense in depth behind the already-exhaustive
  `SafetySignal` type), without throwing.
- No reply text ever reads `pet_name`, `complaint`, `symptoms` content, owner
  name, IDs, or message text — only closed `kind`/enum-like fields
  (`safetyDecision.kind`, `unknownSignals` members, `petResolution.kind`,
  `nextStage`, boolean/null checks on `complaint`/`symptoms.length`) drive
  branching, and only fixed strings are ever returned.
- `test/intakeReply.test.ts` adds 21 `it`/`it.each`-driven tests (29 assertions
  including expanded `it.each` cases) covering every bullet in "Required
  tests": completed-always-none for planned/planned-emergency/failed; failed
  routes to human handoff; emergency precedence over human-request signal,
  unknown safety signals, pet clarification, and missing complaint; human
  handoff precedence over safety/pet/complaint; a human-handoff `nextStage`
  with a `continue_intake` safety decision; safety-question precedence and
  exact canonical-order text; all 8 `SafetySignal` → question mappings
  individually; empty and unrecognized `unknownSignals` failing closed without
  throwing; pet clarification beating complaint; missing-complaint-and-zero-
  symptoms asking for complaint; symptom-with-null-complaint and complaint-
  with-zero-symptoms both reaching `intake_received`; all four
  triage/appointment stages returning only the generic receipt text;
  determinism plus fresh-object identity; no `console.log`/`warn`/`error`
  calls; and absence of the fixture's dynamic pet-name/complaint/symptom
  strings in any returned text. No snapshot test of the whole module was
  added.
- `docs/intake-replies.md` covers all 7 required points: closed categories and
  precedence, why fixed deterministic copy is used for the MVP, safety and
  privacy boundaries, terminal `none`/poison-handoff behavior, that no reply
  is persisted/queued/LLM-generated/sent yet, that atomic outbox persistence
  is required before runtime wiring, and the clinic-veterinarian/Turkish
  legal/privacy approval gate.
- Commands run and results:
  - `pnpm install --frozen-lockfile` → `Already up to date. Done in 721ms.`
  - `pnpm typecheck` → `tsc --noEmit` completed with no errors.
  - `pnpm test` → all tests passed, 442/442 (413 existing + 29 new).
  - `pnpm exec wrangler deploy --dry-run --outdir .wrangler/dry-run` →
    succeeded; `Total Upload: 47.74 KiB / gzip: 11.28 KiB`; bindings listed
    `env.INTAKE_QUEUE` (Queue) and `env.APP_TIMEZONE`; exited on
    `--dry-run: exiting now.` with no deploy performed.
  - `git diff --check` → exit code 0, no whitespace errors.
- Checks not run: none of the required verification commands were skipped.
- Known limitations: the Turkish copy strings (including emergency and
  human-handoff wording) are, per this file's own gate, not yet approved by a
  clinic veterinarian or for Turkish legal/privacy compliance — Codex/Opus
  review is not that approval. `planIntakeReply` is not wired into
  `src/intakeConsumer.ts` or any runtime path, so no reply is generated or
  sent by the deployed Worker as a result of this task. No commit, push,
  deploy, or real API/LLM/Supabase/Cloudflare call was made.
- Risks for Codex review: confirm the 9-rule precedence ordering in
  `src/intakeReply.ts` exactly matches this file (in particular that the
  `nextStage === "human_handoff"` check at rule 5 sits between the
  `safetyDecision`-based checks and the `needs_safety_check` branch); confirm
  every Turkish string is byte-for-byte exact including punctuation; confirm
  `SAFETY_SIGNAL_QUESTIONS` stays compile-time exhaustive over `SafetySignal`
  if that type ever changes; and confirm no test or implementation path
  allows dynamic user data into reply text.

## Codex review record

- Decision: `PASS`, pending the required Claude Opus safety-copy review.
- Scope matches the allowed list exactly. The new module is not imported by
  runtime code and performs no external call, persistence, logging, mutation,
  timing, randomness, or environment access.
- The nine precedence rules match the contract. Completed is terminal; poison
  results route to fixed human handoff; emergency and human decisions precede
  clarification; safety questions precede pet/complaint prompts; the fallback
  is receipt-only and claims no triage or appointment action.
- All fixed Turkish strings and all eight safety questions match the task
  contract. `Record<SafetySignal, string>` makes the question map exhaustive,
  while empty or unrecognized internal signal lists fail closed to the fixed
  human-handoff reply.
- Code-path inspection found no dynamic user/provider field in returned text.
  UTF-8 content was checked directly with Node: no replacement or NUL bytes
  exist; apparent mojibake in PowerShell output is display-only.
- Codex independently reran frozen install, strict typecheck, all 442 tests,
  Wrangler dry-run, and `git diff --check`; all passed before the Opus wording
  review. No pre-Opus implementation deviation was found.
- No commit, push, deploy, real API/LLM call, database mutation, or external
  resource creation was performed. `PROJECT_CONTEXT.md` remains unchanged
  until the mandatory Opus review is resolved.
- Opus should review only: whether the exact emergency/human-handoff wording
  could delay care, over-promise clinic routing/availability, or omit a needed
  immediate-contact instruction; whether the eight questions remain neutral
  fact collection without diagnosis/treatment; and the completed-stage
  `none` rule given the verified new-conversation invariant.

## Claude Opus review record

- Initial decision: `CHANGES_REQUIRED`.
- Blocking finding accepted: the original human-handoff copy falsely claimed
  that the clinic team had been notified and instructed the user to wait,
  although no staff notification channel exists.
- Blocking finding accepted: the original safety-question branch had no
  immediate off-bot escape instruction despite representing unknown danger
  signals.
- Targeted remediation: emergency copy now leads with immediate contact with
  the nearest open veterinary clinic; human-handoff copy truthfully states the
  bot cannot answer and tells the user to call; safety-question copy includes
  an immediate-contact instruction for any listed condition or uncertainty;
  generic receipt copy now includes a worsening/new-symptom escape instruction.
- No precedence, safety decision, stage, dynamic-data, or runtime behavior was
  changed. A second read-only Opus pass is required before completion.
- After remediation, Codex reran frozen install, strict typecheck, all 444
  tests, Wrangler dry-run, and `git diff --check`; all passed. Two focused
  regressions now forbid the false staff-notification/waiting claim and require
  the safety-question escape instruction.
- Final Opus decision: `PASS`. Both blocking wording findings are closed. The
  remaining notes are non-blocking editorial consistency and the known
  operational absence of staff notification; neither changes this unwired
  planner's approved scope.
- Clinic-veterinarian and Turkish legal/privacy approval remain mandatory
  before production. Opus approval is limited to this repository's current
  safety wording and does not replace either external approval.
