import type { ConversationIntakeContext } from "./conversationState";
import type { PlanResult } from "./intakeTurn";
import { planIntakeReply, type IntakeReplyPlan } from "./intakeReply";

/**
 * Intake confirmation and first-time pet registration.
 *
 * Task 034 follow-on ("Adım 2") introduced the confirm-before-create rule.
 * Task 036 moved *when* it happens: the confirmation no longer fires the
 * moment a name is extracted, it fires once, in the dedicated
 * `intake_confirmation` stage, after name, species and complaint have all
 * been collected. See `CURRENT_TASK.md`, "Stage model redesign".
 *
 * - a pet is only ever created after the owner explicitly confirms the exact
 *   name (and species, if known) back — never from extraction alone;
 * - the confirmation message summarizes everything the bot has understood in
 *   one turn — name, species and complaint — rather than asking three times;
 * - a returning owner whose pet already matches gets the same confirmation
 *   with nothing to create, so there is one code path, not two;
 * - a reply that *changes* what would be confirmed is a `correction`: the
 *   fields the owner did not contradict are kept, the ones they did are
 *   applied, and the bound below is not spent, because that is progress;
 * - genuinely unparseable repeats are bounded well below the existing global
 *   `NO_MODEL_STATE_VERSION_CEILING` (`src/intakeConsumer.ts`) so a stuck
 *   owner reaches a human sooner than 12 turns, without duplicating or
 *   replacing that existing safety net;
 * - no new persisted field or `schema_version` bump: the bound is derived
 *   from `context.recentMessages`, which is already loaded for every turn.
 *
 * This module only plans; it never calls the database. The caller
 * (`src/intakeConsumer.ts`) is responsible for passing `createPetName`/
 * `createPetSpecies` into `finalizeIntakeQueueJob` on a `"create"` action,
 * and for advancing the stage on `"create"`/`"confirmed"`.
 */

export type PetRegistrationAction =
  | { kind: "none" }
  | { kind: "ask_confirmation"; name: string; species: string | null; complaint: string | null }
  | { kind: "repeat_confirmation"; name: string; species: string | null; complaint: string | null }
  | { kind: "correction"; name: string; species: string | null; complaint: string | null }
  | { kind: "declined" }
  | { kind: "confirmed" }
  | { kind: "create"; name: string; species: string | null }
  | { kind: "bounded_handoff" };

const MAX_PET_NAME_LENGTH = 200;
const MAX_SPECIES_LENGTH = 100;
const MAX_COMPLAINT_LENGTH = 300;

/**
 * Stable tail shared by every confirmation ask this module builds. It is both
 * user-facing copy and the marker `isConfirmationAsk` uses to recognize its
 * own previous question in `context.recentMessages` — a correction changes the
 * values in the question, so the exact-text comparison used before Task 036
 * could no longer tell "the owner answered our question" from "we never
 * asked". No other outbound copy in this codebase ends this way
 * (`appointmentFlow.ts` shares the EVET/HAYIR grammar but not this sentence),
 * and this module only ever runs in `intake_confirmation`.
 */
const CONFIRMATION_SUFFIX = "Onaylamak için EVET, düzeltmek için HAYIR yazın.";

/**
 * Bound on repeated *identical* confirmation asks before forcing
 * human_handoff. Task 036 narrowed what counts: a correction re-asks with
 * different values and is not a repeat. Deliberately well below the existing global
 * `NO_MODEL_STATE_VERSION_CEILING = 12` (`src/intakeConsumer.ts`), which
 * remains the true non-termination backstop regardless of this heuristic.
 */
export const MAX_PET_IDENTIFICATION_ATTEMPTS = 3;

/** Fixed, reviewable bridge from a safely confirmed intake into appointment booking. */
export const POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT =
  "Bilgileri aldım. Yeni bir belirti ortaya çıkarsa veya durum kötüleşirse kliniğimizi telefonla arayın ya da en yakın açık veteriner kliniğine başvurun. Randevu oluşturmak ister misiniz?";

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Fixed-template confirmation copy. Interpolates only the owner's own
 * already-extracted pet name/species/complaint back to them for confirmation
 * — the one case in this codebase where echoing extracted text is the
 * intended behavior (contrast `applyClinicHandoffContext`'s doc comment,
 * which forbids this for handoff copy). Length-capped defensively even though
 * the extractor's schema does not itself bound string length.
 *
 * COPY REVIEW PENDING: the wording below is engineering's draft. Task 036's
 * approvals table routes any change to confirmation copy to the reviewing
 * veterinarian (`docs/veteriner-hekim-onay-paketi.md`). The *mechanism* is
 * approved; these sentences are not, and must be replaced by whatever the
 * review returns.
 */
