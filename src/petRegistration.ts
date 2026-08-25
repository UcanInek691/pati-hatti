import type { ConversationIntakeContext } from "./conversationState";
import type { PlanResult } from "./intakeTurn";
import { PET_IDENTITY_TEXT, planIntakeReply, type IntakeReplyPlan } from "./intakeReply";

/**
 * First-time pet registration (Task 034 follow-on, "Adım 2" of the
 * user-approved plan in `CURRENT_TASK.md`'s "Candidate follow-on task" and
 * "User decisions" sections):
 *
 * - a pet is only ever created after the owner explicitly confirms the exact
 *   name (and species, if known) back — never from extraction alone;
 * - the confirmation message summarizes name and species together in one
 *   turn when species is already known, rather than asking twice;
 * - repeated pet-identification turns are bounded well below the existing
 *   global `NO_MODEL_STATE_VERSION_CEILING` (`src/intakeConsumer.ts`) so a
 *   stuck first-time owner reaches a human sooner than 12 turns, without
 *   duplicating or replacing that existing safety net;
 * - no new persisted field or `schema_version` bump: the bound is derived
 *   from `context.recentMessages`, which is already loaded for every turn.
 *
 * This module only plans; it never calls the database. The caller
 * (`src/intakeConsumer.ts`) is responsible for passing `createPetName`/
 * `createPetSpecies` into `finalizeIntakeQueueJob` on a `"create"` action,
 * and for clearing the persisted `pet_name`/`species` fields on a
 * `"declined"` action before that same call.
 */

export type PetRegistrationAction =
  | { kind: "none" }
  | { kind: "ask_confirmation"; name: string; species: string | null }
  | { kind: "repeat_confirmation"; name: string; species: string | null }
  | { kind: "declined" }
  | { kind: "create"; name: string; species: string | null }
  | { kind: "bounded_handoff" };

const MAX_PET_NAME_LENGTH = 200;
const MAX_SPECIES_LENGTH = 100;

/**
 * Bound on repeated pet-identification turns (ask/re-ask/confirm cycles)
 * before forcing human_handoff. Deliberately well below the existing global
 * `NO_MODEL_STATE_VERSION_CEILING = 12` (`src/intakeConsumer.ts`), which
 * remains the true non-termination backstop regardless of this heuristic.
 */
export const MAX_PET_IDENTIFICATION_ATTEMPTS = 3;

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Fixed-template confirmation copy. Interpolates only the owner's own
 * already-extracted pet name/species back to them for confirmation — the
 * one case in this codebase where echoing extracted text is the intended
 * behavior (contrast `applyClinicHandoffContext`'s doc comment, which
 * forbids this for handoff copy). Length-capped defensively even though the
 * extractor's schema does not itself bound string length.
 */
export function buildPetConfirmationText(name: string, species: string | null): string {
  const safeName = truncate(name, MAX_PET_NAME_LENGTH);
  const trimmedSpecies = species?.trim() ?? "";
  if (trimmedSpecies !== "") {
    const safeSpecies = truncate(trimmedSpecies, MAX_SPECIES_LENGTH);
    return `"${safeName}" adında, ${safeSpecies} türünde yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.`;
  }
  return `"${safeName}" adında yeni bir kayıt oluşturuyorum, doğru mu? Onaylamak için EVET, değilse HAYIR yazın.`;
}

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
 * Counts only outbound messages that are this flow's own prompts (the base
 * pet-identity question or a confirmation ask for the currently-extracted
 * name/species) — not every outbound message in the window. `pet_identification`
 * can also emit `safety_questions` or the unsupported-media `intake_received`
 * copy (see `intakeReply.ts`), and counting those against this bound would
 * exhaust it before a single pet-identity prompt was ever sent.
 */
