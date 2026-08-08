# Current task — 016 plan deterministic intake replies

Status: `READY`

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
  `Bu durum acil olabilir. Lütfen bot üzerinden yanıt beklemeden kliniğimizi telefonla arayın veya en yakın açık veteriner kliniğine başvurun.`
- `human_handoff`:
  `Talebinizi klinik ekibine yönlendirdim. Lütfen ekip yanıtını bekleyin. Durum kötüleşirse en yakın açık veteriner kliniğiyle doğrudan iletişime geçin.`
- `pet_identity`:
  `Hangi evcil hayvanınız için yazıyorsunuz? Lütfen adını belirtin.`
- `complaint`:
  `Evcil hayvanınızla ilgili sizi endişelendiren durumu veya fark ettiğiniz belirtileri kısaca yazar mısınız?`
- `intake_received`:
  `Bilgileri aldım.`

For `safety_questions`, use this exact prefix:

`Güvenlik için lütfen aşağıdaki soruları her biri için evet veya hayır diye yanıtlayın:`

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
- Safety questions collect explicit yes/no facts only; they do not decide or
  communicate a diagnosis.
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

Pending.

## Delivery record — Sonnet fills after coding

Pending.