export function buildIntakeConfirmationText(name: string, species: string | null, complaint: string | null): string {
  const parts = [`Ad: "${truncate(name, MAX_PET_NAME_LENGTH)}"`];

  const trimmedSpecies = species?.trim() ?? "";
  if (trimmedSpecies !== "") parts.push(`Tür: ${truncate(trimmedSpecies, MAX_SPECIES_LENGTH)}`);

  const trimmedComplaint = complaint?.trim() ?? "";
  if (trimmedComplaint !== "") parts.push(`Şikayet: ${truncate(trimmedComplaint, MAX_COMPLAINT_LENGTH)}`);

  return `Anladığım kadarıyla — ${parts.join(", ")}. Doğru mu? ${CONFIRMATION_SUFFIX}`;
}

function isConfirmationAsk(text: string): boolean {
  return text.endsWith(CONFIRMATION_SUFFIX);
}

/**
 * The copy sent when the owner rejects the summary without saying what was
 * wrong. Before Task 036 a `HAYIR` erased `pet_name` and `species` and re-asked
 * the generic identity question, throwing away a correct species to fix a
 * wrong name; now nothing is erased and the owner is asked for the difference
 * only. Same copy-review status as `buildIntakeConfirmationText`.
 */
export const INTAKE_CORRECTION_PROMPT_TEXT =
  "Hangi bilgiyi düzeltmemi istersiniz? Doğru adı, türü veya şikayeti yazmanız yeterli.";

function normalizeForComparison(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("tr");
}

// Duplicates appointmentFlow.ts's `parseAppointmentDecision` grammar
// (per-file duplication convention; see intakeJobLease.ts's "ponytail"
// comment). Deliberately the same EVET/HAYIR wording and normalization so
// the owner is not asked to learn a second confirmation grammar.
function parseYesNoReply(messageText: string): "confirm" | "decline" | "repeat" {
  const normalized = normalizeForComparison(messageText);
  if (normalized === "evet") return "confirm";
  if (normalized === "hayır" || normalized === "hayir") return "decline";
  return "repeat";
}

/**
 * Counts only outbound messages that are *this exact* confirmation ask — not
 * every outbound message in the window, and not every confirmation ask. Two
 * consequences, both intended:
 *
 * - `intake_confirmation` can also emit `safety_questions` (see
 *   `intakeReply.ts`), and counting those would exhaust the bound before a
 *   single confirmation was ever sent;
 * - a correction changes the values inside the question, so a corrected
 *   re-ask is a different string and does not spend the bound. Only asking
 *   the identical question over and over does, which is exactly the
 *   unproductive case the bound exists for.
 *
 * The owner who never names a pet at all is bounded elsewhere:
 * `hasRepeatedNoProgressQuestion` (`src/intakeConsumer.ts`) hands off on a
 * repeated `PET_IDENTITY_TEXT` with no actionable fact, and the flow never
 * reaches this module until an identity is known.
 */
function countIdenticalConfirmationAsks(context: ConversationIntakeContext, confirmationText: string): number {
  return context.recentMessages.filter((message) => message.direction === "outbound" && message.content === confirmationText).length;
}

/**
 * The content of the most recent outbound message strictly before the
 * current inbound turn — mirrors `intakeConsumer.ts`'s
 * `selectPreviousClinicQuestion`/`hasRepeatedNoProgressQuestion` convention
 * exactly, because `context.recentMessages`'s last element is always the
 * current inbound message itself (the one being processed right now), not
 * some earlier turn. Scanning from the end without first skipping that
 * current inbound would always hit it before any real prior outbound and
 * incorrectly return `null` on every turn — this must search starting one
 * element before it. Skips over any non-outbound entries in between (same
 * tolerance as the two functions above) rather than stopping at the first
 * one, so an intervening duplicate/retry inbound does not hide a real prior
 * confirmation ask.
 */
function lastOutboundContent(context: ConversationIntakeContext, currentMessage: string): string | null {
  const messages = context.recentMessages;
  const last = messages[messages.length - 1];
  if (last === undefined || last.direction !== "inbound" || last.content !== currentMessage) return null;

  for (let i = messages.length - 2; i >= 0; i--) {
    const message = messages[i]!;
    if (message.direction === "outbound") return message.content;
  }
  return null;
}

/**
 * Pure secondary planner, composed over an already-planned `PlanResult`
 * exactly like `appointmentFlow.ts`'s `planAppointmentAction` — never
 * mutates `context` or `plan`, never calls the database.
 */