function countRecentOutboundPrompts(context: ConversationIntakeContext, confirmationText: string): number {
  return context.recentMessages.filter(
    (message) => message.direction === "outbound" && (message.content === PET_IDENTITY_TEXT || message.content === confirmationText),
  ).length;
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
  if (context.intakeStage !== "pet_identification") return { kind: "none" };
  if (plan.nextStage === "human_handoff") return { kind: "none" };
  // Safety precedence is not optional: `planIntakeReply` (intakeReply.ts)
  // always sends the safety questionnaire ahead of pet-identity copy once a
  // signal is unresolved, and `appointmentFlow.ts`'s `planAppointmentAction`
  // enforces the same bypass for its own routing. A confirmation/creation
  // turn must not be able to defer that questionnaire by even one turn.
  if (plan.safetyDecision.kind !== "continue_intake") return { kind: "none" };
  if (plan.petResolution.kind === "matched") return { kind: "none" };
  // An owner with at least one already-registered pet keeps today's
  // fail-closed ambiguous-name clarification behavior unchanged; only a
  // first-time owner with zero pets is a creation candidate.
  if (context.pets.length > 0) return { kind: "none" };

  const name = plan.intakeData.pet_name;
  if (name === null || name.trim() === "") return { kind: "none" };
  const species = plan.intakeData.species;

  const awaitingConfirmationFor = buildPetConfirmationText(name, species);
  const wasAskedThisExactConfirmation = lastOutboundContent(context, messageText) === awaitingConfirmationFor;

  if (wasAskedThisExactConfirmation) {
    const decision = parseYesNoReply(messageText);
    // An explicit, correctly-matched EVET is the one unambiguous
    // forward-progress signal this flow has; it must never itself be turned
    // into a handoff by the same bound that exists to stop *unproductive*
    // repeats. Only the ask/repeat paths below count against the bound.
    if (decision === "confirm") return { kind: "create", name, species };
    if (decision === "decline") return { kind: "declined" };
    // "repeat": unrecognized reply while awaiting confirmation falls through
    // to the same bound check as a fresh ask, below.
  }

  if (countRecentOutboundPrompts(context, awaitingConfirmationFor) >= MAX_PET_IDENTIFICATION_ATTEMPTS) return { kind: "bounded_handoff" };

  return wasAskedThisExactConfirmation ? { kind: "repeat_confirmation", name, species } : { kind: "ask_confirmation", name, species };
}

/**
 * Builds the fixed-copy reply for every `PetRegistrationAction` except
 * `"none"` and `"create"`. `"create"` has no reply of its own here — the
 * caller plans that turn's reply the normal way (`planIntakeReply` against a
 * synthetic matched-pet result), since after creation this is an ordinary
 * complaint-collection turn, not a special one.
 */
export function planPetRegistrationReply(action: PetRegistrationAction): IntakeReplyPlan {
  if (action.kind === "ask_confirmation" || action.kind === "repeat_confirmation") {
    return { kind: "send", category: "pet_identity", text: buildPetConfirmationText(action.name, action.species) };
  }
  if (action.kind === "declined") {
    return { kind: "send", category: "pet_identity", text: PET_IDENTITY_TEXT };
  }
  return { kind: "none" };
}

/**
 * Reply for a successful `"create"` action: reuses `planIntakeReply` against
 * a synthetic already-matched result so complaint/symptom-aware copy
 * selection (Task 031's existing `complaint` vs `intake_received` branch) is
 * not duplicated here. The synthetic `petResolution.petId` is never read by
 * `planIntakeReply` and is not persisted.
 */
export function planPostCreationReply(context: ConversationIntakeContext, plan: Extract<PlanResult, { kind: "planned" }>): IntakeReplyPlan {
  return planIntakeReply(context.intakeStage, {
    kind: "planned",
    nextStage: "complaint_collection",
    petId: null,
    intakeData: plan.intakeData,
    petResolution: { kind: "matched", petId: "" },
    safetyDecision: plan.safetyDecision,
  });
}