export function planPetRegistrationAction(context: ConversationIntakeContext, plan: PlanResult, messageText: string): PetRegistrationAction {
  if (plan.kind !== "planned") return { kind: "none" };
  // Keyed on the *planned* stage, which covers both halves of the stage:
  // entering it from `complaint_collection` (ask the question on that same
  // turn, rather than sending filler and asking on the next one) and sitting
  // in it (`decideNextStage` holds there until this module says otherwise).
  // `human_handoff` is excluded for free, since it is never this value.
  if (plan.nextStage !== "intake_confirmation") return { kind: "none" };
  // Safety precedence is not optional: `planIntakeReply` (intakeReply.ts)
  // always sends the safety questionnaire ahead of intake-confirmation copy
  // once a signal is unresolved, and `appointmentFlow.ts`'s
  // `planAppointmentAction` enforces the same bypass for its own routing. A
  // confirmation/creation turn must not be able to defer that questionnaire
  // by even one turn.
  if (plan.safetyDecision.kind !== "continue_intake") return { kind: "none" };

  // A matched pet is confirmed but never re-created. An owner with pets on
  // file whose name is still ambiguous cannot be here at all: `decideNextStage`
  // holds such a conversation in `pet_identification`, which keeps today's
  // fail-closed clarification behavior unchanged.
  const resolution = plan.petResolution;
  const matchedPet = resolution.kind === "matched" ? context.pets.find((pet) => pet.id === resolution.petId) : undefined;
  const name = matchedPet?.name ?? plan.intakeData.pet_name;
  if (name === null || name === undefined || name.trim() === "") return { kind: "none" };
  const species = matchedPet?.species ?? plan.intakeData.species;
  const complaint = plan.intakeData.complaint;

  const confirmationText = buildIntakeConfirmationText(name, species, complaint);
  const previousOutbound = lastOutboundContent(context, messageText);
  const isAnsweringConfirmation = previousOutbound !== null && isConfirmationAsk(previousOutbound);

  if (isAnsweringConfirmation) {
    // Checked before EVET/HAYIR on purpose. If the owner's message moved any
    // of the three values, what they are answering is no longer what we would
    // now act on — even an "evet" must not create a pet under a name the
    // owner has never actually seen confirmed back to them.
    if (previousOutbound !== confirmationText) return { kind: "correction", name, species, complaint };

    const decision = parseYesNoReply(messageText);
    // An explicit, correctly-matched EVET is the one unambiguous
    // forward-progress signal this flow has; it must never itself be turned
    // into a handoff by the same bound that exists to stop *unproductive*
    // repeats. Only the ask/repeat paths below count against the bound.
    // Task 037 decision 4: `create` is authorized for `new_candidate` only —
    // never for `matched` (nothing to recreate) or `needs_clarification`
    // (which cannot reach here through `planIntakeTurn` today, but must stay
    // refused even if some future caller manages it).
    if (decision === "confirm") {
      if (matchedPet !== undefined) return { kind: "confirmed" };
      return resolution.kind === "new_candidate" ? { kind: "create", name, species } : { kind: "none" };
    }
    if (decision === "decline") return { kind: "declined" };
    // "repeat": unrecognized reply while awaiting confirmation, and nothing in
    // it changed the summary, falls through to the bound check below.
  }

  if (countIdenticalConfirmationAsks(context, confirmationText) >= MAX_PET_IDENTIFICATION_ATTEMPTS) return { kind: "bounded_handoff" };

  return isAnsweringConfirmation
    ? { kind: "repeat_confirmation", name, species, complaint }
    : { kind: "ask_confirmation", name, species, complaint };
}

/**
 * Builds the fixed-copy reply for every `PetRegistrationAction` except
 * `"none"`, `"create"` and `"confirmed"`. Those last two have no reply of
 * their own here — the caller plans that turn's reply the normal way
 * (`planPostConfirmationReply`), since once the summary is confirmed this is
 * an ordinary intake turn, not a special one.
 */
export function planPetRegistrationReply(action: PetRegistrationAction): IntakeReplyPlan {
  if (action.kind === "ask_confirmation" || action.kind === "repeat_confirmation" || action.kind === "correction") {
    return { kind: "send", category: "intake_confirmation", text: buildIntakeConfirmationText(action.name, action.species, action.complaint) };
  }
  if (action.kind === "declined") {
    return { kind: "send", category: "intake_confirmation", text: INTAKE_CORRECTION_PROMPT_TEXT };
  }
  return { kind: "none" };
}

/**
 * Reply for a successful `"create"`/`"confirmed"` action. Non-continuation
 * safety outcomes still reuse `planIntakeReply`; only a safety-clear
 * continuation receives the fixed appointment invitation, which retains the
 * existing worsening-case off-bot contact path. The synthetic
 * `petResolution.petId` is never read by `planIntakeReply` and is not persisted;
 * the synthetic `nextStage` is the stage the caller actually advances to.
 */
export function planPostConfirmationReply(context: ConversationIntakeContext, plan: Extract<PlanResult, { kind: "planned" }>): IntakeReplyPlan {
  if (plan.safetyDecision.kind === "continue_intake") {
    return {
      kind: "send",
      category: "intake_received",
      text: POST_CONFIRMATION_APPOINTMENT_INVITATION_TEXT,
    };
  }
  return planIntakeReply(context.intakeStage, {
    kind: "planned",
    nextStage: "safety_check",
    petId: null,
    intakeData: plan.intakeData,
    petResolution: { kind: "matched", petId: "" },
    safetyDecision: plan.safetyDecision,
  });
}
